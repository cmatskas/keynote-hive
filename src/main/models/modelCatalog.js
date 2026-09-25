/**
 * modelCatalog.js — build the picker's model list.
 *
 * Joins three sources into one grouped list:
 *   1. the live Bedrock catalog (ListFoundationModels + ListInferenceProfiles),
 *   2. Hive's curated metadata (modelCatalogMeta.js: descriptions, cost),
 *   3. the user's configured models (settings.bedrockModels), so every row can
 *      say whether it is already added and which Swarm role it holds.
 *
 * Pure functions over already-fetched data — the IPC layer does the AWS calls
 * and hands the results in, which is what makes this testable without mocking
 * an SDK.
 *
 * WHY INFERENCE PROFILES MATTER
 * Hive invokes models by inference-profile ID where one exists (`global.` or
 * `us.` prefixed) and by bare model ID otherwise; that is what the shipped
 * defaults do and what the Work/Swarm routing expects. So each catalog row
 * carries the ID Hive should *add* (`inferenceProfileId`), chosen from the
 * profiles that actually exist in the user's account for that model, falling
 * back to the bare ID for on-demand-only models like Gemma.
 */

const {
  KNOWN_MODELS, describeModel, baseModelId, providerKey, providerLabel, providerRank,
} = require('./modelCatalogMeta');

/** Prefix order when a model has several inference profiles. */
const PROFILE_PREFERENCE = ['global', 'us', 'eu', 'apac'];

/**
 * Same model, ignoring a trailing version segment (`x-v1` vs `x-v1:0`) and any
 * region/global prefix. Used to match configured IDs to catalog rows and to
 * collapse duplicate catalog entries.
 */
function normalizeId(id) {
  return baseModelId(id).replace(/:\d+$/, '');
}

/**
 * Keep only models the picker should offer: text-in/text-out, invocable
 * on-demand or via a profile, and not a context-window variant of another
 * entry. The ID check catches embeddings/image/video/speech models that still
 * advertise TEXT among their modalities.
 */
function isTextGenerationModel(fm) {
  if (!fm?.modelId) return false;
  const out = fm.outputModalities || [];
  const inp = fm.inputModalities || [];
  if (!out.includes('TEXT') || !inp.includes('TEXT')) return false;
  if (/embed|canvas|reel|sonic|rerank|guard|safeguard/i.test(fm.modelId)) return false;
  if (/:\d+k$/i.test(fm.modelId)) return false;
  const types = fm.inferenceTypesSupported || [];
  return types.length === 0 || types.includes('ON_DEMAND') || types.includes('INFERENCE_PROFILE');
}

/** base model ID → inference-profile IDs that target it, best first. */
function indexProfiles(inferenceProfiles) {
  const byBase = new Map();
  for (const p of inferenceProfiles || []) {
    const id = p?.inferenceProfileId;
    if (!id) continue;
    const base = baseModelId(id);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(id);
  }
  const rank = (id) => {
    const i = PROFILE_PREFERENCE.indexOf(id.split('.')[0]);
    return i === -1 ? PROFILE_PREFERENCE.length : i;
  };
  for (const list of byBase.values()) list.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return byBase;
}

/** configured normalized ID → configured entry. */
function indexConfigured(configuredModels) {
  const byNorm = new Map();
  for (const m of configuredModels || []) {
    const id = m?.inferenceProfileId || m?.inferenceArn;
    if (id) byNorm.set(normalizeId(id), m);
  }
  return byNorm;
}

function makeRow({ modelId, modelName, profiles, configured }) {
  const meta = describeModel(modelId, { modelName });
  return {
    modelId,
    inferenceProfileId: profiles[0] || modelId,
    profiles,
    name: meta.name,
    description: meta.description,
    cost: meta.cost,
    costLabel: meta.costLabel,
    provider: meta.provider,
    providerLabel: meta.providerLabel,
    supportsTools: meta.supportsTools,
    known: meta.known,
    configured: !!configured,
    configuredId: configured ? (configured.inferenceProfileId || configured.inferenceArn) : null,
    configuredRole: configured?.role || '',
    _order: meta.order,
  };
}

