/**
 * Focused tests for swarmTools.js's `web` tool — specifically the error
 * message returned when AgentCore Gateway web search isn't ready. This
 * message is read by the model, so its wording matters: it must explicitly
 * forbid falling back to execute_code-based HTTP/scraping (previously a
 * generic "not available" error left the model free to improvise a sandbox
 * workaround, which looked to users like "the agent is using the sandbox for
 * web search").
 */
jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// swarmTools.js's `tool()` wrapper just needs to preserve the definition
// object (name/description/inputSchema/callback) so tests can call
// .callback() directly — avoids pulling in the real @strands-agents/sdk
// package, which uses ESM syntax Jest can't parse without a transform.
jest.mock('@strands-agents/sdk', () => ({
  tool: jest.fn((def) => def),
}));

const { createSwarmTools } = require('../../src/main/models/swarmTools');

function getWebTool(webSearchManager) {
  const tools = createSwarmTools({ codeInterpreterManager: {}, webSearchManager, settings: {}, onStatus: jest.fn() }, ['web']);
  return tools[0];
}

describe('swarmTools web tool', () => {
  test('returns an error instructing the model NOT to fall back to execute_code when search is unavailable', async () => {
    const webTool = getWebTool({ ready: false });
    const result = await webTool.callback({ query: 'AWS pricing' });
    const parsed = JSON.parse(result);

    expect(parsed.error).toMatch(/unavailable/i);
    expect(parsed.error).toMatch(/execute_code/i);
  });

  test('error message tells the model to inform the user rather than work around it', async () => {
    const webTool = getWebTool({ ready: false });
    const result = await webTool.callback({ query: 'AWS pricing' });
    const parsed = JSON.parse(result);

    expect(parsed.error).toMatch(/tell the user/i);
  });

  test('error message is returned for query-based (search) calls when webSearchManager is entirely absent', async () => {
    const webTool = getWebTool(undefined);
    const result = await webTool.callback({ query: 'AWS pricing' });
    const parsed = JSON.parse(result);

    expect(parsed.error).toMatch(/execute_code/i);
  });

  test('successful search does not go through the unavailable-error path', async () => {
    const webSearchManager = {
      ready: true,
      search: jest.fn(async () => [{ title: 'Result', url: 'https://example.com', content: 'snippet' }]),
    };
    const webTool = getWebTool(webSearchManager);
    const result = await webTool.callback({ query: 'AWS pricing' });
    const parsed = JSON.parse(result);

    expect(parsed.error).toBeUndefined();
    expect(parsed.source).toBe('agentcore');
    expect(webSearchManager.search).toHaveBeenCalledWith('AWS pricing', 5);
  });
});

