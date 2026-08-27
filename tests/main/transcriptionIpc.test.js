/**
 * Tests for the transcription IPC layer in ipc/bedrock.js.
 *
 * The runner is mocked here on purpose. These tests are about *delivery*, not
 * about running a job (see transcriptionRunner.test.js for that): the whole
 * point of this change is that the outcome no longer travels back as the
 * `transcribe-media` promise's resolution, because that promise dies with the
 * renderer. Any teardown between starting a job and its completion — the
 * credential-expiry navigation, a reload, a crash — used to discard a transcript
 * the main process had already successfully retrieved, while the job kept
 * running and billing on AWS.
 *
 * So: the handler returns as soon as the job is running, and the outcome arrives
 * as an event addressed by jobId.
 */

jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Chat-side dependencies of bedrock.js, unused by these tests.
jest.mock('../../src/main/models/codeInterpreterManager', () => jest.fn());
jest.mock('../../src/main/models/strandsAgentFactory', () => ({
  createAgent: jest.fn(),
  isAnthropicModel: jest.fn(() => true),
}));
jest.mock('../../src/main/utils', () => ({ buildFileContentBlocks: jest.fn(async () => []) }));

const mockRunTranscription = jest.fn();
const mockCancelTranscription = jest.fn(async () => ({ cancelled: true }));
const mockGetTranscriptionState = jest.fn(() => ({ active: false }));
const mockRenameActiveTranscription = jest.fn(() => ({ renamed: true }));
// `mock`-prefixed so the jest.mock factory may reference it.
const mockJobCounter = { n: 0 };

jest.mock('../../src/main/models/transcriptionRunner', () => ({
  runTranscription: (...args) => mockRunTranscription(...args),
  cancelTranscription: (...args) => mockCancelTranscription(...args),
  getTranscriptionState: (...args) => mockGetTranscriptionState(...args),
  renameActiveTranscription: (...args) => mockRenameActiveTranscription(...args),
  createJob: ({ sourceFile, displayName }) => ({
    jobId: `job-fixed-${++mockJobCounter.n}`,
    displayName: displayName || 'clip',
    sourceFile: sourceFile || null,
  }),
  // Real behaviour: resolve the window at send time.
  emitToRenderer: (ctx, channel, payload) => {
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send(channel, payload);
    }
  },
}));

const { register } = require('../../src/main/ipc/bedrock');

function buildHarness({ online = true } = {}) {
  const handlers = {};
  const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; } };
  const state = { online };
  const sent = [];

  const ctx = {
    currentSettings: { bucketName: 'in', outputBucketName: 'out', region: 'us-east-1' },
    settingsManager: { loadSettings: jest.fn(async () => ctx.currentSettings) },
    mainWindow: {
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
    },
    awsClients: { transcribe: { send: jest.fn() }, s3: { send: jest.fn() }, agentCoreConfig: {} },
    transcriptionJob: null,
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
  return { handlers, ctx, sent, state };
}

const fakeEvent = () => ({ sender: { send: jest.fn() } });
const fakeFile = { buffer: [1, 2, 3], name: 'clip.mp4', type: 'video/mp4' };

