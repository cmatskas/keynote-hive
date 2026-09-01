/**
 * Tests for transcriptionRunner.js — the transcription job state machine.
 *
 * These are the behaviour tests that used to live in transcription.test.js
 * against the IPC handler. They now target the runner directly, because running
 * a job and delivering its result are deliberately separate concerns: the runner
 * resolves with an outcome and emits progress, and the IPC layer turns that
 * outcome into an event (see transcriptionIpc.test.js).
 *
 * The guarantees worth protecting here:
 *  - A misconfigured job costs nothing — it fails before the upload.
 *  - A network drop or an expired token *pauses* the job rather than failing it.
 *    AWS keeps running and billing for the job either way; only Hive's ability
 *    to observe it is broken, so discarding it would throw away paid-for work.
 *  - Paused time doesn't consume the poll budget, which bounds how long a job
 *    may take, not how long the network is down.
 *  - Cancelling stops the AWS job so it stops billing, even if that has to wait
 *    for the connection to return.
 */

jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockNotify = jest.fn();
jest.mock('../../src/main/notify', () => ({ notify: (...args) => mockNotify(...args) }));

jest.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: jest.fn((input) => ({ _type: 's3get', input })),
  PutObjectCommand: jest.fn((input) => ({ _type: 's3put', input })),
}));

const mockUploadDone = jest.fn(async () => {});
const mockUploadAbort = jest.fn(async () => {});
jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation(() => ({ done: mockUploadDone, abort: mockUploadAbort })),
}));

jest.mock('@aws-sdk/client-transcribe', () => ({
  StartTranscriptionJobCommand: jest.fn(function (input) { this.input = input; this._type = 'start'; }),
  GetTranscriptionJobCommand: jest.fn(function (input) { this.input = input; this._type = 'get'; }),
  DeleteTranscriptionJobCommand: jest.fn(function (input) { this.input = input; this._type = 'delete'; }),
}));

jest.mock('../../src/main/models/transcriptMapper', () => jest.fn().mockImplementation(() => ({
  getAllTimestampedText: () => [{ startTime: 0, endTime: 1, speaker: '1', text: 'hello' }],
})));

const runner = require('../../src/main/models/transcriptionRunner');

const fakeFile = { buffer: [1, 2, 3], name: 'clip.mp4', type: 'video/mp4' };

/**
 * Fake app context. `mainWindow.webContents.send` stands in for the renderer, so
 * emitted progress can be asserted — note the runner resolves the window at send
 * time rather than capturing a sender, which is what makes re-attach work.
 */
function buildCtx({ transcribeSend, online = true } = {}) {
  const state = { online };
  const sent = [];
  const ctx = {
    currentSettings: {
      bucketName: 'test-bucket',
      outputBucketName: 'test-out-bucket',
      transcriptionLanguage: 'en-US',
      region: 'us-east-1',
    },
    settingsManager: { loadSettings: jest.fn(async () => ctx.currentSettings) },
    mainWindow: {
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
    },
    awsClients: {
      transcribe: { send: transcribeSend || jest.fn(async () => ({ TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } })) },
      s3: { send: jest.fn(async () => ({ Body: { transformToString: async () => '{}' } })) },
      agentCoreConfig: {},
    },
    transcriptionJob: null,
    isOnline: () => state.online,
    // In-memory stand-in for the on-disk registry (covered by its own suite).
    transcriptionRegistry: {
      saved: [],
      save: jest.fn(async (record, transcript) => {
        const stored = { ...record, hasTranscript: !!(transcript && transcript.length) };
        ctx.transcriptionRegistry.saved.push({ record: stored, transcript });
        return stored;
      }),
      rename: jest.fn(async () => null),
    },
  };
  return { ctx, sent, state };
}

/** Starts a job the way the IPC handler does, without the event delivery. */
function startJob(ctx, { displayName = null } = {}) {
  const job = runner.createJob({ sourceFile: fakeFile.name, displayName });
  ctx.transcriptionJob = job;
  const promise = runner.runTranscription(ctx, job, { file: fakeFile });
  return { job, promise };
}