describe('swarmTools onStatus tagging (regression: every tool must tag its own name)', () => {
  // Regression guard for a real bug: every onStatus?.() call site previously
  // passed a bare string, and the caller (agentToolExecutor.js) wrapped ALL
  // of them as {tool: 'sandbox', ...} regardless of which tool actually
  // emitted the status/error — so a failed web search showed up in the
  // activity log mislabeled as sandbox activity. Each tool must now tag its
  // own name explicitly in a structured {tool, detail, state} object.

  test('web tool tags its own status updates as tool: "web", not "sandbox"', async () => {
    const onStatus = jest.fn();
    const webSearchManager = { ready: true, search: jest.fn(async () => []) };
    const tools = createSwarmTools({ codeInterpreterManager: {}, webSearchManager, settings: {}, onStatus }, ['web']);
    await tools[0].callback({ query: 'test query' });

    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ tool: 'web' }));
    expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ tool: 'sandbox' }));
  });

  test('web tool tags its own error status as tool: "web", not "sandbox"', async () => {
    const onStatus = jest.fn();
    const tools = createSwarmTools({ codeInterpreterManager: {}, webSearchManager: { ready: false }, settings: {}, onStatus }, ['web']);
    await tools[0].callback({ query: 'test query' });

    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ tool: 'web', detail: expect.stringContaining('Web error') }));
    expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ tool: 'sandbox' }));
  });

  test('execute_code tool tags its own sandbox-startup status as tool: "execute_code"', async () => {
    const onStatus = jest.fn();
    const codeInterpreterManager = {
      sessionId: null,
      startSession: jest.fn(async () => { codeInterpreterManager.sessionId = 'sess-1'; }),
      executeCode: jest.fn(async () => ({ success: true, text: 'ok' })),
    };
    const tools = createSwarmTools({ codeInterpreterManager, webSearchManager: {}, settings: {}, onStatus }, ['execute_code']);
    await tools[0].callback({ code: 'print(1)' });

    expect(onStatus).toHaveBeenCalledWith({ tool: 'execute_code', detail: 'Starting sandbox...', state: 'running' });
  });

  test('save_file_locally tool tags its own error status as tool: "save_file_locally"', async () => {
    const onStatus = jest.fn();
    const codeInterpreterManager = { sessionId: null };
    const tools = createSwarmTools({ codeInterpreterManager, webSearchManager: {}, settings: {}, onStatus }, ['save_file_locally']);
    await tools[0].callback({ sandbox_path: '/tmp/x', local_path: '/tmp/x' });

    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ tool: 'save_file_locally' }));
  });

  test('generate_image tool tags its status as tool: "generate_image", not "sandbox"', async () => {
    const onStatus = jest.fn();
    const codeInterpreterManager = { sessionId: null };
    const tools = createSwarmTools({ codeInterpreterManager, webSearchManager: {}, settings: { region: 'us-east-1' }, onStatus }, ['generate_image']);

    // Don't await the full callback (it would attempt a real Bedrock call in
    // this test env with no credentials) — just confirm the first onStatus
    // call, which fires synchronously before any AWS call, tags correctly.
    tools[0].callback({ prompt: 'a cat' }).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ tool: 'generate_image', detail: expect.stringContaining('Generating image') }));
    expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ tool: 'sandbox' }));
  });
});

