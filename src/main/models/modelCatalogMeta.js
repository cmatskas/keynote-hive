/**
 * modelCatalogMeta.js — what Hive knows about a model that the Bedrock API
 * doesn't tell it.
 *
 * ListFoundationModels returns an ID, a provider, and a name. The picker in
 * Settings → Models wants more than that to be useful: a one-line description
 * of what the model is for, and a rough cost signal so the user can see that
 * one option is ~8× the price of another before choosing it. Neither exists in
 * any Bedrock API, so they are curated here, keyed by the bare model ID (region
 * or global prefix stripped, so `us.` and `global.` inference profiles share
 * an entry).
 *
 * COST INDEX
 * Relative to Claude Sonnet 5 = 1.0, computed as (input + output price per 1M
 * tokens) / Sonnet 5's total. Sources differ by provider, and are stated
 * plainly because they are not equally reliable:
 *   - xAI, Google, Moonshot, Amazon: the AWS Price List API
 *     (`aws pricing get-products --service-code AmazonBedrock`, standard
 *     on-demand input/output token rows, us-east-1). Verified figures.
 *   - Anthropic and OpenAI: the Price List API exposes no usable rows for
 *     these models, so the multipliers (Sonnet 5 1×, Opus 5.5 2×, GPT-6 Sol 1×,
 *     Astra 8.3×, Luna 0.1×) were taken from a reference model picker at
 *     adoption time, and Haiku 4.5's 0.33× is an estimate. UNVERIFIED against
 *     Bedrock pricing — check them against the Bedrock pricing page before
 *     relying on them, and correct here.
 * Prices drift and this table does not. The pills are labelled "~" for that
 * reason; refresh them when a default model changes.
 *
 * Models not listed here still appear in the picker under "Show all models",
 * with the catalog's own name and no description or cost pill.
 */

const { supportsTools } = require('./modelCapabilities');

/** Bedrock provider segment → display label and picker order. */
const PROVIDERS = [
  { key: 'anthropic', label: 'Claude' },
  { key: 'openai', label: 'OpenAI' },
  { key: 'amazon', label: 'Amazon' },
  { key: 'xai', label: 'xAI' },
  { key: 'moonshotai', label: 'Moonshot' },
  { key: 'google', label: 'Google' },
  { key: 'qwen', label: 'Qwen' },
  { key: 'meta', label: 'Meta' },
  { key: 'mistral', label: 'Mistral' },
  { key: 'deepseek', label: 'DeepSeek' },
  { key: 'cohere', label: 'Cohere' },
  { key: 'ai21', label: 'AI21 Labs' },
  { key: 'minimax', label: 'MiniMax' },
  { key: 'nvidia', label: 'NVIDIA' },
  { key: 'twelvelabs', label: 'TwelveLabs' },
  { key: 'writer', label: 'Writer' },
  { key: 'zai', label: 'Z.ai' },
  { key: 'poolside', label: 'Poolside' },
];

/**
 * One vendor, several ID prefixes. The live catalog lists Kimi K2 Thinking as
 * `moonshot.` and K2.5/K3 as `moonshotai.`; without folding them together the
 * picker showed two "Moonshot" groups.
 */
const PROVIDER_ALIASES = {
  moonshot: 'moonshotai',
};

