/**
 * CredentialMonitor — background credential expiry detection.
 *
 * Strategy (Option C):
 * 1. Parse expiry from session token if available → schedule precise warnings
 * 2. Poll every 10 minutes as safety net for long-lived keys / parse failures
 * 3. Warnings: system notification at T-15min, in-app banner at T-2min
 * 4. At expiry: navigate to credentials page
 *
 * Offline handling matters a great deal here, because `_handleExpired()` is
 * destructive: it replaces the renderer with the credentials page, discarding
 * unsaved Work tab state, attachments, and any in-flight UI. The poll used to
 * reach that conclusion from any `valid: false`, and `quickValidate()` reported
 * a DNS failure as `valid: false` — so closing a laptop lid or switching
 * networks could silently destroy the user's work within 10 minutes. A
 * transport failure now pauses the poll instead of escalating; only a genuine
 * rejection by AWS counts as expiry.
 */

const AWSValidator = require('./awsValidator');
const log = require('electron-log/main');
const { notify } = require('../notify');

const POLL_INTERVAL_MS  = 10 * 60 * 1000; // 10 minutes
const WARN_15_MS        = 15 * 60 * 1000; // 15 minutes before expiry
const WARN_2_MS         =  2 * 60 * 1000; //  2 minutes before expiry

class CredentialMonitor {
  constructor({ getCredentials, getMainWindow, onExpired, isOnline = null, shouldDeferNavigation = null }) {
    this.getCredentials  = getCredentials;   // () => currentCredentials
    this.getMainWindow   = getMainWindow;    // () => mainWindow
    this.onExpired       = onExpired;        // called when credentials expire
    this.isOnline        = isOnline;         // () => boolean, optional
    this.shouldDeferNavigation = shouldDeferNavigation; // () => boolean, optional veto

    this._pollTimer   = null;
    this._warn15Timer = null;
    this._warn2Timer  = null;
    this._expireTimer = null;
    this._running     = false;
    this._lastStatus  = 'valid'; // 'valid' | 'warning15' | 'warning2' | 'expired'
    this._pausedOffline = false; // true while we can't reach AWS to check
    this._navigationDeferred = false; // expired, but navigating would lose work
  }

  start() {
    if (this._running) return;
    this._running = true;
    log.info('[CredentialMonitor] started');
    this._scheduleFromCredentials();
    this._startPoll();
  }

  stop() {
    this._running = false;
    clearTimeout(this._warn15Timer);
    clearTimeout(this._warn2Timer);
    clearTimeout(this._expireTimer);
    clearInterval(this._pollTimer);
    this._warn15Timer = this._warn2Timer = this._expireTimer = this._pollTimer = null;
    log.info('[CredentialMonitor] stopped');
  }

  /** Call this after credentials are refreshed to reset all timers. */
  reset() {
    this.stop();
    this._lastStatus = 'valid';
    this._pausedOffline = false;
    this.start();
  }

  /**
   * Called when connectivity returns. Re-checks immediately rather than
   * waiting up to another 10 minutes for the next poll tick, so a credential
   * that genuinely expired *during* the outage is caught promptly.
   */
  resumeAfterOffline() {
    if (!this._running) {
      // Stopped because we already concluded expiry, but the navigation was
      // deferred while offline — now that we're back, honour it.
      this.retryDeferredNavigation();
      return;
    }
    if (!this._pausedOffline) return;
    log.info('[CredentialMonitor] connectivity restored — re-checking credentials');
    this._pausedOffline = false;
    this._runPollCheck().catch(err => log.warn('[CredentialMonitor] resume check failed:', err.message));
  }

