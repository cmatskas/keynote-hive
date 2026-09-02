/**
 * CredentialMonitor — background credential expiry detection.
 *
 * Strategy: poll AWS and react to what it says. That is deliberately all.
 *
 * This used to also try to predict expiry ahead of time, by decoding the
 * session token and scheduling warnings at T-15min and T-2min. That could never
 * work: STS session tokens are opaque, encrypted blobs, not JWTs and not base64
 * JSON, and no AWS API takes a token and returns its lifetime. So the parse
 * failed on every real credential, every launch logged "could not parse token
 * expiry", and the two warning paths were dead code that had never once fired in
 * production. Predicting expiry requires a timestamp from outside the token —
 * the paste, the user, or an AssumeRole round trip — none of which Hive has, so
 * the prediction machinery is gone rather than left looking functional.
 *
 * What replaces it is prompt detection: GetCallerIdentity is free and fast, so
 * polling it once a minute bounds how long a dead credential can go unnoticed.
 *
 * Expiry is reported, never acted on destructively. It previously replaced the
 * renderer with the credentials page, discarding unsaved Work tab state,
 * attachments and any in-flight UI — a heavy price for something the banner
 * already communicates. Hive now notifies, marks the credentials rejected (which
 * disables the controls that need AWS, so nothing is lost to a doomed request),
 * and leaves the user exactly where they were.
 *
 * Because nothing navigates away any more, the monitor must keep polling after
 * expiry: it is the only thing that will notice the credentials being fixed and
 * clear the banner again.
 *
 * Offline handling still matters. The poll used to conclude expiry from any
 * `valid: false`, and `quickValidate()` reports a DNS failure that way — so
 * closing a laptop lid could once destroy the user's work within 10 minutes. A
 * transport failure pauses the poll; only a genuine rejection by AWS counts.
 */

const AWSValidator = require('./awsValidator');
const log = require('electron-log/main');
const { notify } = require('../notify');

// GetCallerIdentity is free and cheap, so poll often enough that expiry is
// noticed within about a minute rather than up to ten. This is detection, not
// prediction: it cannot warn in advance, only report promptly.
const POLL_INTERVAL_MS = 60 * 1000; // 1 minute

class CredentialMonitor {
  constructor({ getCredentials, getMainWindow, onExpired, isOnline = null, onReachedAws = null,
    onRecovered = null, onStateSettled = null }) {
    this.getCredentials  = getCredentials;   // () => currentCredentials
    this.getMainWindow   = getMainWindow;    // () => mainWindow
    this.onExpired       = onExpired;        // called when credentials expire
    this.isOnline        = isOnline;         // () => boolean, optional
    this.onReachedAws = onReachedAws;        // () => void, called on any real answer from AWS
    this.onRecovered  = onRecovered;         // () => void, credentials work again after an expiry
    this.onStateSettled = onStateSettled;    // () => void, verdict confirmed with no transition

    this._pollTimer   = null;
    this._running     = false;
    this._lastStatus  = 'valid'; // 'valid' | 'expired'
    this._pausedOffline = false; // true while we can't reach AWS to check
    this._credentialState = 'unknown'; // 'valid' | 'rejected' | 'unknown'
  }

  start() {
    if (this._running) return;
    this._running = true;
    log.info('[CredentialMonitor] started');
    this._startPoll();
  }

  stop() {
    this._running = false;
    clearInterval(this._pollTimer);
    this._pollTimer = null;
    log.info('[CredentialMonitor] stopped');
  }

  /**
   * Call this after credentials are refreshed.
   *
   * Deliberately does NOT clear `_lastStatus`. It used to set it back to 'valid',
   * which quietly broke the most common recovery path in the app: saving working
   * credentials after an expiry. Recovery is announced only on the transition out
   * of 'expired' (see _runPollCheck), so erasing that memory meant the transition
   * never happened, `credential-expiry-warning: ok` was never sent, and the
   * renderer kept its 'rejected' verdict forever — every AWS control stayed
   * disabled and every send was refused with "needs working AWS credentials",
   * against credentials that were provably fine. Restarting the app was the only
   * way out, because a fresh renderer asks for the state instead of remembering it.
   *
   * Recovery *without* a save always worked, which is why this survived: the
   * broken path was the one nobody tests by hand, since fixing credentials is
   * exactly when you stop looking for bugs.
   *
   * Also re-checks immediately. Waiting out the poll interval left the UI blocked
   * for up to a minute after the user had already been told their credentials
   * were fine.
   */
  reset() {
    this.stop();
    this._pausedOffline = false;
    this._credentialState = 'unknown';
    this.start();
    this._runPollCheck().catch(err =>
      log.warn(`[CredentialMonitor] post-reset check failed: ${err.message}`));
  }

  /**
   * Called when connectivity returns. Re-checks immediately rather than waiting
   * for the next poll tick, so a credential that genuinely expired *during* the
   * outage is caught promptly.
   */
  resumeAfterOffline() {
    if (!this._running) return;
    if (!this._pausedOffline) return;
    log.info('[CredentialMonitor] connectivity restored - re-checking credentials');
    this._pausedOffline = false;
    this._runPollCheck().catch(err => log.warn('[CredentialMonitor] resume check failed:', err.message));
  }

