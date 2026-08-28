/**
 * Tests for the Setup Check IPC layer (src/main/ipc/setupWizard.js), focused on
 * bucket provisioning.
 *
 * The behaviour that matters: Setup Check must be able to create the output
 * bucket even when nothing is configured, using an account-scoped suggestion,
 * and must persist whatever name it used. Without the persist step, Settings and
 * the bucket that actually exists could disagree — leaving the user with a
 * provisioned bucket and a still-broken configuration.
 */

jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockCheckStatus = jest.fn();
const mockCreateTranscriptionBucket = jest.fn();
const mockCreateWebSearchGatewayRole = jest.fn();
const mockCreateMemory = jest.fn();
jest.mock('../../src/main/models/setupWizard', () => ({
  checkStatus: (...args) => mockCheckStatus(...args),
  createTranscriptionBucket: (...args) => mockCreateTranscriptionBucket(...args),
  createWebSearchGatewayRole: (...args) => mockCreateWebSearchGatewayRole(...args),
  createMemory: (...args) => mockCreateMemory(...args),
  // Real implementation — the suggestion format is part of the contract here.
  suggestBucketName: (accountId, kind) =>
    accountId ? `${kind === 'output' ? 'hive-transcripts' : 'hive-media'}-${accountId}` : null,
}));

const mockQuickValidate = jest.fn();
jest.mock('../../src/main/models/awsValidator', () => jest.fn().mockImplementation(() => ({
  quickValidate: mockQuickValidate,
})));

const { register } = require('../../src/main/ipc/setupWizard');

function buildHarness({ settings = {}, online = true, webSearchComesUp = true, webSearchInitThrows = null, webSearchErrorMessage = null } = {}) {
  const handlers = {};
  const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; } };
  const state = { online, webSearchComesUp, webSearchInitThrows, webSearchErrorMessage };

  const ctx = {
    currentCredentials: { accessKeyId: 'AKIA', secretAccessKey: 's', region: 'us-east-1' },
    currentSettings: { bucketName: '', outputBucketName: '', region: 'us-east-1', ...settings },
    credentialsManager: { loadCredentials: jest.fn(async () => ctx.currentCredentials) },
    settingsManager: {
      loadSettings: jest.fn(async () => ctx.currentSettings),
      saveSettings: jest.fn(async () => {}),
    },
    // Web search plumbing: initializeWebSearch() is what the 'save-settings'
    // handler calls, and what Setup Check must also call now.
    webSearchManager: { ready: false },
    webSearchInitError: null,
    initializeWebSearch: jest.fn(async () => {
      if (state.webSearchInitThrows) throw new Error(state.webSearchInitThrows);
      ctx.webSearchManager.ready = state.webSearchComesUp !== false;
      ctx.webSearchInitError = ctx.webSearchManager.ready ? null : (state.webSearchErrorMessage || 'gateway creation failed');
    }),
    isOnline: () => state.online,
    assertOnline: (action = 'This action') => {
      if (!state.online) {
        const err = new Error(`${action} needs an internet connection — Hive is offline.`);
        err.code = 'HIVE_OFFLINE';
        throw err;
      }
    },
  };

  register(ipcMain, ctx);
  return { handlers, ctx, state };
}

const fakeEvent = () => ({ sender: { send: jest.fn() } });

