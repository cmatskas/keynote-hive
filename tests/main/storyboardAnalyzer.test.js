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
  _readRules,
  _readSoundbites,
  _readBrandAlignment,
  RULE_KEYS,
  MAX_WORDS,
} = require('../../src/main/models/storyboardAnalyzer');
const { ELEMENT_KEYS } = require('../../src/main/models/storybrandElements');

const units = (n) => Array.from({ length: n }, (_, i) => ({
  index: i + 1,
  text: `Paragraph ${i + 1} of the keynote.`,
  children: [],
  kind: 'paragraph',
}));

/**
 * The SDK's real stream event shape, matching every other call site in the app
 * (bedrock.js, agentToolExecutor.js, swarmOrchestrator.js) and the same helper
 * bedrockChat.test.js uses.
 *
 * This is deliberately not a convenience wrapper of our own invention. The
 * analyzer originally shipped with a guessed-at shape, and these tests passed
 * anyway because they mocked the *same guess* — a mock that encodes your
 * assumption verifies nothing. Every model then failed in production with "did not
 * return usable JSON" because not one character was ever accumulated.
 */
function textDelta(text) {
  return {
    type: 'modelStreamUpdateEvent',
    event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } },
  };
}

/** A createAgent stand-in that streams a fixed response as real SDK events. */
function agentReturning(response, { onPrompt } = {}) {
  return jest.fn(() => ({
    agent: {
      stream: (prompt) => {
        if (onPrompt) onPrompt(prompt);
        return (async function* () {
          yield textDelta(response);
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

  test('every prompt tells the model not to send the script back', async () => {
    // Asserted across all three calls rather than whichever ran last. The split
    // made this test start passing or failing depending on ordering, which is
    // exactly the kind of accident that leaves a real gap: the rule has to hold
    // for the audit and brand prompts too, since anything they echo could reach
    // the screen.
    const prompts = [];
    await analyze(baseArgs(2), {
      createAgent: agentReturning(goodEnvelope(2), { onPrompt: (p) => prompts.push(p) }),
    });

    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) {
      expect(prompt).toMatch(/do not (include the script text|reproduce the script)/i);
    }
    // The classification prompt is the one that refers to units by number.
    expect(prompts.some(p => /refer to units by\s*number only/i.test(p))).toBe(true);
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

  test('accumulates text across many deltas, ignoring non-text events', async () => {
    // A real stream interleaves lifecycle, reasoning and tool events among the
    // text deltas; only textDelta contributes.
    const envelope = goodEnvelope(2);
    const third = Math.floor(envelope.length / 3);
    const createAgent = jest.fn(() => ({
      agent: {
        stream: () => (async function* () {
          yield { type: 'agentInitializedEvent' };
          yield textDelta(envelope.slice(0, third));
          yield { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockStartEvent' } };
          yield textDelta(envelope.slice(third, third * 2));
          yield { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningDelta', text: 'IGNORE ME' } } };
          yield textDelta(envelope.slice(third * 2));
          yield { type: 'agentCompletedEvent' };
        })(),
      },
      dispose: jest.fn(),
    }));

    const result = await analyze(baseArgs(2), { createAgent });

    expect(Object.keys(result.classifications)).toEqual(['1', '2']);
  });

  test('a stream that yields no text deltas reports an empty response, not bad JSON', async () => {
    // This is the exact production failure. Reporting it as unparseable JSON sent
    // diagnosis at the parser when nothing had been accumulated at all.
    const createAgent = jest.fn(() => ({
      agent: {
        stream: () => (async function* () {
          yield { type: 'agentInitializedEvent' };
          yield { type: 'agentCompletedEvent' };
        })(),
      },
      dispose: jest.fn(),
    }));

    await expect(analyze(baseArgs(2), { createAgent })).rejects.toThrow(/returned an empty response/);
  });

  test('an unparseable reply quotes what came back', async () => {
    // "Unusable JSON" with no evidence is undiagnosable from a bug report.
    await expect(analyze(baseArgs(2), { createAgent: agentReturning('I am unable to help with that request.') }))
      .rejects.toThrow(/It replied: "I am unable to help with that request\."/);
  });

  test('rejects a response with no JSON at all', async () => {
    await expect(analyze(baseArgs(2), { createAgent: agentReturning('I cannot help with that.') }))
      .rejects.toThrow(/did not return usable JSON/);
  });

  test('rejects malformed JSON', async () => {
    await expect(analyze(baseArgs(2), { createAgent: agentReturning('{"classifications": {1: }') }))
      .rejects.toThrow(/did not return usable JSON/);
  });

  test('names the model in the failure, so a bug report identifies it', async () => {
    await expect(analyze(baseArgs(2), { createAgent: agentReturning('nope') }))
      .rejects.toThrow(/us\.anthropic\.claude-opus-4-6-v1/);
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
      // score is null, not 0: an analysis saved before scoring existed has no
      // score, and 0 would render as "missing" against a strong element.
      status: 'weak', score: null, found: '', issue: 'no villain', fix: '',
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

/**
 * The three-call split.
 *
 * One call had to emit the classification map for every paragraph, the whole
 * audit, and the brand check in a single envelope. The sections that came last got
 * the least care, a long script could run the combined output into the token
 * ceiling, and one malformed brace lost everything — including the classification
 * already paid for.
 *
 * Split, the guarantees worth protecting are: the classification is the only fatal
 * call, the judgement calls degrade independently, and nothing waits on anything
 * else.
 */
describe('the three-call split', () => {
  /**
   * An agent whose reply depends on which prompt it is given, so each call can be
   * made to succeed or fail independently.
   */
  function agentPerCall({ classification, audit, brand, onPrompt } = {}) {
    const replyFor = (prompt) => {
      if (/Assign exactly one element/.test(prompt)) return classification;
      if (/4 RULES OF MESSAGING/.test(prompt)) return audit;
      if (/Kernel" Brand Guidelines/.test(prompt)) return brand;
      throw new Error(`unrecognised prompt: ${prompt.slice(0, 60)}`);
    };
    return jest.fn(() => ({
      agent: {
        stream: (prompt) => {
          if (onPrompt) onPrompt(prompt);
          const reply = replyFor(prompt);
          return (async function* () {
            if (reply instanceof Error) throw reply;
            yield textDelta(reply);
          })();
        },
      },
      dispose: jest.fn(),
    }));
  }

  const classificationReply = (n) => JSON.stringify({
    classifications: Object.fromEntries(
      Array.from({ length: n }, (_, i) => [String(i + 1), ELEMENT_KEYS[i % ELEMENT_KEYS.length]]),
    ),
  });

  const auditReply = () => JSON.stringify({
    audit: {
      overall: 'Reads well.',
      elements: Object.fromEntries(ELEMENT_KEYS.map(k => [k, { status: 'strong', score: 9 }])),
      rules: {
        'zero-cognitive-load': { verdict: 'pass', evidence: 'plain language', note: '' },
        survival: { verdict: 'fail', evidence: '22% faster', note: 'lead with the benefit' },
        memorable: { verdict: 'pass', evidence: '', note: '' },
        'customer-hero': { verdict: 'pass', evidence: '', note: '' },
      },
      soundbites: {
        problem: { status: 'strong', found: 'the barking', suggestion: '' },
        empathy: { status: 'weak', found: '', suggestion: 'say you understand' },
        answer: { status: 'strong', found: '', suggestion: '' },
        change: { status: 'missing', found: '', suggestion: 'name who they become' },
        endResult: { status: 'strong', found: '', suggestion: '' },
      },
      whatsWorking: ['clear problem'],
      quickWins: ['add empathy'],
    },
  });

  const brandReply = () => JSON.stringify({
    brandAlignment: {
      score: 74,
      verdict: 'Close, but the opening centres AWS rather than the builder.',
      dimensions: {
        persona: { status: 'weak', score: 6, found: 'we built', issue: 'AWS as hero', fix: 'you build' },
        positioning: { status: 'strong', score: 9, found: '', issue: '', fix: '' },
        traits: { status: 'strong', score: 8, found: '', issue: '', fix: '' },
        voice: { status: 'weak', score: 7, found: '', issue: '', fix: '' },
        craft: { status: 'strong', score: 8, found: '', issue: '', fix: '' },
      },
      naturalAlignment: 'Guide and champion agree here.',
      tensions: ['The tightest line loses the double-take.'],
      outOfScope: ['Slide colour is a visual question.'],
    },
  });

  test('makes exactly three calls, one per concern', async () => {
    const createAgent = agentPerCall({
      classification: classificationReply(2), audit: auditReply(), brand: brandReply(),
    });

    await analyze(baseArgs(2), { createAgent });

    expect(createAgent).toHaveBeenCalledTimes(3);
    // Distinct ids, so a log or a trace can tell them apart.
    const ids = createAgent.mock.calls.map(c => c[0].id).sort();
    expect(new Set(ids).size).toBe(3);
  });

  test('returns the audit and the brand check together', async () => {
    const result = await analyze(baseArgs(2), {
      createAgent: agentPerCall({
        classification: classificationReply(2), audit: auditReply(), brand: brandReply(),
      }),
    });

    expect(result.audit.rules.survival.verdict).toBe('fail');
    expect(result.audit.soundbites.change.status).toBe('missing');
    expect(result.brandAlignment.score).toBe(74);
    expect(result.brandAlignment.dimensions.persona.fix).toBe('you build');
    expect(result.incomplete).toEqual([]);
  });

  test('a failed audit call keeps the classification and the brand check', async () => {
    // The whole point of splitting: colour-coding a script is useful on its own,
    // and losing it because one table came back malformed would be a poor trade.
    const result = await analyze(baseArgs(3), {
      createAgent: agentPerCall({
        classification: classificationReply(3),
        audit: new Error('stream died'),
        brand: brandReply(),
      }),
    });

    expect(Object.keys(result.classifications)).toHaveLength(3);
    expect(result.audit).toBeNull();
    expect(result.brandAlignment.score).toBe(74);
    expect(result.incomplete).toEqual(['audit']);
  });

  test('a failed brand call keeps the classification and the audit', async () => {
    const result = await analyze(baseArgs(3), {
      createAgent: agentPerCall({
        classification: classificationReply(3),
        audit: auditReply(),
        brand: new Error('stream died'),
      }),
    });

    expect(result.audit.overall).toBe('Reads well.');
    expect(result.brandAlignment).toBeNull();
    expect(result.incomplete).toEqual(['brand alignment']);
  });

  test('both judgement calls failing still yields a usable analysis', async () => {
    const result = await analyze(baseArgs(2), {
      createAgent: agentPerCall({
        classification: classificationReply(2),
        audit: new Error('nope'),
        brand: new Error('nope'),
      }),
    });

    expect(Object.keys(result.classifications)).toHaveLength(2);
    expect(result.incomplete).toEqual(['audit', 'brand alignment']);
  });

  test('a failed classification call is fatal', async () => {
    // Without it there is nothing to render, so this is the one that must throw
    // rather than degrade.
    await expect(analyze(baseArgs(2), {
      createAgent: agentPerCall({
        classification: new Error('stream died'),
        audit: auditReply(),
        brand: brandReply(),
      }),
    })).rejects.toThrow();
  });

  test('the calls run concurrently rather than in sequence', async () => {
    // Three sequential round trips would triple the wait for no benefit — none of
    // them needs another's result.
    let inFlight = 0;
    let peak = 0;
    const createAgent = jest.fn((opts) => ({
      agent: {
        stream: (prompt) => (async function* () {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise(r => setTimeout(r, 5));
          inFlight--;
          if (/Assign exactly one element/.test(prompt)) yield textDelta(classificationReply(2));
          else if (/4 RULES/.test(prompt)) yield textDelta(auditReply());
          else yield textDelta(brandReply());
        })(),
      },
      dispose: jest.fn(),
    }));

    await analyze(baseArgs(2), { createAgent });

    expect(peak).toBe(3);
  });

  test('an unparseable brand reply names which call failed', async () => {
    // "Did not return usable JSON" without saying which of three calls is
    // undiagnosable from a bug report.
    const result = await analyze(baseArgs(2), {
      createAgent: agentPerCall({
        classification: classificationReply(2),
        audit: auditReply(),
        brand: 'I cannot help with that.',
      }),
    });

    expect(result.brandAlignment).toBeNull();
    expect(result.incomplete).toEqual(['brand alignment']);
  });
});

describe('the new audit readers', () => {
  test('the 4 Rules keys are fixed, so an invented rule cannot reach the UI', () => {
    // Same reasoning as element keys: a row the UI has no label for would render
    // blank and read as "no issue found".
    const rules = _readRules({
      survival: { verdict: 'fail', evidence: 'specs', note: 'lead with benefit' },
      'my-invented-rule': { verdict: 'fail', evidence: 'x' },
    });

    expect(Object.keys(rules)).toEqual(RULE_KEYS);
    expect(rules.survival.verdict).toBe('fail');
    expect(rules['zero-cognitive-load'].verdict).toBe('unknown');
  });

  test('an invalid verdict becomes unknown rather than passing through', () => {
    const rules = _readRules({ memorable: { verdict: 'MAYBE' } });
    expect(rules.memorable.verdict).toBe('unknown');
  });

  test('the soundbites keep P.E.A.C.E. order regardless of response order', () => {
    // The order is part of the framework — Problem before Empathy before Answer —
    // and a scorecard that reorders them stops matching what the skill teaches.
    const sb = _readSoundbites({
      endResult: { status: 'strong' }, problem: { status: 'weak' },
    });

    expect(Object.keys(sb)).toEqual(['problem', 'empathy', 'answer', 'change', 'endResult']);
  });

  test('brand alignment clamps scores into range', () => {
    const brand = _readBrandAlignment({
      score: 140,
      verdict: 'ok',
      dimensions: { persona: { status: 'strong', score: 99 }, craft: { status: 'weak', score: -4 } },
    });

    expect(brand.score).toBe(100);
    expect(brand.dimensions.persona.score).toBe(10);
    expect(brand.dimensions.craft.score).toBe(0);
  });

  test('brand alignment is null when the response carried nothing usable', () => {
    // Null lets the panel say the check was unavailable. Five "unknown" rows would
    // read like a verdict of "no problems found", which is the opposite.
    expect(_readBrandAlignment(null)).toBeNull();
    expect(_readBrandAlignment({})).toBeNull();
    expect(_readBrandAlignment({ dimensions: {} })).toBeNull();
  });

  test('brand alignment survives a partial response', () => {
    const brand = _readBrandAlignment({ score: 62, dimensions: { persona: { status: 'weak' } } });

    expect(brand.score).toBe(62);
    expect(brand.dimensions.persona.status).toBe('weak');
    expect(brand.dimensions.voice.status).toBe('unknown');
    expect(brand.tensions).toEqual([]);
  });

  test('an audit from before this change still reads cleanly', () => {
    // Analyses saved by earlier versions have no rules, soundbites or scores. They
    // must load as "not assessed" rather than throwing or inventing verdicts.
    const audit = _readAudit({
      overall: 'old analysis',
      elements: { problem: { status: 'weak', issue: 'thin' } },
      whatsWorking: ['x'],
    });

    expect(audit.overall).toBe('old analysis');
    expect(audit.elements.problem.score).toBeNull();
    expect(Object.keys(audit.rules)).toEqual(RULE_KEYS);
    expect(audit.rules.survival.verdict).toBe('unknown');
    expect(audit.soundbites.problem.status).toBe('unknown');
  });
});
