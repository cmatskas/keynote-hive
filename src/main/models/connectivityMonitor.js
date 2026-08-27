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
// Last resort. If no probe has been attempted in this long, something has gone
// wrong with our own scheduling — force one. Restarting the app should never be
// the only way to recover, which is exactly what happened when the state machine
// dead-ended and sat offline for three hours.
const WATCHDOG_INTERVAL_MS = 60 * 1000;
const PROBE_STALE_AFTER_MS = 3 * ONLINE_RECHECK_MS;

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
    this._pendingState = null;   // target of a debounced transition, if any
    this._probeInFlight = null;
    this._watchdogTimer = null;
    this._lastProbeAt = 0;
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
    this._startWatchdog();
    this.recheck();
  }

  stop() {
    this._running = false;
    clearTimeout(this._timer);
    clearTimeout(this._debounceTimer);
    clearInterval(this._watchdogTimer);
    this._timer = this._debounceTimer = this._watchdogTimer = null;
    this._pendingState = null;
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
        this._lastProbeAt = Date.now();
        // The probe is authoritative; `net.isOnline()` is only logged when the
        // two disagree.
        //
        // It used to gate the probe — "don't bother if the OS says there's no
        // interface" — and that was the bug that latched the monitor offline for
        // three hours. `net.isOnline()` can get stuck false after sleep or a
        // network change, and while it was, the actual reachability test never
        // ran: the monitor re-applied offline every 20s without ever checking,
        // logged nothing (no state change), and only a restart cleared it.
        // One HEAD request every 20s is a trivial price for removing that.
        const reachable = await this._probe();
        if (!reachable !== !this._osOnline()) {
          log.info(`[ConnectivityMonitor] probe says ${reachable ? 'reachable' : 'unreachable'} while net.isOnline() says ${this._osOnline()} — trusting the probe`);
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

  /**
   * Apply a probe result.
   *
   * Two invariants, both learned the hard way — the monitor was once observed
   * latched offline for three hours with a working network, recoverable only by
   * restarting the app:
   *
   *  1. **A recheck is always scheduled.** Previously the transition path armed
   *     only a debounce, and that debounce's early return exited without
   *     rescheduling; once taken, no timer remained and the state machine was
   *     dead. Liveness must never depend on the debounce firing.
   *  2. **A pending transition is never re-armed for the same target.** Every
   *     `recheck()` used to clear and re-arm the debounce, so a retrying app
   *     calling `reportNetworkFailure()` could push a recovery out indefinitely.
   */
  _applyState(online) {
    if (online === this._online) {
      // Already there. Cancel any pending move away from it — the latest probe
      // agrees with the current state — and keep the loop alive.
      this._clearPendingTransition();
      this._scheduleRecheck();
      return;
    }

    if (this._pendingState === online && this._debounceTimer) {
      // A move to this exact state is already queued; leave its timer alone.
      this._scheduleRecheck();
      return;
    }

    clearTimeout(this._debounceTimer);
    this._pendingState = online;

    // Debounce: waking from sleep or switching networks produces a burst of
    // transitions, and each would otherwise re-broadcast and re-trigger
    // reconnect work (web search init, transcription resume).
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._pendingState = null;
      try {
        if (!this._running || online === this._online) return;
        this._online = online;
        log.warn(`[ConnectivityMonitor] now ${online ? 'ONLINE' : 'OFFLINE'}`);
        if (this.onChange) this.onChange(online);
      } catch (err) {
        log.error(`[ConnectivityMonitor] onChange handler threw: ${err.message}`);
      } finally {
        // Every exit path, including the early return above.
        this._scheduleRecheck();
      }
    }, DEBOUNCE_MS);

    // Liveness does not wait on the debounce.
    this._scheduleRecheck();
  }

  _clearPendingTransition() {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = null;
    this._pendingState = null;
  }

  /**
   * Independent of the main recheck timer on purpose: its whole job is to catch
   * the case where that timer has been lost. A silent monitor is indistinguishable
   * from a working one until the user notices they've been offline for hours.
   */
  _startWatchdog() {
    clearInterval(this._watchdogTimer);
    this._watchdogTimer = setInterval(() => {
      if (!this._running) return;
      const since = Date.now() - this._lastProbeAt;
      if (since < PROBE_STALE_AFTER_MS) return;
      log.warn(`[ConnectivityMonitor] no probe in ${Math.round(since / 1000)}s — forcing one (scheduling may have been lost)`);
      this.recheck().catch(() => {});
    }, WATCHDOG_INTERVAL_MS);
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
module.exports.WATCHDOG_INTERVAL_MS = WATCHDOG_INTERVAL_MS;
module.exports.PROBE_STALE_AFTER_MS = PROBE_STALE_AFTER_MS;
