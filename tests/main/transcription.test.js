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

const { register, flushPendingTranscriptionDeletes } = require('../../src/main/ipc/bedrock');

/** Collects handlers registered via ipcMain.handle so tests can invoke them. */
function buildHarness({ transcribeSend, online = true } = {}) {
  const handlers = {};
  const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; } };

  const state = { online };

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
    // Mirrors AppContext's real implementations so the handlers' offline
    // guards behave the same way here as in production.
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

describe('transcribe-media configuration guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  /**
   * Both bucket settings default to empty and neither can have a default,
   * since S3 names are unique across all of AWS. `OutputBucketName` used to be
   * passed through unconditionally, so a blank setting sent an empty string —
   * which cannot satisfy the parameter's documented pattern. Nothing validated
   * it and Setup Check only ever looked at the input bucket, so the job failed
   * at AWS with an opaque error.
   */
  test('refuses the job when the output bucket is unset, naming the setting', async () => {
    const { handlers, ctx } = buildHarness();
    ctx.currentSettings = { ...ctx.currentSettings, outputBucketName: '' };

    await expect(handlers['transcribe-media'](fakeEvent(), { file: fakeFile }))
      .rejects.toThrow(/Output S3 Bucket is not set/);
  });

  test('refuses the job when the input bucket is unset', async () => {
    const { handlers, ctx } = buildHarness();
    ctx.currentSettings = { ...ctx.currentSettings, bucketName: '' };

    await expect(handlers['transcribe-media'](fakeEvent(), { file: fakeFile }))
      .rejects.toThrow(/Input S3 Bucket is not set/);
  });

  test('names both buckets when neither is set', async () => {
    const { handlers, ctx } = buildHarness();
    ctx.currentSettings = { ...ctx.currentSettings, bucketName: '', outputBucketName: '' };

    await expect(handlers['transcribe-media'](fakeEvent(), { file: fakeFile }))
      .rejects.toThrow(/Input S3 Bucket and Output S3 Bucket are not set/);
  });

  test('points the user at Settings and Setup Check', async () => {
    const { handlers, ctx } = buildHarness();
    ctx.currentSettings = { ...ctx.currentSettings, outputBucketName: '' };

    await expect(handlers['transcribe-media'](fakeEvent(), { file: fakeFile }))
      .rejects.toThrow(/Settings → Configuration.*Setup Check/s);
  });

  test('carries a recognisable error code rather than only a message', async () => {
    const { handlers, ctx } = buildHarness();
    ctx.currentSettings = { ...ctx.currentSettings, outputBucketName: '' };

    await expect(handlers['transcribe-media'](fakeEvent(), { file: fakeFile }))
      .rejects.toMatchObject({ code: 'HIVE_TRANSCRIPTION_UNCONFIGURED' });
  });

  test('does not upload the media before failing — a misconfigured job costs nothing', async () => {
    // Failing after the upload would leave the file sitting in S3, billed, for
    // a job that was never startable.
    const { Upload } = require('@aws-sdk/lib-storage');
    const transcribeSend = jest.fn(async () => ({}));
    const { handlers, ctx } = buildHarness({ transcribeSend });
    ctx.currentSettings = { ...ctx.currentSettings, outputBucketName: '' };

    await expect(handlers['transcribe-media'](fakeEvent(), { file: fakeFile })).rejects.toThrow();

    expect(Upload).not.toHaveBeenCalled();
    expect(mockUploadDone).not.toHaveBeenCalled();
    expect(transcribeSend).not.toHaveBeenCalled();
  });

  test('releases the job slot so a corrected retry is not blocked', async () => {
    const { handlers, ctx } = buildHarness();
    ctx.currentSettings = { ...ctx.currentSettings, outputBucketName: '' };

    await expect(handlers['transcribe-media'](fakeEvent(), { file: fakeFile })).rejects.toThrow();

    expect(ctx.transcriptionJob).toBeNull();
  });

  test('a fully configured job proceeds past the guard', async () => {
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type !== 'get') return {};
      return {
        TranscriptionJob: {
          TranscriptionJobStatus: 'COMPLETED',
          Transcript: { TranscriptFileUri: 'https://s3.amazonaws.com/out/job/transcript.json' },
        },
      };
    });
    const { handlers } = buildHarness({ transcribeSend });

    const result = await handlers['transcribe-media'](fakeEvent(), { file: fakeFile });

    expect(result.status).toBe('COMPLETED');
    // The output bucket is still handed to Transcribe as configured.
    const startCall = transcribeSend.mock.calls.find(([cmd]) => cmd._type === 'start');
    expect(startCall[0].input.OutputBucketName).toBe('test-out-bucket');
  });
});