describe('setup-wizard-create-item: transcription buckets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuickValidate.mockResolvedValue({
      valid: true,
      offline: false,
      identity: { account: '111122223333' },
    });
    mockCreateTranscriptionBucket.mockImplementation(async (_creds, _region, name) => name);
  });

  test('creates the configured output bucket', async () => {
    const { handlers } = buildHarness({ settings: { outputBucketName: 'my-output' } });

    const result = await handlers['setup-wizard-create-item'](fakeEvent(), 'transcriptionOutputBucket');

    expect(mockCreateTranscriptionBucket).toHaveBeenCalledWith(expect.anything(), 'us-east-1', 'my-output');
    expect(result).toMatchObject({ success: true, bucketName: 'my-output' });
  });

  test('falls back to the account-scoped suggestion when nothing is configured', async () => {
    // Setup Check must be completable in one click rather than bouncing the
    // user to Settings to invent a globally-unique name.
    const { handlers } = buildHarness({ settings: { outputBucketName: '' } });

    const result = await handlers['setup-wizard-create-item'](fakeEvent(), 'transcriptionOutputBucket');

    expect(mockCreateTranscriptionBucket).toHaveBeenCalledWith(
      expect.anything(), 'us-east-1', 'hive-transcripts-111122223333'
    );
    expect(result.bucketName).toBe('hive-transcripts-111122223333');
  });

  test('persists the suggested name so Settings matches the bucket that now exists', async () => {
    const { handlers, ctx } = buildHarness({ settings: { outputBucketName: '' } });

    await handlers['setup-wizard-create-item'](fakeEvent(), 'transcriptionOutputBucket');

    expect(ctx.settingsManager.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ outputBucketName: 'hive-transcripts-111122223333' })
    );
    expect(ctx.currentSettings.outputBucketName).toBe('hive-transcripts-111122223333');
  });

  test('does not rewrite settings when the configured name was already used', async () => {
    const { handlers, ctx } = buildHarness({ settings: { outputBucketName: 'my-output' } });

    await handlers['setup-wizard-create-item'](fakeEvent(), 'transcriptionOutputBucket');

    expect(ctx.settingsManager.saveSettings).not.toHaveBeenCalled();
  });

  test('applies the same fallback and persistence to the input bucket', async () => {
    const { handlers, ctx } = buildHarness({ settings: { bucketName: '' } });

    const result = await handlers['setup-wizard-create-item'](fakeEvent(), 'transcriptionBucket');

    expect(result.bucketName).toBe('hive-media-111122223333');
    expect(ctx.settingsManager.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ bucketName: 'hive-media-111122223333' })
    );
  });

  test('explains what to do when the account id cannot be resolved either', async () => {
    mockQuickValidate.mockResolvedValue({ valid: false, offline: false, identity: null });
    const { handlers } = buildHarness({ settings: { outputBucketName: '' } });

    await expect(handlers['setup-wizard-create-item'](fakeEvent(), 'transcriptionOutputBucket'))
      .rejects.toThrow(/Output S3 Bucket.*set a name in Settings/s);
    expect(mockCreateTranscriptionBucket).not.toHaveBeenCalled();
  });

  test('refuses to provision anything while offline', async () => {
    const { handlers } = buildHarness({ online: false });

    await expect(handlers['setup-wizard-create-item'](fakeEvent(), 'transcriptionOutputBucket'))
      .rejects.toThrow(/offline/i);
  });

  test('rejects an unknown item id', async () => {
    const { handlers } = buildHarness();

    await expect(handlers['setup-wizard-create-item'](fakeEvent(), 'somethingElse'))
      .rejects.toThrow(/Unknown setup item/);
  });
});

describe('get-suggested-bucket-names', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuickValidate.mockResolvedValue({
      valid: true,
      offline: false,
      identity: { account: '111122223333' },
    });
  });

  test('returns both suggestions', async () => {
    const { handlers } = buildHarness();

    await expect(handlers['get-suggested-bucket-names']()).resolves.toEqual({
      input: 'hive-media-111122223333',
      output: 'hive-transcripts-111122223333',
    });
  });

  test('returns null when offline rather than failing the Settings load', async () => {
    const { handlers } = buildHarness({ online: false });
    await expect(handlers['get-suggested-bucket-names']()).resolves.toBeNull();
  });

  test('returns null when the account id is unavailable', async () => {
    mockQuickValidate.mockResolvedValue({ valid: false, offline: false, identity: null });
    const { handlers } = buildHarness();

    await expect(handlers['get-suggested-bucket-names']()).resolves.toBeNull();
  });

  test('returns null when there are no credentials yet', async () => {
    const { handlers, ctx } = buildHarness();
    ctx.currentCredentials = null;
    ctx.credentialsManager.loadCredentials.mockResolvedValue(null);

    await expect(handlers['get-suggested-bucket-names']()).resolves.toBeNull();
  });
});

describe('setup-wizard-check-status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('reports offline without attempting the check', async () => {
    const { handlers } = buildHarness({ online: false });

    const result = await handlers['setup-wizard-check-status']();

    expect(result).toMatchObject({ offline: true });
    expect(result.error).toMatch(/offline/i);
    expect(mockCheckStatus).not.toHaveBeenCalled();
  });

  test('passes the current settings through to the checker', async () => {
    mockCheckStatus.mockResolvedValue({ transcriptionOutputBucket: { status: 'missing' } });
    const { handlers, ctx } = buildHarness({ settings: { outputBucketName: 'out' } });

    await handlers['setup-wizard-check-status']();

    expect(mockCheckStatus).toHaveBeenCalledWith(ctx.currentCredentials, ctx.currentSettings);
  });
});

