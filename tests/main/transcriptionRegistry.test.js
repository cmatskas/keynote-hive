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

/**
 * Full-text search over transcript bodies. Runs here rather than in the renderer
 * because the transcripts are on disk next to us — shipping every one over IPC
 * per keystroke would be wasteful.
 *
 * This is the capability that makes the history useful months later, when you
 * remember a phrase from the recording but not what you named the file. A
 * name-only filter, which is all the Chat sidebar does, cannot answer that.
 */
describe('search', () => {
  const KEYNOTE = [
    { startTime: 0, endTime: 6, speaker: '1', text: 'Good morning and welcome to the keynote.' },
    { startTime: 6, endTime: 14, speaker: '2', text: 'Today we are talking about quarterly revenue growth.' },
    { startTime: 14, endTime: 20, speaker: '1', text: 'Quarterly numbers are up across every region.' },
  ];
  const INTERVIEW = [
    { startTime: 0, endTime: 5, speaker: '1', text: 'Tell me about your migration to the new platform.' },
  ];

  beforeEach(async () => {
    await registry.save(record({
      jobId: 'job-keynote', displayName: 'Keynote Draft 3', sourceFile: 'keynote-v4.mp4',
      createdAt: '2026-06-02T10:00:00.000Z',
    }), KEYNOTE);
    await registry.save(record({
      jobId: 'job-interview', displayName: 'Customer interview', sourceFile: 'interview.m4a',
      createdAt: '2026-05-28T10:00:00.000Z',
    }), INTERVIEW);
    await registry.save(record({
      jobId: 'job-abandoned', displayName: 'Board review', sourceFile: 'board.mp4',
      status: 'ABANDONED', createdAt: '2026-05-01T10:00:00.000Z',
    }), null);
  });

  test('finds a transcription by words spoken in it', async () => {
    // "quarterly" appears in neither name nor file name.
    const hits = await registry.search('quarterly');
    expect(hits.map(h => h.jobId)).toEqual(['job-keynote']);
  });

  test('counts every occurrence across segments', async () => {
    const [hit] = await registry.search('quarterly');
    expect(hit.matchCount).toBe(2);
  });

  test('is case-insensitive', async () => {
    expect((await registry.search('QUARTERLY')).map(h => h.jobId)).toEqual(['job-keynote']);
    expect((await registry.search('Migration')).map(h => h.jobId)).toEqual(['job-interview']);
  });

  test('returns a snippet with the timestamp of the first hit', async () => {
    const [hit] = await registry.search('quarterly');
    expect(hit.snippet).toContain('quarterly revenue growth');
    expect(hit.snippetStartTime).toBe(6);
  });

  test('still matches on name and source file, without a snippet', async () => {
    const byName = await registry.search('Board review');
    expect(byName.map(h => h.jobId)).toEqual(['job-abandoned']);
    expect(byName[0].snippet).toBeNull();

    const byFile = await registry.search('interview.m4a');
    expect(byFile.map(h => h.jobId)).toEqual(['job-interview']);
  });

  test('matches the AWS job name too, so a legacy entry is still findable', async () => {
    const hits = await registry.search('transcription-1730000000000');
    expect(hits.length).toBeGreaterThan(0);
  });

  test('returns results newest-first rather than by relevance', async () => {
    // Predictable ordering: the list must not reshuffle as you type.
    const hits = await registry.search('the');
    const ids = hits.map(h => h.jobId);
    expect(ids.indexOf('job-keynote')).toBeLessThan(ids.indexOf('job-interview'));
  });

  test('copes with a record that has no transcript', async () => {
    const hits = await registry.search('board');
    expect(hits.map(h => h.jobId)).toEqual(['job-abandoned']);
    expect(hits[0].matchCount).toBe(0);
  });

  test('returns nothing for an empty or whitespace query', async () => {
    expect(await registry.search('')).toEqual([]);
    expect(await registry.search('   ')).toEqual([]);
    expect(await registry.search(null)).toEqual([]);
  });

  test('returns nothing when the phrase appears nowhere', async () => {
    expect(await registry.search('helicopter')).toEqual([]);
  });

  test('a corrupt transcript does not break the search', async () => {
    await fs.writeFile(path.join(dir, 'job-keynote.transcript.json'), '{ not json');

    const hits = await registry.search('migration');
    expect(hits.map(h => h.jobId)).toEqual(['job-interview']);
  });

  test('tolerates segments without usable text', async () => {
    await registry.save(record({ jobId: 'job-odd', displayName: 'Odd', createdAt: '2026-04-01T00:00:00.000Z' }), [
      { startTime: 0, endTime: 1 },
      { startTime: 1, endTime: 2, text: null },
      { startTime: 2, endTime: 3, text: 'findable phrase here' },
    ]);

    const hits = await registry.search('findable');
    expect(hits.map(h => h.jobId)).toEqual(['job-odd']);
  });
});

describe('buildSnippet', () => {
  const TEXT = 'The quick brown fox jumps over the lazy dog and then keeps on running for quite a while afterwards';

  test('windows around the hit with ellipses', () => {
    const at = TEXT.indexOf('lazy');
    const snippet = TranscriptionRegistry.buildSnippet(TEXT, at, 4, 10);
    expect(snippet).toContain('lazy');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  test('omits the leading ellipsis when the hit is at the start', () => {
    const snippet = TranscriptionRegistry.buildSnippet(TEXT, 0, 3, 10);
    expect(snippet.startsWith('…')).toBe(false);
  });

  test('omits the trailing ellipsis when the window reaches the end', () => {
    const snippet = TranscriptionRegistry.buildSnippet(TEXT, TEXT.length - 10, 10, 40);
    expect(snippet.endsWith('…')).toBe(false);
  });
});
