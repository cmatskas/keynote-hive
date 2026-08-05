/**
 * Tests for webSearchManager.js.
 *
 * initialize() tests cover the restructured lookup-first design: previously
 * _findExistingGateway() only matched status === 'READY' and silently
 * swallowed ANY lookup error as "not found", so a gateway that existed but
 * wasn't (yet) READY — or a lookup that failed for an unrelated reason —
 * fell through to CreateGateway every time, which AWS correctly rejected
 * with ConflictException ("already exists"), in a loop with no recovery.
 * The fix makes the lookup itself comprehensive (matches any non-terminal-
 * failure status, waits for it to become ready) and lets genuine lookup
 * errors propagate as real errors, so CreateGateway is only attempted when
 * nothing exists at all — conflicts become structurally unlikely rather
 * than something to detect and recover from after the fact.
 *
 * search() tests cover a second, independent bug: the MCP request was
 * missing the `Accept: application/json, text/event-stream` header
 * required by the MCP Streamable HTTP transport, which AgentCore Gateway's
 * MCP endpoint uses — this caused search() to fail even once the Gateway
 * itself was correctly found/created and READY.
 */
jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  CreateGatewayCommand: jest.fn((input) => ({ __type: 'CreateGatewayCommand', input })),
  CreateGatewayTargetCommand: jest.fn((input) => ({ __type: 'CreateGatewayTargetCommand', input })),
  ListGatewaysCommand: jest.fn((input) => ({ __type: 'ListGatewaysCommand', input })),
  GetGatewayCommand: jest.fn((input) => ({ __type: 'GetGatewayCommand', input })),
  GetGatewayTargetCommand: jest.fn((input) => ({ __type: 'GetGatewayTargetCommand', input })),
  ListGatewayTargetsCommand: jest.fn((input) => ({ __type: 'ListGatewayTargetsCommand', input })),
}));

// SignatureV4.sign() just needs to return a headers object merged with
// whatever was passed in, so search() tests can inspect exactly what was
// signed (and therefore what would be sent) without real AWS signing.
const mockSign = jest.fn(async (request) => ({ headers: { ...request.headers, authorization: 'AWS4-HMAC-SHA256 mock' } }));
jest.mock('@smithy/signature-v4', () => ({
  SignatureV4: jest.fn().mockImplementation(() => ({ sign: mockSign })),
}));
jest.mock('@aws-crypto/sha256-js', () => ({ Sha256: jest.fn() }));
jest.mock('@smithy/protocol-http', () => ({
  HttpRequest: jest.fn().mockImplementation((opts) => opts),
}));

const WebSearchManager = require('../../src/main/models/webSearchManager');

