/**
 * @jest-environment jsdom
 */

/**
 * Tests for the Settings tab's Configuration save path.
 *
 * Both S3 bucket settings default to empty and neither can have a default,
 * because S3 bucket names are unique across all of AWS. The only validation
 * that ever enforced them lived in a standalone settings page that nothing
 * loaded any more, so the live Settings tab happily saved blanks — and a blank
 * output bucket then surfaced as an opaque AWS validation error at transcription
 * time. These tests pin the replacement: refuse the save, and pre-fill an
 * account-scoped suggestion so the user has something to accept or overwrite.
 */

const mockElectronAPI = {
  invoke: jest.fn(),
  showToast: jest.fn(),
  receive: jest.fn(),
};
Object.defineProperty(window, 'electronAPI', { value: mockElectronAPI, writable: true });

global.bootstrap = {
  Modal: jest.fn().mockImplementation(() => ({ show: jest.fn(), hide: jest.fn() })),
};
global.bootstrap.Modal.getInstance = jest.fn(() => ({ show: jest.fn(), hide: jest.fn() }));

// Every element id settingsTab.js touches. Stubbed wholesale rather than
// hand-picked: init() calls into skills/models/admin wiring that reaches well
// beyond its own body, and an incomplete fixture fails on an unrelated
// addEventListener rather than on the behaviour under test.
const ALL_IDS = [
  'accessKeyId', 'addModelBtn', 'adminGatewayTargetStatus', 'adminKbStatus',
  'adminOpenWizardBtn', 'adminPolicyWizardModal', 'adminRefreshStatusBtn',
  'adminRoleArnInput', 'adminTabNavItem', 'adminWizardApplyBtn', 'adminWizardBackBtn',
  'adminWizardNextBtn', 'adminWizardPolicyDiff', 'adminWizardReviewSummary',
  'adminWizardStep1', 'adminWizardStep2', 'adminWizardStep3', 'analyticsContent',
  'appVersionText', 'bucketName', 'connStatusBody', 'connStatusCard',
  'copyGrantScriptBtn', 'createSkillBtn', 'credRegion', 'credentialsForm',
  'defaultTheme', 'grantScriptCommand', 'mantleApiKey', 'memoryConnectBtn',
  'memoryDeleteBtn', 'memoryRefreshBtn', 'memorySelect', 'memoryStatusText',
  'modelsTableBody', 'newModelId', 'newModelName', 'newModelRole',
  'newSkillCancelBtn', 'newSkillCloseBtn', 'newSkillContent', 'newSkillName',
  'newSkillPanel', 'newSkillSaveBtn', 'openSkillsFolderBtn', 'outputBucketName',
  'pasteCredBtn', 'runSetupCheckBtn', 'sagemakerImageComponent',
  'sagemakerImageEndpoint', 'saveConfigBtn', 'saveCredBtn', 'secretAccessKey',
  'sessionToken', 'settings-admin', 'setupCheckInstructionsModal', 'setupCheckList',
  'setupCheckModal', 'setupCheckRefreshBtn', 'skillEditorCancelBtn',
  'skillEditorCloseBtn', 'skillEditorContent', 'skillEditorPanel',
  'skillEditorSaveBtn', 'skillEditorTitle', 'skillsList', 'transcriptionLanguage',
  'webSearchGatewayRoleArn', 'webSearchRetryBtn', 'webSearchStatusBadge',
  'webSearchStatusDetail',
];

// These need a value/options contract rather than a bare element.
const SELECTS = {
  transcriptionLanguage: ['en-US'],
  defaultTheme: ['auto'],
  newModelRole: ['creator'],
  memorySelect: [],
};

