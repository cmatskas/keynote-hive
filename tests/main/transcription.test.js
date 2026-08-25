/**
 * Tests for the transcribe-media / cancel-transcription IPC handlers in
 * bedrock.js.
 *
 * These cover the non-blocking transcription work:
 *  - a job can be cancelled mid-poll, and cancellation resolves as a
 *    CANCELLED status rather than throwing an error into the UI
 *  - Cancel wakes the poll loop immediately instead of waiting out the
 *    remaining 5s interval
 *  - Cancel best-effort deletes the Transcribe job, and a missing
 *    DeleteTranscriptionJob permission does not break cancellation
 *  - concurrent jobs are rejected (the renderer has a single transcript pane)
 *  - completion and failure raise an OS notification; cancellation does not
 */

jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockNotify = jest.fn();
jest.mock('../../src/main/notify', () => ({ notify: (...args) => mockNotify(...args) }));

jest.mock('@aws-sdk/client-s3', () => ({ GetObjectCommand: jest.fn() }));

const mockUploadDone = jest.fn(async () => {});
const mockUploadAbort = jest.fn(async () => {});
jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation(() => ({
    done: mockUploadDone,
    abort: mockUploadAbort,
  })),
}));

jest.mock('@aws-sdk/client-transcribe', () => ({
  StartTranscriptionJobCommand: jest.fn(function (input) { this.input = input; this._type = 'start'; }),
  GetTranscriptionJobCommand: jest.fn(function (input) { this.input = input; this._type = 'get'; }),
  DeleteTranscriptionJobCommand: jest.fn(function (input) { this.input = input; this._type = 'delete'; }),
}));

jest.mock('../../src/main/models/codeInterpreterManager', () => jest.fn());
jest.mock('../../src/main/models/transcriptMapper', () => jest.fn().mockImplementation(() => ({
  getAllTimestampedText: () => [{ startTime: 0, endTime: 1, speaker: '1', text: 'hello' }],
})));
jest.mock('../../src/main/models/strandsAgentFactory', () => ({
  createAgent: jest.fn(),
  isAnthropicModel: jest.fn(() => true),
}));
jest.mock('../../src/main/utils', () => ({ buildFileContentBlocks: jest.fn(async () => []) }));

const { register } = require('../../src/main/ipc/bedrock');

/** Collects handlers registered via ipcMain.handle so tests can invoke them. */
function buildHarness({ transcribeSend } = {}) {
  const handlers = {};
  const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; } };

  const ctx = {
    currentSettings: {
      bucketName: 'test-bucket',
      outputBucketName: 'test-out-bucket',
      transcriptionLanguage: 'en-US',
      region: 'us-east-1',
    },
    settingsManager: { loadSettings: jest.fn(async () => ctx.currentSettings) },
    mainWindow: { isDestroyed: () => false, webContents: { send: jest.fn() } },
    awsClients: {
      transcribe: { send: transcribeSend || jest.fn(async () => ({ TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } })) },
      s3: { send: jest.fn(async () => ({ Body: { transformToString: async () => '{}' } })) },
      agentCoreConfig: {},
    },
    transcriptionJob: null,
  };

  register(ipcMain, ctx);
  return { handlers, ctx };
}

const fakeEvent = () => ({ sender: { send: jest.fn() } });
const fakeFile = { buffer: [1, 2, 3], name: 'clip.mp4', type: 'video/mp4' };

/**
 * Yield to the event loop until `predicate` is true. Used instead of a fixed
 * number of microtask flushes so the tests don't depend on exactly how many
 * awaits the handler happens to perform before parking in the poll loop.
 */