async function waitUntil(predicate, label, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

/** Resolves once the job is parked (parked jobs expose resume()). */
const parked = (job) => waitUntil(() => !!job.resume, 'job to park');
/** Resolves once the poll loop is asleep between polls. */
const pollingAsleep = (job) => waitUntil(() => !!job.wake, 'poll loop to sleep');

const progressOf = (sent) => sent.filter(e => e.channel === 'transcription-progress').map(e => e.payload);

const networkError = () => Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
const authError = () => Object.assign(new Error('The security token included in the request is expired'), {
  name: 'ExpiredTokenException',
  $metadata: { httpStatusCode: 403, attempts: 1 },
});
const completedJob = () => ({
  TranscriptionJob: {
    TranscriptionJobStatus: 'COMPLETED',
    Transcript: { TranscriptFileUri: 'https://s3.amazonaws.com/out/job/transcript.json' },
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUploadDone.mockResolvedValue({});
});

describe('createJob / deriveDisplayName', () => {
  test('derives a display name from the file name, extension stripped', () => {
    expect(runner.deriveDisplayName('AWS Keynote Draft 3.mp4')).toBe('AWS Keynote Draft 3');
  });

  test('keeps the name human-readable rather than slugifying it', () => {
    // This is the label the user sees and edits; the slug lives in the AWS job
    // name, which is a separate concern.
    expect(runner.deriveDisplayName('Customer interview — May.m4a')).toBe('Customer interview — May');
  });

  test('copes with no extension and with an empty name', () => {
    expect(runner.deriveDisplayName('recording')).toBe('recording');
    expect(runner.deriveDisplayName('')).toBe('Untitled transcription');
    expect(runner.deriveDisplayName(null)).toBe('Untitled transcription');
  });

  test('assigns a jobId up front, before the AWS job name is known', () => {
    // The AWS name isn't available until the media has uploaded, which is far
    // too late to attribute the first progress events.
    const job = runner.createJob({ sourceFile: 'clip.mp4' });
    expect(job.jobId).toMatch(/^job-\d+-[a-z0-9]+$/);
    expect(job.jobName).toBeNull();
  });

  test('an explicit display name overrides the derived one', () => {
    const job = runner.createJob({ sourceFile: 'clip.mp4', displayName: 'Board review' });
    expect(job.displayName).toBe('Board review');
  });
});

describe('configuration guard', () => {
  test('rejects a blank output bucket before anything is spent', async () => {
    const { Upload } = require('@aws-sdk/lib-storage');
    const { ctx } = buildCtx();
    ctx.currentSettings = { ...ctx.currentSettings, outputBucketName: '' };

    const { promise } = startJob(ctx);
    await expect(promise).rejects.toThrow(/Output S3 Bucket is not set/);

    // Failing after the upload would leave the media billed in S3 for a job
    // that was never startable.
    expect(Upload).not.toHaveBeenCalled();
  });

  test('rejects a blank input bucket', async () => {
    const { ctx } = buildCtx();
    ctx.currentSettings = { ...ctx.currentSettings, bucketName: '' };

    await expect(startJob(ctx).promise).rejects.toThrow(/Input S3 Bucket is not set/);
  });

  test('names both buckets when neither is set and carries a recognisable code', async () => {
    const { ctx } = buildCtx();
    ctx.currentSettings = { ...ctx.currentSettings, bucketName: '', outputBucketName: '' };

    await expect(startJob(ctx).promise).rejects.toMatchObject({
      code: 'HIVE_TRANSCRIPTION_UNCONFIGURED',
      message: expect.stringMatching(/Input S3 Bucket and Output S3 Bucket are not set/),
    });
  });

  test('assertTranscriptionConfigured passes when both are set', () => {
    expect(() => runner.assertTranscriptionConfigured({
      bucketName: 'in', outputBucketName: 'out',
    })).not.toThrow();
  });
});

describe('happy path', () => {
  test('completes, returning the transcript and the recorded identifiers', async () => {
    const transcribeSend = jest.fn(async (cmd) => (cmd._type === 'get' ? completedJob() : {}));
    const { ctx, sent } = buildCtx({ transcribeSend });

    const { job, promise } = startJob(ctx);
    const result = await promise;

    expect(result).toMatchObject({
      status: 'COMPLETED',
      jobId: job.jobId,
      displayName: 'clip',
      sourceFile: 'clip.mp4',
      transcript: [{ startTime: 0, endTime: 1, speaker: '1', text: 'hello' }],
    });
    expect(result.jobName).toMatch(/^transcription-\d+$/);

    // The media key is not derivable from the AWS job name, so it has to be
    // captured at upload time or it's unrecoverable.
    expect(result.mediaKey).toMatch(/^\d+-clip\.mp4$/);

    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Transcription Complete',
      body: expect.stringContaining('clip'),
    }));
    expect(progressOf(sent).map(p => p.status)).toEqual(
      expect.arrayContaining(['UPLOADING', 'IN_PROGRESS', 'RETRIEVING'])
    );
  });

  test('every progress event carries the jobId', async () => {
    const transcribeSend = jest.fn(async (cmd) => (cmd._type === 'get' ? completedJob() : {}));
    const { ctx, sent } = buildCtx({ transcribeSend });

    const { job, promise } = startJob(ctx);
    await promise;

    for (const p of progressOf(sent)) expect(p.jobId).toBe(job.jobId);
  });

  test('passes the configured output bucket to AWS', async () => {
    const transcribeSend = jest.fn(async (cmd) => (cmd._type === 'get' ? completedJob() : {}));
    const { ctx } = buildCtx({ transcribeSend });

    await startJob(ctx).promise;

    const start = transcribeSend.mock.calls.find(([cmd]) => cmd._type === 'start');
    expect(start[0].input.OutputBucketName).toBe('test-out-bucket');
  });

  test('a genuine job failure rejects and notifies', async () => {
    const transcribeSend = jest.fn(async (cmd) => (cmd._type === 'get'
      ? { TranscriptionJob: { TranscriptionJobStatus: 'FAILED', FailureReason: 'Unsupported media format' } }
      : {}));
    const { ctx } = buildCtx({ transcribeSend });

    await expect(startJob(ctx).promise).rejects.toThrow('Unsupported media format');
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Transcription Failed',
      urgency: 'critical',
    }));
  });

  test('a genuine service error fails rather than pausing', async () => {
    // Throttling means AWS answered — pausing on it would hide a real failure
    // behind an indefinite "waiting" state.
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type !== 'get') return {};
      throw Object.assign(new Error('Rate exceeded'), {
        name: 'ThrottlingException',
        $metadata: { httpStatusCode: 429 },
      });
    });
    const { ctx } = buildCtx({ transcribeSend });

    await expect(startJob(ctx).promise).rejects.toThrow('Rate exceeded');
  });
});

