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

async function withRetry(fn, { retries = 3, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
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
  }

  async startSession(timeoutSeconds = 900) {
    if (this.sessionId) return this.sessionId;
    if (this._startPromise) return this._startPromise;

    this._startPromise = this._doStartSession(timeoutSeconds);
    try {
      return await this._startPromise;
    } finally {
      this._startPromise = null;
    }
  }

  async _doStartSession(timeoutSeconds) {
    const response = await withRetry(() => this.client.send(
      new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: this.codeInterpreterIdentifier,
        name: `hive-${Date.now()}`,
        sessionTimeoutSeconds: timeoutSeconds,
      })
    ));
    this.sessionId = response.sessionId;
    log.info(`[code-interpreter] Session started: ${this.sessionId}`);
    await this.executeCode(
      'import subprocess; subprocess.check_call(["pip", "install", "-q", "python-docx", "openpyxl", "python-pptx", "lxml"]); print("Libraries installed")'
    );

    return this.sessionId;
  }

  async executeCode(code) {
    if (!this.sessionId) throw new Error('No active Code Interpreter session');

    const response = await withRetry(() => this.client.send(
      new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.codeInterpreterIdentifier,
        sessionId: this.sessionId,
        name: 'executeCode',
        arguments: { language: 'python', code },
      })
    ));

    return this._collectStreamResults(response.stream);
  }

  async writeFiles(files) {
    if (!this.sessionId) throw new Error('No active Code Interpreter session');

    const response = await withRetry(() => this.client.send(
      new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.codeInterpreterIdentifier,
        sessionId: this.sessionId,
        name: 'writeFiles',
        arguments: { content: files },
      })
    ));

    return this._collectStreamResults(response.stream);
  }

  async readFileBase64(remotePath) {
    const code = `
import base64
with open("${remotePath}", "rb") as f:
    print(base64.b64encode(f.read()).decode())
`;
    const result = await this.executeCode(code);
    return result.text.trim();
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
