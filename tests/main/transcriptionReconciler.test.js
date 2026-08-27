/**
 * Tests for transcriptionReconciler.js — rebuilding the local index from AWS.
 *
 * Two gaps this closes: transcriptions made before the registry existed, and
 * everything lost with `userData` on a reinstall or a new machine. The behaviours
 * that matter:
 *
 *  - A sidecar restores an entry *as it was*, name and original jobId included,
 *    and works even after Transcribe has aged the job out of its own history.
 *  - A local record is never overwritten, because it may carry a name the user
 *    typed and AWS knows nothing about that.
 *  - Each source fails independently. Listing the bucket needs `s3:ListBucket`,
 *    which a scoped-down role may lack, and that must not stop the other source —
 *    nor be reported as a generic failure.
 */

jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  ListObjectsV2Command: jest.fn(function (input) { this.input = input; this._type = 'list'; }),
  GetObjectCommand: jest.fn(function (input) { this.input = input; this._type = 'get'; }),
}));

jest.mock('@aws-sdk/client-transcribe', () => ({
  ListTranscriptionJobsCommand: jest.fn(function (input) { this.input = input; this._type = 'listJobs'; }),
}));

jest.mock('../../src/main/models/transcriptMapper', () => jest.fn().mockImplementation((raw) => ({
  getAllTimestampedText: () => raw?.results?.segments || [{ startTime: 0, endTime: 1, speaker: '1', text: 'mapped' }],
})));

const { reconcile } = require('../../src/main/models/transcriptionReconciler');

const SIDECAR = {
  jobId: 'job-original-1',
  jobName: 'transcription-1717000000000',
  displayName: 'Keynote Draft 3',
  sourceFile: 'keynote-v4.mp4',
  mediaKey: '1717000000000-keynote-v4.mp4',
  outputBucket: 'hive-transcripts-111122223333',
  status: 'COMPLETED',
  createdAt: '2026-06-02T10:00:00.000Z',
};

/**
 * @param {object} opts
 * @param {Array}  opts.objects      S3 objects in the output bucket
 * @param {Array}  opts.jobSummaries Transcribe job-history summaries
 * @param {Array}  opts.existing     records already in the local registry
 */
function buildCtx({
  objects = [],
  jobSummaries = [],
  existing = [],
  listThrows = null,
  listJobsThrows = null,
  bucket = 'hive-transcripts-111122223333',
  online = true,
  sidecars = { 'transcription-1717000000000.hive.json': SIDECAR },
} = {}) {
  const saved = [];

  const ctx = {
    currentSettings: { outputBucketName: bucket, bucketName: 'hive-media-1', transcriptionLanguage: 'en-US' },
    settingsManager: { loadSettings: jest.fn(async () => ctx.currentSettings) },
    awsClients: {
      s3: {
        send: jest.fn(async (cmd) => {
          if (cmd._type === 'list') {
            if (listThrows) throw listThrows;
            return { Contents: objects, IsTruncated: false };
          }
          if (cmd._type === 'get') {
            const key = cmd.input.Key;
            if (key.endsWith('.hive.json')) {
              const doc = sidecars[key];
              if (!doc) throw new Error(`NoSuchKey: ${key}`);
              return { Body: { transformToString: async () => JSON.stringify(doc) } };
            }
            return {
              Body: {
                transformToString: async () => JSON.stringify({
                  results: { segments: [{ startTime: 0, endTime: 3, speaker: '1', text: 'imported words' }] },
                }),
              },
            };
          }
          return {};
        }),
      },
      transcribe: {
        send: jest.fn(async (cmd) => {
          if (cmd._type === 'listJobs') {
            if (listJobsThrows) throw listJobsThrows;
            return { TranscriptionJobSummaries: jobSummaries };
          }
          return {};
        }),
      },
    },
    transcriptionRegistry: {
      list: jest.fn(async () => existing),
      save: jest.fn(async (record, transcript) => { saved.push({ record, transcript }); return record; }),
    },
    isOnline: () => online,
    assertOnline: (action = 'This action') => {
      if (!online) {
        const err = new Error(`${action} needs an internet connection — Hive is offline.`);
        err.code = 'HIVE_OFFLINE';
        throw err;
      }
    },
  };

  return { ctx, saved };
}

const s3Object = (key, lastModified = '2026-06-02T10:05:00.000Z') => ({ Key: key, LastModified: lastModified });

beforeEach(() => jest.clearAllMocks());