function credentials() {
  return { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token', region: 'us-east-1' };
}

describe('WebSearchManager.initialize()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uses an existing READY gateway found on the first lookup (happy path, no roleArn needed)', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd.__type === 'ListGatewaysCommand') {
        return Promise.resolve({ items: [{ gatewayId: 'gw-1', name: 'hive-web-search', status: 'READY' }] });
      }
      if (cmd.__type === 'GetGatewayCommand') {
        return Promise.resolve({ gatewayId: 'gw-1', gatewayUrl: 'https://gw-1.example.com/mcp', status: 'READY' });
      }
      if (cmd.__type === 'ListGatewayTargetsCommand') {
        return Promise.resolve({ items: [{ targetId: 't-1', name: 'web-search-tool', status: 'READY' }] });
      }
      return Promise.resolve({});
    });

    const manager = new WebSearchManager(credentials());
    await manager.initialize(); // no roleArn passed — must not throw

    expect(manager.ready).toBe(true);
    expect(manager.gatewayId).toBe('gw-1');
    // CreateGateway must never be attempted when the lookup already found it.
    expect(mockSend).not.toHaveBeenCalledWith(expect.objectContaining({ __type: 'CreateGatewayCommand' }));
  });

  test('finds and waits for an existing NON-READY gateway (CREATING) instead of attempting to create a duplicate', async () => {
    // This is the actual fix for the reported "already exists" conflict —
    // the lookup now matches a gateway that exists but isn't READY yet,
    // rather than missing it and falling through to CreateGateway.
    let getGatewayCallCount = 0;
    mockSend.mockImplementation((cmd) => {
      if (cmd.__type === 'ListGatewaysCommand') {
        return Promise.resolve({ items: [{ gatewayId: 'gw-2', name: 'hive-web-search', status: 'CREATING' }] });
      }
      if (cmd.__type === 'GetGatewayCommand') {
        getGatewayCallCount++;
        return Promise.resolve(
          getGatewayCallCount >= 2
            ? { gatewayId: 'gw-2', gatewayUrl: 'https://gw-2.example.com/mcp', status: 'READY' }
            : { gatewayId: 'gw-2', status: 'CREATING' }
        );
      }
      if (cmd.__type === 'ListGatewayTargetsCommand') {
        return Promise.resolve({ items: [{ targetId: 't-2', name: 'web-search-tool', status: 'READY' }] });
      }
      return Promise.resolve({});
    });

    const manager = new WebSearchManager(credentials());
    await manager.initialize('arn:aws:iam::123456789012:role/hive-web-search-gateway-role');

    expect(manager.ready).toBe(true);
    expect(manager.gatewayId).toBe('gw-2');
    expect(mockSend).not.toHaveBeenCalledWith(expect.objectContaining({ __type: 'CreateGatewayCommand' }));
  }, 15000);

  test('creates a new gateway only when none exists at all', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd.__type === 'ListGatewaysCommand') return Promise.resolve({ items: [] });
      if (cmd.__type === 'CreateGatewayCommand') {
        return Promise.resolve({ gatewayId: 'gw-new', gatewayUrl: 'https://gw-new.example.com/mcp' });
      }
      if (cmd.__type === 'GetGatewayCommand') {
        return Promise.resolve({ gatewayId: 'gw-new', gatewayUrl: 'https://gw-new.example.com/mcp', status: 'READY' });
      }
      if (cmd.__type === 'ListGatewayTargetsCommand') {
        return Promise.resolve({ items: [{ targetId: 't-new', name: 'web-search-tool', status: 'READY' }] });
      }
      return Promise.resolve({});
    });

    const manager = new WebSearchManager(credentials());
    await manager.initialize('arn:aws:iam::123456789012:role/x');

    expect(manager.ready).toBe(true);
    expect(manager.gatewayId).toBe('gw-new');
  });

  test('throws immediately (without attempting to create) if no gateway exists and no roleArn is provided', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd.__type === 'ListGatewaysCommand') return Promise.resolve({ items: [] });
      return Promise.resolve({});
    });

    const manager = new WebSearchManager(credentials());
    await expect(manager.initialize()).rejects.toThrow(/roleArn required/);
    expect(mockSend).not.toHaveBeenCalledWith(expect.objectContaining({ __type: 'CreateGatewayCommand' }));
  });

  test('a genuine lookup failure (e.g. throttling) propagates as a real error rather than being swallowed and treated as "not found"', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd.__type === 'ListGatewaysCommand') return Promise.reject(new Error('ThrottlingException'));
      return Promise.resolve({});
    });

    const manager = new WebSearchManager(credentials());
    await expect(manager.initialize('arn:aws:iam::123456789012:role/x')).rejects.toThrow('ThrottlingException');
    // Must NOT have fallen through to CreateGateway after the lookup failed.
    expect(mockSend).not.toHaveBeenCalledWith(expect.objectContaining({ __type: 'CreateGatewayCommand' }));
  });

  test('ignores a gateway stuck in CREATE_FAILED and creates a fresh one instead', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd.__type === 'ListGatewaysCommand') {
        return Promise.resolve({ items: [{ gatewayId: 'gw-dead', name: 'hive-web-search', status: 'CREATE_FAILED' }] });
      }
      if (cmd.__type === 'CreateGatewayCommand') {
        return Promise.resolve({ gatewayId: 'gw-fresh', gatewayUrl: 'https://gw-fresh.example.com/mcp' });
      }
      if (cmd.__type === 'GetGatewayCommand') {
        return Promise.resolve({ gatewayId: 'gw-fresh', gatewayUrl: 'https://gw-fresh.example.com/mcp', status: 'READY' });
      }
      if (cmd.__type === 'ListGatewayTargetsCommand') {
        return Promise.resolve({ items: [{ targetId: 't-fresh', name: 'web-search-tool', status: 'READY' }] });
      }
      return Promise.resolve({});
    });

    const manager = new WebSearchManager(credentials());
    await manager.initialize('arn:aws:iam::123456789012:role/x');

    expect(manager.ready).toBe(true);
    expect(manager.gatewayId).toBe('gw-fresh');
  });
});

