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
      // Look up first, comprehensively — matches the gateway regardless of
      // its current status (READY, CREATING, UPDATING), not just READY.
      // This is the actual fix for the "already exists" conflict loop:
      // previously the lookup only matched READY gateways and silently
      // treated any lookup error as "not found", so a gateway that existed
      // but wasn't (yet) READY — or a lookup that failed for an unrelated
      // reason — fell through to CreateGateway every time, which AWS
      // correctly rejected as a conflict. Making the lookup itself reliable
      // means CreateGateway is only ever attempted when nothing exists,
      // rather than needing to recover from a conflict after the fact.
      const existing = await this._findExistingGateway();
      if (existing) {
        this._gatewayId = existing.gatewayId;
        if (existing.status !== 'READY') {
          log.info(`[web-search] Found existing gateway '${this._gatewayId}' in status ${existing.status} — waiting for it to become ready.`);
          await this._waitForGatewayReady();
        } else {
          this._gatewayUrl = existing.gatewayUrl;
        }
        await this._ensureWebSearchTarget();
        this._ready = true;
        log.info(`[web-search] Using existing gateway: ${this._gatewayId}`);
        return;
      }

      // Nothing found — create it.
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

    // this._gatewayUrl already includes the "/mcp" path suffix — confirmed
    // directly against a real GetGateway response
    // (".../gateway.bedrock-agentcore.<region>.amazonaws.com/mcp"). Appending
    // "/mcp" again here produced a malformed ".../mcp/mcp" path, which the
    // service rejected with "Http operation is not supported for gateway
    // protocol type MCP" — a confusing error that had nothing to do with
    // the protocol type itself, just a wrong URL.
    const url = new URL(this._gatewayUrl);
    const request = new HttpRequest({
      method: 'POST',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname,
      // Accept must declare both application/json and text/event-stream —
      // AgentCore Gateway's MCP endpoint uses the MCP Streamable HTTP
      // transport, which can respond with either depending on server
      // config, and a server may reject requests that don't declare
      // acceptance of both. This header must be part of the SigV4 signature
      // (set here, before signing) — previously it was omitted entirely,
      // which is the most likely cause of search() failing even once the
      // Gateway itself was correctly found/created and READY.
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        host: url.hostname,
      },
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

    const contentType = res.headers.get('content-type') || '';
    const json = contentType.includes('text/event-stream')
      ? this._parseSseJsonRpcResponse(await res.text())
      : await res.json();
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

  /**
   * Parses an SSE-framed MCP response body into the JSON-RPC payload.
   * MCP's Streamable HTTP transport may respond with `text/event-stream`
   * instead of a plain JSON body even for a single-shot tools/call request
   * (server-dependent) — each SSE frame is `event: message\ndata: {...}\n\n`.
   * For a non-subscription call there's exactly one JSON-RPC response frame,
   * so this returns the last parsed `data:` payload.
   */
  _parseSseJsonRpcResponse(text) {
    const dataLines = text
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .filter(Boolean);
    if (dataLines.length === 0) throw new Error('Empty or malformed SSE response from MCP endpoint');
    return JSON.parse(dataLines[dataLines.length - 1]);
  }

  /**
   * Finds a gateway by name regardless of status, except terminal failure
   * states (CREATE_FAILED/DELETE_FAILED — those are not usable and should
   * fall through to creating a fresh one under the same name once AWS
   * allows it). Returns { gatewayId, gatewayUrl, status } — gatewayUrl is
   * only populated when status is READY (GetGateway always returns it
   * regardless, but callers should wait for READY before trusting it for
   * traffic). Lookup failures (permissions, throttling, etc.) propagate as
   * real errors rather than being silently treated as "gateway not found" —
   * that conflation previously caused CreateGateway to be attempted against
   * a name that already existed, failing with ConflictException every time.
   */
  async _findExistingGateway() {
    const resp = await this._controlClient.send(new ListGatewaysCommand({ maxResults: 100 }));
    // ListGatewaysResponse's field is `items`, NOT `gateways` — confirmed
    // against the real SDK type (models_0.d.ts). The wrong field name here
    // meant this always evaluated to an empty array regardless of what
    // actually existed, so this lookup unconditionally returned null and
    // every initialize() call fell through to CreateGatewayCommand, which
    // AWS correctly rejected with "already exists" once a gateway had been
    // created by any earlier attempt — this was the entire cause of the
    // "already exists" failure loop, not a race condition or a lookup that
    // only matched READY status (both of those were real gaps too, but
    // fixing them alone could never have worked while this stayed wrong).
    const gw = (resp.items || []).find(
      g => g.name === GATEWAY_NAME && g.status !== 'CREATE_FAILED' && g.status !== 'DELETE_FAILED'
    );
    if (!gw) return null;
    const detail = await this._controlClient.send(new GetGatewayCommand({ gatewayIdentifier: gw.gatewayId }));
    return { gatewayId: detail.gatewayId, gatewayUrl: detail.gatewayUrl, status: detail.status || gw.status };
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
      // Same bug as _findExistingGateway(): ListGatewayTargetsResponse's
      // field is `items`, NOT `targets` — confirmed against the real SDK
      // type. Left uncorrected, this would always see an empty list and
      // attempt CreateGatewayTarget every time, hitting the same
      // "already exists" conflict once fixing the gateway-level bug let
      // execution reach this far.
      const existing = (resp.items || []).find(t => t.name === TARGET_NAME);
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
