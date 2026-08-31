/**
 * Tests for storyboardAnalyzer.
 *
 * Most of these are adversarial. The analyzer's job is not to trust a model: it
 * takes a map of unit index to element key and nothing else, because a model
 * handed a keynote will quietly reflow paragraphs and "fix" perceived typos, and
 * the user would get back a script that looks right and is not theirs.
 *
 * So the tests cover what happens when the response is fenced, prefixed with
 * chatter, shaped as an array instead of an object, missing paragraphs, carrying
 * invented element names, or echoing altered text back. In every case the rule is
 * the same: take the indices, discard the prose, and refuse to render a partial
 * result.
 */

jest.mock('electron-log/main', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  analyze,
  buildPrompt,
  parseEnvelope,
  missingIndices,
  _readClassifications,
  _readAudit,
  MAX_WORDS,
} = require('../../src/main/models/storyboardAnalyzer');
const { ELEMENT_KEYS } = require('../../src/main/models/storybrandElements');

const units = (n) => Array.from({ length: n }, (_, i) => ({
  index: i + 1,
  text: `Paragraph ${i + 1} of the keynote.`,
  children: [],
  kind: 'paragraph',
}));

/** A createAgent stand-in that streams a fixed response. */
function agentReturning(response, { onPrompt } = {}) {
  return jest.fn(() => ({
    agent: {
      stream: async (prompt) => {
        if (onPrompt) onPrompt(prompt);
        return (async function* () {
          yield { contentBlockDelta: { delta: { text: response } } };
        })();
      },
    },
    dispose: jest.fn(),
  }));
}

const goodEnvelope = (n) => JSON.stringify({
  classifications: Object.fromEntries(
    Array.from({ length: n }, (_, i) => [String(i + 1), ELEMENT_KEYS[i % ELEMENT_KEYS.length]]),
  ),
  audit: {
    overall: 'Solid arc, weak on stakes.',
    elements: Object.fromEntries(ELEMENT_KEYS.map(k => [k, {
      status: 'strong', found: 'unit 3', issue: '', fix: '',
    }])),
    whatsWorking: ['Clear problem framing'],
    quickWins: ['Name the villain explicitly'],
  },
});

const baseArgs = (n = 3) => ({
  units: units(n),
  modelId: 'us.anthropic.claude-opus-4-6-v1',
  region: 'us-east-1',
  mantleApiKey: 'key',
  wordCount: 100,
});

describe('the happy path', () => {
  test('returns a classification for every unit', async () => {
    const createAgent = agentReturning(goodEnvelope(3));

    const result = await analyze(baseArgs(3), { createAgent });

    expect(Object.keys(result.classifications)).toEqual(['1', '2', '3']);
    expect(ELEMENT_KEYS).toContain(result.classifications[1]);
    expect(result.modelId).toBe('us.anthropic.claude-opus-4-6-v1');
    expect(typeof result.analysedAt).toBe('number');
  });

  test('returns the normalised audit', async () => {
    const createAgent = agentReturning(goodEnvelope(3));

    const { audit } = await analyze(baseArgs(3), { createAgent });

    expect(audit.overall).toBe('Solid arc, weak on stakes.');
    expect(Object.keys(audit.elements).sort()).toEqual([...ELEMENT_KEYS].sort());
    expect(audit.whatsWorking).toEqual(['Clear problem framing']);
    expect(audit.quickWins).toEqual(['Name the villain explicitly']);
  });

  test('disposes the agent even when parsing fails', async () => {
    const dispose = jest.fn();
    const createAgent = jest.fn(() => ({
      agent: { stream: async () => (async function* () { yield { text: 'not json' }; })() },
      dispose,
    }));

    await expect(analyze(baseArgs(2), { createAgent })).rejects.toThrow();
    expect(dispose).toHaveBeenCalled();
  });
});

