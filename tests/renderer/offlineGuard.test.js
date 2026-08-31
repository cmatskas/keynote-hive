/**
 * @jest-environment jsdom
 */

/**
 * Tests for OfflineGuard — the renderer's offline banner and control gating.
 *
 * The design intent being verified: local features keep working. Hive's
 * conversations, work history, skills and showflows are all files under the
 * app's userData directory and need no network, so only genuinely
 * network-dependent controls may be disabled. Getting that wrong in either
 * direction is a bug — leaving a Send button live offline produces a confusing
 * failure, and disabling the conversation list makes the app needlessly
 * unusable, which is the problem this work exists to fix.
 */

const mockElectronAPI = {
  invoke: jest.fn(),
  receive: jest.fn(),
  showToast: jest.fn(),
};

Object.defineProperty(window, 'electronAPI', { value: mockElectronAPI, writable: true });

/** Returns the handler registered for a receive channel. */
function receiveHandler(channel) {
  const call = mockElectronAPI.receive.mock.calls.find(([ch]) => ch === channel);
  return call && call[1];
}

/** Drives a connectivity transition the way the main process would. */
function goOffline() {
  receiveHandler('connectivity-changed')({ online: false });
}
function goOnline() {
  receiveHandler('connectivity-changed')({ online: true });
}

const NETWORK_BUTTONS = [
  'workSendBtn', 'invokeBedrockBtn', 'swarmStartBtn', 'swarmContinueBtn',
  'swarmInputAnswerBtn', 'swarmInputDefaultBtn', 'fileInput', 'saveCredBtn',
  'runSetupCheckBtn', 'setupCheckRefreshBtn', 'webSearchRetryBtn',
  'memoryConnectBtn', 'memoryDeleteBtn', 'memoryRefreshBtn',
  'adminRefreshStatusBtn', 'adminOpenWizardBtn', 'adminWizardApplyBtn',
  'sbAnalyzeBtn', 'sbReanalyzeBtn',
];

const LOCAL_CONTROLS = [
  'newConversationBtn', 'workNewChatBtn', 'createSkillBtn', 'saveConfigBtn',
  'sf-save-btn', 'sf-open-btn', 'downloadTranscript', 'copyTranscript',
  'themeToggle', 'workAttachFileBtn',
];

async function loadGuard({ online = true, statusThrows = false, credentialState = 'unknown' } = {}) {
  document.body.innerHTML = `
    <div id="credentialWarningBanner" style="display:none;"></div>
    ${NETWORK_BUTTONS.map(id => `<button id="${id}"></button>`).join('\n')}
    ${LOCAL_CONTROLS.map(id => `<button id="${id}"></button>`).join('\n')}
    <div id="uploadZone"></div>
  `;

  mockElectronAPI.invoke.mockImplementation((channel) => {
    if (channel === 'get-connectivity-status') {
      return statusThrows ? Promise.reject(new Error('boom')) : Promise.resolve({ online, credentialState });
    }
    if (channel === 'renderer-connectivity-hint') return Promise.resolve({ online });
    return Promise.resolve(undefined);
  });

  jest.resetModules();
  require('../../src/renderer/offlineGuard.js');
  await window.OfflineGuard.init();
  return window.OfflineGuard;
}

describe('OfflineGuard banner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('no banner while online', async () => {
    await loadGuard({ online: true });
    expect(document.getElementById('offlineBanner').style.display).toBe('none');
  });

  test('shows a banner when offline, explaining local work is safe', async () => {
    await loadGuard({ online: true });
    goOffline();

    const banner = document.getElementById('offlineBanner');
    expect(banner.style.display).toBe('flex');
    expect(banner.textContent).toMatch(/offline/i);
    expect(banner.textContent).toMatch(/locally/i);
  });

  test('the banner is announced to screen readers', async () => {
    await loadGuard({ online: false });
    const banner = document.getElementById('offlineBanner');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('aria-live')).toBe('polite');
  });

  test('the banner has no dismiss control — the condition would just be hidden', async () => {
    await loadGuard({ online: false });
    const banner = document.getElementById('offlineBanner');
    expect(banner.querySelector('.btn-close')).toBeNull();
  });

  test('clears the banner on reconnect', async () => {
    await loadGuard({ online: false });
    expect(document.getElementById('offlineBanner').style.display).toBe('flex');

    goOnline();

    expect(document.getElementById('offlineBanner').style.display).toBe('none');
  });

  test('sits above the credential banner so the two stack predictably', async () => {
    await loadGuard({ online: false });
    const banner = document.getElementById('offlineBanner');
    expect(banner.nextElementSibling.id).toBe('credentialWarningBanner');
  });

  test('assumes online if the status check fails, rather than trapping the user', async () => {
    await loadGuard({ statusThrows: true });
    expect(window.OfflineGuard.isOnline()).toBe(true);
    expect(document.getElementById('offlineBanner').style.display).toBe('none');
  });
});