describe('pausing and resuming', () => {
  test('a network failure mid-poll pauses instead of failing', async () => {
    let polls = 0;
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type !== 'get') return {};
      polls++;
      if (polls === 1) throw networkError();
      return completedJob();
    });
    const { ctx, sent } = buildCtx({ transcribeSend });

    const { job, promise } = startJob(ctx);
    await parked(job);

    const paused = progressOf(sent).find(p => p.status === 'PAUSED');
    expect(paused).toBeDefined();
    expect(paused.reason).toBe('network');
    expect(paused.message).toMatch(/still running on AWS/i);
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Transcription Paused' }));

    job.resume('network');
    await expect(promise).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  test('an expired token pauses and resumes on new credentials', async () => {
    // Isengard-style credentials are typically 1 hour, so mid-job expiry on a
    // multi-minute transcription is routine.
    let polls = 0;
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type !== 'get') return {};
      polls++;
      if (polls === 1) throw authError();
      return completedJob();
    });
    const { ctx, sent } = buildCtx({ transcribeSend });

    const { job, promise } = startJob(ctx);
    await parked(job);

    expect(progressOf(sent).find(p => p.status === 'PAUSED').reason).toBe('auth');

    job.resume('auth');
    await expect(promise).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  test('announces recovery once the observation succeeds again', async () => {
    let polls = 0;
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type !== 'get') return {};
      polls++;
      if (polls === 1) throw networkError();
      return completedJob();
    });
    const { ctx, sent } = buildCtx({ transcribeSend });

    const { job, promise } = startJob(ctx);
    await parked(job);
    job.resume('network');
    await promise;

    expect(progressOf(sent).some(p => /Connection restored/i.test(p.message))).toBe(true);
  });

  test('paused time does not consume the poll attempt budget', async () => {
    let gets = 0;
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type !== 'get') return {};
      gets++;
      if (gets <= 3) throw networkError();
      return completedJob();
    });
    const { ctx } = buildCtx({ transcribeSend });

    const { job, promise } = startJob(ctx);
    for (let i = 0; i < 3; i++) {
      await parked(job);
      job.resume('network');
    }

    await expect(promise).resolves.toMatchObject({ status: 'COMPLETED' });
    // Four polls, but the loop never advanced past attempt 0.
    expect(gets).toBe(4);
  });

  test('notifies once per job, not once per pause', async () => {
    // A flapping connection would otherwise produce a stream of notifications.
    let gets = 0;
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type !== 'get') return {};
      gets++;
      if (gets <= 3) throw networkError();
      return completedJob();
    });
    const { ctx } = buildCtx({ transcribeSend });

    const { job, promise } = startJob(ctx);
    for (let i = 0; i < 3; i++) {
      await parked(job);
      job.resume('network');
    }
    await promise;

    const pausedNotifications = mockNotify.mock.calls.filter(([o]) => o.title === 'Transcription Paused');
    expect(pausedNotifications).toHaveLength(1);
  });

  test('a network failure fetching the finished transcript pauses instead of discarding it', async () => {
    // AWS has already produced the transcript here; failing would throw away
    // completed, paid-for work.
    const transcribeSend = jest.fn(async (cmd) => (cmd._type === 'get' ? completedJob() : {}));
    const { ctx } = buildCtx({ transcribeSend });

    // Counts transcript fetches specifically — the sidecar write is also an S3
    // call, and it isn't what this test is about.
    let fetches = 0;
    ctx.awsClients.s3.send = jest.fn(async (cmd) => {
      if (cmd._type !== 's3get') return {};
      fetches++;
      if (fetches === 1) throw networkError();
      return { Body: { transformToString: async () => '{}' } };
    });

    const { job, promise } = startJob(ctx);
    await parked(job);
    job.resume('network');

    await expect(promise).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(fetches).toBe(2);
  });

  test('reports the network failure to the connectivity monitor rather than assuming', async () => {
    // One flaky endpoint shouldn't declare the whole app offline.
    const reportNetworkFailure = jest.fn();
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type !== 'get') return {};
      throw networkError();
    });
    const { ctx } = buildCtx({ transcribeSend });
    ctx.connectivityMonitor = { reportNetworkFailure };

    const { job } = startJob(ctx);
    await parked(job);

    expect(reportNetworkFailure).toHaveBeenCalled();
    job.cancelled = true;
    job.wake();
  });
});