describe('the model never supplies the text', () => {
  test('ignores text the model attaches to each classification', async () => {
    // The critical property. If the model returns its own version of a paragraph,
    // it must be discarded — not rendered back to the user as their script.
    const response = JSON.stringify({
      classifications: {
        1: { element: 'problem', text: 'A REWRITTEN, IMPROVED PARAGRAPH.' },
        2: { element: 'guide', text: 'ANOTHER REWRITE.' },
      },
      audit: {},
    });

    const result = await analyze(baseArgs(2), { createAgent: agentReturning(response) });

    expect(result.classifications).toEqual({ 1: 'problem', 2: 'guide' });
    // Nothing anywhere in the result carries model-authored prose for a unit.
    expect(JSON.stringify(result)).not.toMatch(/REWRITTEN|REWRITE/);
  });

  test('the prompt asks the model not to return the script', () => {
    let seen = '';
    return analyze(baseArgs(2), {
      createAgent: agentReturning(goodEnvelope(2), { onPrompt: (p) => { seen = p; } }),
    }).then(() => {
      expect(seen).toMatch(/Do not include the script text/i);
      expect(seen).toMatch(/refer to units by\s*number only/i);
    });
  });

  test('drops classifications for units that do not exist', async () => {
    // A model inventing unit 99 must not put an index in the result that points at
    // nothing renderable.
    const response = JSON.stringify({
      classifications: { 1: 'problem', 2: 'guide', 99: 'success' },
      audit: {},
    });

    const result = await analyze(baseArgs(2), { createAgent: agentReturning(response) });

    expect(Object.keys(result.classifications)).toEqual(['1', '2']);
  });
});

describe('tolerating how models actually reply', () => {
  test('strips markdown fences', () => {
    const parsed = parseEnvelope('```json\n{"classifications":{"1":"problem"}}\n```');
    expect(parsed.classifications['1']).toBe('problem');
  });

  test('ignores chatter before and after the object', () => {
    const parsed = parseEnvelope('Sure! Here is the analysis:\n{"a":1}\nHope that helps.');
    expect(parsed).toEqual({ a: 1 });
  });

  test('accepts an array of entries instead of a map', async () => {
    const response = JSON.stringify({
      classifications: [
        { index: 1, element: 'problem' },
        { index: 2, element: 'guide' },
      ],
      audit: {},
    });

    const result = await analyze(baseArgs(2), { createAgent: agentReturning(response) });

    expect(result.classifications).toEqual({ 1: 'problem', 2: 'guide' });
  });

  test('accepts alternative key names in array form', () => {
    const map = _readClassifications([{ unit: 1, key: 'plan' }, { id: 2, value: 'cta' }]);
    expect(map.get(1)).toBe('plan');
    expect(map.get(2)).toBe('cta');
  });

  test('accumulates text from different stream chunk shapes', async () => {
    const envelope = goodEnvelope(2);
    const half = Math.floor(envelope.length / 2);
    const createAgent = jest.fn(() => ({
      agent: {
        stream: async () => (async function* () {
          yield { contentBlockDelta: { delta: { text: envelope.slice(0, half) } } };
          yield { delta: { text: envelope.slice(half) } };
        })(),
      },
      dispose: jest.fn(),
    }));

    const result = await analyze(baseArgs(2), { createAgent });
    expect(Object.keys(result.classifications)).toEqual(['1', '2']);
  });

  test('rejects a response with no JSON at all', async () => {
    await expect(analyze(baseArgs(2), { createAgent: agentReturning('I cannot help with that.') }))
      .rejects.toThrow(/did not return usable JSON/);
  });

  test('rejects malformed JSON', async () => {
    await expect(analyze(baseArgs(2), { createAgent: agentReturning('{"classifications": {1: }') }))
      .rejects.toThrow(/did not return usable JSON/);
  });
});

describe('strict validation', () => {
  test('refuses a partial result and names the missing paragraphs', async () => {
    // Rendering with gaps is worse than failing: a paragraph falling back to a
    // default colour looks identical to a real classification.
    const response = JSON.stringify({
      classifications: { 1: 'problem', 3: 'guide' },
      audit: {},
    });

    await expect(analyze(baseArgs(4), { createAgent: agentReturning(response) }))
      .rejects.toThrow(/classified 2 of 4 paragraphs.*Missing: 2, 4/s);
  });

  test('truncates a long list of missing paragraphs', async () => {
    const response = JSON.stringify({ classifications: { 1: 'problem' }, audit: {} });

    await expect(analyze(baseArgs(20), { createAgent: agentReturning(response) }))
      .rejects.toThrow(/\+11 more/);
  });

  test('treats an invented element name as unclassified', async () => {
    const response = JSON.stringify({
      classifications: { 1: 'problem', 2: 'vibes' },
      audit: {},
    });

    await expect(analyze(baseArgs(2), { createAgent: agentReturning(response) }))
      .rejects.toThrow(/Missing: 2/);
  });

  test('ignores a duplicate assignment rather than flip-flopping', () => {
    const map = _readClassifications({ 1: 'problem', '01': 'guide' });
    expect(map.get(1)).toBe('problem');
  });

  test('rejects non-integer and zero indices', () => {
    const map = _readClassifications({ 0: 'problem', '-1': 'guide', 'abc': 'plan', 1.5: 'cta' });
    expect(map.size).toBe(0);
  });
});