function buildDom() {
  const parts = ALL_IDS.map(id => {
    if (id in SELECTS) {
      const opts = SELECTS[id].map(v => `<option value="${v}" selected>${v}</option>`).join('');
      return `<select id="${id}">${opts}</select>`;
    }
    if (id === 'credentialsForm') return `<form id="${id}"></form>`;
    return `<input id="${id}" />`;
  });

  // Sub-tab scaffolding. Configuration settings are loaded when that sub-tab is
  // opened rather than by init(), so tests that care about the form's contents
  // have to go through the same click the user does.
  parts.push(
    '<a href="#" data-settings-tab="configuration" id="tab-configuration"></a>',
    '<div class="settings-tab-content" id="settings-configuration"></div>'
  );

  document.body.innerHTML = parts.join('\n');
}

/** Opens Settings → Configuration, which is what triggers loadConfig(). */
function openConfigurationTab() {
  document.getElementById('tab-configuration').click();
}

/**
 * Loads settingsTab.js and runs init(), so the Save button is wired exactly as
 * it is in the app rather than reaching into a private function.
 */
function loadSettingsTab({ settings = {}, suggestions = null } = {}) {
  mockElectronAPI.invoke.mockImplementation((channel) => {
    switch (channel) {
      case 'load-settings':
        return Promise.resolve({ bucketName: '', outputBucketName: '', ...settings });
      case 'get-suggested-bucket-names':
        return Promise.resolve(suggestions);
      case 'load-credentials':
        return Promise.resolve(null);
      case 'get-web-search-status':
        return Promise.resolve({ ready: true, error: null });
      case 'memory-list':
        return Promise.resolve([]);
      case 'save-settings':
        return Promise.resolve(true);
      default:
        return Promise.resolve(undefined);
    }
  });

  jest.resetModules();
  require('../../src/renderer/settingsTab.js');
  window.SettingsTab.init();
}

/** Lets the async handlers settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** Was save-settings called? */
const saveCalls = () =>
  mockElectronAPI.invoke.mock.calls.filter(([channel]) => channel === 'save-settings');

describe('Settings tab bucket validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildDom();
  });

  test('refuses to save when the output bucket is blank', async () => {
    loadSettingsTab();
    openConfigurationTab();
    await flush();
    document.getElementById('bucketName').value = 'my-input';
    document.getElementById('outputBucketName').value = '';

    document.getElementById('saveConfigBtn').click();
    await flush();

    expect(saveCalls()).toHaveLength(0);
    expect(mockElectronAPI.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/Output S3 Bucket is required/), 'error'
    );
  });

  test('refuses to save when the input bucket is blank', async () => {
    loadSettingsTab();
    openConfigurationTab();
    await flush();
    document.getElementById('bucketName').value = '';
    document.getElementById('outputBucketName').value = 'my-output';

    document.getElementById('saveConfigBtn').click();
    await flush();

    expect(saveCalls()).toHaveLength(0);
    expect(mockElectronAPI.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/Input S3 Bucket is required/), 'error'
    );
  });

  test('names both buckets when neither is set, and mentions Setup Check', async () => {
    loadSettingsTab();
    openConfigurationTab();
    await flush();
    document.getElementById('bucketName').value = '';
    document.getElementById('outputBucketName').value = '';

    document.getElementById('saveConfigBtn').click();
    await flush();

    expect(saveCalls()).toHaveLength(0);
    const [message] = mockElectronAPI.showToast.mock.calls.find(([, type]) => type === 'error');
    expect(message).toMatch(/Input S3 Bucket and Output S3 Bucket are required/);
    expect(message).toMatch(/Setup Check/);
  });

  test('saves once both buckets are set', async () => {
    loadSettingsTab();
    openConfigurationTab();
    await flush();
    document.getElementById('bucketName').value = 'my-input';
    document.getElementById('outputBucketName').value = 'my-output';

    document.getElementById('saveConfigBtn').click();
    await flush();

    expect(saveCalls()).toHaveLength(1);
    expect(saveCalls()[0][1]).toMatchObject({
      bucketName: 'my-input',
      outputBucketName: 'my-output',
    });
  });

  test('re-enables the Save button after a refused save', async () => {
    // Otherwise the user is locked out of retrying after fixing the field.
    loadSettingsTab();
    openConfigurationTab();
    await flush();

    document.getElementById('saveConfigBtn').click();
    await flush();

    expect(document.getElementById('saveConfigBtn').disabled).toBe(false);
  });
});

