/**
 * list-bedrock-catalog IPC handler (ipc/bedrock.js): the picker's data source.
 *
 * What matters here is not the merge (modelCatalog.test.js covers that) but
 * the plumbing around it: the AWS side is fetched once per session and
 * cached, `refresh` busts the cache, and every failure mode — no credentials,
 * offline, a permission denial — degrades to the curated list with a reason
 * instead of an empty picker or an error.
 */
jest.mock('electron', () => ({}));
jest.mock('electron-log/main', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => ({ GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn() }));
jest.mock('@aws-sdk/lib-storage', () => ({ Upload: jest.fn() }));
jest.mock('@aws-sdk/client-transcribe', () => ({
  StartTranscriptionJobCommand: jest.fn(),
  GetTranscriptionJobCommand: jest.fn(),
  DeleteTranscriptionJobCommand: jest.fn(),
}));
jest.mock('../../src/main/models/codeInterpreterManager', () => jest.fn());
jest.mock('../../src/main/models/transcriptMapper', () => jest.fn());
jest.mock('../../src/main/models/transcriptionReconciler', () => ({}));
jest.mock('../../src/main/models/strandsAgentFactory', () => ({ createAgent: jest.fn(), isAnthropicModel: jest.fn() }));
jest.mock('../../src/main/utils', () => ({ buildFileContentBlocks: jest.fn(), collectStreamText: jest.fn() }));

const mockSend = jest.fn();
const mockDestroy = jest.fn();
jest.mock('@aws-sdk/client-bedrock', () => ({
  BedrockClient: jest.fn().mockImplementation(() => ({ send: mockSend, destroy: mockDestroy })),
  ListFoundationModelsCommand: jest.fn(function (input) { this.input = input; this._type = 'models'; }),
  ListInferenceProfilesCommand: jest.fn(function (input) { this.input = input; this._type = 'profiles'; }),
}));

const { register } = require('../../src/main/ipc/bedrock');

const FM = { modelId: 'anthropic.claude-sonnet-5', modelName: 'Claude Sonnet 5', inputModalities: ['TEXT'], outputModalities: ['TEXT'], inferenceTypesSupported: ['ON_DEMAND'] };

function liveAws({ profilePages = 1 } = {}) {
  let page = 0;
  mockSend.mockImplementation(async (cmd) => {
    if (cmd._type === 'models') return { modelSummaries: [FM] };
    page += 1;
    return {
      inferenceProfileSummaries: [{ inferenceProfileId: page === 1 ? 'global.anthropic.claude-sonnet-5' : `us.page${page}.model` }],
      nextToken: page < profilePages ? `token-${page}` : undefined,
    };
  });
}

function buildHarness({ online = true, credentials = true, configured = [] } = {}) {
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const ctx = {
    currentSettings: { bedrockModels: configured },
    settingsManager: { loadSettings: jest.fn(async () => ({ bedrockModels: configured })) },
    awsClients: credentials ? { agentCoreConfig: { region: 'us-east-1' } } : null,
    isOnline: () => online,
  };
  register(ipcMain, ctx);
  return { handler: handlers['list-bedrock-catalog'], ctx };
}

const sonnetRow = (cat) => cat.groups.flatMap((g) => g.models).find((m) => m.modelId === 'anthropic.claude-sonnet-5');

beforeEach(() => {
  jest.clearAllMocks();
});

test('live path: fetches both lists, merges, and reports source live', async () => {
  liveAws();
  const { handler } = buildHarness();

  const cat = await handler({}, {});

  expect(cat.source).toBe('live');
  expect(sonnetRow(cat)).toMatchObject({ inferenceProfileId: 'global.anthropic.claude-sonnet-5', configured: false });
  expect(mockSend.mock.calls.map(([c]) => c._type)).toEqual(['models', 'profiles']);
  expect(mockDestroy).toHaveBeenCalled();
});

test('paginates inference profiles until nextToken runs out', async () => {
  liveAws({ profilePages: 3 });
  const { handler } = buildHarness();

  await handler({}, {});

  const profileCalls = mockSend.mock.calls.filter(([c]) => c._type === 'profiles');
  expect(profileCalls).toHaveLength(3);
  expect(profileCalls[1][0].input.nextToken).toBe('token-1');
  expect(profileCalls[2][0].input.nextToken).toBe('token-2');
});

test('caches the AWS side across calls, but re-merges against the current configured list', async () => {
  liveAws();
  const { handler, ctx } = buildHarness();

  const first = await handler({}, {});
  expect(sonnetRow(first).configured).toBe(false);

  // User adds the model: settings change, no new AWS call should be needed.
  ctx.currentSettings = { bedrockModels: [{ id: 'S', inferenceProfileId: 'global.anthropic.claude-sonnet-5', role: 'worker' }] };
  const second = await handler({}, {});

  expect(sonnetRow(second)).toMatchObject({ configured: true, configuredRole: 'worker' });
  expect(mockSend.mock.calls.filter(([c]) => c._type === 'models')).toHaveLength(1);
});

test('refresh: true re-fetches from AWS', async () => {
  liveAws();
  const { handler } = buildHarness();

  await handler({}, {});
  await handler({}, { refresh: true });

  expect(mockSend.mock.calls.filter(([c]) => c._type === 'models')).toHaveLength(2);
});

test('no credentials: curated fallback, no AWS call, reason given', async () => {
  const { handler } = buildHarness({ credentials: false });
  const cat = await handler({}, {});
  expect(cat).toMatchObject({ source: 'fallback', reason: expect.stringMatching(/credentials/i) });
  expect(mockSend).not.toHaveBeenCalled();
  expect(sonnetRow(cat)).toBeDefined();
});

test('offline: curated fallback without touching AWS', async () => {
  const { handler } = buildHarness({ online: false });
  const cat = await handler({}, {});
  expect(cat).toMatchObject({ source: 'fallback', reason: expect.stringMatching(/offline/i) });
  expect(mockSend).not.toHaveBeenCalled();
});

test('a permission denial degrades to the fallback and names the missing permission', async () => {
  mockSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
  const { handler } = buildHarness();
  const cat = await handler({}, {});
  expect(cat.source).toBe('fallback');
  expect(cat.reason).toMatch(/ListFoundationModels|ListInferenceProfiles/);
  expect(mockDestroy).toHaveBeenCalled(); // client is cleaned up on the error path too
});

test('a failed fetch is not cached, so the next call tries AWS again', async () => {
  mockSend.mockRejectedValueOnce(new Error('ECONNRESET'));
  const { handler } = buildHarness();

  const first = await handler({}, {});
  expect(first.source).toBe('fallback');

  liveAws();
  const second = await handler({}, {});
  expect(second.source).toBe('live');
});

test('fallback still reflects the configured list', async () => {
  const configured = [{ id: 'S', inferenceProfileId: 'us.anthropic.claude-sonnet-5', role: 'creator' }];
  const { handler } = buildHarness({ online: false, configured });
  const cat = await handler({}, {});
  expect(sonnetRow(cat)).toMatchObject({ configured: true, configuredRole: 'creator', inferenceProfileId: 'us.anthropic.claude-sonnet-5' });
});
