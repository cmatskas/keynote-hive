/**
 * storyboardAnalyzer.js — classify a script against the StoryBrand SB7 elements.
 *
 * ONE CALL, ONE ENVELOPE
 * ----------------------
 * A single model call returns both the per-paragraph classification and the
 * qualitative audit, wrapped in one JSON object:
 *
 *   { "classifications": { "1": "problem", ... }, "audit": { ... } }
 *
 * The envelope matters. Asking for JSON *followed by* a prose audit is where
 * malformed output comes from — the model closes the JSON, starts writing, and the
 * parse boundary becomes ambiguous. Keeping the audit as structured fields inside
 * the same object means one parse either succeeds or fails cleanly, and the audit
 * renders from fields rather than from a blob that has to be re-parsed later.
 *
 * THE MODEL NEVER SUPPLIES THE TEXT
 * ---------------------------------
 * The only thing taken from the response is a map of unit index to element key.
 * Every rendered word comes from `storyboardExtractor`'s units, looked up by
 * index. This is deliberate and load-bearing: a model handed a keynote will
 * quietly reflow paragraphs, "fix" perceived typos and drop clauses, and the user
 * would get back something that looks right and is not their script. Even if the
 * response contains text, it is discarded — see `_readClassifications`.
 *
 * VALIDATION IS STRICT
 * --------------------
 * Every unit must be classified exactly once, with a known element key. A partial
 * result is rejected with the specific missing indices rather than rendered with
 * gaps, because a paragraph silently falling back to a default colour is
 * indistinguishable from a real classification.
 */

const { ELEMENT_KEYS, isValidElementKey, promptElementSummary } = require('./storybrandElements');
const { collectStreamText } = require('../utils');
const log = require('electron-log/main');

/**
 * Above this, one request is likely to be truncated by the model's output limit
 * before it finishes emitting the classification map. Refusing up front with a
 * real number beats a confusing partial-result failure after a paid call.
 */
const MAX_WORDS = 20000;

/** Long enough that a paragraph is recognisable, short enough to stay cheap. */
const MAX_UNIT_CHARS = 1200;

function buildPrompt(units) {
  const numbered = units
    .map(u => {
      const body = [u.text, ...(u.children || []).map(c => `  - ${c}`)].join('\n');
      const truncated = body.length > MAX_UNIT_CHARS ? `${body.slice(0, MAX_UNIT_CHARS)}…` : body;
      return `[${u.index}]${u.kind === 'heading' ? ' (heading)' : ''} ${truncated}`;
    })
    .join('\n\n');

  return `You are a StoryBrand messaging strategist applying Donald Miller's SB7 framework.

Below is a keynote script or outline, split into ${units.length} numbered units.

THE SEVEN ELEMENTS
${promptElementSummary()}

TASK
1. Assign exactly one element to every unit from 1 to ${units.length}. Every unit must be
   classified — choose the closest element even for transitional or structural lines.
2. Produce a qualitative audit of the script as a whole.

SCRIPT
${numbered}

OUTPUT
Reply with a single JSON object and nothing else — no prose before or after, no
markdown fences. Do not include the script text in your reply; refer to units by
number only.

{
  "classifications": {
    "1": "<element key>",
    "2": "<element key>"
    // ... every number from 1 to ${units.length}
  },
  "audit": {
    "overall": "<two or three sentences on how well the script works as a story>",
    "elements": {
      "<element key>": {
        "status": "strong" | "weak" | "missing",
        "found": "<short quote or unit number where this element lands, or empty>",
        "issue": "<what is wrong or missing, or empty if strong>",
        "fix": "<one specific, actionable change, or empty if strong>"
      }
      // ... one entry per element key, all seven
    },
    "whatsWorking": ["<specific strength>", "..."],
    "quickWins": ["<highest-impact change>", "..."]
  }
}

Valid element keys: ${ELEMENT_KEYS.join(', ')}`;
}

/**
 * Pull the JSON object out of a model response.
 *
 * Tolerant of markdown fences and of leading chatter, because models add both
 * despite instructions. Follows the same shape as rubricEvaluator's judge parsing:
 * slice from the first brace to the last and let JSON.parse be the arbiter.
 */
function parseEnvelope(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Read the classification map, taking nothing but indices and element keys.
 *
 * Accepts either `{ "1": "problem" }` or `[{ index: 1, element: "problem" }]`,
 * since models drift between the two. Any text the model attached to an entry is
 * ignored rather than trusted.
 */
function _readClassifications(raw) {
  const out = new Map();
  if (!raw) return out;

  const put = (index, element) => {
    const n = Number(index);
    if (!Number.isInteger(n) || n < 1) return;
    if (!isValidElementKey(element)) return;
    if (!out.has(n)) out.set(n, element);   // first assignment wins
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      put(entry.index ?? entry.unit ?? entry.id, entry.element ?? entry.key ?? entry.value);
    }
    return out;
  }

  if (typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      // A value may arrive as a bare key or as an object carrying one.
      const element = typeof value === 'string'
        ? value
        : (value && typeof value === 'object' ? (value.element ?? value.key) : null);
      put(key, element);
    }
  }
  return out;
}