  /** True while the monitor is holding off because it can't reach AWS. */
  isPausedOffline() {
    return this._pausedOffline;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  _scheduleFromCredentials() {
    const creds = this.getCredentials();
    if (!creds?.sessionToken) return; // long-lived key — rely on poll only

    const expiry = AWSValidator.parseTokenExpiry(creds.sessionToken);
    if (!expiry) {
      log.info('[CredentialMonitor] could not parse token expiry — poll only');
      return;
    }

    const now = Date.now();
    const expiresIn = expiry.getTime() - now;

    // Sanity check: ignore parsed dates that are in the past or more than 24h in the future
    // (likely a parse error producing garbage data)
    if (expiresIn <= 0 || expiresIn > 24 * 60 * 60 * 1000) {
      log.info(`[CredentialMonitor] parsed expiry looks invalid (${Math.round(expiresIn / 60000)}min) — poll only`);
      return;
    }

    log.info(`[CredentialMonitor] token expires in ${Math.round(expiresIn / 60000)}min`);

    if (expiresIn <= 0) {
      this._handleExpired();
      return;
    }

    // Schedule T-15min warning
    const t15 = expiresIn - WARN_15_MS;
    if (t15 > 0) {
      this._warn15Timer = setTimeout(() => this._handleWarn15(expiry), t15);
    } else if (expiresIn > WARN_2_MS) {
      // Already inside 15min window — fire immediately
      this._handleWarn15(expiry);
    }

    // Schedule T-2min warning
    const t2 = expiresIn - WARN_2_MS;
    if (t2 > 0) {
      this._warn2Timer = setTimeout(() => this._handleWarn2(expiry), t2);
    } else if (expiresIn > 0) {
      this._handleWarn2(expiry);
    }

    // Schedule expiry
    this._expireTimer = setTimeout(() => this._handleExpired(), expiresIn);
  }

  _startPoll() {
    this._pollTimer = setInterval(() => {
      this._runPollCheck().catch(err => log.warn('[CredentialMonitor] poll error:', err.message));
    }, POLL_INTERVAL_MS);
  }

  /**
   * One poll iteration. Extracted so resumeAfterOffline() can run the same
   * check immediately instead of waiting for the next interval.
   *
   * The critical distinction: `valid: false` with `offline: true` means we
   * never reached AWS, which says nothing about whether the credentials are
   * still good. Escalating that to _handleExpired() would tear down the
   * renderer and lose the user's work over a transient network blip.
   */
  async _runPollCheck() {
    if (!this._running) return;

    const creds = this.getCredentials();
    if (!creds) return;

    // Skip the round trip entirely if we already know we're offline.
    if (this.isOnline && !this.isOnline()) {
      if (!this._pausedOffline) {
        log.info('[CredentialMonitor] offline — pausing credential checks');
        this._pausedOffline = true;
      }
      return;
    }

    const validator = new AWSValidator(creds);
    const result = await validator.quickValidate();

    if (result.offline) {
      if (!this._pausedOffline) {
        log.info('[CredentialMonitor] could not reach AWS — pausing credential checks (not treating as expiry)');
        this._pausedOffline = true;
      }
      return;
    }

    // We got a real answer from AWS, so any earlier pause is over.
    this._pausedOffline = false;

    if (!result.valid && this._lastStatus !== 'expired') {
      log.warn('[CredentialMonitor] poll detected invalid credentials');
      this._handleExpired();
    }
  }

  _handleWarn15(expiry) {
    if (this._lastStatus !== 'valid') return;
    this._lastStatus = 'warning15';
    const minsLeft = Math.round((expiry.getTime() - Date.now()) / 60000);
    log.info(`[CredentialMonitor] 15min warning (${minsLeft}min left)`);

    // System notification
    notify({
      title: 'Credentials Expiring Soon',
      body: `Your AWS credentials expire in ~${minsLeft} minutes. Update them to avoid interruption.`,
      urgency: 'normal',
    });

    // Tell renderer to show banner
    this._sendToRenderer('credential-expiry-warning', { level: 'warning', minsLeft });
  }

  _handleWarn2(expiry) {
    if (this._lastStatus === 'expired') return;
    this._lastStatus = 'warning2';
    const minsLeft = Math.max(1, Math.round((expiry.getTime() - Date.now()) / 60000));
    log.warn(`[CredentialMonitor] 2min warning (${minsLeft}min left)`);

    notify({
      title: 'Credentials Expiring in 2 Minutes',
      body: 'Update your AWS credentials now to avoid being logged out.',
      urgency: 'critical',
    });

    this._sendToRenderer('credential-expiry-warning', { level: 'critical', minsLeft });
  }

  _handleExpired() {
    if (this._lastStatus === 'expired') return;
    this._lastStatus = 'expired';
    log.warn('[CredentialMonitor] credentials expired');
    this.stop();

    notify({
      title: 'Session Expired',
      body: 'Your AWS credentials have expired. Please update them to continue.',
      urgency: 'critical',
    });

    this._sendToRenderer('credential-expiry-warning', { level: 'expired', minsLeft: 0 });

    // Navigating replaces the renderer with the credentials page, which throws
    // away unsaved work. Only do it when it's actually useful: offline, the
    // user can't validate new credentials anyway, and a caller can veto (e.g.
    // a transcription parked mid-job would lose its result). In those cases the
    // banner has already told them, and the navigation is deferred until the
    // veto lifts — see retryDeferredNavigation().
    if (this._canNavigateNow()) {
      setTimeout(() => this.onExpired(), 3000);
    } else {
      log.info('[CredentialMonitor] deferring navigation to credentials page (offline or vetoed)');
      this._navigationDeferred = true;
    }
  }

  _canNavigateNow() {
    if (this.isOnline && !this.isOnline()) return false;
    if (this.shouldDeferNavigation && this.shouldDeferNavigation()) return false;
    return true;
  }

  /**
   * Retry a navigation that was deferred because we were offline or a caller
   * vetoed it. Safe to call repeatedly; does nothing unless a navigation is
   * actually outstanding and now permitted.
   */
  retryDeferredNavigation() {
    if (!this._navigationDeferred || !this._canNavigateNow()) return;
    this._navigationDeferred = false;
    log.info('[CredentialMonitor] running deferred navigation to credentials page');
    this.onExpired();
  }

  _sendToRenderer(channel, data) {
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}

module.exports = CredentialMonitor;
