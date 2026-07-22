/**
 * Tests for SwarmOrchestrator formatter verification/retry behavior.
 * Focuses on the fix for the "silent failure" bug where formatter agents
 * (docx/pptx generators) could complete without producing an output file.
 */

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp/hive-test-userdata') },
}));

jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('@strands-agents/sdk', () => ({
  Agent: jest.fn(),
  BedrockModel: jest.fn(),
  tool: jest.fn(),
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(),
  ConverseStreamCommand: jest.fn(),
}));

jest.mock('../../src/main/models/swarmTools', () => ({
  createSwarmTools: jest.fn(() => ({})),
}));

jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockRejectedValue(new Error('no checkpoint')),
    stat: jest.fn(),
  },
}));

const SwarmOrchestrator = require('../../src/main/models/swarmOrchestrator');

describe('SwarmOrchestrator — formatter file-save verification', () => {
  let orchestrator;
  let events;

  beforeEach(() => {
    jest.clearAllMocks();
    events = [];
    orchestrator = new SwarmOrchestrator({
      awsConfig: {},
      skillsManager: { getSkillBody: jest.fn().mockResolvedValue(null) },
      codeInterpreterManager: {},
      webSearchManager: {},
      settings: {},
      onEvent: (name, payload) => events.push({ name, payload }),
    });
  });

  describe('_verifyLocalSave', () => {
    test('returns null when output contains no file path', async () => {
      const result = await orchestrator._verifyLocalSave('swarm-1', 0, 'I created the presentation successfully.');
      expect(result).toBeNull();
      expect(events.some(e => e.payload?.chunk?.includes('did not report a local file path'))).toBe(true);
    });

    test('returns the resolved path when output references a real file', async () => {
      require('fs').promises.stat.mockResolvedValueOnce({ size: 20480 });
      const output = 'Done! Saved to ~/Documents/Hive/my-deck.pptx';
      const result = await orchestrator._verifyLocalSave('swarm-1', 0, output);
      expect(result).toMatch(/my-deck\.pptx$/);
      expect(events.some(e => e.payload?.chunk?.includes('Verified'))).toBe(true);
    });

    test('returns null when the referenced file does not actually exist on disk', async () => {
      require('fs').promises.stat.mockRejectedValueOnce(new Error('ENOENT'));
      const output = 'Saved to ~/Documents/Hive/ghost-file.docx';
      const result = await orchestrator._verifyLocalSave('swarm-1', 0, output);
      expect(result).toBeNull();
      expect(events.some(e => e.payload?.chunk?.includes('NOT saved'))).toBe(true);
    });
  });

  describe('runPipeline — formatter retry and hard failure', () => {
    function makeTemplate(formatterOverrides = {}) {
      return {
        id: 'test-template',
        name: 'Test Template',
        agents: [
          {
            id: 'formatter',
            label: 'Formatter',
            model: 'formatter',
            tools: ['execute_code', 'save_file_locally'],
            prompt: 'Generate the file.',
            ...formatterOverrides,
          },
        ],
        edges: [],
      };
    }

    test('retries the formatter agent when no file is verified, then fails the pipeline after exhausting retries', async () => {
      // Formatter always claims success but never produces a real file
      orchestrator._runAgent = jest.fn().mockResolvedValue('All done, file created!');
      orchestrator._verifyLocalSave = jest.fn().mockResolvedValue(null); // never verifies
      orchestrator._saveState = jest.fn().mockResolvedValue(undefined);
      orchestrator._saveCheckpoint = jest.fn().mockResolvedValue(undefined);
      orchestrator._ensureDir = jest.fn().mockResolvedValue(undefined);
      orchestrator._getHistoricalFeedback = jest.fn().mockResolvedValue(null);
      orchestrator._adaptRubric = jest.fn().mockResolvedValue(null);

      const template = makeTemplate({ maxRetries: 2 });
      await orchestrator.runPipeline('swarm-fail', template, 'Build a demo deck', 'autonomous', []);

      // Initial attempt + 2 retries = 3 total calls to _runAgent
      expect(orchestrator._runAgent).toHaveBeenCalledTimes(3);
      // Verification attempted after each run
      expect(orchestrator._verifyLocalSave).toHaveBeenCalledTimes(3);

      const errorEvent = events.find(e => e.name === 'swarm-error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.payload.error).toMatch(/did not produce a file after 2 retries/i);

      // Must NOT checkpoint a failed formatter run — otherwise resume would skip it
      expect(orchestrator._saveCheckpoint).not.toHaveBeenCalled();
    });

    test('succeeds without retrying when the file is verified on the first attempt', async () => {
      orchestrator._runAgent = jest.fn().mockResolvedValue('File created at ~/Documents/Hive/deck.pptx');
      orchestrator._verifyLocalSave = jest.fn().mockResolvedValue('/home/user/Documents/Hive/deck.pptx');
      orchestrator._saveState = jest.fn().mockResolvedValue(undefined);
      orchestrator._saveCheckpoint = jest.fn().mockResolvedValue(undefined);
      orchestrator._ensureDir = jest.fn().mockResolvedValue(undefined);
      orchestrator._getHistoricalFeedback = jest.fn().mockResolvedValue(null);
      orchestrator._adaptRubric = jest.fn().mockResolvedValue(null);
      orchestrator._cleanupOutputFiles = jest.fn().mockResolvedValue(undefined);
      orchestrator._pruneOldRuns = jest.fn().mockResolvedValue(undefined);

      const template = makeTemplate({ maxRetries: 2 });
      await orchestrator.runPipeline('swarm-ok', template, 'Build a demo deck', 'autonomous', []);

      expect(orchestrator._runAgent).toHaveBeenCalledTimes(1);
      expect(orchestrator._verifyLocalSave).toHaveBeenCalledTimes(1);
      expect(orchestrator._saveCheckpoint).toHaveBeenCalledTimes(1);
      expect(events.some(e => e.name === 'swarm-error')).toBe(false);
      expect(events.some(e => e.name === 'swarm-pipeline-done')).toBe(true);
    });

    test('succeeds after one retry when the second attempt produces a verifiable file', async () => {
      orchestrator._runAgent = jest.fn()
        .mockResolvedValueOnce('File created!') // attempt 1 — claims success, no real file
        .mockResolvedValueOnce('File created at ~/Documents/Hive/deck.pptx'); // attempt 2 — real file
      orchestrator._verifyLocalSave = jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('/home/user/Documents/Hive/deck.pptx');
      orchestrator._saveState = jest.fn().mockResolvedValue(undefined);
      orchestrator._saveCheckpoint = jest.fn().mockResolvedValue(undefined);
      orchestrator._ensureDir = jest.fn().mockResolvedValue(undefined);
      orchestrator._getHistoricalFeedback = jest.fn().mockResolvedValue(null);
      orchestrator._adaptRubric = jest.fn().mockResolvedValue(null);
      orchestrator._cleanupOutputFiles = jest.fn().mockResolvedValue(undefined);
      orchestrator._pruneOldRuns = jest.fn().mockResolvedValue(undefined);

      const template = makeTemplate({ maxRetries: 2 });
      await orchestrator.runPipeline('swarm-retry-ok', template, 'Build a demo deck', 'autonomous', []);

      expect(orchestrator._runAgent).toHaveBeenCalledTimes(2);
      expect(orchestrator._saveCheckpoint).toHaveBeenCalledTimes(1);
      expect(events.some(e => e.name === 'swarm-error')).toBe(false);
      expect(events.some(e => e.name === 'swarm-pipeline-done')).toBe(true);
    });

    test('defaults to 2 retries when maxRetries is not specified on the formatter agent', async () => {
      orchestrator._runAgent = jest.fn().mockResolvedValue('claims success');
      orchestrator._verifyLocalSave = jest.fn().mockResolvedValue(null);
      orchestrator._saveState = jest.fn().mockResolvedValue(undefined);
      orchestrator._saveCheckpoint = jest.fn().mockResolvedValue(undefined);
      orchestrator._ensureDir = jest.fn().mockResolvedValue(undefined);
      orchestrator._getHistoricalFeedback = jest.fn().mockResolvedValue(null);
      orchestrator._adaptRubric = jest.fn().mockResolvedValue(null);

      const template = makeTemplate(); // no maxRetries specified
      await orchestrator.runPipeline('swarm-default-retries', template, 'Build something', 'autonomous', []);

      // Initial attempt + default 2 retries = 3 total calls
      expect(orchestrator._runAgent).toHaveBeenCalledTimes(3);
    });
  });
});
