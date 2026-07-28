/**
 * strandsAgentFactory.js — single shared construction point for every Strands
 * `Agent` instance in Hive (Work tab + Swarm). Attaches:
 *
 *  1. A ModelRetryStrategy with exponential backoff for transient model-call
 *     errors (throttling, timeouts) — self-healing with zero custom retry loops.
 *  2. An introspection hook on AfterModelCallEvent + AfterToolCallEvent that
 *     logs every attempt/failure/retry decision through a caller-supplied
 *     `onLog` callback. This is the "internal log" that lets a user see why
 *     an agent recovered (or didn't) without any bespoke logging plumbing —
 *     it's just Strands' own hook events routed to Hive's existing status/
 *     event channels (onStatus for Work, onEvent for Swarm).
 *
 * Both Work (agentToolExecutor.js) and Swarm (swarmOrchestrator.js) call
 * createAgent() instead of `new Agent(...)` directly, so retry/logging
 * behavior lives in exactly one place and never drifts out of sync between
 * the two call sites.
 */
const {
  Agent,
  BedrockModel,
  DefaultModelRetryStrategy,
  ExponentialBackoff,
  AfterModelCallEvent,
  AfterToolCallEvent,
} = require('@strands-agents/sdk');
const log = require('electron-log/main');

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
 * Construct a fully-configured Strands Agent shared by Work and Swarm.
 *
 * @param {object} opts
 * @param {string} opts.modelId - Bedrock model ID
 * @param {string} opts.region
 * @param {object} opts.credentials - AWS credentials object
 * @param {string} opts.systemPrompt
 * @param {Array} opts.tools - Strands tool() instances
 * @param {string} [opts.id] - Agent id (useful for Swarm's multi-agent pipeline)
 * @param {(entry: object) => void} [opts.onLog] - introspective log sink (see attachIntrospectionHooks)
 * @param {number} [opts.maxModelAttempts] - total model-call attempts including the first (default 4)
 * @param {number} [opts.maxToolRetries] - max automatic retries for a single failing tool call (default 3)
 * @returns {{agent: Agent, dispose: () => void}}
 */
function createAgent({ modelId, region, credentials, systemPrompt, tools, id, onLog, maxModelAttempts = 4, maxToolRetries = 3 }) {
  const model = new BedrockModel({
    modelId,
    clientConfig: { region, credentials },
  });

  const retryStrategy = new DefaultModelRetryStrategy({
    maxAttempts: maxModelAttempts,
    backoff: new ExponentialBackoff({ baseMs: 2000, maxMs: 30000 }),
  });

  const agent = new Agent({ model, systemPrompt, tools, id, retryStrategy });
  const dispose = attachIntrospectionHooks(agent, onLog, maxToolRetries);

  return { agent, dispose };
}

module.exports = { createAgent, isRetryableToolError };