describe('WebSearchManager.search()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  async function readyManager() {
    mockSend.mockImplementation((cmd) => {
      if (cmd.__type === 'ListGatewaysCommand') {
        return Promise.resolve({ items: [{ gatewayId: 'gw-1', name: 'hive-web-search', status: 'READY' }] });
      }
      if (cmd.__type === 'GetGatewayCommand') {
        return Promise.resolve({ gatewayId: 'gw-1', gatewayUrl: 'https://gw-1.example.com/mcp', status: 'READY' });
      }
      if (cmd.__type === 'ListGatewayTargetsCommand') {
        return Promise.resolve({ items: [{ targetId: 't-1', name: 'web-search-tool', status: 'READY' }] });
      }
      return Promise.resolve({});
    });
    const manager = new WebSearchManager(credentials());
    await manager.initialize();
    return manager;
  }

  test('sends an Accept header declaring both application/json and text/event-stream', async () => {
    const manager = await readyManager();
    global.fetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ result: { content: [{ text: JSON.stringify({ results: [] }) }] } }),
    });

    await manager.search('AWS pricing');

    expect(mockSign).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json, text/event-stream' }) })
    );
  });

  test('does not double up the "/mcp" path suffix — gatewayUrl from GetGateway already includes it', async () => {
    // Regression guard: this._gatewayUrl is
    // "https://<id>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp"
    // per AWS's own GetGateway response (confirmed directly against a real
    // gateway). Appending "/mcp" again produced ".../mcp/mcp", which the
    // service rejected with a confusing "Http operation is not supported
    // for gateway protocol type MCP" error that had nothing to do with the
    // protocol type — just a malformed URL.
    const manager = await readyManager();
    global.fetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ result: { content: [{ text: JSON.stringify({ results: [] }) }] } }),
    });

    await manager.search('AWS pricing');

    expect(mockSign).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'gw-1.example.com', path: '/mcp' })
    );
    expect(global.fetch).toHaveBeenCalledWith('https://gw-1.example.com/mcp', expect.anything());
  });

  test('parses a plain application/json response', async () => {
    const manager = await readyManager();
    global.fetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        result: { content: [{ text: JSON.stringify({ results: [{ title: 'A', url: 'https://a.com', text: 'snippet' }] }) }] },
      }),
    });

    const results = await manager.search('AWS pricing');
    expect(results).toEqual([{ title: 'A', url: 'https://a.com', content: 'snippet', publishedDate: null }]);
  });

  test('parses an SSE-framed text/event-stream response', async () => {
    const manager = await readyManager();
    const payload = { result: { content: [{ text: JSON.stringify({ results: [{ title: 'B', url: 'https://b.com', text: 'snippet-b' }] }) }] } };
    const sseBody = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    global.fetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/event-stream' },
      text: async () => sseBody,
    });

    const results = await manager.search('AWS pricing');
    expect(results).toEqual([{ title: 'B', url: 'https://b.com', content: 'snippet-b', publishedDate: null }]);
  });

  test('throws a clear error on malformed SSE (no data: lines)', async () => {
    const manager = await readyManager();
    global.fetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/event-stream' },
      text: async () => 'event: message\n\n',
    });

    await expect(manager.search('AWS pricing')).rejects.toThrow(/Empty or malformed SSE/);
  });

  test('throws WebSearchManager not initialized if called before initialize() succeeds', async () => {
    const manager = new WebSearchManager(credentials());
    await expect(manager.search('AWS pricing')).rejects.toThrow('WebSearchManager not initialized');
  });
});