/** Curated entries, in the order they should appear within their provider. */
const KNOWN_MODELS = {
  // ── Claude ──────────────────────────────────────────────────────────────
  'anthropic.claude-sonnet-5': {
    name: 'Claude Sonnet 5',
    description: 'Everyday drafting, editing, and research — the balanced default',
    cost: 1,
  },
  'anthropic.claude-opus-5-5': {
    name: 'Claude Opus 5.5',
    description: 'Deepest reasoning for long-form writing and hard structure problems',
    cost: 2,
  },
  'anthropic.claude-opus-5': {
    name: 'Claude Opus 5',
    description: 'Previous Opus generation; superseded by 5.5 at the same price',
    cost: 2,
  },
  'anthropic.claude-fable-5-1': {
    name: 'Claude Fable 5.1',
    description: 'Narrative and creative voice — stories, scripts, speeches',
    cost: null,
  },
  'anthropic.claude-fable-5': {
    name: 'Claude Fable 5',
    description: 'Previous Fable generation',
    cost: null,
  },
  'anthropic.claude-haiku-4-5-20251001-v1:0': {
    name: 'Claude Haiku 4.5',
    description: 'Fast and inexpensive for short, simple turns',
    cost: 0.33,
  },

  // ── OpenAI ──────────────────────────────────────────────────────────────
  'openai.gpt-6-sol': {
    name: 'GPT-6 Sol',
    description: 'Capability and cost in balance; strong at structured output',
    cost: 1,
  },
  'openai.gpt-6-astra': {
    name: 'GPT-6 Astra',
    description: 'Top-end reasoning for the hardest, most open-ended work',
    cost: 8.3,
  },
  'openai.gpt-6-luna': {
    name: 'GPT-6 Luna',
    description: 'Small and quick for focused, well-defined tasks',
    cost: 0.1,
  },

  // ── Amazon ──────────────────────────────────────────────────────────────
  'amazon.nova-2-lite-v1:0': {
    name: 'Nova 2 Lite',
    description: 'Low-cost general text model with a large context window',
    cost: 0.09, // $0.30 in + $1.25 out per 1M
  },

  // ── xAI ─────────────────────────────────────────────────────────────────
  'xai.grok-4.6': {
    name: 'Grok 4.6',
    description: 'Reasoning model with a large thinking budget; slower to first token',
    cost: 0.49, // $2.20 in + $6.60 out per 1M
  },

  // ── Moonshot ────────────────────────────────────────────────────────────
  'moonshotai.kimi-k3': {
    name: 'Kimi K3',
    description: 'Strong reasoning and long-context comprehension; thinks before answering',
    cost: 1.1, // $3.30 in + $16.50 out per 1M
  },

  // ── Google ──────────────────────────────────────────────────────────────
  'google.gemma-3-27b-it': {
    name: 'Gemma 3 27B',
    description: 'Open-weights model, very cheap; Chat and StoryBrand only (no tool calls)',
    cost: 0.03, // $0.12 in + $0.38 out per 1M
  },
  'google.gemma-3-12b-it': {
    name: 'Gemma 3 12B',
    description: 'Smaller Gemma; Chat and StoryBrand only (no tool calls)',
    cost: null,
  },
};

const KNOWN_ORDER = Object.keys(KNOWN_MODELS);

/**
 * Strip a region/global inference-profile prefix so `us.x`, `global.x`, and
 * `x` all resolve to the same entry. Provider segments are never prefixes.
 */
function baseModelId(id) {
  return (id || '').replace(/^(global|us|eu|apac|us-gov|ca|sa|ap|jp|au)\./, '');
}

function providerKey(id) {
  const raw = baseModelId(id).split('.')[0] || 'other';
  return PROVIDER_ALIASES[raw] || raw;
}

function providerLabel(key) {
  const found = PROVIDERS.find((p) => p.key === key);
  return found ? found.label : key.charAt(0).toUpperCase() + key.slice(1);
}

/** Position of a provider in the picker; unknown providers sort after known ones, alphabetically. */
function providerRank(key) {
  const i = PROVIDERS.findIndex((p) => p.key === key);
  return i === -1 ? PROVIDERS.length : i;
}

/** "~1×", "~8.3×", "~0.1×", "~0.03×" — or null when the cost is unknown. */
function formatCost(cost) {
  if (cost == null || !Number.isFinite(cost)) return null;
  let s;
  if (cost >= 10) s = String(Math.round(cost));
  else if (cost >= 1) s = cost.toFixed(1).replace(/\.0$/, '');
  else if (cost >= 0.1) s = cost.toFixed(1);
  else s = cost.toFixed(2);
  return `~${s}×`;
}

/**
 * Everything the picker needs to render one model, given an ID and (optionally)
 * the catalog's own name for it. Curated data wins over the catalog name; an
 * unknown model gets the catalog name (or its bare ID) and no description/cost.
 */
function describeModel(id, { modelName = null } = {}) {
  const base = baseModelId(id);
  const known = KNOWN_MODELS[base] || null;
  const pKey = providerKey(base);
  return {
    baseModelId: base,
    provider: pKey,
    providerLabel: providerLabel(pKey),
    name: known?.name || modelName || base,
    description: known?.description || null,
    cost: known?.cost ?? null,
    costLabel: formatCost(known?.cost),
    supportsTools: supportsTools(base),
    known: !!known,
    // Sort key within a provider group: curated order first, then by name.
    order: known ? KNOWN_ORDER.indexOf(base) : Number.MAX_SAFE_INTEGER,
  };
}

module.exports = {
  KNOWN_MODELS,
  PROVIDERS,
  baseModelId,
  providerKey,
  providerLabel,
  providerRank,
  formatCost,
  describeModel,
};