describe('cancellation', () => {
  test('cancelling mid-poll resolves as CANCELLED rather than throwing', async () => {
    const transcribeSend = jest.fn(async (cmd) => (cmd._type === 'get'
      ? { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } } : {}));
    const { ctx } = buildCtx({ transcribeSend });

    const { job, promise } = startJob(ctx);
    await pollingAsleep(job);

    await expect(runner.cancelTranscription(ctx)).resolves.toMatchObject({ cancelled: true });
    await expect(promise).resolves.toMatchObject({ status: 'CANCELLED', jobId: job.jobId });
  });

  test('cancelling deletes the AWS job so it stops billing', async () => {
    const transcribeSend = jest.fn(async (cmd) => (cmd._type === 'get'
      ? { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } } : {}));
    const { ctx } = buildCtx({ transcribeSend });

    const { job, promise } = startJob(ctx);
    await pollingAsleep(job);
    await runner.cancelTranscription(ctx);
    await promise;

    const deletes = transcribeSend.mock.calls.filter(([cmd]) => cmd._type === 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0].input.TranscriptionJobName).toMatch(/^transcription-\d+$/);
  });

  test('cancelling while paused stops the job promptly', async () => {
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type === 'get') throw networkError();
      return {};
    });
    const { ctx } = buildCtx({ transcribeSend });

    const { job, promise } = startJob(ctx);
    await parked(job);

    await runner.cancelTranscription(ctx);
    await expect(promise).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  test('a missing DeleteTranscriptionJob permission still cancels cleanly', async () => {
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type === 'delete') throw Object.assign(new Error('not authorized'), {
        name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 },
      });
      if (cmd._type === 'get') return { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } };
      return {};
    });
    const { ctx } = buildCtx({ transcribeSend });

    const { job, promise } = startJob(ctx);
    await pollingAsleep(job);

    await expect(runner.cancelTranscription(ctx)).resolves.toMatchObject({ cancelled: true });
    await expect(promise).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  test('cancelling raises no OS notification — the user already knows', async () => {
    const transcribeSend = jest.fn(async (cmd) => (cmd._type === 'get'
      ? { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } } : {}));
    const { ctx } = buildCtx({ transcribeSend });

    const { job, promise } = startJob(ctx);
    await pollingAsleep(job);
    await runner.cancelTranscription(ctx);
    await promise;

    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('cancel with no job in flight is a no-op', async () => {
    const { ctx } = buildCtx();
    await expect(runner.cancelTranscription(ctx)).resolves.toEqual({ cancelled: false });
  });

  test('cancelling aborts an in-flight upload instead of waiting it out', async () => {
    let releaseUpload;
    mockUploadDone.mockImplementation(() => new Promise(resolve => { releaseUpload = resolve; }));
    const { ctx } = buildCtx();

    const { job, promise } = startJob(ctx);
    await waitUntil(() => !!job.upload, 'upload to start');

    await runner.cancelTranscription(ctx);
    expect(mockUploadAbort).toHaveBeenCalled();

    releaseUpload({});
    await expect(promise).resolves.toMatchObject({ status: 'CANCELLED' });
  });
});

describe('queued deletes while offline', () => {
  test('cancelling offline queues the delete so billing still stops later', async () => {
    const transcribeSend = jest.fn(async (cmd) => (cmd._type === 'get'
      ? { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } } : {}));
    const { ctx, state } = buildCtx({ transcribeSend });

    const { job, promise } = startJob(ctx);
    await pollingAsleep(job);

    state.online = false;
    await runner.cancelTranscription(ctx);
    await promise;

    expect(transcribeSend.mock.calls.filter(([c]) => c._type === 'delete')).toHaveLength(0);
    expect(ctx.pendingTranscriptionDeletes).toEqual([expect.stringMatching(/^transcription-\d+$/)]);

    state.online = true;
    await runner.flushPendingTranscriptionDeletes(ctx);

    expect(transcribeSend.mock.calls.filter(([c]) => c._type === 'delete')).toHaveLength(1);
    expect(ctx.pendingTranscriptionDeletes).toEqual([]);
  });

  test('a queued delete that fails on the network stays queued', async () => {
    const { ctx } = buildCtx({ transcribeSend: jest.fn(async () => { throw networkError(); }) });
    ctx.pendingTranscriptionDeletes = ['transcription-123'];

    await runner.flushPendingTranscriptionDeletes(ctx);

    expect(ctx.pendingTranscriptionDeletes).toEqual(['transcription-123']);
  });

  test('an AccessDenied on delete is dropped rather than retried forever', async () => {
    const { ctx } = buildCtx({
      transcribeSend: jest.fn(async () => {
        throw Object.assign(new Error('not authorized'), {
          name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 },
        });
      }),
    });
    ctx.pendingTranscriptionDeletes = ['transcription-123'];

    await runner.flushPendingTranscriptionDeletes(ctx);

    expect(ctx.pendingTranscriptionDeletes).toEqual([]);
  });

  test('flushing with nothing queued does no work', async () => {
    const transcribeSend = jest.fn(async () => ({}));
    const { ctx } = buildCtx({ transcribeSend });

    await runner.flushPendingTranscriptionDeletes(ctx);

    expect(transcribeSend).not.toHaveBeenCalled();
  });
});

