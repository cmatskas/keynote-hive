/**
 * Tests for buildFlow() — the run-grouping behind the flow ribbon.
 *
 * The ribbon is both a picture of the story and a navigation control, so two
 * things have to hold: runs must reflect the document's real sequence (not its
 * composition, which the sidebar shape bar already shows), and the widths must
 * add up to the whole script or clicking a segment lands somewhere other than
 * where it appeared to point.
 */

const { buildFlow, runIndexForUnit, unitWords } = require('../../src/renderer/storyboardFlow.js');

/** Units as the extractor produces them: 1-based contiguous indices. */
function units(...texts) {
  return texts.map((text, i) => ({ index: i + 1, text, kind: 'paragraph' }));
}

describe('buildFlow()', () => {
  test('groups consecutive paragraphs sharing an element into one run', () => {
    // Without grouping a 70-paragraph keynote draws 70 slivers and reads as noise.
    const flow = buildFlow(units('a', 'b', 'c'), { 1: 'character', 2: 'character', 3: 'problem' });

    expect(flow).toHaveLength(2);
    expect(flow[0]).toMatchObject({ key: 'character', startIndex: 1, endIndex: 2, paragraphs: 2 });
    expect(flow[1]).toMatchObject({ key: 'problem', startIndex: 3, endIndex: 3, paragraphs: 1 });
  });

  test('preserves sequence, so the same element recurring makes two runs', () => {
    // The whole point of the ribbon: a story that returns to Problem later is
    // different from one that covers it once, and composition alone cannot say so.
    const flow = buildFlow(units('a', 'b', 'c'), { 1: 'problem', 2: 'guide', 3: 'problem' });

    expect(flow.map(r => r.key)).toEqual(['problem', 'guide', 'problem']);
  });

  test('sizes runs by word count, not paragraph count', () => {
    // Words are roughly stage time. Two runs of one paragraph each are not
    // necessarily equal halves of a talk.
    const flow = buildFlow(
      [
        { index: 1, text: 'one two three four five six seven eight nine ten' },
        { index: 2, text: 'short' },
      ],
      { 1: 'character', 2: 'problem' },
    );

    expect(flow[0].words).toBe(10);
    expect(flow[1].words).toBe(1);
    expect(flow[0].share).toBeCloseTo(10 / 11);
    expect(flow[1].share).toBeCloseTo(1 / 11);
  });

  test('shares sum to the whole script', () => {
    // If they do not, segment positions drift from what the user clicked.
    const flow = buildFlow(
      units('aa bb', 'cc', 'dd ee ff', 'gg'),
      { 1: 'character', 2: 'problem', 3: 'problem', 4: 'success' },
    );

    const total = flow.reduce((sum, r) => sum + r.share, 0);
    expect(total).toBeCloseTo(1);
  });

  test('counts outline children towards a run\'s weight', () => {
    // A bullet with five sub-points is a longer stretch of talk than a bare one,
    // and the extractor deliberately keeps them as one unit.
    const flow = buildFlow(
      [{ index: 1, text: 'Heading', children: ['first point', 'second point'] }],
      { 1: 'plan' },
    );

    expect(flow[0].words).toBe(5);
  });

  test('keeps an unclassified paragraph as a neutral run rather than dropping it', () => {
    // Dropping it would leave the widths not summing to the whole and shift every
    // later run's position — a silent lie about where things are.
    const flow = buildFlow(units('a', 'b', 'c'), { 1: 'character', 3: 'problem' });

    expect(flow.map(r => r.key)).toEqual(['character', null, 'problem']);
    expect(flow.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1);
  });

  test('accepts string keys, as JSON round-tripping produces', () => {
    // Classifications come back from disk with stringified numeric keys.
    const flow = buildFlow(units('a', 'b'), { '1': 'guide', '2': 'guide' });

    expect(flow).toHaveLength(1);
    expect(flow[0].key).toBe('guide');
  });

  test('a single-element script is one full-width run', () => {
    const flow = buildFlow(units('a', 'b', 'c'), { 1: 'cta', 2: 'cta', 3: 'cta' });

    expect(flow).toHaveLength(1);
    expect(flow[0].share).toBeCloseTo(1);
  });

  test('empty input yields no runs', () => {
    expect(buildFlow([], {})).toEqual([]);
    expect(buildFlow(null, {})).toEqual([]);
    expect(buildFlow(undefined, undefined)).toEqual([]);
  });

  test('a script of empty paragraphs still divides sensibly', () => {
    // No words anywhere would divide by zero; falls back to paragraph share so the
    // ribbon renders instead of collapsing.
    const flow = buildFlow(units('', '  '), { 1: 'character', 2: 'problem' });

    expect(flow).toHaveLength(2);
    expect(flow[0].share).toBeCloseTo(0.5);
    expect(flow[1].share).toBeCloseTo(0.5);
  });

  test('missing classifications entirely produce one neutral run', () => {
    const flow = buildFlow(units('a', 'b'), {});

    expect(flow).toHaveLength(1);
    expect(flow[0].key).toBeNull();
  });
});

describe('runIndexForUnit()', () => {
  const flow = buildFlow(units('a', 'b', 'c', 'd'), { 1: 'character', 2: 'character', 3: 'problem', 4: 'guide' });

  test('finds the run containing a paragraph', () => {
    expect(runIndexForUnit(flow, 1)).toBe(0);
    expect(runIndexForUnit(flow, 2)).toBe(0);   // mid-run, not just the boundary
    expect(runIndexForUnit(flow, 3)).toBe(1);
    expect(runIndexForUnit(flow, 4)).toBe(2);
  });

  test('returns -1 for a paragraph outside the script', () => {
    expect(runIndexForUnit(flow, 99)).toBe(-1);
    expect(runIndexForUnit(flow, 0)).toBe(-1);
    expect(runIndexForUnit(null, 1)).toBe(-1);
  });
});

describe('unitWords()', () => {
  test('ignores punctuation-only spacing and collapses whitespace', () => {
    expect(unitWords({ text: '  two   words  ' })).toBe(2);
    expect(unitWords({ text: '' })).toBe(0);
    expect(unitWords({ text: 'line\nbreak\ttab' })).toBe(3);
  });
});