describe('swarmTools cancellation forwarding (ToolContext.agent.cancelSignal)', () => {
  /** Builds the SDK-shaped ToolContext second callback argument. */
  function contextWith(signal) {
    return { agent: { cancelSignal: signal } };
  }

  test('execute_code forwards the cancel signal into startSession and executeCode', async () => {
    const codeInterpreterManager = {
      sessionId: null,
      startSession: jest.fn(async () => { codeInterpreterManager.sessionId = 'sess-1'; }),
      executeCode: jest.fn(async () => ({ success: true, text: 'ok' })),
    };
    const tools = createSwarmTools({ codeInterpreterManager, webSearchManager: {}, settings: {}, onStatus: jest.fn() }, ['execute_code']);

    const controller = new AbortController();
    await tools[0].callback({ code: 'print(1)' }, contextWith(controller.signal));

    expect(codeInterpreterManager.startSession).toHaveBeenCalledWith(7200, { signal: controller.signal });
    expect(codeInterpreterManager.executeCode).toHaveBeenCalledWith('print(1)', { signal: controller.signal });
  });

  test('execute_code works without a ToolContext (signal undefined, backward compatible)', async () => {
    const codeInterpreterManager = {
      sessionId: 'sess-1',
      executeCode: jest.fn(async () => ({ success: true, text: 'ok' })),
    };
    const tools = createSwarmTools({ codeInterpreterManager, webSearchManager: {}, settings: {}, onStatus: jest.fn() }, ['execute_code']);

    const result = await tools[0].callback({ code: 'print(1)' });

    expect(codeInterpreterManager.executeCode).toHaveBeenCalledWith('print(1)', { signal: undefined });
    expect(result).toBe('ok');
  });

  test('save_file_locally forwards the cancel signal into readFileBase64', async () => {
    const os = require('os');
    const path = require('path');
    const localPath = path.join(os.homedir(), `.hive-test-cancel-${Date.now()}.bin`);
    const codeInterpreterManager = {
      sessionId: 'sess-1',
      readFileBase64: jest.fn(async () => Buffer.from('hello').toString('base64')),
    };
    const tools = createSwarmTools({ codeInterpreterManager, webSearchManager: {}, settings: {}, onStatus: jest.fn() }, ['save_file_locally']);

    const controller = new AbortController();
    try {
      const result = JSON.parse(await tools[0].callback(
        { sandbox_path: '/tmp/out.bin', local_path: localPath },
        contextWith(controller.signal),
      ));
      expect(result.success).toBe(true);
      expect(codeInterpreterManager.readFileBase64).toHaveBeenCalledWith('/tmp/out.bin', { signal: controller.signal });
    } finally {
      await require('fs').promises.unlink(localPath).catch(() => {});
    }
  });

  test('web tool URL fetch aborts immediately when the cancel signal is already aborted', async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn(async (_url, opts) => {
      // The composed signal (timeout ∪ cancel) must already be aborted.
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      expect(opts.signal.aborted).toBe(true);
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    global.fetch = fetchMock;
    try {
      const tools = createSwarmTools({ codeInterpreterManager: {}, webSearchManager: {}, settings: {}, onStatus: jest.fn() }, ['web']);
      const controller = new AbortController();
      controller.abort();

      const result = JSON.parse(await tools[0].callback({ url: 'https://example.com' }, contextWith(controller.signal)));

      expect(fetchMock).toHaveBeenCalled();
      expect(result.error).toMatch(/aborted/i);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('web tool URL fetch still gets a (timeout-only) signal when no cancel signal is present', async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn(async (_url, opts) => {
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      expect(opts.signal.aborted).toBe(false);
      return {
        ok: true,
        text: async () => '<html><title>Hi</title><body>content</body></html>',
      };
    });
    global.fetch = fetchMock;
    try {
      const tools = createSwarmTools({ codeInterpreterManager: {}, webSearchManager: {}, settings: {}, onStatus: jest.fn() }, ['web']);
      const result = JSON.parse(await tools[0].callback({ url: 'https://example.com' }));

      expect(result.title).toBe('Hi');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('swarmTools execute_code — expired-sandbox recovery note', () => {
  test('prepends a session-recreated note to the tool result so the model knows files are gone', async () => {
    const codeInterpreterManager = {
      sessionId: 'sess-new',
      executeCode: jest.fn(async () => ({ success: true, text: 'ok', sessionRecreated: true })),
    };
    const tools = createSwarmTools({ codeInterpreterManager, webSearchManager: {}, settings: {}, onStatus: jest.fn() }, ['execute_code']);

    const result = await tools[0].callback({ code: 'print(1)' });

    expect(result).toMatch(/session had expired and was automatically recreated/i);
    expect(result).toMatch(/ok$/);
  });

  test('includes the note in the error payload when the retried code also failed', async () => {
    const codeInterpreterManager = {
      sessionId: 'sess-new',
      executeCode: jest.fn(async () => ({
        success: false,
        text: '',
        errors: ["FileNotFoundError: '/tmp/report.docx'"],
        sessionRecreated: true,
      })),
    };
    const tools = createSwarmTools({ codeInterpreterManager, webSearchManager: {}, settings: {}, onStatus: jest.fn() }, ['execute_code']);

    const result = JSON.parse(await tools[0].callback({ code: 'open("/tmp/report.docx")' }));

    expect(result.error).toMatch(/FileNotFoundError/);
    expect(result.session_note).toMatch(/automatically recreated/i);
  });

  test('does not add any note on a normal, non-recovered execution', async () => {
    const codeInterpreterManager = {
      sessionId: 'sess-1',
      executeCode: jest.fn(async () => ({ success: true, text: 'plain output' })),
    };
    const tools = createSwarmTools({ codeInterpreterManager, webSearchManager: {}, settings: {}, onStatus: jest.fn() }, ['execute_code']);

    const result = await tools[0].callback({ code: 'print(1)' });

    expect(result).toBe('plain output');
  });
});