  /** True while the monitor is holding off because it can't reach AWS. */
  isPausedOffline() {
    return this._pausedOffline;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  _startPoll() {
    this._pollTimer = setInterval(() => {
      this._runPollCheck().catch(err => log.warn('[CredentialMonitor] poll error:', err.message));
    }, POLL_INTERVAL_MS);
  }

  /**
   * One poll iteration. Extracted so resumeAfterOffline() can run the same
   * check immediately instead of waiting for the next interval.
   *
   * Deliberately **not** gated on connectivity. It used to return early when the
   * connectivity monitor reported offline — "don't bother with a doomed round
   * trip" — and that made expired credentials undetectable for as long as that
   * monitor was wrong. In production it was wrong for three hours, so the app
   * blamed the network and could not tell the user whether their token had also
   * expired. `quickValidate()` already returns a three-state result that
   * distinguishes "could not reach AWS" from "AWS rejected these credentials",
   * which is the right place for that decision.
   *
   * A successful check is also proof we can reach AWS, so it nudges the
   * connectivity monitor — the two now correct each other rather than one
   * depending on the other.
   */
  async _runPollCheck() {
    if (!this._running) return;

    const creds = this.getCredentials();
    if (!creds) return;

    const validator = new AWSValidator(creds);
    const result = await validator.quickValidate();

    if (result.offline) {
      if (!this._pausedOffline) {
        log.info('[CredentialMonitor] could not reach AWS - pausing credential checks (not treating as expiry)');
        this._pausedOffline = true;
      }
      this._credentialState = 'unknown';
      return;
    }

    // We got a real answer from AWS, so any earlier pause is over — and we have
    // just proved the network works, whatever the connectivity monitor believes.
    this._pausedOffline = false;
    if (this.onReachedAws) {
      try { this.onReachedAws(); } catch (err) { log.warn(`[CredentialMonitor] onReachedAws threw: ${err.message}`); }
    }

    this._credentialState = result.valid ? 'valid' : 'rejected';

    if (!result.valid) {
      this._handleExpired();
    } else if (this._lastStatus === 'expired') {
      this._handleRecovered();
    } else if (this.onStateSettled) {
      // Valid, and not a recovery — but the renderer may still be holding a
      // stale verdict (it caches what it was last told, and a reset clears our
      // 'unknown' without telling it). Let the host re-broadcast the truth.
      try { this.onStateSettled(); } catch (err) {
        log.warn(`[CredentialMonitor] onStateSettled threw: ${err.message}`);
      }
    }
  }

  /**
   * What we last learned about the credentials: 'valid', 'rejected', or 'unknown'
   * when AWS could not be reached. Lets the UI say which thing is actually broken
   * instead of attributing everything to being offline, and lets it disable the
   * controls that would fail.
   */
  getCredentialState() {
    return this._credentialState;
  }

  _handleExpired() {
    if (this._lastStatus === 'expired') return;
    this._lastStatus = 'expired';
    log.warn('[CredentialMonitor] credentials rejected by AWS');

    notify({
      title: 'AWS Credentials Expired',
      body: 'Update them in Settings > Credentials to continue. Your work is safe.',
      urgency: 'critical',
    });

    this._credentialState = 'rejected';
    this._sendToRenderer('credential-expiry-warning', { level: 'expired' });

    // Deliberately no navigation. Replacing the renderer with the credentials
    // page discarded unsaved work to tell the user something the banner already
    // says. The renderer disables everything that needs AWS instead, so an
    // action can't be lost to a request that was going to fail anyway.
    //
    // Note there is no stop() here either: polling has to continue, because it
    // is the only thing that will notice the credentials being fixed.
    if (this.onExpired) {
      try { this.onExpired(); } catch (err) { log.warn(`[CredentialMonitor] onExpired threw: ${err.message}`); }
    }
  }

  /**
   * The credentials work again — typically because the user pasted new ones,
   * but also covers a role being re-granted server-side. Only reachable because
   * the monitor keeps polling after expiry.
   */
  _handleRecovered() {
    this._lastStatus = 'valid';
    log.info('[CredentialMonitor] credentials valid again');

    notify({
      title: 'AWS Credentials Working',
      body: 'Hive is connected again.',
      urgency: 'low',
    });

    this._sendToRenderer('credential-expiry-warning', { level: 'ok' });

    // Mirrors onExpired. Without this the only thing correcting the renderer was
    // the banner event above, so a single dropped message left the UI wrong with
    // nothing to repair it.
    if (this.onRecovered) {
      try { this.onRecovered(); } catch (err) {
        log.warn(`[CredentialMonitor] onRecovered threw: ${err.message}`);
      }
    }
  }

  _sendToRenderer(channel, data) {
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}

module.exports = CredentialMonitor;
module.exports.POLL_INTERVAL_MS = POLL_INTERVAL_MS;
