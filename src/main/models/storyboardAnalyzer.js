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

/**
 * The 4 Rules, the 5 Soundbites and the 5 brand dimensions, as fixed key lists.
 *
 * Fixed rather than read from the model's response so a renamed or invented key
 * cannot produce a row the UI has no label for — the same reason element keys are
 * validated against ELEMENT_KEYS.
 */
const RULE_KEYS = ['zero-cognitive-load', 'survival', 'memorable', 'customer-hero'];
const SOUNDBITE_KEYS = ['problem', 'empathy', 'answer', 'change', 'endResult'];
const BRAND_DIMENSION_KEYS = ['persona', 'positioning', 'traits', 'voice', 'craft'];

/** Long enough that a paragraph is recognisable, short enough to stay cheap. */
const MAX_UNIT_CHARS = 1200;

/** The script as numbered units — shared by all three prompts. */
function numberedScript(units) {
  return units
    .map(u => {
      const body = [u.text, ...(u.children || []).map(c => `  - ${c}`)].join('\n');
      const truncated = body.length > MAX_UNIT_CHARS ? `${body.slice(0, MAX_UNIT_CHARS)}…` : body;
      return `[${u.index}]${u.kind === 'heading' ? ' (heading)' : ''} ${truncated}`;
    })
    .join('\n\n');
}

/**
 * Call 1 — classification. One element per unit, nothing else.
 *
 * Mechanical and high-volume: for a long script this output is mostly a map of
 * numbers to keys. Keeping judgement out of it means the model is not trading
 * attention between "which element is unit 47" and "how good is the Guide
 * section", and the output stays small enough not to approach the token ceiling.
 */
function buildClassificationPrompt(units) {
  return `You are a StoryBrand messaging strategist applying Donald Miller's SB7 framework.

Below is a keynote script or outline, split into ${units.length} numbered units.

THE SEVEN ELEMENTS
${promptElementSummary()}

TASK
Assign exactly one element to every unit from 1 to ${units.length}. Every unit must be
classified — choose the closest element even for transitional or structural lines.

SCRIPT
${numberedScript(units)}

OUTPUT
Reply with a single JSON object and nothing else — no prose before or after, no
markdown fences. Do not include the script text in your reply; refer to units by
number only.

{
  "classifications": {
    "1": "<element key>",
    "2": "<element key>"
    // ... every number from 1 to ${units.length}
  }
}

Valid element keys: ${ELEMENT_KEYS.join(', ')}`;
}

/**
 * Call 2 — the StoryBrand audit: seven elements, the 4 Rules, and P.E.A.C.E.
 *
 * All judgement about the story itself, in one call, because these three lenses
 * inform each other — a weak Problem element and a failed "link it to survival"
 * are usually the same defect seen twice.
 */
