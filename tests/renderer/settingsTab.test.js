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
  'modelCustomForm', 'modelCustomToggle', 'modelPicker', 'modelPickerList',
  'modelPickerNote', 'modelPickerRefresh', 'modelPickerShowAll', 'modelsResetBtn',
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
    if (id === 'modelsTableBody') return `<table><tbody id="${id}"></tbody></table>`;
    // Picker containers and links need real element types: rows render into a
    // div, and the links/buttons receive onclick + preventDefault.
    if (['modelPicker', 'modelPickerList', 'modelPickerNote', 'modelCustomForm'].includes(id)) return `<div id="${id}"></div>`;
    if (['modelPickerRefresh', 'modelPickerShowAll', 'modelCustomToggle'].includes(id)) return `<a href="#" id="${id}"></a>`;
    if (id === 'modelsResetBtn') return `<button id="${id}"></button>`;
    return `<input id="${id}" />`;
  });

  // Sub-tab scaffolding. Configuration settings are loaded when that sub-tab is
  // opened rather than by init(), so tests that care about the form's contents
  // have to go through the same click the user does. Models works the same way.
  parts.push(
    '<a href="#" data-settings-tab="configuration" id="tab-configuration"></a>',
    '<div class="settings-tab-content" id="settings-configuration"></div>',
    '<a href="#" data-settings-tab="models" id="tab-models"></a>',
    '<div class="settings-tab-content" id="settings-models"></div>'
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


/**
 * Settings → Models: adding a model. Whether a model can hold a Swarm role is
 * decided in the main process from its ID during the save (modelCapabilities),
 * so a role chosen for a tool-less model is cleared and comes back as None.
 * Correct, but silent — the user has to be told why.
 */
describe('Settings tab: adding a tool-less model with a role', () => {
  const isToolless = (id) => /google\.gemma-3-/i.test(id || '');

  /**
   * Stand-in for the main process's save/load pair: save strips the role from
   * a tool-less model, load derives supportsTools from the ID — the same
   * contract settingsManager + modelCapabilities implement for real.
   */
  function loadModelsTabWithFakeMain(initialModels) {
    let stored = initialModels;
    mockElectronAPI.invoke.mockImplementation((channel, payload) => {
      switch (channel) {
        case 'load-settings':
          return Promise.resolve({
            bucketName: 'b', outputBucketName: 'o',
            bedrockModels: stored.map(m => ({ ...m, supportsTools: !isToolless(m.inferenceProfileId) })),
          });
        case 'save-settings':
          if (Array.isArray(payload?.bedrockModels)) {
            stored = payload.bedrockModels.map(({ supportsTools: _d, ...m }) => (
              m.role && isToolless(m.inferenceProfileId) ? { ...m, role: '' } : m
            ));
          }
          return Promise.resolve(true);
        case 'load-credentials': return Promise.resolve(null);
        case 'get-web-search-status': return Promise.resolve({ ready: true, error: null });
        case 'memory-list': return Promise.resolve([]);
        default: return Promise.resolve(undefined);
      }
    });
    jest.resetModules();
    require('../../src/renderer/settingsTab.js');
    window.SettingsTab.init();
    document.getElementById('tab-models').click();
  }

  async function addModel(name, profileId, role) {
    document.getElementById('newModelName').value = name;
    document.getElementById('newModelId').value = profileId;
    document.getElementById('newModelRole').value = role;
    document.getElementById('addModelBtn').click();
    await flush();
    await flush();
  }

  beforeEach(() => {
    jest.clearAllMocks();
    buildDom();
  });

  test('explains why the role came back as None', async () => {
    loadModelsTabWithFakeMain([
      { id: 'Claude Opus 5.5', inferenceProfileId: 'global.anthropic.claude-opus-5-5', role: '' },
    ]);
    await flush();

    await addModel('Gemma 3 27B', 'google.gemma-3-27b-it', 'creator');

    expect(mockElectronAPI.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/Gemma 3 27B makes no tool calls.*Swarm role.*Chat and StoryBrand/),
      'warning'
    );
    // And the table reflects the outcome: the role select is disabled, on None.
    const gemmaRow = [...document.querySelectorAll('#modelsTableBody tr')]
      .find(tr => tr.textContent.includes('google.gemma-3-27b-it'));
    const select = gemmaRow.querySelector('.model-role-select');
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('');
  });

  test('says nothing when a tool-capable model takes a role', async () => {
    loadModelsTabWithFakeMain([]);
    await flush();

    await addModel('Claude Sonnet 5', 'global.anthropic.claude-sonnet-5', 'creator');

    expect(mockElectronAPI.showToast).not.toHaveBeenCalledWith(expect.anything(), 'warning');
    const select = document.querySelector('#modelsTableBody .model-role-select');
    expect(select.disabled).toBe(false);
    expect(select.value).toBe('creator');
  });

  test('says nothing when a tool-less model is added without a role', async () => {
    loadModelsTabWithFakeMain([]);
    await flush();

    await addModel('Gemma 3 27B', 'google.gemma-3-27b-it', '');

    expect(mockElectronAPI.showToast).not.toHaveBeenCalledWith(expect.anything(), 'warning');
  });
});


