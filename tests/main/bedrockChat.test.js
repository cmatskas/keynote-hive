/**
 * Tests for bedrock.js's invokeChatModel() cancellation behavior (Chat tab
 * Stop button):
 *
 *  - The abort signal is passed to agent.stream() as cancelSignal, so the
 *    SDK aborts the in-flight model request instead of waiting for the next
 *    stream event to arrive (which for reasoning models can be a long gap).
 *  - An already-aborted signal short-circuits before the file-extraction
 *    phase (which spins up a Code Interpreter session).
 *  - An abort-shaped error thrown mid-stream is treated as a graceful stop:
 *    partial text is returned and bedrock-stream-complete still fires so
 *    the renderer UI resets.
 */

jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('@aws-sdk/client-s3', () => ({ GetObjectCommand: jest.fn() }));
jest.mock('@aws-sdk/lib-storage', () => ({ Upload: jest.fn() }));
jest.mock('@aws-sdk/client-transcribe', () => ({
  StartTranscriptionJobCommand: jest.fn(),
  GetTranscriptionJobCommand: jest.fn(),
  DeleteTranscriptionJobCommand: jest.fn(),
}));
jest.mock('../../src/main/models/codeInterpreterManager', () => jest.fn());
jest.mock('../../src/main/models/transcriptMapper', () => jest.fn());

const mockCreateAgent = jest.fn();
jest.mock('../../src/main/models/strandsAgentFactory', () => ({
  createAgent: (...args) => mockCreateAgent(...args),
  isAnthropicModel: jest.fn(() => true),
}));

const mockBuildFileContentBlocks = jest.fn(async () => []);
jest.mock('../../src/main/utils', () => ({
  // Only the file-block builder is stubbed. collectStreamText is passed through
  // deliberately: it is the shared stream accumulator, and these tests are the
  // best coverage of it against real SDK event shapes.
  ...jest.requireActual('../../src/main/utils'),
  buildFileContentBlocks: (...args) => mockBuildFileContentBlocks(...args),
}));

const { invokeChatModel } = require('../../src/main/ipc/bedrock');

function buildCtx() {
  return {
    currentSettings: { mantleApiKey: 'test-key', region: 'us-east-1' },
    settingsManager: { loadSettings: jest.fn(async () => ({ mantleApiKey: 'test-key', region: 'us-east-1' })) },
    awsClients: { agentCoreConfig: { region: 'us-east-1' } },
  };
}

/** Wraps stream events in an async generator, as agent.stream() returns. */
function streamOf(events) {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

function textDelta(text) {
  return { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } } };
}

describe('invokeChatModel cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('passes the abort signal to agent.stream() as cancelSignal', async () => {
    const stream = jest.fn().mockReturnValue(streamOf([textDelta('hi')]));
    mockCreateAgent.mockReturnValue({ agent: { stream }, dispose: jest.fn() });

    const controller = new AbortController();
    const result = await invokeChatModel(buildCtx(), 'model-x', 'hello', [], [], null, controller.signal);

    expect(stream).toHaveBeenCalledWith(expect.anything(), { cancelSignal: controller.signal });
    expect(result).toBe('hi');
  });

  test('passes cancelSignal: undefined when no signal is provided', async () => {
    const stream = jest.fn().mockReturnValue(streamOf([textDelta('hi')]));
    mockCreateAgent.mockReturnValue({ agent: { stream }, dispose: jest.fn() });

    await invokeChatModel(buildCtx(), 'model-x', 'hello', [], []);

    expect(stream).toHaveBeenCalledWith(expect.anything(), { cancelSignal: undefined });
  });

  test('short-circuits before file extraction when the signal is already aborted', async () => {
    const stream = jest.fn();
    mockCreateAgent.mockReturnValue({ agent: { stream }, dispose: jest.fn() });

    const controller = new AbortController();
    controller.abort();
    const result = await invokeChatModel(
      buildCtx(), 'model-x', 'hello', [],
      [{ name: 'doc.pdf', buffer: [1, 2, 3] }],
      null, controller.signal,
    );

    expect(result).toBe('');
    expect(mockBuildFileContentBlocks).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  test('treats an abort-shaped mid-stream error as a graceful stop: partial text + stream-complete still fires', async () => {
    const controller = new AbortController();
    const stream = jest.fn().mockReturnValue((async function* () {
      yield textDelta('Partial ');
      yield textDelta('answer.');
      controller.abort();
      const err = new Error('Request aborted');
      err.name = 'AbortError';
      throw err;
    })());
    const dispose = jest.fn();
    mockCreateAgent.mockReturnValue({ agent: { stream }, dispose });

    const send = jest.fn();
    const event = { sender: { send } };
    const result = await invokeChatModel(buildCtx(), 'model-x', 'hello', [], [], event, controller.signal);

    expect(result).toBe('Partial answer.');
    expect(send).toHaveBeenCalledWith('bedrock-stream-complete');
    expect(dispose).toHaveBeenCalled();
  });

  test('still rethrows stream errors when the signal is NOT aborted', async () => {
    const controller = new AbortController();
    const stream = jest.fn().mockReturnValue((async function* () {
      yield textDelta('x');
      throw new Error('real model failure');
    })());
    mockCreateAgent.mockReturnValue({ agent: { stream }, dispose: jest.fn() });

    await expect(
      invokeChatModel(buildCtx(), 'model-x', 'hello', [], [], null, controller.signal),
    ).rejects.toThrow('real model failure');
  });
});