describe('input guards', () => {
  test('refuses an empty script', async () => {
    await expect(analyze({ ...baseArgs(0), units: [] })).rejects.toThrow(/Nothing to analyse/);
  });

  test('refuses with no model selected', async () => {
    await expect(analyze({ ...baseArgs(2), modelId: '' })).rejects.toThrow(/No model selected/);
  });

  test('names the missing Mantle key rather than failing at the call', async () => {
    await expect(analyze({ ...baseArgs(2), mantleApiKey: '' }))
      .rejects.toThrow(/Mantle API key not configured/);
  });

  test('refuses a script above the single-call word limit', async () => {
    // Better a real number up front than a truncated response after a paid call.
    await expect(analyze({ ...baseArgs(2), wordCount: MAX_WORDS + 1 }))
      .rejects.toThrow(/above the .* limit for a single analysis/);
  });
});

describe('the audit is secondary to the classification', () => {
  test('a completely missing audit does not fail the analysis', async () => {
    // The colour-coding is the point; losing the audit must not lose it.
    const response = JSON.stringify({
      classifications: { 1: 'problem', 2: 'guide' },
    });

    const { audit } = await analyze(baseArgs(2), { createAgent: agentReturning(response) });

    expect(audit.overall).toBe('');
    expect(Object.keys(audit.elements)).toHaveLength(ELEMENT_KEYS.length);
    expect(audit.whatsWorking).toEqual([]);
  });

  test('fills a status for every element even when the model skips some', () => {
    const audit = _readAudit({ elements: { problem: { status: 'weak', issue: 'no villain' } } });

    expect(audit.elements.problem).toEqual({
      status: 'weak', found: '', issue: 'no villain', fix: '',
    });
    expect(audit.elements.success.status).toBe('unknown');
  });

  test('rejects an invalid status rather than passing it to the UI', () => {
    const audit = _readAudit({ elements: { problem: { status: 'AMAZING' } } });
    expect(audit.elements.problem.status).toBe('unknown');
  });

  test('drops non-string entries from the lists', () => {
    const audit = _readAudit({ whatsWorking: ['real', 42, null, '  '], quickWins: 'not an array' });
    expect(audit.whatsWorking).toEqual(['real']);
    expect(audit.quickWins).toEqual([]);
  });
});

describe('buildPrompt', () => {
  test('numbers every unit and states the count', () => {
    const prompt = buildPrompt(units(3));
    expect(prompt).toContain('[1]');
    expect(prompt).toContain('[3]');
    expect(prompt).toMatch(/every number from 1 to 3/);
  });

  test('lists all seven valid element keys', () => {
    const prompt = buildPrompt(units(2));
    for (const key of ELEMENT_KEYS) expect(prompt).toContain(key);
  });

  test('marks headings so structural lines are recognisable', () => {
    const prompt = buildPrompt([{ index: 1, text: 'CHAPTER 1', children: [], kind: 'heading' }]);
    expect(prompt).toContain('[1] (heading)');
  });

  test('includes outline children so a grouped bullet is classified on all its content', () => {
    const prompt = buildPrompt([
      { index: 1, text: 'Five root causes', children: ['Wrong problem', 'No measurement'], kind: 'bullet' },
    ]);
    expect(prompt).toContain('Wrong problem');
    expect(prompt).toContain('No measurement');
  });

  test('truncates an absurdly long unit rather than sending it whole', () => {
    const prompt = buildPrompt([{ index: 1, text: 'x'.repeat(5000), children: [], kind: 'paragraph' }]);
    expect(prompt.length).toBeLessThan(4000);
    expect(prompt).toContain('…');
  });
});

describe('missingIndices', () => {
  test('lists unclassified indices in order', () => {
    const classified = new Map([[1, 'problem'], [3, 'guide']]);
    expect(missingIndices(units(4), classified)).toEqual([2, 4]);
  });

  test('is empty when everything is classified', () => {
    const classified = new Map([[1, 'problem'], [2, 'guide']]);
    expect(missingIndices(units(2), classified)).toEqual([]);
  });
});
