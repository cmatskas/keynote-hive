/**
 * WebSearchManager — manages an AgentCore Gateway with Web Search Tool connector.
 * Creates the Gateway on first use, stores the ID in settings for reuse,
 * and exposes a search() method that invokes the MCP tools/call endpoint.
 */
const {
  BedrockAgentCoreControlClient,
  CreateGatewayCommand,
  CreateGatewayTargetCommand,
  ListGatewaysCommand,
  GetGatewayCommand,
  GetGatewayTargetCommand,
  ListGatewayTargetsCommand,
} = require('@aws-sdk/client-bedrock-agentcore-control');
const { SignatureV4 } = require('@smithy/signature-v4');
const { Sha256 } = require('@aws-crypto/sha256-js');
const { HttpRequest } = require('@smithy/protocol-http');
const log = require('electron-log/main');

const GATEWAY_NAME = 'hive-web-search';
const TARGET_NAME = 'web-search-tool';
const REGION = 'us-east-1'; // Web Search only available here

class WebSearchManager {
  constructor(credentials) {
    this._credentials = credentials;
    this._gatewayUrl = null;
    this._gatewayId = null;
    this._ready = false;

    const config = {
      region: REGION,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    };
    this._controlClient = new BedrockAgentCoreControlClient(config);
    this._signerCredentials = config.credentials;
  }

  /** Initialize: find or create the Gateway + web-search target. */
  async initialize(roleArn) {
    try {
      // Try to find existing gateway
      const existing = await this._findExistingGateway();
      if (existing) {
        this._gatewayId = existing.gatewayId;
        this._gatewayUrl = existing.gatewayUrl;
        // Ensure web-search target exists
        await this._ensureWebSearchTarget();
        this._ready = true;
        log.info(`[web-search] Using existing gateway: ${this._gatewayId}`);
        return;
      }

      // Create new gateway with IAM auth
      if (!roleArn) throw new Error('roleArn required to create web search gateway');
      const gw = await this._controlClient.send(new CreateGatewayCommand({
        name: GATEWAY_NAME,
        protocolType: 'MCP',
        roleArn,
        authorizerType: 'AWS_IAM',
      }));
      this._gatewayId = gw.gatewayId;
      this._gatewayUrl = gw.gatewayUrl;
      log.info(`[web-search] Created gateway: ${this._gatewayId}`);

      // Wait for READY status
      await this._waitForGatewayReady();
      await this._ensureWebSearchTarget();
      this._ready = true;
    } catch (err) {
      log.error(`[web-search] Initialization failed: ${err.message}`);
      this._ready = false;
      throw err;
    }
  }

  get ready() { return this._ready; }
  get gatewayId() { return this._gatewayId; }

  /** Search the web via AgentCore Web Search Tool. */
  async search(query, maxResults = 5) {
    if (!this._ready) throw new Error('WebSearchManager not initialized');

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: `search-${Date.now()}`,
      method: 'tools/call',
      params: {
        name: `${TARGET_NAME}___WebSearch`,
        arguments: { query: query.slice(0, 200), maxResults: Math.min(maxResults, 25) },
      },
    });

    const url = new URL(`${this._gatewayUrl}/mcp`);
    const request = new HttpRequest({
      method: 'POST',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname,
      headers: { 'Content-Type': 'application/json', host: url.hostname },
      body,
    });

    const signer = new SignatureV4({
      service: 'bedrock-agentcore',
      region: REGION,
      credentials: this._signerCredentials,
      sha256: Sha256,
    });
    const signed = await signer.sign(request);

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: signed.headers,
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Web search failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    if (json.error) throw new Error(`MCP error: ${json.error.message || JSON.stringify(json.error)}`);

    // Parse response: content[0].text contains JSON with results array
    const content = json.result?.content?.[0]?.text;
    if (!content) return [];

    const parsed = JSON.parse(content);
    return (parsed.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      content: r.text || '',
      publishedDate: r.publishedDate || null,
    }));
  }

  // ── Private helpers ──────────────────────────────────────

  async _findExistingGateway() {
    try {
      const resp = await this._controlClient.send(new ListGatewaysCommand({ maxResults: 100 }));
      const gw = (resp.gateways || []).find(g => g.name === GATEWAY_NAME && g.status === 'READY');
      if (!gw) return null;
      // Get full details for the URL
      const detail = await this._controlClient.send(new GetGatewayCommand({ gatewayIdentifier: gw.gatewayId }));
      return { gatewayId: detail.gatewayId, gatewayUrl: detail.gatewayUrl };
    } catch { return null; }
  }

  async _waitForGatewayReady(maxWaitMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const gw = await this._controlClient.send(new GetGatewayCommand({ gatewayIdentifier: this._gatewayId }));
      if (gw.status === 'READY') {
        this._gatewayUrl = gw.gatewayUrl;
        return;
      }
      if (gw.status === 'CREATE_FAILED') throw new Error('Gateway creation failed');
      await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error('Gateway creation timed out');
  }

  async _ensureWebSearchTarget() {
    // Check if target already exists
    try {
      const resp = await this._controlClient.send(new ListGatewayTargetsCommand({ gatewayIdentifier: this._gatewayId }));
      const existing = (resp.targets || []).find(t => t.name === TARGET_NAME);
      if (existing && existing.status === 'READY') return;
      if (existing) {
        // Wait for it
        await this._waitForTargetReady(existing.targetId);
        return;
      }
    } catch { /* proceed to create */ }

    // Create web-search target
    const target = await this._controlClient.send(new CreateGatewayTargetCommand({
      gatewayIdentifier: this._gatewayId,
      name: TARGET_NAME,
      targetConfiguration: {
        mcp: {
          connector: {
            source: { connectorId: 'web-search' },
            configurations: [{ name: 'WebSearch', parameterValues: {} }],
          },
        },
      },
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
    }));
    log.info(`[web-search] Created target: ${target.targetId}`);
    await this._waitForTargetReady(target.targetId);
  }

  async _waitForTargetReady(targetId, maxWaitMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const t = await this._controlClient.send(new GetGatewayTargetCommand({
        gatewayIdentifier: this._gatewayId,
        targetId,
      }));
      if (t.status === 'READY') return;
      if (t.status === 'CREATE_FAILED') throw new Error('Target creation failed');
      await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error('Target creation timed out');
  }
}

module.exports = WebSearchManager;
