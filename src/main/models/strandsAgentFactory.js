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
 *  3. Model routing: every model call goes through standard Amazon Bedrock
 *     (bedrock-runtime) via the Strands SDK's BedrockModel and the Converse
 *     Stream API. The Mantle endpoint (and its AnthropicModel/OpenAIModel
 *     protocol split and base-path table) has been removed: the newest
 *     model generations (Claude Opus 5.x/Sonnet 5/Fable 5, GPT-6 Sol/Luna,
 *     Kimi K3, Nova 2) ship on standard Bedrock only, and Mantle-only
 *     models are expected to land on Bedrock over time. Authentication is
 *     still the same one-off, long-term Bedrock API key from Settings
 *     (stored as `mantleApiKey` for continuity) — BedrockModel's `apiKey`
 *     option sends it as a bearer token instead of SigV4, so model calls
 *     stay decoupled from the user's expiring AWS credentials.
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
const { BedrockModel } = require('@strands-agents/sdk/models/bedrock');
const log = require('electron-log/main');

// Whether a model ID is an Anthropic (Claude) model. No longer a routing
// decision — BedrockModel speaks Converse to every model family — but still
// a naming-convention check other parts of Hive rely on (thinking-field
// family, document/image block handling in utils.js): every Anthropic model
// ID on Bedrock contains the literal substring "anthropic." (with a region/
// inference-profile prefix, e.g. "us.anthropic.claude-sonnet-4-6",
// "global.anthropic.claude-opus-5").
function isAnthropicModel(modelId) {
  return /anthropic\./i.test(modelId || '');
}

// Matches AWS region identifiers such as us-east-1, ap-southeast-1. Anchored
// so a malformed region cannot re-point the client at an unexpected
// endpoint. BedrockModel builds its own bedrock-runtime endpoint from the
// region internally, but validating here keeps the error immediate and
// legible ("Invalid AWS region") rather than a downstream DNS failure.
const VALID_REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]+$/;

function validateRegion(region) {
  if (!VALID_REGION.test(region || '')) {
    throw new Error(`Invalid AWS region for Bedrock: '${region}'`);
  }
}

