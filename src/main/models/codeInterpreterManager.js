const {
  BedrockAgentCoreClient,
  StartCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
} = require('@aws-sdk/client-bedrock-agentcore');
const log = require('electron-log/main');

// Transient-error detection for retrying AgentCore calls. Concurrent tool
// calls (e.g. the Strands SDK's default ConcurrentToolExecutor firing
// several read_local_file calls in one turn against a directory attachment)
// can push several requests at AgentCore's endpoint at once, which has been
// observed to occasionally return a malformed/non-JSON response (raw HTTP
// status text, connection reset, throttling) instead of a normal AWS JSON
// error — surfacing as a confusing `Unexpected token 'H', "HTTP conte..."`
// SyntaxError from the AWS SDK's own response deserializer, with no
// AWS-shaped error code to branch on. This retries a small, fixed number of
// times with backoff on exactly that class of failure, in addition to the
// SDK's own throttling/5xx retry codes.
const RETRYABLE_ERROR_NAMES = new Set([
  'ThrottlingException',
  'ServiceUnavailableException',
  'InternalServerException',
  'TimeoutError',
]);

function isRetryableError(err) {
  if (!err) return false;
  if (RETRYABLE_ERROR_NAMES.has(err.name)) return true;
  if (err.$metadata?.httpStatusCode >= 500) return true;
  // Malformed-response symptom: the SDK's protocol layer tried to JSON.parse
  // a raw HTTP status line or error page instead of a real response body.
  if (err instanceof SyntaxError && /unexpected token/i.test(err.message)) return true;
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') return true;
  return false;
}

/**
 * AgentCore reports an expired/terminated Code Interpreter session as a
 * ValidationException with a "... is not active" message — e.g.
 * "Code interpreter session 01M0AEVN6ENN7RJ2EPQ65VKE9Z is not active".
 * This happens on long conversations: the session's sessionTimeoutSeconds
 * elapses server-side while the manager still holds the stale sessionId.
 * Deliberately NOT retryable via withRetry (retrying the same dead session
 * can never succeed) — instead it triggers transparent session recreation,
 * see _invokeWithRecovery().
 */
function isSessionExpiredError(err) {
  return !!err && err.name === 'ValidationException' && /is not active/i.test(err.message || '');
}