describe('importing from the output bucket', () => {
  test('a sidecar restores the entry exactly as it was', async () => {
    // Including the original jobId, so an entry re-imported after local loss
    // keeps its identity rather than becoming a duplicate.
    const { ctx, saved } = buildCtx({
      objects: [
        s3Object('transcription-1717000000000.json'),
        s3Object('transcription-1717000000000.hive.json'),
      ],
    });

    const result = await reconcile(ctx);

    expect(result.imported).toBe(1);
    expect(result.fromSidecar).toBe(1);
    expect(saved[0].record).toMatchObject({
      jobId: 'job-original-1',
      displayName: 'Keynote Draft 3',
      sourceFile: 'keynote-v4.mp4',
      importedFrom: 'sidecar',
    });
    expect(saved[0].transcript).toEqual([{ startTime: 0, endTime: 3, speaker: '1', text: 'imported words' }]);
  });

  test('a transcript with no sidecar is imported unnamed rather than given an invented name', async () => {
    // Pre-v3.7.0 jobs have no sidecar. The sidebar shows these with a prompt to
    // name them.
    const { ctx, saved } = buildCtx({
      objects: [s3Object('transcription-1700000000000.json')],
      sidecars: {},
    });

    const result = await reconcile(ctx);

    expect(result.imported).toBe(1);
    expect(result.fromTranscript).toBe(1);
    expect(saved[0].record).toMatchObject({
      jobId: 'imported-transcription-1700000000000',
      jobName: 'transcription-1700000000000',
      displayName: 'transcription-1700000000000',
      status: 'COMPLETED',
      importedFrom: 'transcript',
    });
    expect(saved[0].record.createdAt).toBe('2026-06-02T10:05:00.000Z');
  });

  test('attaches the transcript through the same mapper the live path uses', async () => {
    // So an imported transcript is indistinguishable from a freshly-made one.
    const { ctx, saved } = buildCtx({
      objects: [s3Object('transcription-1717000000000.json'), s3Object('transcription-1717000000000.hive.json')],
    });

    await reconcile(ctx);

    expect(saved[0].transcript[0]).toHaveProperty('startTime');
    expect(saved[0].transcript[0]).toHaveProperty('text');
  });

  test('a sidecar with no transcript still imports the metadata', async () => {
    const { ctx, saved } = buildCtx({
      objects: [s3Object('transcription-1717000000000.hive.json')],
    });

    const result = await reconcile(ctx);

    expect(result.imported).toBe(1);
    expect(saved[0].transcript).toBeNull();
  });

  test('never overwrites a record the registry already has', async () => {
    // The local record may carry a name the user typed; AWS has no idea.
    const { ctx, saved } = buildCtx({
      objects: [s3Object('transcription-1717000000000.json'), s3Object('transcription-1717000000000.hive.json')],
      existing: [{ jobId: 'local-1', jobName: 'transcription-1717000000000', displayName: 'My own name' }],
    });

    const result = await reconcile(ctx);

    expect(result.imported).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    expect(saved).toHaveLength(0);
  });

  test('ignores unrelated objects in the bucket', async () => {
    const { ctx, saved } = buildCtx({
      objects: [s3Object('notes.txt'), s3Object('images/logo.png')],
      sidecars: {},
    });

    const result = await reconcile(ctx);

    expect(result.imported).toBe(0);
    expect(saved).toHaveLength(0);
  });

  test('one unreadable object does not abort the rest', async () => {
    const { ctx, saved } = buildCtx({
      objects: [
        s3Object('transcription-broken.hive.json'),
        s3Object('transcription-1717000000000.json'),
        s3Object('transcription-1717000000000.hive.json'),
      ],
      // 'transcription-broken.hive.json' is absent from sidecars, so reading it throws.
    });

    const result = await reconcile(ctx);

    expect(result.failed).toBe(1);
    expect(result.imported).toBe(1);
    expect(saved).toHaveLength(1);
  });

  test('follows pagination rather than importing only the first page', async () => {
    const { ctx } = buildCtx({ sidecars: {} });
    let page = 0;
    ctx.awsClients.s3.send = jest.fn(async (cmd) => {
      if (cmd._type === 'list') {
        page++;
        if (page === 1) {
          return { Contents: [s3Object('transcription-a.json')], IsTruncated: true, NextContinuationToken: 't1' };
        }
        return { Contents: [s3Object('transcription-b.json')], IsTruncated: false };
      }
      return { Body: { transformToString: async () => JSON.stringify({ results: { segments: [] } }) } };
    });

    const result = await reconcile(ctx);

    expect(page).toBe(2);
    expect(result.imported).toBe(2);
  });
});

