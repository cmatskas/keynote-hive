/**
 * modelCapabilities.js — what a configured model can do, decided from its
 * Bedrock model ID so the answer is the same whether the model came from the
 * shipped defaults or was typed into Settings → Models by hand.
 *
 * Today that is one capability: whether the model makes real Converse tool
 * calls. The Work tab and every Swarm agent are tool loops; a model that
 * answers a tool request with plain text (Gemma 3 writes Python as prose
 * instead of emitting a toolUse block — verified live on Converse) makes the
 * agent's tools silently never run. Such models stay usable in Chat and
 * StoryBrand, which send no tools.
 *
 * This is an explicit list of known tool-less models rather than an allowlist
 * of tool-capable ones, so a newly added model is assumed capable (the common
 * case on Bedrock) instead of vanishing from the Work tab.
 */

// Matched against the model/inference-profile ID, which may carry a region
// or global prefix (us., eu., apac., global.).
const TOOLLESS_MODEL_PATTERNS = [
  /(^|\.)google\.gemma-3-/i,
];

/** Whether a model ID is known to make real Converse tool calls. */
function supportsTools(modelId) {
  return !TOOLLESS_MODEL_PATTERNS.some((p) => p.test(modelId || ''));
}

/**
 * Returns the model list with `supportsTools` set on every entry, always
 * derived from the ID. It is never read from (or written to) settings.json:
 * a stored flag would pin the answer and outlive a change to the list above.
 * Returns new objects; the caller's array is not mutated.
 */
function withCapabilities(models) {
  if (!Array.isArray(models)) return models;
  return models.map((m) => ({
    ...m,
    supportsTools: supportsTools(m.inferenceProfileId || m.inferenceArn),
  }));
}

/**
 * Prepares models for persisting: drops derived fields, so settings.json keeps
 * only user choices, and clears any Swarm role on a tool-less model — Swarm
 * would ignore it (ipc/swarm.js), and a saved role that does nothing is worse
 * than showing None.
 */
function stripCapabilities(models) {
  if (!Array.isArray(models)) return models;
  return models.map(({ supportsTools: _derived, ...rest }) => (
    rest.role && !supportsTools(rest.inferenceProfileId || rest.inferenceArn)
      ? { ...rest, role: '' }
      : rest
  ));
}

module.exports = { supportsTools, withCapabilities, stripCapabilities };