/**
 * The field report that prompted this: after walking between buildings the app
 * stayed offline, and there was no way to prompt it to look again — restarting was
 * the only recovery.
 */
describe('OfflineGuard retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('offers a retry while offline', async () => {
    await loadGuard({ online: false });
    const btn = document.getElementById('offlineRetryBtn');
    expect(btn).not.toBeNull();
    expect(btn.classList.contains('d-none')).toBe(false);
  });

  test('asks the main process to re-probe rather than guessing locally', async () => {
    await loadGuard({ online: false });
    mockElectronAPI.invoke.mockClear();
    mockElectronAPI.invoke.mockResolvedValue({ online: true });

    document.getElementById('offlineRetryBtn').click();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockElectronAPI.invoke).toHaveBeenCalledWith('renderer-connectivity-hint');
  });

  test('clears the banner when the network is back', async () => {
    await loadGuard({ online: false });
    expect(document.getElementById('offlineBanner').style.display).toBe('flex');
    mockElectronAPI.invoke.mockResolvedValue({ online: true });

    document.getElementById('offlineRetryBtn').click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('offlineBanner').style.display).toBe('none');
    expect(window.OfflineGuard.isOnline()).toBe(true);
  });

  test('says so when still offline, rather than appearing to do nothing', async () => {
    await loadGuard({ online: false });
    mockElectronAPI.invoke.mockResolvedValue({ online: false });

    document.getElementById('offlineRetryBtn').click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockElectronAPI.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/Still offline/i), 'warning'
    );
    expect(document.getElementById('offlineBanner').style.display).toBe('flex');
  });

  test('re-enables the button afterwards, including on failure', async () => {
    await loadGuard({ online: false });
    mockElectronAPI.invoke.mockRejectedValue(new Error('ipc gone'));
    const btn = document.getElementById('offlineRetryBtn');

    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toMatch(/Retry now/);
  });
});

/**
 * "Offline" and "AWS rejected your credentials" are different problems and only
 * one of them is actionable. Reporting the first when the second is true is what
 * sent the user hunting through their network settings.
 */
describe('OfflineGuard credential state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('names the credentials when AWS has rejected them', async () => {
    await loadGuard({ online: false, credentialState: 'rejected' });

    const banner = document.getElementById('offlineBanner');
    expect(banner.textContent).toMatch(/rejected your credentials/i);
    expect(banner.textContent).toMatch(/Settings/);
    expect(banner.textContent).not.toMatch(/Hive is offline/);
  });

  test('hides the retry button when retrying cannot help', async () => {
    await loadGuard({ online: false, credentialState: 'rejected' });
    expect(document.getElementById('offlineRetryBtn').classList.contains('d-none')).toBe(true);
  });

  test('still reassures that local work is available', async () => {
    await loadGuard({ online: false, credentialState: 'rejected' });
    expect(document.getElementById('offlineBanner').textContent).toMatch(/locally/);
  });

  test('blames the network when the credentials are fine', async () => {
    await loadGuard({ online: false, credentialState: 'valid' });

    const banner = document.getElementById('offlineBanner');
    expect(banner.textContent).toMatch(/Hive is offline/);
    expect(document.getElementById('offlineRetryBtn').classList.contains('d-none')).toBe(false);
  });

  test('picks up a credential verdict from a connectivity event', async () => {
    await loadGuard({ online: true, credentialState: 'valid' });

    receiveHandler('connectivity-changed')({ online: false, credentialState: 'rejected' });

    expect(document.getElementById('offlineBanner').textContent).toMatch(/rejected your credentials/i);
  });

  test('a verdict learned elsewhere updates the banner', async () => {
    await loadGuard({ online: false, credentialState: 'valid' });

    window.OfflineGuard.setCredentialState('rejected');

    expect(document.getElementById('offlineBanner').textContent).toMatch(/rejected your credentials/i);
    expect(window.OfflineGuard.credentialState()).toBe('rejected');
  });
});