describe('importing from Transcribe job history', () => {
  test('imports a job the bucket does not account for', async () => {
    // Typically output that went to a service-managed bucket.
    const { ctx, saved } = buildCtx({
      objects: [],
      sidecars: {},
      jobSummaries: [{
        TranscriptionJobName: 'transcription-service-managed',
        TranscriptionJobStatus: 'COMPLETED',
        LanguageCode: 'en-US',
        CreationTime: new Date('2026-05-01T09:00:00.000Z'),
        CompletionTime: new Date('2026-05-01T09:04:00.000Z'),
        OutputLocationType: 'SERVICE_BUCKET',
      }],
    });

    const result = await reconcile(ctx);

    expect(result.fromJobHistory).toBe(1);
    expect(saved[0].record).toMatchObject({
      jobName: 'transcription-service-managed',
      displayName: 'transcription-service-managed',
      status: 'COMPLETED',
      language: 'en-US',
      outputLocationType: 'SERVICE_BUCKET',
      importedFrom: 'jobHistory',
    });
    // No transcript to attach — it lives in a bucket Hive can't address.
    expect(saved[0].transcript).toBeNull();
    expect(saved[0].record.outputBucket).toBeNull();
  });

  test('does not re-import a job the bucket scan already covered', async () => {
    const { ctx, saved } = buildCtx({
      objects: [s3Object('transcription-1717000000000.json'), s3Object('transcription-1717000000000.hive.json')],
      jobSummaries: [{
        TranscriptionJobName: 'transcription-1717000000000',
        TranscriptionJobStatus: 'COMPLETED',
      }],
    });

    const result = await reconcile(ctx);

    expect(result.imported).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved[0].record.importedFrom).toBe('sidecar');
  });

  test('follows job-history pagination', async () => {
    const { ctx } = buildCtx({ objects: [], sidecars: {} });
    let page = 0;
    ctx.awsClients.transcribe.send = jest.fn(async () => {
      page++;
      if (page === 1) {
        return {
          TranscriptionJobSummaries: [{ TranscriptionJobName: 'a', TranscriptionJobStatus: 'COMPLETED' }],
          NextToken: 't1',
        };
      }
      return { TranscriptionJobSummaries: [{ TranscriptionJobName: 'b', TranscriptionJobStatus: 'COMPLETED' }] };
    });

    const result = await reconcile(ctx);

    expect(page).toBe(2);
    expect(result.imported).toBe(2);
  });

  test('records a non-completed job with its actual status', async () => {
    const { ctx, saved } = buildCtx({
      objects: [], sidecars: {},
      jobSummaries: [{ TranscriptionJobName: 'transcription-failed', TranscriptionJobStatus: 'FAILED' }],
    });

    await reconcile(ctx);

    expect(saved[0].record.status).toBe('FAILED');
  });
});

describe('partial failure', () => {
  test('a missing s3:ListBucket is named specifically, and job history still runs', async () => {
    // A scoped-down role may lack this. Reporting it generically would send the
    // user hunting; reporting nothing would read as "there is nothing there".
    const denied = Object.assign(new Error('User is not authorized to perform: s3:ListBucket'), {
      name: 'AccessDenied',
    });
    const { ctx, saved } = buildCtx({
      listThrows: denied,
      jobSummaries: [{ TranscriptionJobName: 'transcription-from-history', TranscriptionJobStatus: 'COMPLETED' }],
    });

    const result = await reconcile(ctx);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/s3:ListBucket/);
    // The other source still worked.
    expect(result.imported).toBe(1);
    expect(saved[0].record.importedFrom).toBe('jobHistory');
  });

  test('a failed job-history listing still keeps what the bucket found', async () => {
    const { ctx, saved } = buildCtx({
      objects: [s3Object('transcription-1717000000000.json'), s3Object('transcription-1717000000000.hive.json')],
      listJobsThrows: new Error('Throttling'),
    });

    const result = await reconcile(ctx);

    expect(result.imported).toBe(1);
    expect(result.errors[0]).toMatch(/Could not list Transcribe jobs/);
    expect(saved).toHaveLength(1);
  });

  test('explains itself when no output bucket is configured', async () => {
    const { ctx } = buildCtx({ bucket: '', objects: [], sidecars: {} });

    const result = await reconcile(ctx);

    expect(result.errors[0]).toMatch(/No output bucket is configured/);
    expect(ctx.awsClients.s3.send).not.toHaveBeenCalled();
  });

  test('refuses to run while offline rather than reporting an empty result', async () => {
    const { ctx } = buildCtx({ online: false });

    await expect(reconcile(ctx)).rejects.toThrow(/offline/i);
    expect(ctx.awsClients.s3.send).not.toHaveBeenCalled();
  });

  test('reports nothing found without inventing an error', async () => {
    const { ctx } = buildCtx({ objects: [], sidecars: {}, jobSummaries: [] });

    const result = await reconcile(ctx);

    expect(result).toMatchObject({ imported: 0, failed: 0 });
    expect(result.errors).toEqual([]);
  });
});