/** A runTranscription stand-in the test resolves or rejects on demand. */
function deferredRun() {
  let settle;
  mockRunTranscription.mockImplementation(() => new Promise((resolve, reject) => {
    settle = { resolve, reject };
  }));
  return { get settle() { return settle; } };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const eventsOn = (sent, channel) => sent.filter(e => e.channel === channel).map(e => e.payload);

beforeEach(() => {
  jest.clearAllMocks();
  mockJobCounter.n = 0;
  mockGetTranscriptionState.mockReturnValue({ active: false });
  mockCancelTranscription.mockResolvedValue({ cancelled: true });
});

describe('transcribe-media returns immediately', () => {
  test('resolves with STARTED and the job identity, without waiting for the job', async () => {
    const run = deferredRun();
    const { handlers } = buildHarness();

    const response = await handlers['transcribe-media'](fakeEvent(), { file: fakeFile });

    expect(response).toEqual({
      status: 'STARTED',
      jobId: 'job-fixed-1',
      displayName: 'clip',
      sourceFile: 'clip.mp4',
    });
    // Still running — the handler did not block on it.
    expect(run.settle).toBeDefined();
    run.settle.resolve({ status: 'CANCELLED', jobId: 'job-fixed-1' });
    await flush();
  });

  test('registers the job on the context so cancel and state queries can find it', async () => {
    deferredRun();
    const { handlers, ctx } = buildHarness();

    await handlers['transcribe-media'](fakeEvent(), { file: fakeFile });

    expect(ctx.transcriptionJob).toMatchObject({ jobId: 'job-fixed-1' });
  });

  test('passes an explicit display name through to the job', async () => {
    deferredRun();
    const { handlers, ctx } = buildHarness();

    await handlers['transcribe-media'](fakeEvent(), { file: fakeFile, displayName: 'Board review' });

    expect(ctx.transcriptionJob.displayName).toBe('Board review');
  });

  test('rejects a second concurrent job rather than clobbering the first', async () => {
    deferredRun();
    const { handlers } = buildHarness();

    await handlers['transcribe-media'](fakeEvent(), { file: fakeFile });

    await expect(handlers['transcribe-media'](fakeEvent(), { file: fakeFile }))
      .rejects.toThrow('A transcription is already in progress');
    expect(mockRunTranscription).toHaveBeenCalledTimes(1);
  });

  test('refuses to start while offline', async () => {
    const { handlers } = buildHarness({ online: false });

    await expect(handlers['transcribe-media'](fakeEvent(), { file: fakeFile }))
      .rejects.toThrow(/offline/i);
    expect(mockRunTranscription).not.toHaveBeenCalled();
  });

  test('refuses to start without AWS clients', async () => {
    const { handlers, ctx } = buildHarness();
    ctx.awsClients.transcribe = null;

    await expect(handlers['transcribe-media'](fakeEvent(), { file: fakeFile }))
      .rejects.toThrow('AWS credentials not configured');
  });
});

describe('terminal events', () => {
  test('a completed job emits transcription-complete carrying the transcript', async () => {
    const run = deferredRun();
    const { handlers, sent } = buildHarness();
    await handlers['transcribe-media'](fakeEvent(), { file: fakeFile });

    const result = {
      status: 'COMPLETED',
      jobId: 'job-fixed-1',
      transcript: [{ startTime: 0, endTime: 1, text: 'hello' }],
    };
    run.settle.resolve(result);
    await flush();

    expect(eventsOn(sent, 'transcription-complete')).toEqual([result]);
  });

  test('a cancelled job emits transcription-cancelled with the jobId', async () => {
    const run = deferredRun();
    const { handlers, sent } = buildHarness();
    await handlers['transcribe-media'](fakeEvent(), { file: fakeFile });

    run.settle.resolve({ status: 'CANCELLED', jobId: 'job-fixed-1' });
    await flush();

    expect(eventsOn(sent, 'transcription-cancelled')).toEqual([{ jobId: 'job-fixed-1' }]);
  });

  test('an abandoned job emits transcription-abandoned naming the still-running AWS job', async () => {
    const run = deferredRun();
    const { handlers, sent } = buildHarness();
    await handlers['transcribe-media'](fakeEvent(), { file: fakeFile });

    run.settle.resolve({
      status: 'ABANDONED',
      jobId: 'job-fixed-1',
      jobName: 'transcription-123',
      message: 'still running on AWS',
    });
    await flush();

    expect(eventsOn(sent, 'transcription-abandoned')[0]).toMatchObject({
      jobName: 'transcription-123',
      message: 'still running on AWS',
    });
  });

  test('a thrown failure emits transcription-failed with the message and code', async () => {
    const run = deferredRun();
    const { handlers, sent } = buildHarness();
    await handlers['transcribe-media'](fakeEvent(), { file: fakeFile });

    run.settle.reject(Object.assign(new Error('Unsupported media format'), {
      code: 'HIVE_TRANSCRIPTION_UNCONFIGURED',
    }));
    await flush();

    expect(eventsOn(sent, 'transcription-failed')).toEqual([{
      jobId: 'job-fixed-1',
      error: 'Unsupported media format',
      code: 'HIVE_TRANSCRIPTION_UNCONFIGURED',
    }]);
  });

  test('the job slot is released on every terminal path, so the next job is not blocked', async () => {
    for (const outcome of [
      () => ({ resolve: { status: 'COMPLETED', jobId: 'x', transcript: [] } }),
      () => ({ resolve: { status: 'CANCELLED', jobId: 'x' } }),
      () => ({ resolve: { status: 'ABANDONED', jobId: 'x' } }),
      () => ({ reject: new Error('boom') }),
    ]) {
      jest.clearAllMocks();
      const run = deferredRun();
      const { handlers, ctx } = buildHarness();
      await handlers['transcribe-media'](fakeEvent(), { file: fakeFile });
      expect(ctx.transcriptionJob).not.toBeNull();

      const o = outcome();
      if (o.resolve) run.settle.resolve(o.resolve); else run.settle.reject(o.reject);
      await flush();

      expect(ctx.transcriptionJob).toBeNull();
    }
  });

  test('an outcome arriving after the window is gone does not throw', async () => {
    // The exact scenario this change exists for: the renderer went away while
    // the job was still running.
    const run = deferredRun();
    const { handlers, ctx } = buildHarness();
    await handlers['transcribe-media'](fakeEvent(), { file: fakeFile });

    ctx.mainWindow = null;
    run.settle.resolve({ status: 'COMPLETED', jobId: 'job-fixed-1', transcript: [] });
    await flush();

    expect(ctx.transcriptionJob).toBeNull();
  });

  test('the outcome is not delivered via the invoking event.sender', async () => {
    // A captured sender is stale after a reload, so relying on it is what lost
    // transcripts. Delivery must go through the live window instead.
    const run = deferredRun();
    const { handlers } = buildHarness();
    const event = fakeEvent();
    await handlers['transcribe-media'](event, { file: fakeFile });

    run.settle.resolve({ status: 'COMPLETED', jobId: 'job-fixed-1', transcript: [] });
    await flush();

    expect(event.sender.send).not.toHaveBeenCalled();
  });
});

describe('re-attach and companion handlers', () => {
  test('get-transcription-state reports an in-flight job', async () => {
    mockGetTranscriptionState.mockReturnValue({
      active: true,
      jobId: 'job-fixed-1',
      displayName: 'clip',
      status: 'IN_PROGRESS',
      message: 'Processing audio... (10s elapsed)',
    });
    const { handlers } = buildHarness();

    // Synchronous handler — ipcMain.handle promisifies it in production, but
    // here it's called directly.
    expect(await handlers['get-transcription-state']()).toMatchObject({
      active: true,
      jobId: 'job-fixed-1',
      message: 'Processing audio... (10s elapsed)',
    });
  });

  test('get-transcription-state reports nothing running when idle', async () => {
    const { handlers } = buildHarness();
    expect(await handlers['get-transcription-state']()).toEqual({ active: false });
  });

  test('cancel-transcription delegates to the runner', async () => {
    const { handlers, ctx } = buildHarness();

    await expect(handlers['cancel-transcription']()).resolves.toEqual({ cancelled: true });
    expect(mockCancelTranscription).toHaveBeenCalledWith(ctx);
  });

  test('rename-transcription delegates to the runner with the job id and name', async () => {
    const { handlers, ctx } = buildHarness();

    await handlers['rename-transcription'](fakeEvent(), { jobId: 'job-fixed-1', displayName: 'Board review' });

    expect(mockRenameActiveTranscription).toHaveBeenCalledWith(ctx, 'job-fixed-1', 'Board review');
  });
});
