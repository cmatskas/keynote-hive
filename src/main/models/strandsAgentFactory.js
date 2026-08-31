/**
 * strandsAgentFactory.js — single shared construction point for every Strands
 * `Agent` instance in Hive (Work tab, Chat tab, and Swarm). Attaches:
 *
 *  1. A ModelRetryStrategy with exponential backoff for transient model-call
 *     errors — throttling (Strands' own default) plus each provider SDK's
 *     other transient error shapes (see HiveModelRetryStrategy below) —
 *     self-healing with zero custom retry loops.
 *  2. An introspection hook on AfterModelCallEvent + AfterToolCallEvent that
 *     logs every attempt/failure/retry decision through a caller-supplied
 *     `onLog` callback. This is the "internal log" that lets a user see why
 *     an agent recovered (or didn't) without any bespoke logging plumbing —
 *     it's just Strands' own hook events routed to Hive's existing status/
 *     event channels (onStatus for Work, onEvent for Swarm).
 *  3. Model-family routing: every model call now goes through Amazon
 *     Bedrock's OpenAI/Anthropic-compatible "Mantle" endpoint — Bedrock
 *     Converse (BedrockModel) has been removed entirely. Which SDK class to
 *     construct is decided purely by model identity: model IDs containing
 *     "anthropic." go through AnthropicModel (Mantle's native Anthropic
 *     Messages API surface); every other model ID goes through OpenAIModel
 *     (Mantle's OpenAI-compatible Responses API surface — this also covers
 *     genuinely Mantle-only, non-Anthropic models like xAI's Grok or
 *     Google's Gemma, which speak the OpenAI-compatible wire protocol on
 *     Mantle despite not being OpenAI models themselves). Both branches
 *     authenticate with the same one-off, long-term `mantleApiKey` from
 *     Settings — no per-request bearer-token minting/refresh roundtrips.
 *
 * Both Work (agentToolExecutor.js), Chat (ipc/bedrock.js), and Swarm
 * (swarmOrchestrator.js) call createAgent() instead of `new Agent(...)`
 * directly, so retry/logging/routing behavior lives in exactly one place
 * and never drifts out of sync between call sites.
 */
const {
  Agent,
  DefaultModelRetryStrategy,
  ExponentialBackoff,
  AfterModelCallEvent,
  AfterToolCallEvent,
} = require('@strands-agents/sdk');
const { OpenAIModel } = require('@strands-agents/sdk/models/openai');
const { AnthropicModel } = require('@strands-agents/sdk/models/anthropic');
const {
  InternalServerError: OpenAIInternalServerError,
  APIConnectionError: OpenAIAPIConnectionError,
  APIConnectionTimeoutError: OpenAIAPIConnectionTimeoutError,
} = require('openai');
const {
  InternalServerError: AnthropicInternalServerError,
  APIConnectionError: AnthropicAPIConnectionError,
  APIConnectionTimeoutError: AnthropicAPIConnectionTimeoutError,
} = require('@anthropic-ai/sdk');
const log = require('electron-log/main');

// Which Mantle wire-protocol family a model ID belongs to. This is a
// naming-convention check, not a routing flag — unlike the old Converse-vs-
// Mantle decision (which had no consistent per-provider scheme and needed an
// explicit per-model Settings checkbox), every Anthropic model ID on Bedrock
// consistently contains the literal substring "anthropic." (with a region/
// inference-profile prefix, e.g. "us.anthropic.claude-sonnet-4-6",
// "global.anthropic.claude-opus-4-6-v1") — so it's safe to infer directly
// from the model ID with no configuration needed. Every other model ID
// (GPT-5.x, gpt-oss, xAI Grok, Google Gemma, etc.) speaks Mantle's
// OpenAI-compatible Responses API surface instead of the Anthropic Messages
// API surface, regardless of which company actually makes the model.
function isAnthropicModel(modelId) {
  return /anthropic\./i.test(modelId || '');
}

// Matches AWS region identifiers such as us-east-1, ap-southeast-1. Anchored
// so a malformed region (e.g. one containing '@', ':', '/', '#') cannot
// re-point the Mantle endpoint URL to a non-AWS host — mirrors the same
// guard the Strands SDK applies internally in its own (non-exported)
// bedrockMantleConfig path, since a malformed region here would exfiltrate
// mantleApiKey to whatever host it gets re-pointed to.
const VALID_REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]+$/;

function validateRegion(region) {
  if (!VALID_REGION.test(region || '')) {
    throw new Error(`Invalid AWS region for Mantle endpoint: '${region}'`);
  }
}

