/**
 * Tool-less models (Gemma 3 on Converse answers a tool request with plain
 * text) must never reach a tool loop — the Work tab or a Swarm role — whether
 * they came from the shipped defaults or were typed into Settings → Models by
 * hand. These tests pin each place that decision is enforced.
 */
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/mock/userData') },
}));
jest.mock('electron-log/main', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('fs', () => ({
  promises: { access: jest.fn(), mkdir: jest.fn(), readFile: jest.fn(), writeFile: jest.fn(), unlink: jest.fn() },
}));

const fs = require('fs').promises;
const { supportsTools, withCapabilities, stripCapabilities } = require('../../src/main/models/modelCapabilities');
const SettingsManager = require('../../src/main/models/settingsManager');

const GEMMA = { id: 'Gemma 3 27B', inferenceProfileId: 'google.gemma-3-27b-it', role: '' };
const OPUS = { id: 'Claude Opus 5.5', inferenceProfileId: 'global.anthropic.claude-opus-5-5', role: 'creator' };

describe('supportsTools', () => {
  test.each([
    'google.gemma-3-27b-it',
    'google.gemma-3-12b-it',
    'us.google.gemma-3-27b-it',
  ])('%s is tool-less', (id) => {
    expect(supportsTools(id)).toBe(false);
  });

  test.each([
    'global.anthropic.claude-opus-5-5',
    'us.openai.gpt-6-sol',
    'us.xai.grok-4.6',
    // v4.4.2 default additions — verified live to make real toolUse calls.
    'global.moonshotai.kimi-k3',
    'global.openai.gpt-6-luna',
    'global.amazon.nova-2-lite-v1:0',
    'some.brand-new-model-v1',
  ])('%s is assumed tool-capable', (id) => {
    expect(supportsTools(id)).toBe(true);
  });

  test('a missing ID is treated as capable rather than throwing', () => {
    expect(supportsTools(undefined)).toBe(true);
  });
});

describe('withCapabilities / stripCapabilities', () => {
  test('derives the flag from the ID, ignoring any stored value', () => {
    const out = withCapabilities([{ ...GEMMA, supportsTools: true }, OPUS]);
    expect(out.map((m) => m.supportsTools)).toEqual([false, true]);
  });

  test('does not mutate the input', () => {
    const input = [{ ...GEMMA }];
    withCapabilities(input);
    expect(input[0]).not.toHaveProperty('supportsTools');
  });

  test('strip removes the derived field and clears a role on a tool-less model', () => {
    const out = stripCapabilities([
      { ...GEMMA, role: 'worker', supportsTools: false },
      { ...OPUS, supportsTools: true },
    ]);
    expect(out).toEqual([{ ...GEMMA, role: '' }, OPUS]);
  });

  test('non-arrays pass through', () => {
    expect(withCapabilities(undefined)).toBeUndefined();
    expect(stripCapabilities(null)).toBeNull();
  });
});

describe('SettingsManager', () => {
  let manager;
  beforeEach(() => {
    jest.clearAllMocks();
    manager = new SettingsManager();
  });

  test('fresh install: the default Gemma is loaded as tool-less, Opus 5.5 as creator', async () => {
    fs.access.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    const { bedrockModels } = await manager.loadSettings();
    const gemma = bedrockModels.find((m) => m.inferenceProfileId === 'google.gemma-3-27b-it');
    const creator = bedrockModels.find((m) => m.role === 'creator');
    expect(gemma).toMatchObject({ role: '', supportsTools: false });
    expect(creator.inferenceProfileId).toBe('global.anthropic.claude-opus-5-5');
  });

  test('a Gemma added by hand (no flag in settings.json) is still loaded as tool-less', async () => {
    fs.access.mockResolvedValue();
    fs.readFile.mockResolvedValue(JSON.stringify({ bedrockModels: [OPUS, { ...GEMMA, id: 'my gemma' }] }));
    const { bedrockModels } = await manager.loadSettings();
    expect(bedrockModels.map((m) => m.supportsTools)).toEqual([true, false]);
  });

  test('saving never persists the derived flag, and drops a role on a tool-less model', async () => {
    fs.access.mockResolvedValue();
    await manager.saveSettings({
      bedrockModels: [{ ...OPUS, supportsTools: true }, { ...GEMMA, role: 'formatter', supportsTools: false }],
    });
    const written = JSON.parse(fs.writeFile.mock.calls[0][1]);
    expect(written.bedrockModels).toEqual([OPUS, { ...GEMMA, role: '' }]);
  });
});

describe('swarm-run-pipeline role resolution', () => {
  const resolveModels = jest.fn();

  beforeAll(() => {
    jest.doMock('../../src/main/models/swarmOrchestrator', () => jest.fn());
    jest.doMock('../../src/main/models/codeInterpreterManager', () => jest.fn());
    jest.doMock('../../src/main/notify', () => ({ notify: jest.fn() }));
    jest.doMock('../../src/main/models/pipelineTemplates', () => ({
      resolveModels,
      getTemplate: jest.fn(() => null), // stop right after role resolution
      getAllTemplates: jest.fn(() => []),
    }));
  });

  async function runWith(bedrockModels) {
    const handlers = {};
    const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
    const ctx = {
      awsClients: { bedrock: {} },
      assertOnline: jest.fn(),
      currentSettings: { bedrockModels },
    };
    jest.isolateModules(() => { require('../../src/main/ipc/swarm').register(ipcMain, ctx); });
    await expect(handlers['swarm-run-pipeline']({}, { templateId: 'x', brief: 'b' })).rejects.toThrow('Unknown template');
  }

  beforeEach(() => resolveModels.mockClear());

  test('a role on a tool-less model is ignored so the default applies', async () => {
    await runWith([OPUS, { ...GEMMA, role: 'worker' }]);
    expect(resolveModels).toHaveBeenCalledWith({ creator: 'global.anthropic.claude-opus-5-5' });
  });

  test('roles on tool-capable models are passed through unchanged', async () => {
    await runWith([OPUS, { id: 'Sonnet', inferenceProfileId: 'global.anthropic.claude-sonnet-5', role: 'worker' }]);
    expect(resolveModels).toHaveBeenCalledWith({
      creator: 'global.anthropic.claude-opus-5-5',
      worker: 'global.anthropic.claude-sonnet-5',
    });
  });
});


describe('invoke-agent guard', () => {
  // The Work dropdown already filters tool-less models out, but that is a DOM
  // invariant; this guard is the main-process backstop, symmetrical with the
  // swarm-run-pipeline check above.
  beforeAll(() => {
    jest.doMock('../../src/main/models/memoryManager', () => jest.fn());
    jest.doMock('../../src/main/models/agentToolExecutor', () => jest.fn());
  });

  function buildHandler() {
    const handlers = {};
    const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
    const ctx = {
      awsClients: { bedrock: {} },
      assertOnline: jest.fn(),
      agentAbortControllers: new Map(),
      // Throws a sentinel so a request that gets PAST the guard stops right
      // there, proving the guard let it through without running a real job.
      settingsManager: { loadSettings: jest.fn(async () => { throw new Error('SENTINEL: past the guard'); }) },
    };
    jest.isolateModules(() => { require('../../src/main/ipc/agent').register(ipcMain, ctx); });
    return { handlers, ctx };
  }

  const fakeEvent = () => ({ sender: { send: jest.fn() } });

  test('refuses a tool-less model before any work starts', async () => {
    const { handlers, ctx } = buildHandler();

    await expect(
      handlers['invoke-agent'](fakeEvent(), { model: 'google.gemma-3-27b-it', prompt: 'p', sessionId: 's1' })
    ).rejects.toThrow(/makes no tool calls.*Chat or StoryBrand/);

    // Refused up front: nothing loaded, nothing registered to clean up.
    expect(ctx.settingsManager.loadSettings).not.toHaveBeenCalled();
    expect(ctx.agentAbortControllers.size).toBe(0);
  });

  test('a tool-capable model gets past the guard', async () => {
    const { handlers } = buildHandler();

    await expect(
      handlers['invoke-agent'](fakeEvent(), { model: 'global.anthropic.claude-opus-5-5', prompt: 'p', sessionId: 's1' })
    ).rejects.toThrow('SENTINEL: past the guard');
  });
});