/**
 * Settings → Models: the catalog picker. Grouped rows from list-bedrock-catalog,
 * Add/Remove per row against the configured list, "Show all models", the
 * offline note, Reset to defaults, and the custom-ID escape hatch.
 *
 * The fake main process here runs the *real* buildCatalog over a small fixture,
 * so configured/role flags on each row come from the same code the app uses.
 */
describe('Settings tab: catalog model picker', () => {
  const { buildCatalog, buildFallbackCatalog } = require('../../src/main/models/modelCatalog');

  const fm = (modelId, modelName) => ({
    modelId, modelName, inputModalities: ['TEXT'], outputModalities: ['TEXT'], inferenceTypesSupported: ['ON_DEMAND'],
  });
  const FOUNDATION = [
    fm('anthropic.claude-sonnet-5', 'Claude Sonnet 5'),
    fm('anthropic.claude-opus-5-5', 'Claude Opus 5.5'),
    fm('openai.gpt-6-sol', 'GPT-6 Sol'),
    fm('google.gemma-3-27b-it', 'Gemma 3 27B'),
    fm('mistral.mistral-large-3', 'Mistral Large 3'),   // uncurated: only under Show all
  ];
  const PROFILES = [
    { inferenceProfileId: 'global.anthropic.claude-sonnet-5' },
    { inferenceProfileId: 'global.anthropic.claude-opus-5-5' },
    { inferenceProfileId: 'us.openai.gpt-6-sol' },
  ];
  const DEFAULTS = [
    { id: 'Claude Opus 5.5', inferenceProfileId: 'global.anthropic.claude-opus-5-5', role: 'creator' },
    { id: 'Claude Sonnet 5', inferenceProfileId: 'global.anthropic.claude-sonnet-5', role: 'worker' },
  ];

  let stored;
  let catalogCalls;

  function installFakeMain({ initialModels, offline = false }) {
    stored = initialModels;
    catalogCalls = [];
    mockElectronAPI.invoke.mockImplementation((channel, payload) => {
      switch (channel) {
        case 'load-settings':
          return Promise.resolve({ bucketName: 'b', outputBucketName: 'o', bedrockModels: stored.map(m => ({ ...m, supportsTools: !/gemma-3/.test(m.inferenceProfileId) })) });
        case 'save-settings':
          if (Array.isArray(payload?.bedrockModels)) stored = payload.bedrockModels.map(({ supportsTools: _d, ...m }) => m);
          return Promise.resolve(true);
        case 'list-bedrock-catalog':
          catalogCalls.push(payload);
          return Promise.resolve(offline
            ? buildFallbackCatalog({ configuredModels: stored, reason: 'Hive is offline' })
            : buildCatalog({ foundationModels: FOUNDATION, inferenceProfiles: PROFILES, configuredModels: stored }));
        case 'get-default-settings':
          return Promise.resolve({ bedrockModels: DEFAULTS });
        case 'load-credentials': return Promise.resolve(null);
        case 'get-web-search-status': return Promise.resolve({ ready: true, error: null });
        case 'memory-list': return Promise.resolve([]);
        default: return Promise.resolve(undefined);
      }
    });
    jest.resetModules();
    require('../../src/renderer/settingsTab.js');
    window.SettingsTab.init();
    document.getElementById('tab-models').click();
  }

  const rows = () => [...document.querySelectorAll('#modelPickerList .model-picker-row')];
  const rowNamed = (name) => rows().find(r => r.querySelector('.model-picker-row-name').textContent.includes(name));
  const groupLabels = () => [...document.querySelectorAll('#modelPickerList .model-picker-group-label')].map(el => el.textContent);
  const settle = async () => { await flush(); await flush(); await flush(); };

  beforeEach(() => {
    jest.clearAllMocks();
    buildDom();
    window.confirm = jest.fn(() => true);
  });

  test('renders provider groups with name, description, cost pill, and Add/Remove per configured state', async () => {
    installFakeMain({ initialModels: [DEFAULTS[1]] }); // Sonnet configured as worker
    await settle();

    expect(groupLabels()).toEqual(['Claude', 'OpenAI', 'Google']);

    const sonnet = rowNamed('Claude Sonnet 5');
    expect(sonnet.classList.contains('is-configured')).toBe(true);
    expect(sonnet.querySelector('.model-picker-row-desc').textContent).toMatch(/everyday/i);
    expect(sonnet.querySelector('.model-picker-cost').textContent).toBe('~1×');
    expect(sonnet.querySelector('.model-picker-remove')).not.toBeNull();
    expect(sonnet.querySelector('.model-picker-add')).toBeNull();

    const opus = rowNamed('Claude Opus 5.5');
    expect(opus.classList.contains('is-configured')).toBe(false);
    expect(opus.querySelector('.model-picker-cost').textContent).toBe('~2×');
    expect(opus.querySelector('.model-picker-add')).not.toBeNull();
  });

  test('flags tool-less models on their row', async () => {
    installFakeMain({ initialModels: [] });
    await settle();
    expect(rowNamed('Gemma 3 27B').querySelector('.badge').textContent).toMatch(/Chat & StoryBrand only/);
    expect(rowNamed('Claude Opus 5.5').querySelector('.badge')).toBeNull();
  });

  test('Add saves the model with the catalog\'s preferred inference-profile ID and flips the row to Remove', async () => {
    installFakeMain({ initialModels: [] });
    await settle();

    rowNamed('GPT-6 Sol').querySelector('.model-picker-add').click();
    await settle();

    expect(stored).toEqual([{ id: 'GPT-6 Sol', inferenceProfileId: 'us.openai.gpt-6-sol', role: '' }]);
    const sol = rowNamed('GPT-6 Sol');
    expect(sol.classList.contains('is-configured')).toBe(true);
    expect(sol.querySelector('.model-picker-remove')).not.toBeNull();
    // The configured table below stays in sync.
    expect(document.querySelector('#modelsTableBody').textContent).toContain('us.openai.gpt-6-sol');
  });

  test('Remove drops the model from the configured list and flips the row back to Add', async () => {
    installFakeMain({ initialModels: [{ id: 'Sol', inferenceProfileId: 'us.openai.gpt-6-sol', role: '' }] });
    await settle();

    rowNamed('GPT-6 Sol').querySelector('.model-picker-remove').click();
    await settle();

    expect(stored).toEqual([]);
    expect(rowNamed('GPT-6 Sol').querySelector('.model-picker-add')).not.toBeNull();
  });

  test('Remove is disabled, with an explanation, while the model holds a Swarm role', async () => {
    installFakeMain({ initialModels: [DEFAULTS[0]] }); // Opus as creator
    await settle();

    const btn = rowNamed('Claude Opus 5.5').querySelector('.model-picker-remove');
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/Swarm creator/);
  });

  test('a configured model matches its row even when configured under a different prefix', async () => {
    installFakeMain({ initialModels: [{ id: 'Sonnet (us)', inferenceProfileId: 'us.anthropic.claude-sonnet-5', role: '' }] });
    await settle();
    expect(rowNamed('Claude Sonnet 5').querySelector('.model-picker-remove')).not.toBeNull();
  });

  test('"Show all models" reveals uncurated catalog entries and toggles its label', async () => {
    installFakeMain({ initialModels: [] });
    await settle();

    expect(rowNamed('Mistral Large 3')).toBeUndefined();
    const link = document.getElementById('modelPickerShowAll');
    expect(link.textContent).toBe('Show all models');

    link.click();
    await settle();
    expect(link.textContent).toBe('Show fewer models');
    const mistral = rowNamed('Mistral Large 3');
    expect(mistral).toBeDefined();
    // Uncurated: no description, so the row shows its ID; no cost pill.
    expect(mistral.querySelector('.model-picker-row-desc code').textContent).toBe('mistral.mistral-large-3');
    expect(mistral.querySelector('.model-picker-cost')).toBeNull();

    link.click();
    await settle();
    expect(rowNamed('Mistral Large 3')).toBeUndefined();
  });

  test('offline: shows the curated list with a note saying why', async () => {
    installFakeMain({ initialModels: [], offline: true });
    await settle();

    const note = document.getElementById('modelPickerNote');
    expect(note.classList.contains('d-none')).toBe(false);
    expect(note.textContent).toMatch(/Hive is offline/);
    expect(rowNamed('Claude Sonnet 5')).toBeDefined();
    expect(rowNamed('Mistral Large 3')).toBeUndefined();
  });

  test('Refresh re-reads the catalog with refresh: true', async () => {
    installFakeMain({ initialModels: [] });
    await settle();
    catalogCalls.length = 0;

    document.getElementById('modelPickerRefresh').click();
    await settle();
    expect(catalogCalls).toEqual([{ refresh: true }]);
  });

  test('Reset to defaults asks first, then replaces the list with Hive\'s defaults', async () => {
    installFakeMain({ initialModels: [{ id: 'Sol', inferenceProfileId: 'us.openai.gpt-6-sol', role: '' }] });
    await settle();

    document.getElementById('modelsResetBtn').click();
    await settle();

    expect(window.confirm).toHaveBeenCalled();
    expect(stored).toEqual(DEFAULTS);
    expect(rowNamed('GPT-6 Sol').querySelector('.model-picker-add')).not.toBeNull();
  });

  test('Reset to defaults does nothing when declined', async () => {
    window.confirm = jest.fn(() => false);
    installFakeMain({ initialModels: [{ id: 'Sol', inferenceProfileId: 'us.openai.gpt-6-sol', role: '' }] });
    await settle();

    document.getElementById('modelsResetBtn').click();
    await settle();
    expect(stored).toEqual([{ id: 'Sol', inferenceProfileId: 'us.openai.gpt-6-sol', role: '' }]);
  });

  test('the custom-ID form is hidden until asked for', async () => {
    installFakeMain({ initialModels: [] });
    await settle();
    const form = document.getElementById('modelCustomForm');
    form.classList.add('d-none'); // as in the real markup
    document.getElementById('modelCustomToggle').click();
    expect(form.classList.contains('d-none')).toBe(false);
  });
});