async function withRetry(fn, { retries = 3, baseDelayMs = 500, signal = null } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Never retry after a user-requested abort — even if the surfaced
      // error happens to look transient (e.g. a connection reset caused by
      // the abort itself).
      if (signal?.aborted) throw err;
      if (attempt === retries || !isRetryableError(err)) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      log.warn(`[code-interpreter] Transient error (${err.name || err.message}), retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * Manages AgentCore Code Interpreter sessions.
 * Handles session lifecycle: start → invoke (multiple times) → stop.
 */
class CodeInterpreterManager {
  constructor(clientConfig) {
    this.client = new BedrockAgentCoreClient(clientConfig);
    this.sessionId = null;
    this.codeInterpreterIdentifier = 'aws.codeinterpreter.v1';
    // In-flight start promise, so concurrent callers (e.g. several
    // read_local_file tool calls firing in parallel under the Strands SDK's
    // default concurrent tool executor) await the SAME session-start
    // instead of each racing to start their own — see _doStartSession().
    this._startPromise = null;
    // Session lifetime bookkeeping for expiry detection/recovery: what
    // timeout the current session was started with (reused when recreating
    // an expired session) and when it started (for the proactive check in
    // _invokeWithRecovery()).
    this._sessionTimeoutSeconds = null;
    this._sessionStartedAt = null;
  }

  async startSession(timeoutSeconds = 900, { signal = null } = {}) {
    if (this.sessionId) return this.sessionId;
    if (this._startPromise) return this._startPromise;

    this._startPromise = this._doStartSession(timeoutSeconds, signal);
    try {
      return await this._startPromise;
    } finally {
      this._startPromise = null;
    }
  }

  async _doStartSession(timeoutSeconds, signal = null) {
    const response = await withRetry(() => this.client.send(
      new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: this.codeInterpreterIdentifier,
        name: `hive-${Date.now()}`,
        sessionTimeoutSeconds: timeoutSeconds,
      }),
      { abortSignal: signal ?? undefined }
    ), { signal });
    this.sessionId = response.sessionId;
    this._sessionTimeoutSeconds = timeoutSeconds;
    this._sessionStartedAt = Date.now();
    log.info(`[code-interpreter] Session started: ${this.sessionId} (timeout ${timeoutSeconds}s)`);
    await this.executeCode(
      'import subprocess; subprocess.check_call(["pip", "install", "-q", "python-docx", "openpyxl", "python-pptx", "lxml"]); print("Libraries installed")',
      { signal }
    );

    return this.sessionId;
  }

  async executeCode(code, { signal = null } = {}) {
    if (!this.sessionId) throw new Error('No active Code Interpreter session');
    return this._invokeWithRecovery('executeCode', { language: 'python', code }, signal);
  }

  async writeFiles(files, { signal = null } = {}) {
    if (!this.sessionId) throw new Error('No active Code Interpreter session');
    return this._invokeWithRecovery('writeFiles', { content: files }, signal);
  }

  async readFileBase64(remotePath, { signal = null } = {}) {
    const code = `
import base64
with open("${remotePath}", "rb") as f:
    print(base64.b64encode(f.read()).decode())
`;
    const result = await this.executeCode(code, { signal });
    // A failed read (e.g. the file vanished because the session expired and
    // was recreated empty) must throw, not fall through — result.text would
    // be '' here, and Buffer.from('', 'base64') would silently produce a
    // 0-byte file at the caller.
    if (!result.success) {
      throw new Error(`Failed to read ${remotePath} from sandbox: ${result.errors.join('; ') || 'unknown error'}`);
    }
    return result.text.trim();
  }

  /**
   * Sends an InvokeCodeInterpreterCommand with transparent recovery from an
   * expired session — the fix for "ValidationException: Code interpreter
   * session ... is not active" killing long conversations.
   *
   * Two layers:
   *  1. Proactive — if the session is provably past its own
   *     sessionTimeoutSeconds, recreate it up front instead of burning a
   *     round trip that is guaranteed to fail.
   *  2. Reactive — if AgentCore still reports the session as not active
   *     (idle expiry, server-side termination, clock skew), recreate the
   *     session and retry the command exactly once.
   *
   * Recovered sessions start EMPTY — files from the old sandbox are gone
   * (AgentCore deleted them). The result carries `sessionRecreated: true`
   * so callers composing model-facing tool results can say so, letting the
   * agent re-upload/regenerate rather than silently referencing files that
   * no longer exist.
   */
  async _invokeWithRecovery(name, args, signal) {
    if (this._isSessionLikelyExpired()) {
      log.warn(`[code-interpreter] Session ${this.sessionId} is past its ${this._sessionTimeoutSeconds}s lifetime — recreating proactively`);
      await this._recreateSession(this.sessionId, signal);
      const result = await this._invoke(name, args, signal);
      return { ...result, sessionRecreated: true };
    }

    const sidAtStart = this.sessionId;
    try {
      return await this._invoke(name, args, signal);
    } catch (err) {
      if (!isSessionExpiredError(err) || signal?.aborted) throw err;
      log.warn(`[code-interpreter] Session ${sidAtStart} is no longer active — recreating and retrying once`);
      await this._recreateSession(sidAtStart, signal);
      const result = await this._invoke(name, args, signal);
      return { ...result, sessionRecreated: true };
    }
  }

  async _invoke(name, args, signal) {
    const response = await withRetry(() => this.client.send(
      new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.codeInterpreterIdentifier,
        // Read inside the closure so a recovery/retry picks up the NEW
        // session ID, not the one captured when the call began.
        sessionId: this.sessionId,
        name,
        arguments: args,
      }),
      // abortSignal cancels the in-flight AgentCore request (including its
      // streamed response) when the user hits Stop. Note the sandbox-side
      // process may still run to completion server-side — we stop waiting,
      // we don't kill the session (Work tab file state must survive).
      { abortSignal: signal ?? undefined }
    ), { signal });

    return this._collectStreamResults(response.stream);
  }

  /** True when the current session is provably past its own requested lifetime (60s safety margin). */
  _isSessionLikelyExpired() {
    if (!this.sessionId || !this._sessionStartedAt || !this._sessionTimeoutSeconds) return false;
    return Date.now() - this._sessionStartedAt >= (this._sessionTimeoutSeconds - 60) * 1000;
  }

  /**
   * Drops the stale session and starts a fresh one with the same timeout the
   * original was started with. Concurrency-safe: only clears sessionId if it
   * still holds the stale value (another concurrent caller may have already
   * recreated it — in that case startSession() returns the existing fresh
   * session immediately), and startSession()'s in-flight-promise lock
   * collapses concurrent recreations into a single
   * StartCodeInterpreterSessionCommand.
   */
  async _recreateSession(staleId, signal) {
    if (this.sessionId === staleId) this.sessionId = null;
    await this.startSession(this._sessionTimeoutSeconds ?? 900, { signal });
    log.info(`[code-interpreter] Session recreated: ${staleId} -> ${this.sessionId} (previous sandbox contents are gone)`);
  }

  async stopSession() {
    if (!this.sessionId) return;
    const sid = this.sessionId;

    try {
      await withRetry(() => this.client.send(
        new StopCodeInterpreterSessionCommand({
          codeInterpreterIdentifier: this.codeInterpreterIdentifier,
          sessionId: this.sessionId,
        })
      ));
    } finally {
      this.sessionId = null;
      this._sessionTimeoutSeconds = null;
      this._sessionStartedAt = null;
      log.info(`[code-interpreter] Session stopped: ${sid}`);
    }
  }

  async _collectStreamResults(stream) {
    const texts = [];
    const errors = [];

    for await (const event of stream) {
      if (event.result && event.result.content) {
        for (const item of event.result.content) {
          if (item.type === 'text') texts.push(item.text);
          if (item.type === 'error') errors.push(item.text || item.error);
        }
      }
    }

    return {
      text: texts.join('\n'),
      errors,
      success: errors.length === 0,
    };
  }
}

module.exports = CodeInterpreterManager;
module.exports.isRetryableError = isRetryableError;
module.exports.withRetry = withRetry;
module.exports.isSessionExpiredError = isSessionExpiredError;