function buildAuditPrompt(units) {
  return `You are a StoryBrand messaging strategist applying Donald Miller's StoryBrand 2.0
framework — the SB7 elements, the 4 Rules of Messaging, and the 5 Foundational
Soundbites (P.E.A.C.E.).

Below is a keynote script or outline, split into ${units.length} numbered units.

THE SEVEN ELEMENTS
${promptElementSummary()}

THE 4 RULES OF MESSAGING
1. zero-cognitive-load — Clear beats clever. Flag jargon, abstraction, insider language.
2. survival — The brain attends to saving money or time, health, status, relationships,
   security. Flag messaging that leads with features or specs instead.
3. memorable — Short phrases get repeated. Flag invisible filler words like
   "innovative", "solutions", "best-in-class". Could a listener repeat this line?
4. customer-hero — The brand is the guide, never the hero. Flag language about the
   speaker or the company rather than the audience's problem and transformation.

THE 5 FOUNDATIONAL SOUNDBITES (P.E.A.C.E.)
problem — names the challenge keeping the audience up at night, in plain language.
empathy — shows the speaker understands how that problem feels.
answer — positions the solution, closing the loop the problem opened, in few words.
change — who does the audience get to become?
endResult — the better life on the other side.

SCORING
Score 0-10 per item. strong = 8-10 (present, clear, audience-focused).
weak = 4-7 (present but vague, speaker-focused, or buried).
missing = 0-3 (absent or unrecognisable).
Score conservatively: if you have to hunt for it, it is weak, not strong. A false
"strong" costs the user real money — never inflate a score to be encouraging.

SCRIPT
${numberedScript(units)}

OUTPUT
Reply with a single JSON object and nothing else — no prose before or after, no
markdown fences. Do not reproduce the script; quote at most a short phrase.

{
  "audit": {
    "overall": "<two or three sentences on how well the script works as a story>",
    "elements": {
      "<element key>": {
        "status": "strong" | "weak" | "missing",
        "score": <0-10>,
        "found": "<short quote or unit number, or empty>",
        "issue": "<what is wrong or missing, or empty if strong>",
        "fix": "<one specific, actionable change, or empty if strong>"
      }
      // ... all seven element keys
    },
    "rules": {
      "zero-cognitive-load": { "verdict": "pass" | "fail", "evidence": "<short quote>", "note": "<why, or the rewrite>" },
      "survival":            { "verdict": "pass" | "fail", "evidence": "...", "note": "..." },
      "memorable":           { "verdict": "pass" | "fail", "evidence": "...", "note": "..." },
      "customer-hero":       { "verdict": "pass" | "fail", "evidence": "...", "note": "..." }
    },
    "soundbites": {
      "problem":   { "status": "strong" | "weak" | "missing", "found": "<quote or empty>", "suggestion": "<drafted or improved line>" },
      "empathy":   { "status": "...", "found": "...", "suggestion": "..." },
      "answer":    { "status": "...", "found": "...", "suggestion": "..." },
      "change":    { "status": "...", "found": "...", "suggestion": "..." },
      "endResult": { "status": "...", "found": "...", "suggestion": "..." }
    },
    "whatsWorking": ["<specific strength>", "..."],
    "quickWins": ["<highest-impact change>", "..."]
  }
}

Valid element keys: ${ELEMENT_KEYS.join(', ')}`;
}

/**
 * Call 3 — AWS Kernel brand alignment.
 *
 * Its own call because it is a genuinely separate axis with its own expertise, and
 * because as the tail of a combined response it got the thinnest treatment of
 * anything in the envelope. Here it is the whole task.
 */
function buildBrandPrompt(units) {
  return `You are an AWS brand strategist applying the AWS "Kernel" Brand Guidelines V1.0
to a keynote script. Evaluate how well it sounds, feels and positions like AWS.

THE BRAND
Positioning: "We believe there is a builder in everyone, ready to turn their
ambition into action." AWS champions builders — anyone with an idea and the drive
to make it real.

Persona — Every Maker's Champion: AWS is never the hero, always the champion behind
the builder. It sees the customer's potential before they do, hands them tools, and
backs them until success feels inevitable. This agrees with StoryBrand's
guide-not-hero principle; where the script gets both right, say so.

5 Personality Traits: encouraging (back ambition without cheerleading) · candid
(say it straight, clear-eyed about the realities of building) · curious (ask,
listen, understand the audience's world) · ingenious (find a smarter way) ·
determined (dig in when the build gets hard).

5 Voice Tenets: delight in doing (energy of making) · you first (it is the
audience's story) · double take (make people listen twice — wit, a fresh angle) ·
perfect is boring (texture and a human voice over polish) · make it feel real
(concrete detail and real numbers, not glossed-over ones).

Writing craft — do: present tense · prove with specifics ("from 4s to 0.8s" beats
"dramatically faster") · one idea per sentence · move every line forward · pristine
on technical detail · eye-level tone. Don't: corporate buzzwords · vagueness · hype
and exclamation points · superlatives and absolutes ("always", "best") · info dumps
· jargon, even "cloud" · leading with the Amazon name as a headline (Amazon is a
silent credential).

SCOPE
Verbal identity only — positioning, persona, traits, voice, craft. Do not judge
visual identity (logo, colour, typography, slides, motion). If something raises a
visual question, note it as out of scope.

SCORING
Score each of the five dimensions 0-10, conservatively. strong = 8-10, weak = 4-7,
missing = 0-3. If you have to hunt for it, it is weak. Never inflate to be kind —
off-brand copy that ships erodes brand equity. Then give one overall score out of
100 as the five dimension scores summed and doubled.

SCRIPT
${numberedScript(units)}

OUTPUT
Reply with a single JSON object and nothing else — no prose before or after, no
markdown fences. Do not reproduce the script; quote at most a short phrase.

{
  "brandAlignment": {
    "score": <0-100>,
    "verdict": "<one line: how close to AWS voice is this?>",
    "dimensions": {
      "persona":     { "status": "strong" | "weak" | "missing", "score": <0-10>, "found": "<short quote>", "issue": "<specific issue, or empty>", "fix": "<concrete on-brand rewrite, or empty>" },
      "positioning": { "status": "...", "score": <0-10>, "found": "...", "issue": "...", "fix": "..." },
      "traits":      { "status": "...", "score": <0-10>, "found": "...", "issue": "...", "fix": "..." },
      "voice":       { "status": "...", "score": <0-10>, "found": "...", "issue": "...", "fix": "..." },
      "craft":       { "status": "...", "score": <0-10>, "found": "...", "issue": "...", "fix": "..." }
    },
    "naturalAlignment": "<where StoryBrand and AWS brand agree in this script, or empty>",
    "tensions": ["<a place where maximum clarity costs brand character, with both options>", "..."],
    "outOfScope": ["<visual-brand question to refer to the brand team>", "..."]
  }
}`;
}