describe('state reporting and rename', () => {
  test('getTranscriptionState reports no active job when idle', () => {
    const { ctx } = buildCtx();
    expect(runner.getTranscriptionState(ctx)).toEqual({ active: false });
  });

  test('getTranscriptionState exposes enough to rebuild a reloaded pane', async () => {
    const transcribeSend = jest.fn(async (cmd) => (cmd._type === 'get'
      ? { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } } : {}));
    const { ctx } = buildCtx({ transcribeSend });

    const { job, promise } = startJob(ctx);
    await pollingAsleep(job);

    expect(runner.getTranscriptionState(ctx)).toMatchObject({
      active: true,
      jobId: job.jobId,
      displayName: 'clip',
      sourceFile: 'clip.mp4',
      status: 'IN_PROGRESS',
      message: expect.stringMatching(/Processing audio/),
    });

    job.cancelled = true;
    job.wake();
    await promise;
  });

  test('getTranscriptionState surfaces the pause reason', async () => {
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type === 'get') throw networkError();
      return {};
    });
    const { ctx } = buildCtx({ transcribeSend });

    const { job, promise } = startJob(ctx);
    await parked(job);

    expect(runner.getTranscriptionState(ctx)).toMatchObject({
      status: 'PAUSED',
      pauseReason: 'network',
    });

    job.cancelled = true;
    job.wake();
    await promise;
  });

  test('renaming the active job updates its display name', () => {
    const { ctx } = buildCtx();
    const job = runner.createJob({ sourceFile: 'clip.mp4' });
    ctx.transcriptionJob = job;

    expect(runner.renameActiveTranscription(ctx, job.jobId, '  Board review  '))
      .toEqual({ renamed: true, displayName: 'Board review' });
    expect(job.displayName).toBe('Board review');
  });

  test('refuses a rename for a different job, or a blank name', () => {
    const { ctx } = buildCtx();
    const job = runner.createJob({ sourceFile: 'clip.mp4' });
    ctx.transcriptionJob = job;

    expect(runner.renameActiveTranscription(ctx, 'job-someone-else', 'X')).toEqual({ renamed: false });
    expect(runner.renameActiveTranscription(ctx, job.jobId, '   ')).toEqual({ renamed: false });
    expect(job.displayName).toBe('clip');
  });
});

describe('emitToRenderer', () => {
  test('resolves the window at send time, so a reloaded renderer still receives events', () => {
    // The whole reason terminal events survive a teardown: a captured
    // event.sender is stale after a reload, but ctx.mainWindow is current.
    const ctx = { mainWindow: null };
    expect(() => runner.emitToRenderer(ctx, 'x', {})).not.toThrow();

    const send = jest.fn();
    ctx.mainWindow = { isDestroyed: () => false, webContents: { send } };
    runner.emitToRenderer(ctx, 'transcription-complete', { jobId: 'job-1' });
    expect(send).toHaveBeenCalledWith('transcription-complete', { jobId: 'job-1' });
  });

  test('does not send to a destroyed window', () => {
    const send = jest.fn();
    const ctx = { mainWindow: { isDestroyed: () => true, webContents: { send } } };
    runner.emitToRenderer(ctx, 'x', {});
    expect(send).not.toHaveBeenCalled();
  });
});

/**
 * Step 2 of the rework: a finished job is recorded in two places, so it stops
 * being something the user has to re-run.
 *
 *  - The local registry is the fast, offline tier.
 *  - A sidecar object next to the transcript in the *user's own* output bucket is
 *    the durable tier: a single ListObjectsV2 rebuilds the index, names included,
 *    outliving the retention window that eventually removes AWS job metadata.
 *    Only possible because v3.5.0 guaranteed that bucket exists and is theirs.
 */