// Models known to support "extended thinking" / reasoning tokens, and which
// request-shape family they need. This is an explicit allowlist rather than
// inferred from the model ID prefix alone or a "try it and see" approach —
// Mantle validates provider-specific request fields and can reject unknown
// ones outright rather than silently ignoring them, so Hive decides support
// here rather than hoping the API no-ops gracefully.
//
//  - 'anthropic': Claude 3.7+/4.x — params: { thinking: {...} } (Anthropic
//    Messages API's native field, sent via AnthropicModel's `params`
//    passthrough since AnthropicModelConfig has no dedicated `thinking`
//    field).
//  - 'openai': GPT-5-class reasoning models via Mantle's Responses API —
//    params: { reasoning: { effort: ... } }. Chat Completions models (and
//    non-reasoning GPT models) are NOT in this list.
//
// Matched by substring against the model's inferenceProfileId/modelId since
// Bedrock model IDs carry region/version prefixes.
const EXTENDED_THINKING_PATTERNS = [
  { family: 'anthropic', pattern: /anthropic\.claude-(3-7|opus-4|sonnet-4)/i },
  { family: 'openai', pattern: /^openai\.gpt-5(\.|-)/i },
];

/**
 * Returns which extended-thinking request-shape family a model supports, or
 * null if the model isn't known to support it. Callers use this to decide
 * whether to attach thinking/reasoning fields to the model config — and to
 * silently skip doing so for unsupported models rather than sending a field
 * the provider might reject.
 *
 * @param {string} modelId
 * @returns {'anthropic'|'openai'|null}
 */
function supportsExtendedThinking(modelId) {
  if (!modelId) return null;
  const match = EXTENDED_THINKING_PATTERNS.find(({ pattern }) => pattern.test(modelId));
  return match ? match.family : null;
}

// Default reasoning token budget for Anthropic's `thinking` field. Well under
// DEFAULT_MAX_OUTPUT_TOKENS so a thinking-heavy turn still has headroom left
// for the actual answer.
const DEFAULT_THINKING_BUDGET_TOKENS = 4096;

// FLAG FOR POST-MIGRATION RE-VERIFICATION: this value was derived from a
// live Bedrock Converse ValidationException against Claude Opus 4.8/5 and
// Sonnet 5 specifically (Converse's per-model output ceiling, confirmed to
// be 128,000 tokens exactly for that lineup). Now that BedrockModel/Converse
// has been removed and every model goes through Mantle instead, this number
// needs to be re-verified empirically against Mantle's actual behavior —
// Mantle is a genuinely different serving path (confirmed via AWS's own
// Mantle quotas docs: separate input/output TPM quotas from Converse, and
// most models on Mantle have no published per-account quota at all, so
// their real output ceiling isn't documented anywhere Hive could find). Do
// NOT assume this number is still correct post-migration — test against
// real Mantle responses per model family before trusting it in production.
const DEFAULT_MAX_OUTPUT_TOKENS = 120000;

// Transient tool-level errors worth retrying automatically (network blips,
// AgentCore Gateway cold starts/throttling, sandbox session hiccups).
// Matched case-insensitively against err.name and err.message.
const RETRYABLE_TOOL_ERROR_PATTERNS = [
  'timeout', 'timed out', 'econnreset', 'econnrefused', 'enotfound',
  'throttl', 'toomanyrequests', '429', '503', 'serviceunavailable',
  'resourcenotfoundexception', // sandbox session expired — caller restarts session inside the tool
];

function isRetryableToolError(err) {
  if (!err) return false;
  const haystack = `${err.name || ''} ${err.message || ''}`.toLowerCase();
  return RETRYABLE_TOOL_ERROR_PATTERNS.some(p => haystack.includes(p));
}

// OpenAI SDK error classes (thrown by OpenAIModel) don't set `.name` to
// their class name — verified empirically, `.name` is just the inherited
// 'Error' — so these must be matched via `instanceof` against the actual
// exported classes, not a string comparison. Throttling (RateLimitError) is
// already normalized to ModelThrottledError by classifyOpenAIError()/
// _rewrapError() upstream, so it's covered by the base retry strategy and
// not repeated here.
const RETRYABLE_OPENAI_ERROR_CLASSES = [
  OpenAIInternalServerError,
  OpenAIAPIConnectionError,
  OpenAIAPIConnectionTimeoutError,
];

