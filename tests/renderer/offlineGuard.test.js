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
];

const LOCAL_CONTROLS = [
  'newConversationBtn', 'workNewChatBtn', 'createSkillBtn', 'saveConfigBtn',
  'sf-save-btn', 'sf-open-btn', 'downloadTranscript', 'copyTranscript',
  'themeToggle', 'workAttachFileBtn',
];

async function loadGuard({ online = true, statusThrows = false } = {}) {
  document.body.innerHTML = `
    <div id="credentialWarningBanner" style="display:none;"></div>
    ${NETWORK_BUTTONS.map(id => `<button id="${id}"></button>`).join('\n')}
    ${LOCAL_CONTROLS.map(id => `<button id="${id}"></button>`).join('\n')}
    <div id="uploadZone"></div>
  `;

  mockElectronAPI.invoke.mockImplementation((channel) => {
    if (channel === 'get-connectivity-status') {
      return statusThrows ? Promise.reject(new Error('boom')) : Promise.resolve({ online });
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