describe('OfflineGuard control gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each(NETWORK_BUTTONS)('disables %s when offline', async (id) => {
    await loadGuard({ online: true });
    goOffline();

    const el = document.getElementById(id);
    expect(el.disabled).toBe(true);
    expect(el.classList.contains('offline-disabled')).toBe(true);
    expect(el.title).toMatch(/internet connection|only be tested online/i);
  });

  test.each(LOCAL_CONTROLS)('leaves %s enabled when offline — it needs no network', async (id) => {
    await loadGuard({ online: true });
    goOffline();

    expect(document.getElementById(id).disabled).toBe(false);
  });

  test('blocks the upload zone with a class, since a div ignores `disabled`', async () => {
    await loadGuard({ online: true });
    goOffline();

    expect(document.getElementById('uploadZone').classList.contains('offline-blocked')).toBe(true);

    goOnline();
    expect(document.getElementById('uploadZone').classList.contains('offline-blocked')).toBe(false);
  });

  test('re-enables on reconnect and restores the original tooltip', async () => {
    await loadGuard({ online: true });
    const btn = document.getElementById('workSendBtn');
    btn.title = 'Send (Enter)';

    goOffline();
    expect(btn.title).not.toBe('Send (Enter)');

    goOnline();
    expect(btn.disabled).toBe(false);
    expect(btn.title).toBe('Send (Enter)');
    expect(btn.classList.contains('offline-disabled')).toBe(false);
  });

  test('does not re-enable a control that was already disabled for its own reasons', async () => {
    // A Send button disabled mid-request must stay disabled when connectivity
    // returns — the guard only restores what it disabled itself.
    await loadGuard({ online: true });
    const btn = document.getElementById('workSendBtn');
    btn.disabled = true; // e.g. a request is in flight

    goOffline();
    goOnline();

    expect(btn.disabled).toBe(true);
  });

  test('refresh() gates controls that were rendered after init', async () => {
    await loadGuard({ online: true });
    goOffline();

    const late = document.createElement('button');
    late.id = 'memoryConnectBtn2';
    document.body.appendChild(late);

    // Not in the inventory, so it stays enabled...
    window.OfflineGuard.refresh();
    expect(late.disabled).toBe(false);

    // ...but a known control added late is picked up.
    document.getElementById('workSendBtn').remove();
    const lateSend = document.createElement('button');
    lateSend.id = 'workSendBtn';
    document.body.appendChild(lateSend);
    window.OfflineGuard.refresh();
    expect(lateSend.disabled).toBe(true);
  });

  test('tolerates a page where most controls are absent', async () => {
    document.body.innerHTML = '<button id="workSendBtn"></button>';
    mockElectronAPI.invoke.mockResolvedValue({ online: true });
    jest.resetModules();
    require('../../src/renderer/offlineGuard.js');
    await window.OfflineGuard.init();

    expect(() => goOffline()).not.toThrow();
    expect(document.getElementById('workSendBtn').disabled).toBe(true);
  });
});

describe('OfflineGuard.requireOnline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('allows the action and stays silent while online', async () => {
    await loadGuard({ online: true });
    expect(window.OfflineGuard.requireOnline('Sending a message')).toBe(true);
    expect(mockElectronAPI.showToast).not.toHaveBeenCalled();
  });

  test('refuses with an offline message that never mentions credentials', async () => {
    await loadGuard({ online: false });

    expect(window.OfflineGuard.requireOnline('Sending a message')).toBe(false);
    expect(mockElectronAPI.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/offline/i),
      'warning'
    );
    expect(mockElectronAPI.showToast).not.toHaveBeenCalledWith(
      expect.stringMatching(/credential/i),
      expect.anything()
    );
  });
});

describe('OfflineGuard.onChange', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('notifies subscribers on a transition and stops after unsubscribe', async () => {
    await loadGuard({ online: true });
    const seen = [];
    const unsubscribe = window.OfflineGuard.onChange(v => seen.push(v));

    goOffline();
    goOnline();
    expect(seen).toEqual([false, true]);

    unsubscribe();
    goOffline();
    expect(seen).toEqual([false, true]);
  });

  test('does not fire when the state has not actually changed', async () => {
    await loadGuard({ online: true });
    const seen = [];
    window.OfflineGuard.onChange(v => seen.push(v));

    goOnline(); // already online
    expect(seen).toEqual([]);
  });

  test('a throwing subscriber does not stop the others', async () => {
    await loadGuard({ online: true });
    const seen = [];
    window.OfflineGuard.onChange(() => { throw new Error('subscriber exploded'); });
    window.OfflineGuard.onChange(v => seen.push(v));

    goOffline();

    expect(seen).toEqual([false]);
  });
});

describe('OfflineGuard OS event forwarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('forwards browser online/offline events as a hint for the main process to verify', async () => {
    // navigator.onLine only reports interface state and is true on a captive
    // portal, so the renderer asks the main process to re-probe rather than
    // asserting the answer itself.
    await loadGuard({ online: true });
    mockElectronAPI.invoke.mockClear();

    window.dispatchEvent(new Event('offline'));
    await Promise.resolve();
    await Promise.resolve();

    expect(mockElectronAPI.invoke).toHaveBeenCalledWith('renderer-connectivity-hint');
  });
});


/**
 * Rejected credentials must disable the same AWS controls that being offline
 * does — the request fails either way, and leaving them clickable meant a
 * long-typed prompt or a queued pipeline could be lost to a call that was never
 * going to succeed.
 *
 * The exception matters as much as the rule: the controls that are how you FIX
 * credentials have to stay usable, or the banner tells the user to do something
 * the UI has just prevented.
 */
