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
    // StoryBrand analysis
    { id: 'sbAnalyzeBtn',         reason: 'Analysing a script needs an internet connection.' },
    { id: 'sbReanalyzeBtn',       reason: 'Re-analysing needs an internet connection.' },
    // Transcription
    { id: 'uploadZone',           reason: 'Transcription needs an internet connection.' },
    { id: 'fileInput',            reason: 'Transcription needs an internet connection.' },
    // Credentials + setup.
    //
    // `fixesCredentials` marks the controls that are how you RECOVER from
    // rejected credentials. Disabling those when AWS has rejected your keys
    // would leave the user staring at a banner telling them to do something the
    // UI had just prevented. They are still disabled when genuinely offline,
    // where they cannot work either way.
    { id: 'saveCredBtn',          reason: 'Credentials can only be tested online.', fixesCredentials: true },
    { id: 'runSetupCheckBtn',     reason: 'Setup Check needs an internet connection.', fixesCredentials: true },
    { id: 'setupCheckRefreshBtn', reason: 'Setup Check needs an internet connection.', fixesCredentials: true },
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

  const CREDENTIALS_REJECTED_REASON =
    'AWS rejected your credentials. Update them in Settings > Credentials.';

  let online = true;
  // 'valid' | 'rejected' | 'unknown' — reported by the main process so the banner
  // can name the actual problem rather than always blaming the network.
  let credentialState = 'unknown';
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
        '<span id="offlineBannerText" class="flex-grow-1 small"></span>' +
        '<button class="btn btn-sm btn-outline-light ms-3" id="offlineRetryBtn">Retry now</button>';

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
    banner.querySelector('#offlineRetryBtn')?.addEventListener('click', retryNow);
    return banner;
  }

  /**
   * Ask the main process to re-check immediately.
   *
   * A user who has just walked back into coverage should not have to wait out the
   * next scheduled probe, or guess whether the app has noticed. Before this there
   * was no way to prompt it at all — the only recovery was restarting the app.
   */
  async function retryNow() {
    const btn = document.getElementById('offlineRetryBtn');
    const original = btn ? btn.textContent : null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Checking…';
    }

    try {
      const res = await window.electronAPI.invoke('renderer-connectivity-hint');
      const back = res && res.online === true;
      setOnline(back);
      if (!back && window.electronAPI?.showToast) {
        window.electronAPI.showToast('Still offline — could not reach AWS.', 'warning');
      }
    } catch (err) {
      console.error('Connectivity retry failed:', err);
    } finally {
      // Restore even on success: the banner is hidden rather than destroyed, so
      // the button has to be usable again next time.
      if (btn) {
        btn.disabled = false;
        btn.textContent = original;
      }
    }
  }

  const CREDENTIALS_REJECTED_MESSAGE =
    'AWS rejected your credentials. Update them in Settings → Credentials. Your ' +
    'conversations, work history, skills and showflows are stored locally and remain available.';

  function renderBanner() {
    const banner = ensureBanner();
    banner.style.display = online ? 'none' : 'flex';

    // When AWS has actually rejected the credentials, saying "offline" sends the
    // user looking at their network instead of the thing they can fix. Prefer the
    // actionable message, and drop the retry button — retrying won't help.
    const rejected = credentialState === 'rejected';
    const textEl = banner.querySelector('#offlineBannerText');
    if (textEl) textEl.textContent = rejected ? CREDENTIALS_REJECTED_MESSAGE : OFFLINE_MESSAGE;
    const icon = banner.querySelector('.bi');
    if (icon) icon.className = rejected ? 'bi bi-key me-2' : 'bi bi-wifi-off me-2';
    const retry = banner.querySelector('#offlineRetryBtn');
    if (retry) retry.classList.toggle('d-none', rejected);
  }

  // ── Control gating ───────────────────────────────────────────────────────

  /**
   * Can Hive actually reach AWS successfully right now?
   *
   * Rejected credentials are just as disqualifying as no network: the request
   * will fail either way. Gating on connectivity alone meant that with valid
   * network and dead credentials every AWS control stayed clickable, so a
   * long-typed prompt or a queued pipeline could be lost to a request that was
   * never going to succeed.
   */
  function awsAvailable() {
    return online && credentialState !== 'rejected';
  }

  function applyToControls() {
    const blockedByCredentials = online && credentialState === 'rejected';

    NETWORK_CONTROLS.forEach(({ id, reason, fixesCredentials }) => {
      const el = document.getElementById(id);
      if (!el) return; // not every control exists on every page

      // The way out of a credentials problem must stay open.
      const block = blockedByCredentials ? !fixesCredentials : !online;
      const why = blockedByCredentials ? CREDENTIALS_REJECTED_REASON : reason;

      if (block) {
        // Don't touch (or later restore) something already disabled elsewhere.
        if (el.disabled || el.classList.contains('offline-disabled')) return;
        el.disabled = true;
        el.classList.add('offline-disabled');
        if (el.title) el.dataset.offlinePrevTitle = el.title;
        el.title = why;
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
    if (uploadZone) uploadZone.classList.toggle('offline-blocked', !awsAvailable());
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
    credentialState: () => credentialState,

    /** Record a credential verdict learned elsewhere (e.g. a failed send). */
    setCredentialState(next) {
      credentialState = next || 'unknown';
      renderBanner();
      // Previously this only repainted the banner, so rejected credentials
      // changed the wording while leaving every AWS control clickable.
      applyToControls();
    },

    /** True when a request to AWS could actually succeed right now. */
    awsAvailable,

    retryNow,

    /** Subscribe to connectivity transitions. Returns an unsubscribe function. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * Guard an action that needs the network. Returns true when it's safe to
     * proceed; otherwise shows a toast explaining why and returns false.
     */
    requireAws(action = 'This action') {
      if (awsAvailable()) return true;
      const message = online
        ? `${action} needs working AWS credentials — update them in Settings > Credentials.`
        : `${action} needs an internet connection — Hive is offline.`;
      if (window.electronAPI?.showToast) window.electronAPI.showToast(message, 'warning');
      return false;
    },

    /**
     * Older name, kept so existing call sites keep working. Now refuses for
     * rejected credentials too, which is the point.
     */
    requireOnline(action = 'This action') {
      return OfflineGuard.requireAws(action);
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
        credentialState = status?.credentialState || 'unknown';
        setOnline(status?.online !== false);
      } catch {
        setOnline(true); // never trap the user behind a failed status check
      }

      window.electronAPI.receive('connectivity-changed', (payload) => {
        if (payload && payload.credentialState) credentialState = payload.credentialState;
        // setOnline() only notifies listeners when `online` itself changed, but
        // the credential verdict can change on its own — so re-gate explicitly.
        setOnline(payload?.online !== false);
        applyToControls();
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
