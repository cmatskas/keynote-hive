/**
 * Tests for transcriptionRegistry.js — the local index of everything Hive has
 * transcribed.
 *
 * This is the piece that stops users re-running transcriptions they've already
 * paid for: a completed job on AWS used to be unreachable from Hive the moment
 * the renderer moved on, because nothing recorded that it existed.
 *
 * Uses a real temp directory rather than a mocked fs — the whole contract here is
 * about what survives on disk, and the metadata/transcript file split is the
 * detail that keeps listing cheap.
 */

jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// The registry takes an explicit dir in tests, but the module still resolves a
// default from app.getPath() at construction.
jest.mock('electron', () => ({ app: { getPath: () => '/tmp/hive-test-userdata' } }));

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const TranscriptionRegistry = require('../../src/main/models/transcriptionRegistry');

let dir;
let registry;

const TRANSCRIPT = [
  { startTime: 0, endTime: 4.5, speaker: '1', text: 'Good morning.' },
  { startTime: 4.5, endTime: 12.25, speaker: '2', text: 'Thanks for having me.' },
];

function record(overrides = {}) {
  return {
    jobId: 'job-1',
    jobName: 'transcription-1730000000000',
    displayName: 'Keynote Draft 3',
    sourceFile: 'keynote-v4.mp4',
    mediaKey: '1730000000000-keynote-v4.mp4',
    mediaBucket: 'hive-media-111122223333',
    outputBucket: 'hive-transcripts-111122223333',
    language: 'en-US',
    status: 'COMPLETED',
    createdAt: '2026-06-02T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-registry-'));
  registry = new TranscriptionRegistry(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('save and get', () => {
  test('round-trips a record with its transcript', async () => {
    await registry.save(record(), TRANSCRIPT);

    const entry = await registry.get('job-1');
    expect(entry).toMatchObject({
      jobId: 'job-1',
      displayName: 'Keynote Draft 3',
      sourceFile: 'keynote-v4.mp4',
      status: 'COMPLETED',
    });
    expect(entry.transcript).toEqual(TRANSCRIPT);
  });

  test('carries the media key through, since it is not derivable from the job name', async () => {
    await registry.save(record(), TRANSCRIPT);
    const entry = await registry.get('job-1');
    expect(entry.mediaKey).toBe('1730000000000-keynote-v4.mp4');
    expect(entry.mediaBucket).toBe('hive-media-111122223333');
  });

  test('derives segment count and duration so the list needs no transcript', async () => {
    const stored = await registry.save(record(), TRANSCRIPT);

    expect(stored.hasTranscript).toBe(true);
    expect(stored.segmentCount).toBe(2);
    expect(stored.durationSeconds).toBe(12.25);
  });

  test('stores metadata and transcript in separate files', async () => {
    // Listing a sidebar must not read every transcript — that's the reason for
    // the split.
    await registry.save(record(), TRANSCRIPT);

    const files = (await fs.readdir(dir)).sort();
    expect(files).toEqual(['job-1.json', 'job-1.transcript.json']);

    const metaSize = (await fs.stat(path.join(dir, 'job-1.json'))).size;
    const transcriptSize = (await fs.stat(path.join(dir, 'job-1.transcript.json'))).size;
    expect(metaSize).toBeGreaterThan(0);
    expect(transcriptSize).toBeGreaterThan(0);
  });

  test('records a job with no transcript — an abandoned one is still retrievable from AWS', async () => {
    await registry.save(record({ jobId: 'job-2', status: 'ABANDONED' }), null);

    const entry = await registry.get('job-2');
    expect(entry.status).toBe('ABANDONED');
    expect(entry.hasTranscript).toBe(false);
    expect(entry.segmentCount).toBe(0);
    expect(entry.durationSeconds).toBeNull();
    expect(entry.transcript).toBeNull();
    // No transcript file written for a record that has none.
    expect(await fs.readdir(dir)).toEqual(['job-2.json']);
  });

  test('refuses a record without a jobId', async () => {
    await expect(registry.save({ displayName: 'no id' }, TRANSCRIPT))
      .rejects.toThrow(/needs a jobId/);
  });

  test('get returns null for an unknown job', async () => {
    expect(await registry.get('nope')).toBeNull();
    expect(await registry.getRecord('nope')).toBeNull();
    expect(await registry.getTranscript('nope')).toBeNull();
  });

  test('creates its directory on demand', async () => {
    const fresh = new TranscriptionRegistry(path.join(dir, 'nested', 'deeper'));
    await fresh.save(record({ jobId: 'job-3' }), TRANSCRIPT);
    expect(await fresh.get('job-3')).not.toBeNull();
  });
});

describe('list', () => {
  test('returns metadata newest first', async () => {
    await registry.save(record({ jobId: 'old', createdAt: '2026-05-01T00:00:00.000Z' }), TRANSCRIPT);
    await registry.save(record({ jobId: 'new', createdAt: '2026-06-01T00:00:00.000Z' }), TRANSCRIPT);
    await registry.save(record({ jobId: 'middle', createdAt: '2026-05-15T00:00:00.000Z' }), TRANSCRIPT);

    expect((await registry.list()).map(r => r.jobId)).toEqual(['new', 'middle', 'old']);
  });

  test('does not include transcripts', async () => {
    await registry.save(record(), TRANSCRIPT);
    const [entry] = await registry.list();
    expect(entry.transcript).toBeUndefined();
    expect(entry.segmentCount).toBe(2);
  });

  test('ignores the transcript files when scanning', async () => {
    await registry.save(record(), TRANSCRIPT);
    expect(await registry.list()).toHaveLength(1);
  });

  test('skips a corrupt record rather than failing the whole list', async () => {
    // One bad file must not hide every other transcript.
    await registry.save(record({ jobId: 'good' }), TRANSCRIPT);
    await fs.writeFile(path.join(dir, 'broken.json'), '{ not json');

    const listed = await registry.list();
    expect(listed.map(r => r.jobId)).toEqual(['good']);
  });

  test('returns an empty list when nothing has been transcribed', async () => {
    expect(await registry.list()).toEqual([]);
  });
});

describe('rename', () => {
  test('updates the display name and stamps it', async () => {
    await registry.save(record(), TRANSCRIPT);

    const updated = await registry.rename('job-1', '  Board review  ');

    expect(updated.displayName).toBe('Board review');
    expect(updated.renamedAt).toBeTruthy();
    expect((await registry.getRecord('job-1')).displayName).toBe('Board review');
  });

  test('leaves the transcript untouched', async () => {
    await registry.save(record(), TRANSCRIPT);
    await registry.rename('job-1', 'Board review');
    expect(await registry.getTranscript('job-1')).toEqual(TRANSCRIPT);
  });

  test('refuses a blank name and an unknown job', async () => {
    await registry.save(record(), TRANSCRIPT);

    expect(await registry.rename('job-1', '   ')).toBeNull();
    expect(await registry.rename('nope', 'Whatever')).toBeNull();
    expect((await registry.getRecord('job-1')).displayName).toBe('Keynote Draft 3');
  });
});

describe('remove', () => {
  test('deletes both files', async () => {
    await registry.save(record(), TRANSCRIPT);
    await registry.remove('job-1');

    expect(await registry.get('job-1')).toBeNull();
    expect(await fs.readdir(dir)).toEqual([]);
  });

  test('is local-only — nothing here touches AWS', async () => {
    // The transcript in the user's output bucket is the durable copy and
    // deleting it is irreversible, so that has to be a separate, explicit
    // choice rather than a side effect of tidying the local list.
    await registry.save(record(), TRANSCRIPT);
    await registry.remove('job-1');
    // Nothing to assert against AWS: the registry has no AWS client at all.
    expect(registry.awsClients).toBeUndefined();
  });

  test('removing an unknown job is a no-op', async () => {
    await expect(registry.remove('nope')).resolves.toBeUndefined();
  });

  test('has() reports presence', async () => {
    await registry.save(record(), TRANSCRIPT);
    expect(await registry.has('job-1')).toBe(true);
    expect(await registry.has('nope')).toBe(false);
  });
});

describe('durationOf', () => {
  test('reads the end of the last segment', () => {
    expect(TranscriptionRegistry.durationOf(TRANSCRIPT)).toBe(12.25);
  });

  test('is null for anything without usable segments', () => {
    expect(TranscriptionRegistry.durationOf([])).toBeNull();
    expect(TranscriptionRegistry.durationOf(null)).toBeNull();
    expect(TranscriptionRegistry.durationOf([{ text: 'no times' }])).toBeNull();
  });
});