describe('OfflineGuard gating on rejected credentials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** Deliver a credential verdict the way the main process would. */
  const reject = () => receiveHandler('connectivity-changed')({ online: true, credentialState: 'rejected' });
  const accept = () => receiveHandler('connectivity-changed')({ online: true, credentialState: 'valid' });

  const FIX_CREDENTIALS = ['saveCredBtn', 'runSetupCheckBtn', 'setupCheckRefreshBtn'];
  const BLOCKED = NETWORK_BUTTONS.filter(id => !FIX_CREDENTIALS.includes(id));

  test('disables AWS controls while online but rejected', async () => {
    await loadGuard();
    expect(document.getElementById('workSendBtn').disabled).toBe(false);

    reject();

    BLOCKED.forEach(id => {
      expect(document.getElementById(id).disabled).toBe(true);
    });
  });

  test('keeps the controls that fix credentials usable', async () => {
    // Disabling these would trap the user: the banner says "update them in
    // Settings" and the button to do it would be greyed out.
    await loadGuard();

    reject();

    FIX_CREDENTIALS.forEach(id => {
      expect(document.getElementById(id).disabled).toBe(false);
    });
  });

  test('still disables those same controls when genuinely offline', async () => {
    // They cannot work without a network either, so the carve-out is specific to
    // the credentials case.
    await loadGuard();

    goOffline();

    FIX_CREDENTIALS.forEach(id => {
      expect(document.getElementById(id).disabled).toBe(true);
    });
  });

  test('explains credentials rather than blaming the network', async () => {
    await loadGuard();

    reject();

    const title = document.getElementById('workSendBtn').title;
    expect(title).toMatch(/credentials/i);
    expect(title).not.toMatch(/internet connection/i);
  });

  test('re-enables everything once the credentials work again', async () => {
    await loadGuard();
    reject();
    expect(document.getElementById('workSendBtn').disabled).toBe(true);

    accept();

    NETWORK_BUTTONS.forEach(id => {
      expect(document.getElementById(id).disabled).toBe(false);
    });
  });

  test('leaves purely local controls alone', async () => {
    await loadGuard();

    reject();

    LOCAL_CONTROLS.forEach(id => {
      expect(document.getElementById(id).disabled).toBe(false);
    });
  });

  test('blocks the upload zone, which is a div and ignores disabled', async () => {
    await loadGuard();

    reject();

    expect(document.getElementById('uploadZone').classList.contains('offline-blocked')).toBe(true);
  });

  test('setCredentialState gates controls, not just the banner', async () => {
    // This previously only repainted the banner, so the wording changed while
    // every control stayed live.
    const guard = await loadGuard();

    guard.setCredentialState('rejected');

    expect(document.getElementById('workSendBtn').disabled).toBe(true);
  });

  test('awsAvailable() reflects both causes', async () => {
    const guard = await loadGuard();
    expect(guard.awsAvailable()).toBe(true);

    reject();
    expect(guard.awsAvailable()).toBe(false);
    expect(guard.isOnline()).toBe(true);   // connectivity itself is fine

    accept();
    expect(guard.awsAvailable()).toBe(true);

    goOffline();
    expect(guard.awsAvailable()).toBe(false);
  });

  test('does not re-enable a control that was disabled for its own reasons', async () => {
    // e.g. a Send button disabled mid-request must stay disabled.
    await loadGuard();
    const btn = document.getElementById('workSendBtn');
    btn.disabled = true;

    reject();
    accept();

    expect(btn.disabled).toBe(true);
  });
});

describe('OfflineGuard.requireAws', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('allows the action when AWS is reachable', async () => {
    const guard = await loadGuard();
    expect(guard.requireAws('Sending a message')).toBe(true);
  });

  test('refuses and names credentials when they are rejected', async () => {
    const guard = await loadGuard();
    receiveHandler('connectivity-changed')({ online: true, credentialState: 'rejected' });

    expect(guard.requireAws('Sending a message')).toBe(false);
    expect(mockElectronAPI.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/credentials/i),
      'warning',
    );
  });

  test('refuses and names the network when offline', async () => {
    const guard = await loadGuard();
    goOffline();

    expect(guard.requireAws('Sending a message')).toBe(false);
    expect(mockElectronAPI.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/internet connection/i),
      'warning',
    );
  });

  test('requireOnline still works and now covers rejected credentials too', async () => {
    // Kept as an alias so existing call sites did not all have to change.
    const guard = await loadGuard();
    receiveHandler('connectivity-changed')({ online: true, credentialState: 'rejected' });

    expect(guard.requireOnline('Sending a message')).toBe(false);
  });
});