describe('persistence', () => {
  const putsOf = (ctx) => ctx.awsClients.s3.send.mock.calls
    .filter(([cmd]) => cmd._type === 's3put')
    .map(([cmd]) => cmd.input);

  function completingCtx() {
    const transcribeSend = jest.fn(async (cmd) => (cmd._type === 'get' ? completedJob() : {}));
    const built = buildCtx({ transcribeSend });
    built.ctx.awsClients.s3.send = jest.fn(async (cmd) => {
      if (cmd._type === 's3get') return { Body: { transformToString: async () => '{}' } };
      return {};
    });
    return built;
  }

  test('saves a registry record with the transcript on completion', async () => {
    const { ctx } = completingCtx();

    const { job } = startJob(ctx);
    await (ctx.transcriptionJob === job ? Promise.resolve() : Promise.resolve());
    const result = await runner.runTranscription(ctx, runner.createJob({ sourceFile: fakeFile.name }), { file: fakeFile });

    expect(result.status).toBe('COMPLETED');
    const saved = ctx.transcriptionRegistry.saved.at(-1);
    expect(saved.record).toMatchObject({
      status: 'COMPLETED',
      displayName: 'clip',
      sourceFile: 'clip.mp4',
      language: 'en-US',
      mediaBucket: 'test-bucket',
      outputBucket: 'test-out-bucket',
    });
    expect(saved.record.mediaKey).toMatch(/^\d+-clip\.mp4$/);
    expect(saved.transcript).toEqual([{ startTime: 0, endTime: 1, speaker: '1', text: 'hello' }]);
  });

  test('writes the sidecar next to the transcript in the output bucket', async () => {
    const { ctx } = completingCtx();

    const result = await runner.runTranscription(ctx, runner.createJob({ sourceFile: fakeFile.name }), { file: fakeFile });

    const [put] = putsOf(ctx);
    expect(put.Bucket).toBe('test-out-bucket');
    expect(put.Key).toBe(`${result.jobName}.hive.json`);
    expect(put.ContentType).toBe('application/json');

    // The sidecar must carry everything needed to rebuild an index entry.
    const body = JSON.parse(put.Body);
    expect(body).toMatchObject({
      jobId: result.jobId,
      jobName: result.jobName,
      displayName: 'clip',
      sourceFile: 'clip.mp4',
      status: 'COMPLETED',
    });
    expect(body.mediaKey).toMatch(/^\d+-clip\.mp4$/);
  });

  test('persists before announcing completion', async () => {
    // The opposite order would report success for something unrecoverable if the
    // app died in between.
    const order = [];
    const { ctx } = completingCtx();
    ctx.transcriptionRegistry.save = jest.fn(async () => { order.push('save'); return {}; });
    mockNotify.mockImplementation(() => { order.push('notify'); });

    await runner.runTranscription(ctx, runner.createJob({ sourceFile: fakeFile.name }), { file: fakeFile });

    expect(order).toEqual(['save', 'notify']);
  });

  test('a sidecar failure does not fail the job', async () => {
    // The transcript is already retrieved and saved locally; losing the AWS-side
    // recovery tier is not worth failing a successful job over.
    const { ctx } = completingCtx();
    ctx.awsClients.s3.send = jest.fn(async (cmd) => {
      if (cmd._type === 's3get') return { Body: { transformToString: async () => '{}' } };
      throw new Error('AccessDenied on PutObject');
    });

    const result = await runner.runTranscription(ctx, runner.createJob({ sourceFile: fakeFile.name }), { file: fakeFile });

    expect(result.status).toBe('COMPLETED');
    expect(ctx.transcriptionRegistry.saved).toHaveLength(1);
  });

  test('a registry failure does not fail the job either', async () => {
    const { ctx } = completingCtx();
    ctx.transcriptionRegistry.save = jest.fn(async () => { throw new Error('disk full'); });

    const result = await runner.runTranscription(ctx, runner.createJob({ sourceFile: fakeFile.name }), { file: fakeFile });

    expect(result.status).toBe('COMPLETED');
    expect(result.transcript).toHaveLength(1);
  });

  test('records an abandoned job — it is still on AWS and still collectable', async () => {
    // Exactly the kind of job a user would otherwise re-run.
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type === 'get') throw networkError();
      return {};
    });
    const { ctx } = buildCtx({ transcribeSend });
    const job = runner.createJob({ sourceFile: fakeFile.name });
    ctx.transcriptionJob = job;
    job.pausedTotalMs = runner.MAX_PAUSED_MS;   // budget already spent

    const result = await runner.runTranscription(ctx, job, { file: fakeFile });

    expect(result.status).toBe('ABANDONED');
    const saved = ctx.transcriptionRegistry.saved.at(-1);
    expect(saved.record).toMatchObject({ status: 'ABANDONED', abandonedReason: 'network' });
    expect(saved.transcript).toBeNull();
  });

  test('does not record a cancelled job — the user threw it away deliberately', async () => {
    const transcribeSend = jest.fn(async (cmd) => (cmd._type === 'get'
      ? { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } } : {}));
    const { ctx } = buildCtx({ transcribeSend });

    const { job, promise } = startJob(ctx);
    await pollingAsleep(job);
    await runner.cancelTranscription(ctx);
    await promise;

    expect(ctx.transcriptionRegistry.saved).toHaveLength(0);
  });

  test('skips the sidecar when no output bucket is configured', async () => {
    const { ctx } = completingCtx();
    ctx.currentSettings = { ...ctx.currentSettings, outputBucketName: '' };
    // Bypass the config guard to isolate sidecar behaviour.
    const job = runner.createJob({ sourceFile: fakeFile.name });
    job.jobName = 'transcription-1';

    await expect(runner.writeSidecar(ctx, job, { jobId: job.jobId })).resolves.toBe(false);
    expect(putsOf(ctx)).toHaveLength(0);
  });
});