/**
 * Kept as the classification prompt.
 *
 * The name predates the split, and the classification call is the one that must
 * succeed, so it keeps the plain name.
 */
const buildPrompt = buildClassificationPrompt;

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
      // Null rather than 0 when absent: an analysis saved before scoring existed
      // has no score, and 0 would render as "missing" on a strong element.
      score: _readScore(entry.score, 10),
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
    rules: _readRules(source.rules),
    soundbites: _readSoundbites(source.soundbites),
    whatsWorking: stringList(source.whatsWorking),
    quickWins: stringList(source.quickWins),
  };
}

/** Clamp a model-supplied score into range, or null when it gave none. */
function _readScore(value, max) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(max, Math.round(n)));
}

function _readStatus(value) {
  return ['strong', 'weak', 'missing'].includes(value) ? value : 'unknown';
}

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * The 4 Rules check.
 *
 * Keys are fixed rather than taken from the response, so a model that renames or
 * invents a rule cannot introduce a row the UI has no copy for.
 */
function _readRules(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of RULE_KEYS) {
    const entry = source[key] && typeof source[key] === 'object' ? source[key] : {};
    out[key] = {
      verdict: ['pass', 'fail'].includes(entry.verdict) ? entry.verdict : 'unknown',
      evidence: str(entry.evidence),
      note: str(entry.note),
    };
  }
  return out;
}

/** The P.E.A.C.E. scorecard, in fixed order. */
function _readSoundbites(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of SOUNDBITE_KEYS) {
    const entry = source[key] && typeof source[key] === 'object' ? source[key] : {};
    out[key] = {
      status: _readStatus(entry.status),
      found: str(entry.found),
      suggestion: str(entry.suggestion),
    };
  }
  return out;
}

/**
 * AWS Kernel brand alignment.
 *
 * Returns null for a response with nothing usable in it, so the panel can say the
 * check was unavailable rather than render five "unknown" rows that read like a
 * verdict of "no issues found".
 */