/** Group rows by provider in picker order, sorted within each group. */
function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.provider)) {
      groups.set(row.provider, { provider: row.provider, label: providerLabel(row.provider), models: [] });
    }
    groups.get(row.provider).models.push(row);
  }
  const out = [...groups.values()];
  out.sort((a, b) => providerRank(a.provider) - providerRank(b.provider) || a.label.localeCompare(b.label));
  for (const g of out) {
    g.models.sort((a, b) => a._order - b._order || a.name.localeCompare(b.name));
    for (const m of g.models) delete m._order;
  }
  return out;
}

/**
 * The live catalog, merged. Duplicate catalog entries for one model (`x-v1`
 * and `x-v1:0`) collapse to a single row, preferring the form an inference
 * profile targets, since that is the form Hive will invoke.
 */
function buildCatalog({ foundationModels, inferenceProfiles, configuredModels }) {
  const profilesByBase = indexProfiles(inferenceProfiles);
  const configuredByNorm = indexConfigured(configuredModels);

  const byNorm = new Map();
  for (const fm of foundationModels || []) {
    if (!isTextGenerationModel(fm)) continue;
    const norm = normalizeId(fm.modelId);
    const hasProfile = profilesByBase.has(fm.modelId);
    const existing = byNorm.get(norm);
    if (!existing || (hasProfile && !profilesByBase.has(existing.modelId))) {
      byNorm.set(norm, fm);
    }
  }

  const rows = [];
  for (const [norm, fm] of byNorm) {
    rows.push(makeRow({
      modelId: fm.modelId,
      modelName: fm.modelName || null,
      profiles: profilesByBase.get(fm.modelId) || [],
      configured: configuredByNorm.get(norm) || null,
    }));
  }

  // A configured model that the catalog no longer lists (retired, or a
  // cross-account profile the list call can't see) still needs a row, or the
  // user could never remove it from here.
  for (const [norm, m] of configuredByNorm) {
    if (byNorm.has(norm)) continue;
    const id = m.inferenceProfileId || m.inferenceArn;
    rows.push(makeRow({ modelId: baseModelId(id), modelName: m.id || null, profiles: [id], configured: m }));
  }

  return { source: 'live', groups: groupRows(rows) };
}

/**
 * Offline / no-permission fallback: the curated list only, so the picker still
 * works for the models Hive knows. Invoke IDs are the convention the defaults
 * follow — `global.` profile for everything except Google's Gemma, which has
 * no profile and is invoked by bare ID.
 */
function buildFallbackCatalog({ configuredModels, reason = null } = {}) {
  const configuredByNorm = indexConfigured(configuredModels);
  const rows = [];
  const seen = new Set();

  for (const base of Object.keys(KNOWN_MODELS)) {
    const norm = normalizeId(base);
    seen.add(norm);
    const configured = configuredByNorm.get(norm) || null;
    const invokeId = configured
      ? (configured.inferenceProfileId || configured.inferenceArn)
      : (providerKey(base) === 'google' ? base : `global.${base}`);
    rows.push(makeRow({ modelId: base, modelName: null, profiles: [invokeId], configured }));
  }
  for (const [norm, m] of configuredByNorm) {
    if (seen.has(norm)) continue;
    const id = m.inferenceProfileId || m.inferenceArn;
    rows.push(makeRow({ modelId: baseModelId(id), modelName: m.id || null, profiles: [id], configured: m }));
  }

  return { source: 'fallback', reason, groups: groupRows(rows) };
}

module.exports = {
  buildCatalog,
  buildFallbackCatalog,
  isTextGenerationModel,
  normalizeId,
  PROFILE_PREFERENCE,
};
