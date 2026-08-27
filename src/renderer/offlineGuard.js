/**
 * OfflineGuard — renderer-side offline banner and control gating.
 *
 * Hive's local features (conversation history, work history, skills, showflow,
 * settings) are all backed by files under the app's userData directory and need
 * no network at all. Only model calls, transcription, the AgentCore sandbox,
 * web search, and credential validation do. Before this, going offline made the
 * whole app unusable — so the goal here is the opposite default: everything
 * local keeps working, and only the controls that genuinely need AWS get
 * disabled, with a visible explanation of why.
 *
 * Two responsibilities:
 *  1. A persistent, non-dismissible banner while offline (dismissing it would
 *     just hide a condition the user can't otherwise see).
 *  2. Disabling network-dependent controls, and restoring exactly the ones it
 *     disabled — never re-enabling a control that was already disabled for its
 *     own reasons (e.g. a Send button disabled mid-request).
 */

(function () {
  'use strict';

  /**
   * Controls that require AWS. Each entry is an element id plus the reason
   * shown in its tooltip while offline.
   *
   * Deliberately NOT listed — these work offline and must stay enabled:
   * conversation list/search/load/delete, work history, skills editing,
   * settings save, showflow new/open/save/import/export, transcript
   * download/copy, theme toggle, attach-file pickers (local file selection).
   */
  const NETWORK_CONTROLS = [
    // Model invocation
    { id: 'workSendBtn',          reason: 'Sending a message needs an internet connection.' },
    { id: 'invokeBedrockBtn',     reason: 'Sending a message needs an internet connection.' },
    { id: 'swarmStartBtn',        reason: 'Running a pipeline needs an internet connection.' },
    { id: 'swarmContinueBtn',     reason: 'Continuing a pipeline needs an internet connection.' },
    { id: 'swarmInputAnswerBtn',  reason: 'Continuing a pipeline needs an internet connection.' },
    { id: 'swarmInputDefaultBtn', reason: 'Continuing a pipeline needs an internet connection.' },
    // Transcription
    { id: 'uploadZone',           reason: 'Transcription needs an internet connection.' },
    { id: 'fileInput',            reason: 'Transcription needs an internet connection.' },
    // Credentials + setup
    { id: 'saveCredBtn',          reason: 'Credentials can only be tested online.' },
    { id: 'runSetupCheckBtn',     reason: 'Setup Check needs an internet connection.' },
    { id: 'setupCheckRefreshBtn', reason: 'Setup Check needs an internet connection.' },
    { id: 'webSearchRetryBtn',    reason: 'Web search setup needs an internet connection.' },
    { id: 'transcriptionReconcileBtn', reason: 'Looking for past transcriptions needs an internet connection.' },
    // AgentCore Memory
    { id: 'memoryConnectBtn',     reason: 'Memory is stored in AWS and needs an internet connection.' },
    { id: 'memoryDeleteBtn',      reason: 'Memory is stored in AWS and needs an internet connection.' },
    { id: 'memoryRefreshBtn',     reason: 'Memory is stored in AWS and needs an internet connection.' },
    // Admin tab
    { id: 'adminRefreshStatusBtn', reason: 'Admin checks need an internet connection.' },
    { id: 'adminOpenWizardBtn',   reason: 'Admin actions need an internet connection.' },
    { id: 'adminWizardApplyBtn',  reason: 'Admin actions need an internet connection.' },
  ];

  const OFFLINE_MESSAGE =
    'Hive is offline. Your conversations, work history, skills and showflows are all stored ' +
    'locally and remain fully available. Anything that calls AWS — sending messages, running ' +
    'pipelines, and transcription — is paused until the connection returns.';

  let online = true;
  // Only restore what we disabled, so a control disabled for its own reasons
  // (mid-request, invalid form) isn't wrongly re-enabled on reconnect.
  const disabledByUs = new Set();
  const listeners = new Set();

  // ── Banner ───────────────────────────────────────────────────────────────

  function ensureBanner() {
    let banner = document.getElementById('offlineBanner');
    if (banner) return banner;

    banner = document.createElement('div');
    banner.id = 'offlineBanner';
    banner.className = 'offline-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.style.display = 'none';
    banner.innerHTML =
      '<i class="bi bi-wifi-off me-2" aria-hidden="true"></i>' +
      '<span id="offlineBannerText" class="flex-grow-1 small"></span>';

    // Sit directly above the credential warning banner if present, so the two
    // stack predictably below the navbar instead of fighting for the same slot.
    const credBanner = document.getElementById('credentialWarningBanner');
    if (credBanner && credBanner.parentNode) {
      credBanner.parentNode.insertBefore(banner, credBanner);
    } else {
      document.body.insertBefore(banner, document.body.firstChild);
    }
    const textEl = banner.querySelector('#offlineBannerText');
    if (textEl) textEl.textContent = OFFLINE_MESSAGE;
    return banner;
  }

  function renderBanner() {
    const banner = ensureBanner();
    banner.style.display = online ? 'none' : 'flex';
  }

  // ── Control gating ───────────────────────────────────────────────────────

  function applyToControls() {
    NETWORK_CONTROLS.forEach(({ id, reason }) => {
      const el = document.getElementById(id);
      if (!el) return; // not every control exists on every page

      if (!online) {
        // Don't touch (or later restore) something already disabled elsewhere.
        if (el.disabled || el.classList.contains('offline-disabled')) return;
        el.disabled = true;
        el.classList.add('offline-disabled');
        if (el.title) el.dataset.offlinePrevTitle = el.title;
        el.title = reason;
        disabledByUs.add(id);
      } else if (disabledByUs.has(id)) {
        el.disabled = false;
        el.classList.remove('offline-disabled');
        if (el.dataset.offlinePrevTitle !== undefined) {
          el.title = el.dataset.offlinePrevTitle;
          delete el.dataset.offlinePrevTitle;
        } else {
          el.removeAttribute('title');
        }
        disabledByUs.delete(id);
      }
    });

    // The upload zone is a div, so `disabled` means nothing to it — block the
    // click affordance explicitly.
    const uploadZone = document.getElementById('uploadZone');
    if (uploadZone) uploadZone.classList.toggle('offline-blocked', !online);
  }

  function setOnline(next) {
    const changed = next !== online;
    online = next;
    renderBanner();
    applyToControls();
    if (changed) {
      listeners.forEach(fn => {
        try { fn(online); } catch (err) { console.error('Offline listener failed:', err); }
      });
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  const OfflineGuard = {
    isOnline: () => online,

    /** Subscribe to connectivity transitions. Returns an unsubscribe function. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * Guard an action that needs the network. Returns true when it's safe to
     * proceed; otherwise shows a toast explaining why and returns false.
     */
    requireOnline(action = 'This action') {
      if (online) return true;
      const message = `${action} needs an internet connection — Hive is offline.`;
      if (window.electronAPI?.showToast) window.electronAPI.showToast(message, 'warning');
      return false;
    },

    /** Re-apply gating — call after injecting controls that render late. */
    refresh() {
      renderBanner();
      applyToControls();
    },

    async init() {
      // Ask the main process for the current state: the renderer may have
      // loaded after the last transition, so there's nothing to infer from.
      try {
        const status = await window.electronAPI.invoke('get-connectivity-status');
        setOnline(status?.online !== false);
      } catch {
        setOnline(true); // never trap the user behind a failed status check
      }

      window.electronAPI.receive('connectivity-changed', ({ online: isOnline }) => {
        setOnline(isOnline !== false);
      });

      // The browser's own events fire sooner than the main process's recheck
      // timer, so forward them as a hint. We don't trust navigator.onLine as
      // the answer — it reports interface state and is true on a captive
      // portal — so the main process re-probes and tells us the verdict.
      const hint = () => {
        window.electronAPI.invoke('renderer-connectivity-hint')
          .then(res => { if (res && typeof res.online === 'boolean') setOnline(res.online); })
          .catch(() => {});
      };
      window.addEventListener('online', hint);
      window.addEventListener('offline', hint);
    },
  };

  window.OfflineGuard = OfflineGuard;
})();