describe('renameTranscription', () => {
  test('renames the in-flight job without touching the registry', async () => {
    const { ctx } = buildCtx();
    const job = runner.createJob({ sourceFile: 'clip.mp4' });
    ctx.transcriptionJob = job;

    await expect(runner.renameTranscription(ctx, job.jobId, 'Board review'))
      .resolves.toEqual({ renamed: true, displayName: 'Board review' });
    expect(job.displayName).toBe('Board review');
    expect(ctx.transcriptionRegistry.rename).not.toHaveBeenCalled();
  });

  test('falls back to the registry for a job that has already finished', async () => {
    const { ctx } = buildCtx();
    ctx.transcriptionRegistry.rename = jest.fn(async () => ({
      jobId: 'job-old', jobName: 'transcription-1', displayName: 'Board review',
    }));

    await expect(runner.renameTranscription(ctx, 'job-old', 'Board review'))
      .resolves.toEqual({ renamed: true, displayName: 'Board review' });
    expect(ctx.transcriptionRegistry.rename).toHaveBeenCalledWith('job-old', 'Board review');
  });

  test('refreshes the sidecar so the AWS-side tier does not drift', async () => {
    const { ctx } = buildCtx();
    ctx.transcriptionRegistry.rename = jest.fn(async () => ({
      jobId: 'job-old', jobName: 'transcription-1', displayName: 'Board review',
    }));

    await runner.renameTranscription(ctx, 'job-old', 'Board review');

    const put = ctx.awsClients.s3.send.mock.calls.find(([cmd]) => cmd._type === 's3put');
    expect(put).toBeDefined();
    expect(JSON.parse(put[0].input.Body).displayName).toBe('Board review');
  });

  test('still renames offline — the sidecar is a backstop, not a gate', async () => {
    const { ctx, state } = buildCtx();
    state.online = false;
    ctx.transcriptionRegistry.rename = jest.fn(async () => ({
      jobId: 'job-old', jobName: 'transcription-1', displayName: 'Board review',
    }));

    await expect(runner.renameTranscription(ctx, 'job-old', 'Board review'))
      .resolves.toMatchObject({ renamed: true });
    expect(ctx.awsClients.s3.send).not.toHaveBeenCalled();
  });

  test('reports failure for an unknown job', async () => {
    const { ctx } = buildCtx();
    await expect(runner.renameTranscription(ctx, 'nope', 'X')).resolves.toEqual({ renamed: false });
  });
});

describe('paused budget exhaustion', () => {
  /**
   * Regression: the budget-exhausted path calls finish() before the retry timer
   * exists, and the timer used to be declared with `const` further down the same
   * scope — so clearTimeout() hit its temporal dead zone and threw a
   * ReferenceError. The ABANDONED outcome became a generic failure, telling the
   * user their transcription had failed rather than that it was paused too long
   * and still waiting on AWS. Present since v3.4.0; no test reached it because
   * none exhausted the 30-minute budget.
   */
  test('reports ABANDONED rather than throwing when the budget is already spent', async () => {
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type === 'get') throw networkError();
      return {};
    });
    const { ctx } = buildCtx({ transcribeSend });
    const job = runner.createJob({ sourceFile: fakeFile.name });
    ctx.transcriptionJob = job;
    job.pausedTotalMs = runner.MAX_PAUSED_MS;

    const result = await runner.runTranscription(ctx, job, { file: fakeFile });

    expect(result).toMatchObject({ status: 'ABANDONED', jobId: job.jobId });
    expect(result.message).toMatch(/still running on AWS/i);
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Transcription Paused Too Long',
    }));
  });

  test('the abandoned job is named so it can be found on AWS', async () => {
    const transcribeSend = jest.fn(async (cmd) => {
      if (cmd._type === 'get') throw networkError();
      return {};
    });
    const { ctx } = buildCtx({ transcribeSend });
    const job = runner.createJob({ sourceFile: fakeFile.name });
    ctx.transcriptionJob = job;
    job.pausedTotalMs = runner.MAX_PAUSED_MS;

    const result = await runner.runTranscription(ctx, job, { file: fakeFile });

    expect(result.jobName).toMatch(/^transcription-\d+$/);
  });
});

/**
 * The processing budget.
 *
 * This replaced a flat 60 attempts x 5s = exactly 5 minutes, which made long
 * media structurally impossible: Transcribe accepts up to 4 hours of audio and
 * takes real time roughly proportional to its length, so any substantial file
 * blew the cap. Worse, the cap was reported as a plain failure and wrote no
 * record, while the job ran on to completion on AWS and billed — so the user was
 * told their transcript was gone at the moment they were paying for one.
 *
 * Nothing in the suite covered that path, which is how a wrong constant survived.
 *
 * Elapsed time is simulated by moving job.pollStartedAt rather than by waiting,
 * so these exercise the real budget arithmetic in the real loop.
 */