// Models known to support "extended thinking" / reasoning tokens, and which
// request-shape family they need. This is an explicit allowlist rather than
// inferred from the model ID prefix alone or a "try it and see" approach —
// Bedrock validates additionalModelRequestFields per model and can reject
// unknown ones outright rather than silently ignoring them, so Hive decides
// support here rather than hoping the API no-ops gracefully.
//
//  - 'anthropic': Claude 3.7+/4.x — { thinking: { type: 'enabled',
//    budget_tokens } } via BedrockModel's additionalRequestFields (Converse
//    passes it through as additionalModelRequestFields).
//  - 'openai': GPT-5-class reasoning models — { reasoning_effort } via the
//    same passthrough (OpenAI models on Bedrock Converse take the Chat
//    Completions-style field, not the Responses API's nested shape).
//
// Matched by substring against the model's inferenceProfileId/modelId since
// Bedrock model IDs carry region/version prefixes.
const EXTENDED_THINKING_PATTERNS = [
  { family: 'anthropic', pattern: /anthropic\.claude-(3-7|opus-4|sonnet-4)/i },
  { family: 'openai', pattern: /^(us\.|eu\.|apac\.|global\.)?openai\.gpt-5(\.|-)/i },
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

// Derived from a live Bedrock Converse ValidationException against Claude
// Opus 4.8/5 and Sonnet 5 (Converse's per-model output ceiling, confirmed
// to be 128,000 tokens exactly for that lineup); 120,000 leaves margin.
// This value was originally measured on Converse, was flagged for
// re-verification during the Mantle era (a different serving path with its
// own quotas), and is back on its home turf now that model calls have
// returned to Converse — the original derivation applies again. Models
// with a lower per-model ceiling reject the request with a legible
// ValidationException naming the limit, so a wrong value here fails loud,
// not silent.
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

// Transient Bedrock model-call errors worth retrying, matched by error name
// (AWS SDK exceptions keep their `.name` — e.g. 'ServiceUnavailableException'
// — and the Strands SDK re-throws them as-is after normalizeError(), so a
// name check works here; this is unlike the removed openai/@anthropic-ai SDK
// classes, which reported `.name` as plain 'Error' and needed `instanceof`).
// Throttling is deliberately absent: the Strands SDK normalizes Bedrock's
// throttlingException to ModelThrottledError before it reaches this
// strategy, so the base DefaultModelRetryStrategy already covers it.
// ValidationException/AccessDeniedException are deliberately NOT retryable —
// they never heal on retry and hiding them delays the real error report.
const RETRYABLE_BEDROCK_ERROR_NAMES = new Set([
  'ServiceUnavailableException',
  'InternalServerException',
  'ModelNotReadyException', // on-demand model still warming — AWS docs say retry
  'TimeoutError',
  'AbortError', // smithy request-timeout abort, distinct from user cancellation (checked below)
]);

// Network-level failures surface as plain Errors from the fetch handler with
// indicative messages rather than typed classes. 'unable to process your
// request' is Bedrock's generic 503 body (the CLI reports it as
// ServiceUnavailableException; the Strands SDK wraps it as ModelError, so
// the name check above never sees it) — brief instances of it are
// retryable, and a persistent one exhausts maxModelAttempts and surfaces.
const RETRYABLE_BEDROCK_MESSAGE_PATTERNS = [
  'econnreset', 'econnrefused', 'enotfound', 'etimedout', 'socket hang up',
  'network', 'fetch failed',
  'unable to process your request',
];

class HiveModelRetryStrategy extends DefaultModelRetryStrategy {
  isRetryable(error) {
    if (super.isRetryable(error)) return true;
    if (!error) return false;
    // A user-initiated cancel also surfaces as an abort — never retry those.
    // The SDK's cancelSignal path ends the stream with stopReason 'cancelled'
    // before this strategy runs, but keep the guard for safety.
    if (error.name === 'AbortError' && /cancel/i.test(error.message || '')) return false;
    if (RETRYABLE_BEDROCK_ERROR_NAMES.has(error.name)) return true;
    const msg = (error.message || '').toLowerCase();
    return RETRYABLE_BEDROCK_MESSAGE_PATTERNS.some((p) => msg.includes(p));
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
 * @param {string} opts.region - AWS region hosting the Bedrock models (e.g. "us-east-1")
 * @param {string} opts.mantleApiKey - long-term Bedrock API key sent as a bearer token
 *   (field name kept from the Mantle era for settings continuity — it's the same kind of key)
 * @param {string} opts.systemPrompt
 * @param {Array} opts.tools - Strands tool() instances (pass [] for non-agentic use, e.g. the Chat tab)
 * @param {string} [opts.id] - Agent id (useful for Swarm's multi-agent pipeline)
 * @param {(entry: object) => void} [opts.onLog] - introspective log sink (see attachIntrospectionHooks)
 * @param {number} [opts.maxModelAttempts] - total model-call attempts including the first (default 4)
 * @param {number} [opts.maxToolRetries] - max automatic retries for a single failing tool call (default 3)
 * @param {number} [opts.maxTokens] - max output tokens per model call (default DEFAULT_MAX_OUTPUT_TOKENS —
 *   see the comment above that constant — Converse-derived ceiling with margin)
 * @param {boolean} [opts.enableThinking] - request extended thinking/reasoning tokens for
 *   this turn. Silently ignored (no-op) if `modelId` isn't in the supportsExtendedThinking()
 *   allowlist — callers don't need to check support themselves.
 * @param {string|false} [opts.contextManager] - SDK context management strategy (default 'auto').
 *   'auto' enables the SDK's SummarizingConversationManager (proactive compression at 85% of the
 *   context window, summarize-on-overflow) plus the ContextOffloader plugin, which moves tool
 *   results over ~1500 tokens out of context (a 750-token preview and a reference stay in; the
 *   agent can fetch the rest via the SDK-registered `retrieve_offloaded_content` tool). Offload
 *   storage is in-memory, which is safe by construction here: every Hive agent is built fresh per
 *   invocation and its internal message list never outlives the turn (the Work tab re-seeds
 *   history from its own transcript). Pass false to opt out (SDK default sliding window, no
 *   offloader) — e.g. if a caller's tool results must stay verbatim in context.
 * @returns {{agent: Agent, dispose: () => void}}
 */
function createAgent({ modelId, region, mantleApiKey, systemPrompt, tools, id, onLog, maxModelAttempts = 4, maxToolRetries = 3, maxTokens = DEFAULT_MAX_OUTPUT_TOKENS, enableThinking = false, contextManager = 'auto' }) {
  validateRegion(region);
  const thinkingFamily = enableThinking ? supportsExtendedThinking(modelId) : null;

  // One model class for every family: BedrockModel speaks the Converse
  // Stream API to bedrock-runtime, which serves all providers uniformly —
  // no per-family protocol split, no base-path table, no endpoint URL
  // construction (the AWS SDK derives the bedrock-runtime endpoint from
  // `region`). The long-term Bedrock API key is sent as a bearer token via
  // `apiKey` (the SDK swaps it in for SigV4 at finalizeRequest), so model
  // calls remain decoupled from the user's expiring AWS credentials exactly
  // as they were on Mantle.
  const model = new BedrockModel({
    modelId,
    region,
    maxTokens,
    apiKey: mantleApiKey,
    // The SDK's apiKey middleware OVERWRITES the Authorization header after
    // SigV4 signing — but signing still runs first and needs credentials to
    // compute the signature it's about to throw away. Without these, the
    // default credential chain is consulted and the call fails with "Could
    // not load credentials from any providers" on any machine without
    // ambient AWS credentials — which is CI, and every packaged Hive
    // install (users' AWS credentials live in Hive's own store, not the
    // chain). These placeholders are never sent: the signature derived from
    // them is replaced by the bearer header. Caught by the release
    // pipeline's live check on the first v4.4.0 tag — local runs passed
    // only because this machine has ~/.aws credentials to sign with.
    clientConfig: {
      credentials: { accessKeyId: 'bearer-auth-placeholder', secretAccessKey: 'bearer-auth-placeholder' },
    },
    // Prompt caching. With strategy 'auto', BedrockModel detects per model
    // ID whether Bedrock supports caching for it (Anthropic-style cache
    // points covering tools, system prompt, and the last user message) and
    // no-ops with a logged warning where it doesn't — so this is safe to
    // set unconditionally for every family. Verified live by the cache
    // write/read assertion in tests/integration/bedrock-live.js.
    cacheConfig: { strategy: 'auto' },
    // Extended thinking / reasoning, passed through Converse's
    // additionalModelRequestFields. Only attached for models in the
    // supportsExtendedThinking() allowlist — Bedrock rejects unknown
    // request fields on models that don't take them.
    //  - Anthropic: the Messages API `thinking` block.
    //  - OpenAI GPT-5-class: `reasoning: { effort }` (same shape the
    //    Strands harness sends for these models on Bedrock).
    ...(thinkingFamily === 'anthropic'
      ? { additionalRequestFields: { thinking: { type: 'enabled', budget_tokens: DEFAULT_THINKING_BUDGET_TOKENS } } }
      : {}),
    ...(thinkingFamily === 'openai'
      ? { additionalRequestFields: { reasoning: { effort: 'medium' } } }
      : {}),
  });

  const retryStrategy = new HiveModelRetryStrategy({
    maxAttempts: maxModelAttempts,
    backoff: new ExponentialBackoff({ baseMs: 2000, maxMs: 30000 }),
  });

  // `contextManager` is passed only when truthy: the SDK treats the field as
  // an enum ('auto' | 'agentic'), so opting out means omitting it entirely,
  // not passing false.
  const agent = new Agent({
    model,
    systemPrompt,
    tools,
    id,
    retryStrategy,
    ...(contextManager ? { contextManager } : {}),
  });
  const dispose = attachIntrospectionHooks(agent, onLog, maxToolRetries);

  return { agent, dispose };
}


module.exports = { createAgent, isRetryableToolError, supportsExtendedThinking, isAnthropicModel };
