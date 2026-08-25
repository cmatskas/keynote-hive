/**
 * Shared OS notification helper.
 *
 * Every OS-level notification Hive raises goes through here so that title
 * prefixing, `Notification.isSupported()` guarding, and click-to-focus
 * behaviour stay consistent. Previously each call site rolled its own
 * (ipc/swarm.js had a local `swarmNotify`, credentialMonitor.js constructed
 * `new Notification(...)` inline three times), which meant the "Hive — "
 * prefix and the focus-on-click affordance were applied inconsistently.
 */

const { Notification } = require('electron');
const log = require('electron-log/main');

/**
 * Show an OS notification.
 *
 * @param {object}   opts
 * @param {string}   opts.title        - shown after the "Hive — " prefix
 * @param {string}   opts.body         - notification body text
 * @param {string}   [opts.urgency]    - 'low' | 'normal' | 'critical' (Linux only, harmless elsewhere)
 * @param {boolean}  [opts.silent]     - suppress the notification sound
 * @param {object}   [opts.window]     - BrowserWindow to show/focus when the notification is clicked
 * @param {Function} [opts.onClick]    - extra callback run on click, after the window is focused
 * @returns {boolean} true if a notification was actually shown
 */
function notify({ title, body, urgency = 'normal', silent = false, window = null, onClick = null } = {}) {
  // `Notification` is undefined when this module is loaded outside a real
  // Electron main process (e.g. under Jest, where `require('electron')`
  // resolves to the npm shim), so guard on the type rather than assuming it.
  if (!Notification || typeof Notification.isSupported !== 'function') return false;
  if (!Notification.isSupported()) return false;

  try {
    const n = new Notification({
      title: `Hive — ${title}`,
      body,
      urgency,
      silent,
    });

    if (window || onClick) {
      n.on('click', () => {
        try {
          if (window && !window.isDestroyed()) {
            window.show();
            window.focus();
          }
          if (onClick) onClick();
        } catch (err) {
          log.warn(`[notify] click handler failed: ${err.message}`);
        }
      });
    }

    n.show();
    return true;
  } catch (err) {
    // A notification failing is never worth breaking the caller over.
    log.warn(`[notify] failed to show notification: ${err.message}`);
    return false;
  }
}

module.exports = { notify };
