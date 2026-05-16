/**
 * CredentialMonitor — background credential expiry detection.
 *
 * Strategy (Option C):
 * 1. Parse expiry from session token if available → schedule precise warnings
 * 2. Poll every 10 minutes as safety net for long-lived keys / parse failures
 * 3. Warnings: system notification at T-15min, in-app banner at T-2min
 * 4. At expiry: navigate to credentials page
 */

const { Notification } = require('electron');
const AWSValidator = require('./awsValidator');
const log = require('electron-log/main');

const POLL_INTERVAL_MS  = 10 * 60 * 1000; // 10 minutes
const WARN_15_MS        = 15 * 60 * 1000; // 15 minutes before expiry
const WARN_2_MS         =  2 * 60 * 1000; //  2 minutes before expiry

class CredentialMonitor {
  constructor({ getCredentials, getMainWindow, onExpired }) {
    this.getCredentials  = getCredentials;   // () => currentCredentials
    this.getMainWindow   = getMainWindow;    // () => mainWindow
    this.onExpired       = onExpired;        // called when credentials expire

    this._pollTimer   = null;
    this._warn15Timer = null;
    this._warn2Timer  = null;
    this._expireTimer = null;
    this._running     = false;
    this._lastStatus  = 'valid'; // 'valid' | 'warning15' | 'warning2' | 'expired'
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
    this.start();
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
    this._pollTimer = setInterval(async () => {
      if (!this._running) return;
      const creds = this.getCredentials();
      if (!creds) return;
      try {
        const validator = new AWSValidator(creds);
        const result = await validator.quickValidate();
        if (!result.valid && this._lastStatus !== 'expired') {
          log.warn('[CredentialMonitor] poll detected invalid credentials');
          this._handleExpired();
        }
      } catch (err) {
        log.warn('[CredentialMonitor] poll error:', err.message);
      }
    }, POLL_INTERVAL_MS);
  }

  _handleWarn15(expiry) {
    if (this._lastStatus !== 'valid') return;
    this._lastStatus = 'warning15';
    const minsLeft = Math.round((expiry.getTime() - Date.now()) / 60000);
    log.info(`[CredentialMonitor] 15min warning (${minsLeft}min left)`);

    // System notification
    if (Notification.isSupported()) {
      new Notification({
        title: 'Hive — Credentials Expiring Soon',
        body: `Your AWS credentials expire in ~${minsLeft} minutes. Update them to avoid interruption.`,
        urgency: 'normal',
      }).show();
    }

    // Tell renderer to show banner
    this._sendToRenderer('credential-expiry-warning', { level: 'warning', minsLeft });
  }

  _handleWarn2(expiry) {
    if (this._lastStatus === 'expired') return;
    this._lastStatus = 'warning2';
    const minsLeft = Math.max(1, Math.round((expiry.getTime() - Date.now()) / 60000));
    log.warn(`[CredentialMonitor] 2min warning (${minsLeft}min left)`);

    if (Notification.isSupported()) {
      new Notification({
        title: 'Hive — Credentials Expiring in 2 Minutes',
        body: 'Update your AWS credentials now to avoid being logged out.',
        urgency: 'critical',
      }).show();
    }

    this._sendToRenderer('credential-expiry-warning', { level: 'critical', minsLeft });
  }

  _handleExpired() {
    if (this._lastStatus === 'expired') return;
    this._lastStatus = 'expired';
    log.warn('[CredentialMonitor] credentials expired');
    this.stop();

    if (Notification.isSupported()) {
      new Notification({
        title: 'Hive — Session Expired',
        body: 'Your AWS credentials have expired. Please update them to continue.',
        urgency: 'critical',
      }).show();
    }

    this._sendToRenderer('credential-expiry-warning', { level: 'expired', minsLeft: 0 });

    // Give renderer 3 seconds to show the message, then navigate
    setTimeout(() => this.onExpired(), 3000);
  }

  _sendToRenderer(channel, data) {
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}

module.exports = CredentialMonitor;
