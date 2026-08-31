/**
 * Tests for StoryboardRegistry and the StoryBrand IPC layer.
 *
 * Two behaviours carry weight here.
 *
 * Analyses are persisted rather than recomputed, because classification is not
 * deterministic — re-running the same script can land a transitional paragraph on a
 * different element. Without a stored snapshot the colours would shift under the
 * user between viewings, which would make the tab feel broken even though nothing
 * had gone wrong.
 *
 * And the local half must work offline. Extraction is free and local, so reading a
 * file, listing history, opening a saved analysis and searching all have to work
 * with no network. Only the single classification call is gated.
 */

jest.mock('electron-log/main', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const os = require('os');
const path = require('path');
const fs = require('fs');

const mockUserData = { dir: '' };
jest.mock('electron', () => ({ app: { getPath: () => mockUserData.dir } }));

const StoryboardRegistry = require('../../src/main/models/storyboardRegistry');
const { countElements } = require('../../src/main/models/storyboardRegistry');
const { register, resolveModel } = require('../../src/main/ipc/storyboard');

const UNITS = [
  { index: 1, text: 'AI agents are not making it to production at scale.', children: [], kind: 'paragraph' },
  { index: 2, text: 'We have a unique vantage point on this.', children: [], kind: 'paragraph' },
  { index: 3, text: 'Here is your prescription. Four things.', children: ['One: momentum'], kind: 'bullet' },
];

const ANALYSIS = {
  units: UNITS,
  classifications: { 1: 'problem', 2: 'guide', 3: 'plan' },
  audit: { overall: 'Strong arc.', elements: {}, whatsWorking: [], quickWins: [] },
  sourceName: 'keynote.docx',
  format: 'docx',
  wordCount: 3281,
  modelId: 'us.anthropic.claude-opus-4-6-v1',
};

let registry;

beforeEach(() => {
  mockUserData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-sb-'));
  registry = new StoryboardRegistry();
  jest.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(mockUserData.dir, { recursive: true, force: true });
});

describe('saving and loading', () => {
  test('round-trips an analysis with its text and classifications together', async () => {
    // The snapshot is the point: text and colours must travel as one unit.
    const saved = await registry.save(ANALYSIS);
    const loaded = await registry.get(saved.id);

    expect(loaded.units).toEqual(UNITS);
    expect(loaded.classifications).toEqual({ 1: 'problem', 2: 'guide', 3: 'plan' });
    expect(loaded.wordCount).toBe(3281);
    expect(loaded.modelId).toBe('us.anthropic.claude-opus-4-6-v1');
  });

  test('generates a usable id and defaults the name to the source file', async () => {
    const saved = await registry.save(ANALYSIS);

    expect(StoryboardRegistry.isValidId(saved.id)).toBe(true);
    expect(saved.displayName).toBe('keynote.docx');
  });

  test('honours an explicit display name', async () => {
    const saved = await registry.save({ ...ANALYSIS, displayName: 'Q4 keynote, second pass' });
    expect(saved.displayName).toBe('Q4 keynote, second pass');
  });

  test('returns null for an analysis that does not exist', async () => {
    expect(await registry.get('sb-nope-nope')).toBeNull();
  });

  test('rejects an id that could escape the store directory', async () => {
    // Ids are generated here but arrive back over IPC.
    expect(StoryboardRegistry.isValidId('../../etc/passwd')).toBe(false);
    expect(await registry.get('../../etc/passwd')).toBeNull();
    expect(await registry.remove('../../etc/passwd')).toBe(false);
  });

  test('saving twice with the same id overwrites rather than duplicating', async () => {
    const first = await registry.save(ANALYSIS);
    await registry.save({ ...ANALYSIS, id: first.id, classifications: { 1: 'success', 2: 'success', 3: 'success' } });

    const list = await registry.list();
    expect(list).toHaveLength(1);
    expect((await registry.get(first.id)).classifications[1]).toBe('success');
  });
});

describe('the sidebar list', () => {
  test('is empty before anything is saved', async () => {
    expect(await registry.list()).toEqual([]);
  });

  test('omits the heavy fields so the list stays cheap over IPC', async () => {
    await registry.save(ANALYSIS);
    const [summary] = await registry.list();

    expect(summary.units).toBeUndefined();
    expect(summary.classifications).toBeUndefined();
    expect(summary.audit).toBeUndefined();
    expect(summary.displayName).toBe('keynote.docx');
    expect(summary.unitCount).toBe(3);
  });

  test('carries an element breakdown for a story-shape preview', async () => {
    await registry.save(ANALYSIS);
    const [summary] = await registry.list();

    expect(summary.elementCounts).toEqual({ problem: 1, guide: 1, plan: 1 });
    expect(summary.hasAudit).toBe(true);
  });

  test('is newest first', async () => {
    await registry.save({ ...ANALYSIS, displayName: 'older', createdAt: 1000 });
    await registry.save({ ...ANALYSIS, displayName: 'newer', createdAt: 2000 });

    expect((await registry.list()).map(r => r.displayName)).toEqual(['newer', 'older']);
  });

  test('one corrupt file does not hide the rest of the history', async () => {
    const saved = await registry.save(ANALYSIS);
    fs.writeFileSync(path.join(mockUserData.dir, 'storyboard-analyses', 'broken.json'), '{ not json');

    const list = await registry.list();

    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(saved.id);
  });
});

describe('rename and delete', () => {
  test('renames without touching the analysis', async () => {
    const saved = await registry.save(ANALYSIS);

    const renamed = await registry.rename(saved.id, 'Board version');

    expect(renamed.displayName).toBe('Board version');
    expect((await registry.get(saved.id)).classifications).toEqual(ANALYSIS.classifications);
  });

  test('refuses an empty name', async () => {
    const saved = await registry.save(ANALYSIS);
    await expect(registry.rename(saved.id, '   ')).rejects.toThrow(/cannot be empty/);
  });

  test('renaming something that does not exist returns null', async () => {
    expect(await registry.rename('sb-missing-xx', 'x')).toBeNull();
  });

  test('deletes', async () => {
    const saved = await registry.save(ANALYSIS);
    expect(await registry.remove(saved.id)).toBe(true);
    expect(await registry.get(saved.id)).toBeNull();
  });

  test('deleting twice reports false the second time', async () => {
    const saved = await registry.save(ANALYSIS);
    await registry.remove(saved.id);
    expect(await registry.remove(saved.id)).toBe(false);
  });
});

describe('search looks inside the script', () => {
  test('finds an analysis by a phrase in the keynote', async () => {
    // A name typed months ago is a worse handle than a phrase you remember.
    await registry.save(ANALYSIS);

    const results = await registry.search('vantage point');

    expect(results).toHaveLength(1);
    expect(results[0].matches[0].index).toBe(2);
    expect(results[0].matches[0].snippet).toContain('vantage point');
  });

  test('reports which element the matching paragraph landed on', async () => {
    await registry.save(ANALYSIS);
    const [result] = await registry.search('prescription');
    expect(result.matches[0].element).toBe('plan');
  });

  test('searches outline children too', async () => {
    await registry.save(ANALYSIS);
    const results = await registry.search('One: momentum');
    expect(results).toHaveLength(1);
  });

  test('matches on the name as well', async () => {
    await registry.save({ ...ANALYSIS, displayName: 'Reinvent keynote' });
    const [result] = await registry.search('reinvent');
    expect(result.nameHit).toBe(true);
  });

  test('is case-insensitive', async () => {
    await registry.save(ANALYSIS);
    expect(await registry.search('PRODUCTION')).toHaveLength(1);
  });

  test('returns nothing for an empty query rather than everything', async () => {
    await registry.save(ANALYSIS);
    expect(await registry.search('   ')).toEqual([]);
  });

  test('finds nothing when nothing matches', async () => {
    await registry.save(ANALYSIS);
    expect(await registry.search('xylophone')).toEqual([]);
  });
});

describe('revision chains', () => {
  test('links a re-upload back to the analysis it supersedes', async () => {
    // The tab is read-only: you revise the script in Word and re-upload, so the
    // history has to live here rather than in an editor.
    const v1 = await registry.save({ ...ANALYSIS, displayName: 'draft 1' });
    const v2 = await registry.save({ ...ANALYSIS, displayName: 'draft 2', revisionOf: v1.id });

    const chain = await registry.revisionChain(v2.id);

    expect(chain.map(c => c.displayName)).toEqual(['draft 1', 'draft 2']);
  });

  test('a standalone analysis is a chain of one', async () => {
    const saved = await registry.save(ANALYSIS);
    expect(await registry.revisionChain(saved.id)).toHaveLength(1);
  });

  test('omits the heavy fields from the chain', async () => {
    const saved = await registry.save(ANALYSIS);
    const [entry] = await registry.revisionChain(saved.id);
    expect(entry.units).toBeUndefined();
  });

  test('a corrupted self-referential chain does not hang', async () => {
    const saved = await registry.save(ANALYSIS);
    const file = path.join(mockUserData.dir, 'storyboard-analyses', `${saved.id}.json`);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.revisionOf = record.id;              // points at itself
    fs.writeFileSync(file, JSON.stringify(record));

    const chain = await registry.revisionChain(saved.id);

    expect(chain).toHaveLength(1);
  });
});

describe('chaining a re-upload onto what it supersedes', () => {
  test('finds the most recent analysis of the same file', async () => {
    await registry.save({ ...ANALYSIS, displayName: 'first pass', createdAt: 1000 });
    const second = await registry.save({ ...ANALYSIS, displayName: 'second pass', createdAt: 2000 });

    const found = await registry.findPredecessor({ sourceName: 'keynote.docx', format: 'docx' });

    expect(found.id).toBe(second.id);
  });

  test('finds nothing for a file never analysed before', async () => {
    await registry.save(ANALYSIS);
    expect(await registry.findPredecessor({ sourceName: 'other.docx', format: 'docx' })).toBeNull();
  });

  test('never chains pasted text, whose source name is always the same', async () => {
    // Otherwise unrelated snippets would be strung into one bogus history.
    await registry.save({ ...ANALYSIS, sourceName: 'Pasted text', format: 'text' });
    expect(await registry.findPredecessor({ sourceName: 'Pasted text', format: 'text' })).toBeNull();
  });

  test('a re-upload is linked automatically, so the history is real', async () => {
    // The stored revisionOf field was previously never set by anything, which made
    // the documented "see whether a rewrite fixed it" behaviour unreachable.
    const first = await registry.save(ANALYSIS);
    const second = await registry.save({ ...ANALYSIS, revisionOf: first.id });

    const chain = await registry.revisionChain(second.id);

    expect(chain).toHaveLength(2);
    expect(chain[0].id).toBe(first.id);
  });
});

describe('countElements', () => {
  test('tallies units per element', () => {
    expect(countElements({ 1: 'problem', 2: 'problem', 3: 'guide' }))
      .toEqual({ problem: 2, guide: 1 });
  });

  test('handles nothing classified', () => {
    expect(countElements(null)).toEqual({});
  });
});

describe('resolveModel', () => {
  const settings = {
    bedrockModels: [
      { id: 'Haiku', inferenceProfileId: 'haiku-id', role: 'formatter' },
      { id: 'Opus', inferenceProfileId: 'opus-id', role: 'creator' },
    ],
  };

  test('honours the model the user picked', () => {
    expect(resolveModel(settings, 'chosen-id')).toBe('chosen-id');
  });

  test('defaults to the Creator role model', () => {
    // Classifying a whole keynote is the "best model" case.
    expect(resolveModel(settings, null)).toBe('opus-id');
  });

  test('falls back to the first configured model when no Creator is assigned', () => {
    const noCreator = { bedrockModels: [{ id: 'A', inferenceProfileId: 'a-id', role: '' }] };
    expect(resolveModel(noCreator, null)).toBe('a-id');
  });

  test('returns empty when nothing is configured', () => {
    expect(resolveModel({}, null)).toBe('');
  });
});

describe('IPC layer', () => {
  function harness({ online = true } = {}) {
    const handlers = {};
    const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; } };
    const ctx = {
      currentSettings: {
        region: 'us-east-1',
        mantleApiKey: 'key',
        bedrockModels: [{ id: 'Opus', inferenceProfileId: 'opus-id', role: 'creator' }],
      },
      settingsManager: { loadSettings: jest.fn(async () => ctx.currentSettings) },
      isOnline: () => online,
      assertOnline: (action = 'This action') => {
        if (!online) {
          const err = new Error(`${action} needs an internet connection — Hive is offline.`);
          err.code = 'HIVE_OFFLINE';
          throw err;
        }
      },
    };
    register(ipcMain, ctx);
    return { handlers, ctx };
  }

  const evt = () => ({ sender: { send: jest.fn() } });

  test('exposes the element definitions for the legend', async () => {
    const { handlers } = harness();
    const elements = await handlers['storyboard-get-elements'](evt());

    expect(elements).toHaveLength(7);
    expect(elements[0]).toMatchObject({ key: 'character', slug: 'blue' });
  });

  test('extracts pasted text without touching AWS', async () => {
    const { handlers } = harness({ online: false });

    const result = await handlers['storyboard-extract-text'](evt(), { text: 'One.\n\nTwo.' });

    expect(result.units.map(u => u.text)).toEqual(['One.', 'Two.']);
  });

  test('local history works offline', async () => {
    // Everything except the single classification call must work with no network.
    const { handlers } = harness({ online: false });
    await registry.save(ANALYSIS);

    await expect(handlers['storyboard-list'](evt())).resolves.toHaveLength(1);
    await expect(handlers['storyboard-search'](evt(), 'production')).resolves.toHaveLength(1);
  });

  test('refuses to analyse while offline, before spending anything', async () => {
    const { handlers } = harness({ online: false });

    await expect(handlers['storyboard-analyze'](evt(), { units: UNITS }))
      .rejects.toThrow(/offline/i);
  });

  test('refuses to re-analyse while offline', async () => {
    const { handlers } = harness({ online: false });
    await expect(handlers['storyboard-reanalyze'](evt(), { id: 'sb-whatever-1' }))
      .rejects.toThrow(/offline/i);
  });

  test('re-analysing something deleted fails clearly', async () => {
    const { handlers } = harness();
    await expect(handlers['storyboard-reanalyze'](evt(), { id: 'sb-missing-xx' }))
      .rejects.toThrow(/no longer exists/);
  });

  test('rejects an extract with no filename', async () => {
    const { handlers } = harness();
    await expect(handlers['storyboard-extract'](evt(), {})).rejects.toThrow(/No file provided/);
  });

  test('analyse links a re-upload to the previous analysis of that file', async () => {
    const { handlers, ctx } = harness();
    const first = await registry.save(ANALYSIS);

    // Stub the model call so this exercises the chaining, not the analyzer.
    const analyzer = require('../../src/main/models/storyboardAnalyzer');
    const spy = jest.spyOn(analyzer, 'analyze').mockResolvedValue({
      classifications: { 1: 'problem', 2: 'guide', 3: 'plan' },
      audit: null,
      modelId: 'opus-id',
      analysedAt: Date.now(),
    });

    const saved = await handlers['storyboard-analyze'](evt(), {
      units: UNITS, sourceName: 'keynote.docx', format: 'docx', wordCount: 3281,
    });

    expect(saved.revisionOf).toBe(first.id);
    spy.mockRestore();
  });

  test('a first analysis of a file has no predecessor', async () => {
    const { handlers } = harness();
    const analyzer = require('../../src/main/models/storyboardAnalyzer');
    const spy = jest.spyOn(analyzer, 'analyze').mockResolvedValue({
      classifications: { 1: 'problem', 2: 'guide', 3: 'plan' }, audit: null, modelId: 'opus-id', analysedAt: 1,
    });

    const saved = await handlers['storyboard-analyze'](evt(), {
      units: UNITS, sourceName: 'brand-new.docx', format: 'docx', wordCount: 100,
    });

    expect(saved.revisionOf).toBeNull();
    spy.mockRestore();
  });

  test('rename and delete go through', async () => {
    const { handlers } = harness();
    const saved = await registry.save(ANALYSIS);

    await handlers['storyboard-rename'](evt(), { id: saved.id, displayName: 'Renamed' });
    expect((await handlers['storyboard-get'](evt(), saved.id)).displayName).toBe('Renamed');

    expect(await handlers['storyboard-delete'](evt(), saved.id)).toBe(true);
    expect(await handlers['storyboard-get'](evt(), saved.id)).toBeNull();
  });
});