/**
 * Regression: on a brand-new install the Gateway role was created and its ARN
 * persisted, but web search stayed down for the rest of the session.
 *
 * The ARN is saved via settingsManager directly, bypassing the 'save-settings'
 * IPC handler — which is the only place that re-initialises web search when the
 * role ARN changes. So webSearchManager remained exactly as it had failed at
 * startup ("roleArn required to create web search gateway") while Setup Check
 * showed a green tick, and the agent silently fell back to scraping via
 * execute_code, which is indistinguishable from web search working.
 *
 * This was invisible until v3.12.0 fixed the em-dash description bug that had
 * been failing the step before it — nobody had ever got this far on a new
 * install.
 */
describe('setup-wizard-create-item: web search gateway', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateWebSearchGatewayRole.mockResolvedValue('arn:aws:iam::111122223333:role/hive-web-search-gateway');
  });

  test('persists the role ARN', async () => {
    const { handlers, ctx } = buildHarness();

    const result = await handlers['setup-wizard-create-item'](fakeEvent(), 'webSearchGateway');

    expect(ctx.settingsManager.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ webSearchGatewayRoleArn: 'arn:aws:iam::111122223333:role/hive-web-search-gateway' }),
    );
    expect(result.arn).toBe('arn:aws:iam::111122223333:role/hive-web-search-gateway');
  });

  test('brings web search up instead of leaving it down until the next launch', async () => {
    const { handlers, ctx } = buildHarness();
    expect(ctx.webSearchManager.ready).toBe(false);

    const result = await handlers['setup-wizard-create-item'](fakeEvent(), 'webSearchGateway');

    expect(ctx.initializeWebSearch).toHaveBeenCalledTimes(1);
    expect(ctx.webSearchManager.ready).toBe(true);
    expect(result.webSearchReady).toBe(true);
  });

  test('re-initialises only after the ARN is saved, so the new role is the one used', async () => {
    const order = [];
    const { handlers, ctx } = buildHarness();
    ctx.settingsManager.saveSettings.mockImplementation(async () => { order.push('save'); });
    ctx.initializeWebSearch.mockImplementation(async () => { order.push('init'); ctx.webSearchManager.ready = true; });

    await handlers['setup-wizard-create-item'](fakeEvent(), 'webSearchGateway');

    expect(order).toEqual(['save', 'init']);
  });

  test('says so when web search does not come up, rather than reporting plain success', async () => {
    // The green tick claiming "Ready" while web search was dead is what made
    // the original failure invisible.
    const { handlers } = buildHarness({ webSearchComesUp: false, webSearchErrorMessage: 'gateway CREATE_FAILED' });

    const result = await handlers['setup-wizard-create-item'](fakeEvent(), 'webSearchGateway');

    expect(result.webSearchReady).toBe(false);
    expect(result.webSearchError).toBe('gateway CREATE_FAILED');
    expect(result.detail).not.toMatch(/activated web search/);
  });

  test('reports the role as created even when web search fails, because it was', async () => {
    const { handlers } = buildHarness({ webSearchComesUp: false });

    const result = await handlers['setup-wizard-create-item'](fakeEvent(), 'webSearchGateway');

    expect(result.success).toBe(true);
    expect(result.arn).toBeTruthy();
  });

  test('a throwing initializeWebSearch does not fail the whole item', async () => {
    // The role genuinely exists at this point; discarding that would make the
    // user create it again.
    const { handlers } = buildHarness({ webSearchInitThrows: 'boom' });

    const result = await handlers['setup-wizard-create-item'](fakeEvent(), 'webSearchGateway');

    expect(result.success).toBe(true);
    expect(result.webSearchReady).toBe(false);
    expect(result.webSearchError).toBe('boom');
  });

  test('works against a context with no web search wiring at all', async () => {
    const { handlers, ctx } = buildHarness();
    delete ctx.initializeWebSearch;
    delete ctx.webSearchManager;

    const result = await handlers['setup-wizard-create-item'](fakeEvent(), 'webSearchGateway');

    expect(result.success).toBe(true);
    expect(result.webSearchReady).toBe(false);
  });
});