async function waitUntil(predicate, label, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

/** Resolves once the poll loop is parked in cancellableSleep. */
const parkedInPoll = (ctx) => waitUntil(() => !!ctx.transcriptionJob?.wake, 'poll loop to park');

describe('transcribe-media cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  test('cancelling mid-poll resolves as CANCELLED instead of throwing', async () => {
    // Always IN_PROGRESS, so the job only ends when cancelled.
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type === 'get') return { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } };
      return {};
    });
    const { handlers, ctx } = buildHarness({ transcribeSend });

    const pending = handlers['transcribe-media'](fakeEvent(), { file: fakeFile });

    // Let the upload + StartTranscriptionJob + first poll settle so the job
    // is parked in cancellableSleep.
    await parkedInPoll(ctx);

    const cancelResult = await handlers['cancel-transcription']();
    expect(cancelResult).toEqual({ cancelled: true });

    // Resolves promptly (well under the 5s poll interval) because Cancel
    // wakes the sleep rather than letting it run out.
    const result = await pending;
    expect(result).toEqual({ status: 'CANCELLED' });
    expect(ctx.transcriptionJob).toBeNull();
  });

  test('cancel deletes the Transcribe job so it stops billing', async () => {
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type === 'get') return { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } };
      return {};
    });
    const { handlers, ctx } = buildHarness({ transcribeSend });

    const pending = handlers['transcribe-media'](fakeEvent(), { file: fakeFile });
    await parkedInPoll(ctx);

    await handlers['cancel-transcription']();
    await pending;

    const deleteCalls = transcribeSend.mock.calls.filter(([cmd]) => cmd._type === 'delete');
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0].input.TranscriptionJobName).toMatch(/^transcription-\d+$/);
  });

  test('a missing DeleteTranscriptionJob permission still cancels cleanly', async () => {
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type === 'delete') throw new Error('AccessDeniedException');
      if (cmd._type === 'get') return { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } };
      return {};
    });
    const { handlers, ctx } = buildHarness({ transcribeSend });

    const pending = handlers['transcribe-media'](fakeEvent(), { file: fakeFile });
    await parkedInPoll(ctx);

    await expect(handlers['cancel-transcription']()).resolves.toEqual({ cancelled: true });
    await expect(pending).resolves.toEqual({ status: 'CANCELLED' });
  });

  test('cancel with no job in flight is a no-op', async () => {
    const { handlers } = buildHarness();
    await expect(handlers['cancel-transcription']()).resolves.toEqual({ cancelled: false });
  });

  test('cancellation raises no OS notification (the user already knows)', async () => {
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type === 'get') return { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } };
      return {};
    });
    const { handlers, ctx } = buildHarness({ transcribeSend });

    const pending = handlers['transcribe-media'](fakeEvent(), { file: fakeFile });
    await parkedInPoll(ctx);
    await handlers['cancel-transcription']();
    await pending;

    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe('transcribe-media concurrency and notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  test('a second concurrent job is rejected rather than clobbering the first', async () => {
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type === 'get') return { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } };
      return {};
    });
    const { handlers, ctx } = buildHarness({ transcribeSend });

    const first = handlers['transcribe-media'](fakeEvent(), { file: fakeFile });
    await waitUntil(() => !!ctx.transcriptionJob, 'first job to register');

    await expect(handlers['transcribe-media'](fakeEvent(), { file: fakeFile }))
      .rejects.toThrow('A transcription is already in progress');

    await parkedInPoll(ctx);
    await handlers['cancel-transcription']();
    await first;
  });

  test('completion notifies with the file name and returns the transcript', async () => {
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type === 'get') {
        return {
          TranscriptionJob: {
            TranscriptionJobStatus: 'COMPLETED',
            Transcript: { TranscriptFileUri: 'https://s3.amazonaws.com/out-bucket/job/transcript.json' },
          },
        };
      }
      return {};
    });
    const { handlers, ctx } = buildHarness({ transcribeSend });

    const result = await handlers['transcribe-media'](fakeEvent(), { file: fakeFile });

    expect(result.status).toBe('COMPLETED');
    expect(result.transcript).toEqual([{ startTime: 0, endTime: 1, speaker: '1', text: 'hello' }]);
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Transcription Complete',
      body: expect.stringContaining('clip.mp4'),
    }));
    expect(ctx.transcriptionJob).toBeNull();
  });

  test('failure notifies with critical urgency and rethrows', async () => {
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type === 'get') {
        return { TranscriptionJob: { TranscriptionJobStatus: 'FAILED', FailureReason: 'Unsupported media format' } };
      }
      return {};
    });
    const { handlers, ctx } = buildHarness({ transcribeSend });

    await expect(handlers['transcribe-media'](fakeEvent(), { file: fakeFile }))
      .rejects.toThrow('Unsupported media format');

    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Transcription Failed',
      urgency: 'critical',
    }));
    // Job slot is released even on failure, so the next upload isn't blocked.
    expect(ctx.transcriptionJob).toBeNull();
  });

  test('clicking a notification asks the renderer to focus the Transcribe tab', async () => {
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type === 'get') {
        return {
          TranscriptionJob: {
            TranscriptionJobStatus: 'COMPLETED',
            Transcript: { TranscriptFileUri: 'https://s3.amazonaws.com/out-bucket/job/transcript.json' },
          },
        };
      }
      return {};
    });
    const { handlers, ctx } = buildHarness({ transcribeSend });

    await handlers['transcribe-media'](fakeEvent(), { file: fakeFile });

    const { onClick, window } = mockNotify.mock.calls[0][0];
    expect(window).toBe(ctx.mainWindow);
    onClick();
    expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('transcription-focus-request');
  });
});
