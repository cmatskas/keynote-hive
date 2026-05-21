const {
  BedrockAgentCoreClient,
  StartCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
} = require('@aws-sdk/client-bedrock-agentcore');
const log = require('electron-log/main');

/**
 * Manages AgentCore Code Interpreter sessions.
 * Handles session lifecycle: start → invoke (multiple times) → stop.
 */
class CodeInterpreterManager {
  constructor(clientConfig) {
    this.client = new BedrockAgentCoreClient(clientConfig);
    this.sessionId = null;
    this.codeInterpreterIdentifier = 'aws.codeinterpreter.v1';
  }

  async startSession(timeoutSeconds = 900) {
    if (this.sessionId) return this.sessionId;

    const response = await this.client.send(
      new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: this.codeInterpreterIdentifier,
        name: `hive-${Date.now()}`,
        sessionTimeoutSeconds: timeoutSeconds,
      })
    );
    this.sessionId = response.sessionId;
    log.info(`[code-interpreter] Session started: ${this.sessionId}`);
    await this.executeCode(
      'import subprocess; subprocess.check_call(["pip", "install", "-q", "python-docx", "openpyxl", "python-pptx", "lxml"]); print("Libraries installed")'
    );

    return this.sessionId;
  }

  async executeCode(code) {
    if (!this.sessionId) throw new Error('No active Code Interpreter session');

    const response = await this.client.send(
      new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.codeInterpreterIdentifier,
        sessionId: this.sessionId,
        name: 'executeCode',
        arguments: { language: 'python', code },
      })
    );

    return this._collectStreamResults(response.stream);
  }

  async writeFiles(files) {
    if (!this.sessionId) throw new Error('No active Code Interpreter session');

    const response = await this.client.send(
      new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.codeInterpreterIdentifier,
        sessionId: this.sessionId,
        name: 'writeFiles',
        arguments: { content: files },
      })
    );

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
      await this.client.send(
        new StopCodeInterpreterSessionCommand({
          codeInterpreterIdentifier: this.codeInterpreterIdentifier,
          sessionId: this.sessionId,
        })
      );
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
