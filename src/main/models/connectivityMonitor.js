/**
 * ConnectivityMonitor — is Hive able to reach AWS right now?
 *
 * Hive had no connectivity awareness at all before this. Everything network-
 * related discovered the answer by failing, and because
 * `AWSValidator.quickValidate()` reported a DNS failure as invalid credentials,
 * those failures were misattributed (see src/main/awsErrors.js).
 *
 * Detection strategy, in order of cost:
 *
 * 1. `net.isOnline()` / the OS online-offline transition is the cheap signal.
 *    It's event-driven and free, but it only reports whether an interface is
 *    up — it says yes on a captive portal or a VPN that routes nowhere.
 * 2. A reachability probe confirms it. Before declaring a state change we do
 *    one small HTTPS HEAD against the regional STS endpoint. Any HTTP answer
 *    at all (including 400 or 403 — STS rejecting an unsigned HEAD is still
 *    proof the network works) counts as online; a transport failure counts as
 *    offline.
 *
 * Transitions are debounced, because a laptop waking or switching networks
 * emits several events in a row and each one would otherwise re-broadcast to
 * the renderer and re-trigger reconnect work.
 */

const { net } = require('electron');
const https = require('https');
const log = require('electron-log/main');

const PROBE_TIMEOUT_MS   = 5000;
const DEBOUNCE_MS        = 1500;
// While offline, re-probe on a timer as well as on OS events: a captive portal
// being satisfied in a browser produces no OS transition at all.
const OFFLINE_RECHECK_MS = 20 * 1000;
// While online we trust events and lazy failures rather than polling, so this
// is a slow safety net only.
const ONLINE_RECHECK_MS  = 5 * 60 * 1000;

class ConnectivityMonitor {
  /**
   * @param {object}   opts
   * @param {Function} opts.getRegion  - () => AWS region string, for the probe endpoint
   * @param {Function} opts.onChange   - (online: boolean) => void, called only on an actual transition
   */
  constructor({ getRegion, onChange }) {
    this.getRegion = getRegion;
    this.onChange = onChange;

    // Optimistic start: assume online until proven otherwise, so a healthy
    // launch never flashes an offline banner while the first probe runs.
    this._online = true;
    this._running = false;
    this._timer = null;
    this._debounceTimer = null;
    this._probeInFlight = null;
  }

  isOnline() {
    return this._online;
  }

  start() {
    if (this._running) return;
    this._running = true;
    log.info('[ConnectivityMonitor] started');

    // Electron surfaces OS connectivity transitions to the renderer, not the
    // main process, so there's no main-process event to subscribe to here —
    // net.isOnline() plus the recheck timer is the main-process equivalent.
    // The renderer forwards its own online/offline events via
    // `renderer-connectivity-hint` for a faster reaction (see recheck()).
    this._scheduleRecheck();
    this.recheck();
  }

  stop() {
    this._running = false;
    clearTimeout(this._timer);
    clearTimeout(this._debounceTimer);
    this._timer = this._debounceTimer = null;
    log.info('[ConnectivityMonitor] stopped');
  }

  /**
   * Force an immediate connectivity check. Called on start, on the recheck
   * timer, when the renderer reports an OS transition, and by any code that
   * has just seen a transport failure and wants the state updated now.
   *
   * @returns {Promise<boolean>} the (possibly unchanged) online state
   */
  async recheck() {
    if (!this._running) return this._online;

    // Collapse concurrent callers onto one probe — several subsystems can
    // notice a failure in the same tick.
    if (this._probeInFlight) return this._probeInFlight;

    this._probeInFlight = (async () => {
      try {
        // Cheap gate first: if the OS says there's no interface at all, don't
        // bother with the probe.
        let reachable = false;
        if (this._osOnline()) {
          reachable = await this._probe();
        }
        this._applyState(reachable);
        return this._online;
      } finally {
        this._probeInFlight = null;
      }
    })();

    return this._probeInFlight;
  }

  /**
   * Report a transport-level failure observed elsewhere (e.g. an AWS call that
   * failed with ENOTFOUND). Triggers a re-check rather than trusting the
   * caller, so one flaky endpoint can't declare the whole app offline.
   */
  reportNetworkFailure() {
    if (!this._running) return;
    this.recheck().catch(() => {});
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  _osOnline() {
    try {
      // net.isOnline() is unavailable in some test/headless contexts.
      return typeof net?.isOnline === 'function' ? net.isOnline() : true;
    } catch {
      return true;
    }
  }

  /**
   * One HTTPS HEAD against the regional STS endpoint. We care only about
   * whether the transport works — any HTTP status is a success, because it
   * proves DNS resolved, TCP connected, and TLS completed.
   */
  _probe() {
    const region = (this.getRegion && this.getRegion()) || 'us-east-1';
    const host = `sts.${region}.amazonaws.com`;

    return new Promise(resolve => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const req = https.request(
        { method: 'HEAD', host, path: '/', timeout: PROBE_TIMEOUT_MS, agent: false },
        (res) => { res.resume(); done(true); }
      );
      req.on('timeout', () => { req.destroy(); done(false); });
      req.on('error', () => done(false));
      req.end();
    });
  }

  _applyState(online) {
    if (online === this._online) {
      this._scheduleRecheck();
      return;
    }

    // Debounce: waking from sleep or switching networks produces a burst of
    // transitions, and each one would otherwise re-broadcast and re-trigger
    // reconnect work (web search init, transcription resume).
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      if (!this._running || online === this._online) return;
      this._online = online;
      log.warn(`[ConnectivityMonitor] now ${online ? 'ONLINE' : 'OFFLINE'}`);
      try {
        if (this.onChange) this.onChange(online);
      } catch (err) {
        log.error(`[ConnectivityMonitor] onChange handler threw: ${err.message}`);
      }
      this._scheduleRecheck();
    }, DEBOUNCE_MS);
  }

  _scheduleRecheck() {
    if (!this._running) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(
      () => this.recheck().catch(() => {}),
      this._online ? ONLINE_RECHECK_MS : OFFLINE_RECHECK_MS
    );
  }
}

module.exports = ConnectivityMonitor;
module.exports.PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS;
module.exports.DEBOUNCE_MS = DEBOUNCE_MS;
module.exports.OFFLINE_RECHECK_MS = OFFLINE_RECHECK_MS;
module.exports.ONLINE_RECHECK_MS = ONLINE_RECHECK_MS;