describe('the processing budget', () => {
  /** Pretend the job has been observed for `ms` already. */
  const pretendElapsed = (job, ms) => { job.pollStartedAt = Date.now() - ms; };

  test('keeps polling well past the old 5-minute cap', async () => {
    // The reported bug, directly: a job still in progress at 10 minutes used to
    // be failed here.
    const { ctx } = buildCtx();
    const { job, promise } = startJob(ctx);
    await pollingAsleep(job);

    pretendElapsed(job, 10 * 60 * 1000);
    job.wake();
    await pollingAsleep(job);

    expect(job.cancelled).toBe(false);

    // And it still completes rather than having been abandoned along the way.
    ctx.awsClients.transcribe.send = jest.fn(async () => completedJob());
    job.wake();
    await expect(promise).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  test('a job that finishes after an hour still delivers its transcript', async () => {
    const { ctx } = buildCtx();
    const { job, promise } = startJob(ctx);
    await pollingAsleep(job);

    pretendElapsed(job, 60 * 60 * 1000);
    ctx.awsClients.transcribe.send = jest.fn(async () => completedJob());
    job.wake();

    await expect(promise).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  test('exhausting the budget is ABANDONED, not FAILED, and records the job', async () => {
    const { ctx, sent } = buildCtx();
    const { job, promise } = startJob(ctx);
    await pollingAsleep(job);

    pretendElapsed(job, runner.MAX_PROCESSING_MS + 1000);
    job.wake();

    const result = await promise;

    expect(result.status).toBe('ABANDONED');
    expect(result.jobName).toBe(job.jobName);
    // A record must exist, or nothing points at the job left running on AWS.
    expect(ctx.transcriptionRegistry.saved).toHaveLength(1);
    expect(ctx.transcriptionRegistry.saved[0].record).toMatchObject({
      status: 'ABANDONED',
      abandonedReason: 'timeout',
    });
    expect(sent.some(e => e.channel === 'transcription-progress')).toBe(true);
  });

  test('the abandoned message says the job is still on AWS and how to collect it', async () => {
    const { ctx } = buildCtx();
    const { job, promise } = startJob(ctx);
    await pollingAsleep(job);

    pretendElapsed(job, runner.MAX_PROCESSING_MS + 1000);
    job.wake();

    const result = await promise;

    expect(result.message).toContain('still running on AWS');
    expect(result.message).toContain('Find past transcriptions');
    expect(result.message).toContain('not be charged twice');
    expect(result.message).toContain(job.jobName);
  });

  test('paused time does not consume the processing budget', async () => {
    // An outage has its own budget (MAX_PAUSED_MS). If it also ate this one, a
    // long pause would abandon a job that had barely been observed.
    const { ctx } = buildCtx();
    const { job, promise } = startJob(ctx);
    await pollingAsleep(job);

    job.pollStartedAt = Date.now() - (runner.MAX_PROCESSING_MS + 60 * 1000);
    job.pausedTotalMs = runner.MAX_PROCESSING_MS; // nearly all of it was paused
    job.wake();
    await pollingAsleep(job);

    ctx.awsClients.transcribe.send = jest.fn(async () => completedJob());
    job.wake();
    await expect(promise).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  test('reports real elapsed time, not attempts x interval', async () => {
    const { ctx, sent } = buildCtx();
    const { job, promise } = startJob(ctx);
    await pollingAsleep(job);

    pretendElapsed(job, 90 * 60 * 1000);
    job.wake();
    await pollingAsleep(job);

    const messages = progressOf(sent).map(p => p.message);
    expect(messages.some(m => m.includes('1h 30m elapsed'))).toBe(true);

    job.cancelled = true;
    job.wake();
    await promise;
  });
});

describe('poll backoff', () => {
  test('widens with elapsed time, then holds at a minute', () => {
    // Short files stay responsive; a 4-hour job costs ~270 GetTranscriptionJob
    // calls instead of ~2,880 at a flat 5s.
    expect(runner.pollIntervalFor(0)).toBe(5000);
    expect(runner.pollIntervalFor(59 * 1000)).toBe(5000);
    expect(runner.pollIntervalFor(60 * 1000)).toBe(15000);
    expect(runner.pollIntervalFor(4 * 60 * 1000)).toBe(15000);
    expect(runner.pollIntervalFor(5 * 60 * 1000)).toBe(30000);
    expect(runner.pollIntervalFor(14 * 60 * 1000)).toBe(30000);
    expect(runner.pollIntervalFor(15 * 60 * 1000)).toBe(60000);
    expect(runner.pollIntervalFor(4 * 60 * 60 * 1000)).toBe(60000);
  });

  test('the budget is generous enough for the media AWS actually accepts', () => {
    // Transcribe's maximum media duration is 4 hours; the ceiling has to clear
    // that plus queueing or long files are impossible again.
    expect(runner.MAX_PROCESSING_MS).toBeGreaterThan(4 * 60 * 60 * 1000);
  });
});

describe('observedProcessingMs / formatElapsed', () => {
  test('excludes paused time', () => {
    const now = 1_000_000;
    const job = { pollStartedAt: now - 60_000, pausedTotalMs: 20_000 };
    expect(runner.observedProcessingMs(job, now)).toBe(40_000);
  });

  test('is zero before polling starts', () => {
    expect(runner.observedProcessingMs({ pausedTotalMs: 0 })).toBe(0);
  });

  test('never goes negative if the clock moves backwards', () => {
    const job = { pollStartedAt: 2_000_000, pausedTotalMs: 0 };
    expect(runner.observedProcessingMs(job, 1_000_000)).toBe(0);
  });

  test('formats seconds, minutes and hours', () => {
    expect(runner.formatElapsed(0)).toBe('0s');
    expect(runner.formatElapsed(45_000)).toBe('45s');
    expect(runner.formatElapsed(59_999)).toBe('59s');
    expect(runner.formatElapsed(60_000)).toBe('1m');
    expect(runner.formatElapsed(59 * 60 * 1000)).toBe('59m');
    expect(runner.formatElapsed(60 * 60 * 1000)).toBe('1h 0m');
    expect(runner.formatElapsed(90 * 60 * 1000)).toBe('1h 30m');
    expect(runner.formatElapsed(4 * 60 * 60 * 1000 + 5 * 60 * 1000)).toBe('4h 5m');
  });
});