function _readBrandAlignment(raw) {
  const source = raw && typeof raw === 'object' ? raw : null;
  if (!source) return null;

  const rawDims = source.dimensions && typeof source.dimensions === 'object' ? source.dimensions : {};
  const dimensions = {};
  let anyDimension = false;
  for (const key of BRAND_DIMENSION_KEYS) {
    const entry = rawDims[key] && typeof rawDims[key] === 'object' ? rawDims[key] : {};
    const status = _readStatus(entry.status);
    if (status !== 'unknown') anyDimension = true;
    dimensions[key] = {
      status,
      score: _readScore(entry.score, 10),
      found: str(entry.found),
      issue: str(entry.issue),
      fix: str(entry.fix),
    };
  }

  const score = _readScore(source.score, 100);
  const verdict = str(source.verdict);
  if (!anyDimension && score === null && !verdict) return null;

  const stringList = (value) => (Array.isArray(value)
    ? value.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim())
    : []);

  return {
    score,
    verdict,
    dimensions,
    naturalAlignment: str(source.naturalAlignment),
    tensions: stringList(source.tensions),
    outOfScope: stringList(source.outOfScope),
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

  const call = { modelId, region, mantleApiKey, deps };

  // Three calls rather than one, run concurrently.
  //
  // A single call had to emit the classification map for every paragraph *and* the
  // whole audit *and* the brand check in one envelope. Three problems with that,
  // all of which get worse as a script gets longer: the sections that come last
  // get the least care, the combined output can run into the token ceiling, and
  // one malformed brace loses everything including the classification you already
  // paid for.
  //
  // Split, each call has a single job and a small output. They are independent —
  // none needs another's result — so they run in parallel and the wall-clock cost
  // is the slowest of the three, not the sum. createAgent() returns a fresh
  // instance per call, so concurrency is safe.
  const [classificationResult, auditResult, brandResult] = await Promise.allSettled([
    runJsonCall({ ...call, prompt: buildClassificationPrompt(units), label: 'classification' }),
    runJsonCall({ ...call, prompt: buildAuditPrompt(units), label: 'audit' }),
    runJsonCall({ ...call, prompt: buildBrandPrompt(units), label: 'brand alignment' }),
  ]);

  // The classification is the analysis. Without it there is nothing to render, so
  // its failure is the only fatal one.
  if (classificationResult.status === 'rejected') throw classificationResult.reason;

  const classified = _readClassifications(classificationResult.value.classifications);
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

  // The judgement calls degrade instead of failing the analysis. Colour-coding a
  // script is useful on its own, and losing it because a brand table came back
  // malformed would be a poor trade. Re-analyse retries all three.
  const audit = auditResult.status === 'fulfilled'
    ? _readAudit(auditResult.value.audit ?? auditResult.value)
    : null;
  const brandAlignment = brandResult.status === 'fulfilled'
    ? _readBrandAlignment(brandResult.value.brandAlignment ?? brandResult.value)
    : null;

  const failed = [];
  if (auditResult.status === 'rejected') {
    failed.push('audit');
    log.warn(`[storyboard] audit call failed: ${auditResult.reason?.message}`);
  }
  if (brandResult.status === 'rejected') {
    failed.push('brand alignment');
    log.warn(`[storyboard] brand call failed: ${brandResult.reason?.message}`);
  }

  log.info(
    `[storyboard] classified ${Object.keys(classifications).length} units with ${modelId}` +
    (failed.length ? ` (${failed.join(' and ')} unavailable)` : ''),
  );

  return {
    classifications,
    audit,
    brandAlignment,
    // Named so the panel can say which part is missing rather than rendering an
    // empty section that looks like a verdict of "nothing to report".
    incomplete: failed,
    modelId,
    analysedAt: Date.now(),
  };
}

/**
 * One model call that must return one JSON object.
 *
 * Shared by all three calls so the error messages, the stream accumulation and
 * the parse tolerance stay identical — three copies of this would drift, and the
 * last time this file hand-rolled its own stream loop it silently accumulated
 * nothing and blamed the parser.
 */
async function runJsonCall({ modelId, region, mantleApiKey, prompt, label, deps = {} }) {
  const createAgent = deps.createAgent || require('./strandsAgentFactory').createAgent;
  const { agent, dispose } = createAgent({
    modelId,
    region,
    mantleApiKey,
    systemPrompt: 'You are a precise analytical assistant. You reply with valid JSON only.',
    tools: [],
    id: `storyboard-${label.replace(/\s+/g, '-')}`,
  });

  let response = '';
  try {
    response = await collectStreamText(agent.stream(prompt));
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
      `${modelId} returned an empty response for the ${label}. This is usually a transport ` +
      'or model availability problem rather than the script — try again, or pick another model.',
    );
  }

  const envelope = parseEnvelope(response);
  if (!envelope) {
    // Include what actually came back; "unusable JSON" with no evidence is
    // undiagnosable from a bug report.
    const preview = response.trim().replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(
      `${modelId} did not return usable JSON for the ${label}. It replied: ` +
      `"${preview}${response.length > 200 ? '…' : ''}". Try again, or pick a different model.`,
    );
  }
  return envelope;
}

module.exports = {
  analyze,
  buildPrompt,
  buildClassificationPrompt,
  buildAuditPrompt,
  buildBrandPrompt,
  runJsonCall,
  _readBrandAlignment,
  _readRules,
  _readSoundbites,
  RULE_KEYS,
  SOUNDBITE_KEYS,
  BRAND_DIMENSION_KEYS,
  parseEnvelope,
  missingIndices,
  _readClassifications,
  _readAudit,
  MAX_WORDS,
  MAX_UNIT_CHARS,
};