// Same reasoning as the OpenAI classes above, for @anthropic-ai/sdk's error
// classes (thrown by AnthropicModel). Confirmed via the installed Strands
// SDK's anthropic.js source: RateLimitError (HTTP 429) is already normalized
// to ModelThrottledError by the SDK itself before it ever reaches Hive's
// retry strategy, so it's deliberately excluded here for the same reason
// OpenAI's RateLimitError is excluded above.
const RETRYABLE_ANTHROPIC_ERROR_CLASSES = [
  AnthropicInternalServerError,
  AnthropicAPIConnectionError,
  AnthropicAPIConnectionTimeoutError,
];

class HiveModelRetryStrategy extends DefaultModelRetryStrategy {
  isRetryable(error) {
    return (
      super.isRetryable(error) ||
      RETRYABLE_OPENAI_ERROR_CLASSES.some((cls) => error instanceof cls) ||
      RETRYABLE_ANTHROPIC_ERROR_CLASSES.some((cls) => error instanceof cls)
    );
  }
}

/**
 * Build the introspection hook. Returns a HookProvider-shaped object with
 * register(agent) that wires both hook callbacks and enforces a max retry
 * count per tool call (model retries are already bounded by retryStrategy).
 *
 * @param {(entry: {source:'model'|'tool', name?:string, attempt:number, error:string, retried:boolean}) => void} onLog
 * @param {number} maxToolRetries
 */
function attachIntrospectionHooks(agent, onLog, maxToolRetries = 3) {
  const log_ = onLog || (() => {});
  const toolAttempts = new Map(); // toolUseId -> attempt count, reset per tool-call lifecycle

  const cleanupModel = agent.addHook(AfterModelCallEvent, (event) => {
    if (!event.error) return;
    // ModelRetryStrategy already decides retries for throttling; we only log here.
    log_({
      source: 'model',
      attempt: event.attemptCount,
      error: event.error.message,
      retried: !!event.retry,
    });
  });

  const cleanupTool = agent.addHook(AfterToolCallEvent, (event) => {
    if (!event.error) {
      toolAttempts.delete(event.toolUse.toolUseId);
      return;
    }

    const attempt = (toolAttempts.get(event.toolUse.toolUseId) || 0) + 1;
    toolAttempts.set(event.toolUse.toolUseId, attempt);

    const retryable = isRetryableToolError(event.error) && attempt < maxToolRetries;
    if (retryable) event.retry = true;
    else toolAttempts.delete(event.toolUse.toolUseId);

    log_({
      source: 'tool',
      name: event.toolUse.name,
      attempt,
      error: event.error.message,
      retried: retryable,
    });

    if (retryable) {
      log.info(`[agent-factory] Retrying tool "${event.toolUse.name}" after transient error (attempt ${attempt}/${maxToolRetries}): ${event.error.message}`);
    } else if (event.error) {
      log.warn(`[agent-factory] Tool "${event.toolUse.name}" failed, not retrying: ${event.error.message}`);
    }
  });

  return () => { cleanupModel(); cleanupTool(); };
}

/**
 * Construct a fully-configured Strands Agent shared by Work, Chat, and Swarm.
 *
 * @param {object} opts
 * @param {string} opts.modelId - Bedrock model ID (e.g. "us.anthropic.claude-sonnet-4-6", "openai.gpt-5.6-sol")
 * @param {string} opts.region - AWS region hosting the Mantle endpoint (e.g. "us-east-1")
 * @param {string} opts.mantleApiKey - one-off, long-term Bedrock API key used to authenticate against Mantle
 * @param {string} opts.systemPrompt
 * @param {Array} opts.tools - Strands tool() instances (pass [] for non-agentic use, e.g. the Chat tab)
 * @param {string} [opts.id] - Agent id (useful for Swarm's multi-agent pipeline)
 * @param {(entry: object) => void} [opts.onLog] - introspective log sink (see attachIntrospectionHooks)
 * @param {number} [opts.maxModelAttempts] - total model-call attempts including the first (default 4)
 * @param {number} [opts.maxToolRetries] - max automatic retries for a single failing tool call (default 3)
 * @param {number} [opts.maxTokens] - max output tokens per model call (default DEFAULT_MAX_OUTPUT_TOKENS —
 *   see the flag comment above that constant; re-verify against real Mantle behavior)
 * @param {boolean} [opts.enableThinking] - request extended thinking/reasoning tokens for
 *   this turn. Silently ignored (no-op) if `modelId` isn't in the supportsExtendedThinking()
 *   allowlist — callers don't need to check support themselves.
 * @returns {{agent: Agent, dispose: () => void}}
 */