describe('Settings tab bucket suggestions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildDom();
  });

  test('pre-fills both blank bucket fields with editable suggestions', async () => {
    loadSettingsTab({
      suggestions: { input: 'hive-media-111122223333', output: 'hive-transcripts-111122223333' },
    });
    openConfigurationTab();
    await flush();
    await flush();

    // Real field values, not placeholders — so saving keeps them.
    expect(document.getElementById('bucketName').value).toBe('hive-media-111122223333');
    expect(document.getElementById('outputBucketName').value).toBe('hive-transcripts-111122223333');
  });

  test('never overwrites a name the user already configured', async () => {
    loadSettingsTab({
      settings: { bucketName: 'my-own-bucket', outputBucketName: 'my-own-output' },
      suggestions: { input: 'hive-media-111122223333', output: 'hive-transcripts-111122223333' },
    });
    openConfigurationTab();
    await flush();
    await flush();

    expect(document.getElementById('bucketName').value).toBe('my-own-bucket');
    expect(document.getElementById('outputBucketName').value).toBe('my-own-output');
  });

  test('fills only the blank field when one is already set', async () => {
    loadSettingsTab({
      settings: { bucketName: 'my-own-bucket', outputBucketName: '' },
      suggestions: { input: 'hive-media-111122223333', output: 'hive-transcripts-111122223333' },
    });
    openConfigurationTab();
    await flush();
    await flush();

    expect(document.getElementById('bucketName').value).toBe('my-own-bucket');
    expect(document.getElementById('outputBucketName').value).toBe('hive-transcripts-111122223333');
  });

  test('leaves fields blank when no suggestion is available', async () => {
    loadSettingsTab({ suggestions: null });
    openConfigurationTab();
    await flush();
    await flush();

    expect(document.getElementById('bucketName').value).toBe('');
    expect(document.getElementById('outputBucketName').value).toBe('');
  });

  test('does not ask for suggestions while offline', async () => {
    window.OfflineGuard = { isOnline: () => false };
    loadSettingsTab({ suggestions: { input: 'a', output: 'b' } });
    openConfigurationTab();
    await flush();
    await flush();

    const asked = mockElectronAPI.invoke.mock.calls
      .some(([channel]) => channel === 'get-suggested-bucket-names');
    expect(asked).toBe(false);
    delete window.OfflineGuard;
  });

  test('a failed suggestion lookup does not break the Settings load', async () => {
    mockElectronAPI.invoke.mockImplementation((channel) => {
      if (channel === 'get-suggested-bucket-names') return Promise.reject(new Error('boom'));
      if (channel === 'load-settings') return Promise.resolve({ bucketName: '', outputBucketName: '' });
      return Promise.resolve(undefined);
    });
    jest.resetModules();
    require('../../src/renderer/settingsTab.js');

    expect(() => window.SettingsTab.init()).not.toThrow();
    expect(() => openConfigurationTab()).not.toThrow();
    await flush();
    await flush();

    expect(document.getElementById('outputBucketName').value).toBe('');
  });
});


/**
 * Regression: Setup Check showed a green "Ready" tick for the Web Search Gateway
 * as soon as the IAM role was created, regardless of whether web search actually
 * came up. On a brand-new install it did not — the role ARN was persisted in a way
 * that skipped the re-initialisation trigger — and the agent then silently fell
 * back to scraping via execute_code, which looks exactly like web search working.
 *
 * The handler now reports webSearchReady, and the row must reflect it.
 */