describe('transcribe-media offline and auth pausing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  /** An error shaped the way the SDK reports a transport failure. */
  const networkError = () => Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
  /** An error shaped the way STS reports an expired session token. */
  const authError = () => Object.assign(new Error('The security token included in the request is expired'), {
    name: 'ExpiredTokenException',
    $metadata: { httpStatusCode: 403, attempts: 1 },
  });

  test('a network failure mid-poll pauses the job instead of failing it', async () => {
    // The job is still running and billing on AWS — failing here would discard
    // work the user has already paid for.
    let polls = 0;
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type !== 'get') return {};
      polls++;
      if (polls === 1) throw networkError();
      return {
        TranscriptionJob: {
          TranscriptionJobStatus: 'COMPLETED',
          Transcript: { TranscriptFileUri: 'https://s3.amazonaws.com/out/job/transcript.json' },
        },
      };
    });
    const { handlers, ctx } = buildHarness({ transcribeSend });
    const event = fakeEvent();

    const pending = handlers['transcribe-media'](event, { file: fakeFile });
    await waitUntil(() => !!ctx.transcriptionJob?.resume, 'job to park');

    // The renderer is told it's paused, not that it failed.
    const paused = event.sender.send.mock.calls
      .map(([, data]) => data)
      .find(d => d.status === 'PAUSED');
    expect(paused).toBeDefined();
    expect(paused.reason).toBe('network');
    expect(paused.message).toMatch(/still running on AWS/i);

    // An OS notification says paused, not failed.
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Transcription Paused' }));

    // Reconnecting resumes the same job and it completes normally.
    ctx.transcriptionJob.resume('network');
    const result = await pending;

    expect(result.status).toBe('COMPLETED');
    expect(result.transcript).toEqual([{ startTime: 0, endTime: 1, speaker: '1', text: 'hello' }]);
  });

  test('an expired token mid-poll pauses rather than failing, and resumes on new credentials', async () => {
    // Isengard-style credentials are typically 1 hour, so mid-job expiry on a
    // multi-minute transcription is routine, not a corner case.
    let polls = 0;
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type !== 'get') return {};
      polls++;
      if (polls === 1) throw authError();
      return {
        TranscriptionJob: {
          TranscriptionJobStatus: 'COMPLETED',
          Transcript: { TranscriptFileUri: 'https://s3.amazonaws.com/out/job/transcript.json' },
        },
      };
    });
    const { handlers, ctx } = buildHarness({ transcribeSend });
    const event = fakeEvent();

    const pending = handlers['transcribe-media'](event, { file: fakeFile });
    await waitUntil(() => !!ctx.transcriptionJob?.resume, 'job to park');

    const paused = event.sender.send.mock.calls
      .map(([, data]) => data)
      .find(d => d.status === 'PAUSED');
    expect(paused.reason).toBe('auth');
    expect(paused.message).toMatch(/credentials/i);

    ctx.transcriptionJob.resume('auth');
    const result = await pending;
    expect(result.status).toBe('COMPLETED');
  });

  test('emits a resumed message once the observation succeeds again', async () => {
    let polls = 0;
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type !== 'get') return {};
      polls++;
      if (polls === 1) throw networkError();
      return {
        TranscriptionJob: {
          TranscriptionJobStatus: 'COMPLETED',
          Transcript: { TranscriptFileUri: 'https://s3.amazonaws.com/out/job/transcript.json' },
        },
      };
    });
    const { handlers, ctx } = buildHarness({ transcribeSend });
    const event = fakeEvent();

    const pending = handlers['transcribe-media'](event, { file: fakeFile });
    await waitUntil(() => !!ctx.transcriptionJob?.resume, 'job to park');
    ctx.transcriptionJob.resume('network');
    await pending;

    const messages = event.sender.send.mock.calls.map(([, data]) => data.message);
    expect(messages.some(m => /Connection restored/i.test(m))).toBe(true);
  });

  test('paused time does not consume the poll attempt budget', async () => {
    // The 60-attempt budget bounds how long the *job* may take. Time spent
    // waiting for a connection is a separate concern with its own budget.
    let getCalls = 0;
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type !== 'get') return {};
      getCalls++;
      if (getCalls <= 3) throw networkError();
      return {
        TranscriptionJob: {
          TranscriptionJobStatus: 'COMPLETED',
          Transcript: { TranscriptFileUri: 'https://s3.amazonaws.com/out/job/transcript.json' },
        },
      };
    });
    const { handlers, ctx } = buildHarness({ transcribeSend });

    const pending = handlers['transcribe-media'](fakeEvent(), { file: fakeFile });

    // Three separate pauses, each resumed — all within the first attempt.
    // Waits on `resume` rather than `paused`: `resume` exists only while the
    // job is genuinely parked, so this can't latch onto a stale state.
    for (let i = 0; i < 3; i++) {
      await waitUntil(() => !!ctx.transcriptionJob?.resume, `pause ${i + 1}`);
      ctx.transcriptionJob.resume('network');
    }

    const result = await pending;
    expect(result.status).toBe('COMPLETED');
    // 4 GetTranscriptionJob calls, but the loop never advanced past attempt 0.
    expect(getCalls).toBe(4);
  });

  test('cancelling while paused stops the job promptly', async () => {
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type === 'get') throw networkError();
      return {};
    });
    const { handlers, ctx } = buildHarness({ transcribeSend });

    const pending = handlers['transcribe-media'](fakeEvent(), { file: fakeFile });
    await waitUntil(() => !!ctx.transcriptionJob?.resume, 'job to park');

    await handlers['cancel-transcription']();

    await expect(pending).resolves.toEqual({ status: 'CANCELLED' });
  });

  test('cancelling while offline queues the delete so billing still stops later', async () => {
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type === 'get') return { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } };
      return {};
    });
    const { handlers, ctx, state } = buildHarness({ transcribeSend });

    const pending = handlers['transcribe-media'](fakeEvent(), { file: fakeFile });
    await parkedInPoll(ctx);

    // Connection drops, then the user cancels.
    state.online = false;
    await handlers['cancel-transcription']();
    await pending;

    // No delete attempted while offline...
    expect(transcribeSend.mock.calls.filter(([c]) => c._type === 'delete')).toHaveLength(0);
    // ...but it's queued rather than lost.
    expect(ctx.pendingTranscriptionDeletes).toEqual([expect.stringMatching(/^transcription-\d+$/)]);

    // On reconnect the queued delete is flushed.
    state.online = true;
    await flushPendingTranscriptionDeletes(ctx);

    expect(transcribeSend.mock.calls.filter(([c]) => c._type === 'delete')).toHaveLength(1);
    expect(ctx.pendingTranscriptionDeletes).toEqual([]);
  });

  test('a queued delete that fails on the network stays queued', async () => {
    const { ctx, state } = buildHarness({
      transcribeSend: jest.fn(async () => { throw networkError(); }),
    });
    ctx.pendingTranscriptionDeletes = ['transcription-123'];
    state.online = true;

    await flushPendingTranscriptionDeletes(ctx);

    expect(ctx.pendingTranscriptionDeletes).toEqual(['transcription-123']);
  });

  test('an AccessDenied on delete is dropped rather than retried forever', async () => {
    // DeleteTranscriptionJob is documented as an optional permission.
    const { ctx, state } = buildHarness({
      transcribeSend: jest.fn(async () => {
        throw Object.assign(new Error('not authorized'), {
          name: 'AccessDeniedException',
          $metadata: { httpStatusCode: 403 },
        });
      }),
    });
    ctx.pendingTranscriptionDeletes = ['transcription-123'];
    state.online = true;

    await flushPendingTranscriptionDeletes(ctx);

    expect(ctx.pendingTranscriptionDeletes).toEqual([]);
  });

  test('a genuine service error still fails the job rather than pausing', async () => {
    // Throttling and validation errors mean AWS answered — pausing on those
    // would hide real failures behind an indefinite "waiting" state.
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type !== 'get') return {};
      throw Object.assign(new Error('Rate exceeded'), {
        name: 'ThrottlingException',
        $metadata: { httpStatusCode: 429 },
      });
    });
    const { handlers } = buildHarness({ transcribeSend });

    await expect(handlers['transcribe-media'](fakeEvent(), { file: fakeFile }))
      .rejects.toThrow('Rate exceeded');
  });

  test('a network failure fetching the finished transcript pauses instead of discarding it', async () => {
    // AWS has already produced the transcript at this point; failing here would
    // throw away completed, paid-for work.
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type !== 'get') return {};
      return {
        TranscriptionJob: {
          TranscriptionJobStatus: 'COMPLETED',
          Transcript: { TranscriptFileUri: 'https://s3.amazonaws.com/out/job/transcript.json' },
        },
      };
    });
    const { handlers, ctx } = buildHarness({ transcribeSend });

    let s3Calls = 0;
    ctx.awsClients.s3.send = jest.fn(async () => {
      s3Calls++;
      if (s3Calls === 1) throw networkError();
      return { Body: { transformToString: async () => '{}' } };
    });

    const pending = handlers['transcribe-media'](fakeEvent(), { file: fakeFile });
    await waitUntil(() => !!ctx.transcriptionJob?.resume, 'result fetch to park');
    ctx.transcriptionJob.resume('network');

    const result = await pending;
    expect(result.status).toBe('COMPLETED');
    expect(s3Calls).toBe(2);
  });

  test('refuses to start a transcription while offline', async () => {
    const { handlers } = buildHarness({ online: false });

    await expect(handlers['transcribe-media'](fakeEvent(), { file: fakeFile }))
      .rejects.toThrow(/offline/i);
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