function createAgent({ modelId, region, mantleApiKey, systemPrompt, tools, id, onLog, maxModelAttempts = 4, maxToolRetries = 3, maxTokens = DEFAULT_MAX_OUTPUT_TOKENS, enableThinking = false }) {
  validateRegion(region);
  const thinkingFamily = enableThinking ? supportsExtendedThinking(modelId) : null;

  // Both branches point at the same Mantle host and use the same API key —
  // no bearer-token minting/refresh, unlike the old OpenAIModel-only
  // bedrockMantleConfig helper. The base *path* differs by model family
  // and, within OpenAI-compatible models, by individual model LINE (not
  // vendor prefix — a vendor can straddle both paths, e.g. google.gemma-4-*
  // is on /openai/v1 while google.gemma-3-* is on /v1).
  //
  // This table is maintained independently of @strands-agents/sdk's own
  // internal bedrockMantleBaseUrl() helper (mantle.js), which is
  // `@internal` and not exported — so it can't be imported directly, only
  // read for reference. As of SDK 1.12.0 (which shipped a real upstream
  // fix, github.com/strands-agents/harness-sdk#3691, after xai.grok-4.3
  // was found mis-routed to /v1 despite Mantle serving it from
  // /openai/v1), the SDK's own table is: ['openai.gpt-5.', 'xai.grok-4.',
  // 'google.gemma-4-']. Our regex below mirrors that exactly, confirmed by
  // reading the installed SDK's mantle.js directly — re-check that file
  // after any future SDK upgrade in case the table changes again.
  //
  // Everything not matched by the regex (including google.gemma-3-* and
  // every other OpenAI-compatible model) falls to /v1 — this is the
  // correct default, not a fallback for "unverified" models.
  //
  // Anthropic is a separate protocol entirely (AnthropicModel, not
  // OpenAIModel) and is handled by the ternary below, not this table.
  // @anthropic-ai/sdk's Messages.create() always POSTs to the literal path
  // `/v1/messages` relative to `baseURL`, and Mantle serves Anthropic
  // models from an /anthropic prefix on top of that
  // (`https://bedrock-mantle.{region}.api.aws/anthropic` ->
  // `/anthropic/v1/messages`) — confirmed via direct curl testing against
  // the live endpoint after Mantle changed this routing once already
  // (bare host without the /anthropic prefix worked initially, then
  // started 404ing). If either the OpenAI-compatible table or the
  // Anthropic prefix breaks again, re-verify with a direct curl call
  // against the real endpoint before trusting this comment, the SDK's
  // internal helper, or any prior fix — Mantle's routing has changed
  // twice already without notice.
  const basePath = /^(openai\.gpt-5(\.|-)|xai\.grok-4\.|google\.gemma-4-)/i.test(modelId || '') ? '/openai/v1' : '/v1';
  const mantleHost = `https://bedrock-mantle.${region}.api.aws`;
  const baseURL = isAnthropicModel(modelId) ? `${mantleHost}/anthropic` : `${mantleHost}${basePath}`;

  const model = isAnthropicModel(modelId)
    ? new AnthropicModel({
        modelId,
        maxTokens,
        apiKey: mantleApiKey,
        clientConfig: { baseURL },
        // Anthropic's extended thinking. AnthropicModelConfig has no
        // dedicated `thinking` field, so it's passed via the `params`
        // forward-compat passthrough (same pattern OpenAIModel uses below
        // for `reasoning`). Only attached when thinkingFamily === 'anthropic'.
        ...(thinkingFamily === 'anthropic'
          ? { params: { thinking: { type: 'enabled', budget_tokens: DEFAULT_THINKING_BUDGET_TOKENS } } }
          : {}),
      })
    : new OpenAIModel({
        modelId,
        maxTokens,
        apiKey: mantleApiKey,
        clientConfig: { baseURL },
        // GPT-5-class reasoning models take an effort level rather than a
        // token budget. Passed via `params` (the SDK's forward-compat
        // passthrough) since OpenAIResponsesConfig has no dedicated
        // `reasoning` field. Only attached when thinkingFamily === 'openai' —
        // never sent to non-reasoning OpenAI-compatible models.
        ...(thinkingFamily === 'openai' ? { params: { reasoning: { effort: 'medium' } } } : {}),
      });

  const retryStrategy = new HiveModelRetryStrategy({
    maxAttempts: maxModelAttempts,
    backoff: new ExponentialBackoff({ baseMs: 2000, maxMs: 30000 }),
  });

  const agent = new Agent({ model, systemPrompt, tools, id, retryStrategy });
  const dispose = attachIntrospectionHooks(agent, onLog, maxToolRetries);

  return { agent, dispose };
}


module.exports = { createAgent, isRetryableToolError, supportsExtendedThinking, isAnthropicModel };