describe('Setup Check: web search gateway row', () => {
  const setupStatus = {
    webSearchGateway: { status: 'missing', detail: 'No Gateway or execution role found' },
  };

  /**
   * Render the Setup Check list, then click the row's Create button.
   *
   * loadSettingsTab() installs its own invoke mock, so the Setup Check channels
   * have to be layered on afterwards or they get overwritten.
   */
  async function renderRowsAndCreate(status, createResult) {
    loadSettingsTab();
    await flush();

    mockElectronAPI.invoke.mockImplementation((channel) => {
      switch (channel) {
        case 'load-settings': return Promise.resolve({ bucketName: 'b', outputBucketName: 'o' });
        case 'load-credentials': return Promise.resolve(null);
        case 'get-web-search-status': return Promise.resolve({ ready: false, error: null });
        case 'memory-list': return Promise.resolve([]);
        case 'setup-wizard-check-status': return Promise.resolve(status);
        case 'setup-wizard-create-item': return Promise.resolve(createResult);
        default: return Promise.resolve(undefined);
      }
    });

    document.getElementById('setupCheckRefreshBtn').click();
    await flush();

    const row = document.getElementById('setupCheckList').firstElementChild;
    row.querySelector('button').click();
    await flush();
    return { row };
  }

  const clickCreate = (createResult) => renderRowsAndCreate(setupStatus, createResult);

  beforeEach(() => {
    jest.clearAllMocks();
    buildDom();
    // jsdom does not implement confirm(); _createSetupItem gates on it.
    window.confirm = jest.fn(() => true);
  });

  test('shows Ready when web search actually came up', async () => {
    const { row } = await clickCreate({
      success: true,
      detail: 'Created role and activated web search: arn:aws:iam::1:role/r',
      arn: 'arn:aws:iam::1:role/r',
      webSearchReady: true,
      webSearchError: null,
    });

    const badge = row.querySelector('.badge');
    expect(badge.textContent).toBe('Ready');
    expect(badge.className).toContain('bg-success');
    expect(row.querySelector('button')).toBeNull();   // nothing left to do
  });

  test('does not claim Ready when web search did not start', async () => {
    const { row } = await clickCreate({
      success: true,
      detail: 'Created role: arn:aws:iam::1:role/r',
      arn: 'arn:aws:iam::1:role/r',
      webSearchReady: false,
      webSearchError: 'gateway CREATE_FAILED',
    });

    const badge = row.querySelector('.badge');
    expect(badge.textContent).toBe('Needs attention');
    expect(badge.className).toContain('bg-warning');
    expect(badge.className).not.toContain('bg-success');
  });

  test('names the reason web search did not start', async () => {
    const { row } = await clickCreate({
      success: true, detail: 'Created role: arn', arn: 'arn',
      webSearchReady: false, webSearchError: 'gateway CREATE_FAILED',
    });

    expect(row.querySelector('small').textContent).toContain('gateway CREATE_FAILED');
  });

  test('leaves a retry button when web search did not start', async () => {
    const { row } = await clickCreate({
      success: true, detail: 'Created role: arn', arn: 'arn',
      webSearchReady: false, webSearchError: 'boom',
    });

    const btn = row.querySelector('button');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('Retry');
    expect(btn.disabled).toBe(false);
  });

  test('still fills the role ARN field in Configuration', async () => {
    await clickCreate({
      success: true, detail: 'Created role: arn:aws:iam::1:role/r', arn: 'arn:aws:iam::1:role/r',
      webSearchReady: true, webSearchError: null,
    });

    expect(document.getElementById('webSearchGatewayRoleArn').value).toBe('arn:aws:iam::1:role/r');
  });

  test('other items are unaffected by the web-search-specific handling', async () => {
    // A bucket result carries no webSearchReady at all; it must still go green.
    const { row } = await renderRowsAndCreate(
      { transcriptionBucket: { status: 'missing', detail: 'absent' } },
      { success: true, detail: 'Created bucket: b', bucketName: 'b' },
    );

    expect(row.querySelector('.badge').textContent).toBe('Ready');
    expect(row.querySelector('.badge').className).toContain('bg-success');
  });
});