/** Normalise the audit, filling gaps rather than failing on them. */
function _readAudit(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rawElements = source.elements && typeof source.elements === 'object' ? source.elements : {};

  const elements = {};
  for (const key of ELEMENT_KEYS) {
    const entry = rawElements[key] && typeof rawElements[key] === 'object' ? rawElements[key] : {};
    const status = ['strong', 'weak', 'missing'].includes(entry.status) ? entry.status : 'unknown';
    elements[key] = {
      status,
      found: typeof entry.found === 'string' ? entry.found : '',
      issue: typeof entry.issue === 'string' ? entry.issue : '',
      fix: typeof entry.fix === 'string' ? entry.fix : '',
    };
  }

  const stringList = (value) => (Array.isArray(value)
    ? value.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim())
    : []);

  return {
    overall: typeof source.overall === 'string' ? source.overall : '',
    elements,
    whatsWorking: stringList(source.whatsWorking),
    quickWins: stringList(source.quickWins),
  };
}

/**
 * Which unit indices did the model fail to classify?
 * Reported specifically so a failure names what went wrong.
 */
function missingIndices(units, classified) {
  return units.map(u => u.index).filter(i => !classified.has(i));
}

/**
 * Run the analysis.
 *
 * @param {object} args
 * @param {Array}  args.units      - from storyboardExtractor
 * @param {string} args.modelId    - Mantle model id
 * @param {string} args.region
 * @param {string} args.mantleApiKey
 * @param {number} [args.wordCount]
 * @param {object} [deps]          - { createAgent } injectable for tests
 * @returns {Promise<{classifications: object, audit: object, modelId: string, analysedAt: number}>}
 */
async function analyze({ units, modelId, region, mantleApiKey, wordCount = 0 }, deps = {}) {
  if (!Array.isArray(units) || units.length === 0) throw new Error('Nothing to analyse.');
  if (!modelId) throw new Error('No model selected.');
  if (!mantleApiKey) {
    throw new Error('Mantle API key not configured — set it in Settings > Mantle API Key');
  }
  if (wordCount > MAX_WORDS) {
    throw new Error(
      `That script is ${wordCount.toLocaleString()} words, above the ${MAX_WORDS.toLocaleString()}-word ` +
      'limit for a single analysis. Split it into sections and analyse each one.',
    );
  }

  const createAgent = deps.createAgent || require('./strandsAgentFactory').createAgent;
  const { agent, dispose } = createAgent({
    modelId,
    region,
    mantleApiKey,
    systemPrompt: 'You are a precise analytical assistant. You reply with valid JSON only.',
    tools: [],
    id: 'storyboard',
  });

  let response = '';
  try {
    // Via the shared accumulator, not a hand-rolled loop. This originally guessed
    // at the SDK's event shape and silently accumulated nothing, so every model
    // failed with "did not return usable JSON" — the parse was never the problem.
    response = await collectStreamText(agent.stream(buildPrompt(units)));
  } finally {
    if (typeof dispose === 'function') {
      try { dispose(); } catch { /* disposal is best-effort */ }
    }
  }

  if (!response.trim()) {
    // A separate message on purpose: an empty response means the request or the
    // stream failed, not that the model wrote something unparseable. Conflating
    // the two is what made the original bug hard to place.
    throw new Error(
      `${modelId} returned an empty response. This is usually a transport or model ` +
      'availability problem rather than the script — try again, or pick another model.',
    );
  }

  const envelope = parseEnvelope(response);
  if (!envelope) {
    // Include what actually came back; "unusable JSON" with no evidence is
    // undiagnosable from a bug report.
    const preview = response.trim().replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(
      `${modelId} did not return usable JSON. It replied: "${preview}${response.length > 200 ? '…' : ''}". ` +
      'Try again, or pick a different model.',
    );
  }

  const classified = _readClassifications(envelope.classifications);
  const missing = missingIndices(units, classified);
  if (missing.length > 0) {
    // Deliberately not rendered with gaps: a paragraph quietly falling back to a
    // default colour is indistinguishable from a real classification.
    const shown = missing.slice(0, 8).join(', ');
    throw new Error(
      `The model classified ${classified.size} of ${units.length} paragraphs. ` +
      `Missing: ${shown}${missing.length > 8 ? `, +${missing.length - 8} more` : ''}. Try re-analysing.`,
    );
  }

  // Keys outside the script are the model inventing units; drop them rather than
  // persisting indices that point at nothing.
  const valid = new Set(units.map(u => u.index));
  const classifications = {};
  for (const [index, element] of classified) {
    if (valid.has(index)) classifications[index] = element;
  }

  log.info(`[storyboard] classified ${Object.keys(classifications).length} units with ${modelId}`);

  return {
    classifications,
    audit: _readAudit(envelope.audit),
    modelId,
    analysedAt: Date.now(),
  };
}

module.exports = {
  analyze,
  buildPrompt,
  parseEnvelope,
  missingIndices,
  _readClassifications,
  _readAudit,
  MAX_WORDS,
  MAX_UNIT_CHARS,
};
