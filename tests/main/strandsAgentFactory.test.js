/**
 * Tests for strandsAgentFactory.js — Bedrock-only model routing.
 *
 * Every model call goes through standard Amazon Bedrock (bedrock-runtime)
 * via the Strands SDK's BedrockModel and the Converse Stream API — one
 * model class for every family, no per-family protocol split, no endpoint
 * URL construction. Authentication is the long-term Bedrock API key from
 * Settings (still stored/passed as `mantleApiKey` for continuity), sent as
 * a bearer token via BedrockModel's `apiKey` option instead of SigV4 — so
 * model calls stay decoupled from the user's expiring AWS credentials.
 *
 * The Mantle era (AnthropicModel/OpenAIModel split, /anthropic prefix,
 * base-path table) is over; see tests/integration/bedrock-live.js for the
 * live checks that verify Bedrock's actual behavior end to end.
 */

jest.mock('@strands-agents/sdk', () => {
  class MockModelThrottledError extends Error {}
  class DefaultModelRetryStrategy {
    constructor(opts = {}) {
      this._maxAttempts = opts.maxAttempts;
      this._backoff = opts.backoff;
    }
    isRetryable(error) {
      return error instanceof MockModelThrottledError;
    }
  }
  class ExponentialBackoff {
    constructor(opts = {}) { this._opts = opts; }
  }
  class AfterModelCallEvent {}
  class AfterToolCallEvent {}
  const Agent = jest.fn().mockImplementation(() => ({
    addHook: jest.fn(() => jest.fn()), // returns a cleanup function, matching the real API
  }));
  return {
    Agent,
    tool: jest.fn(),
    DefaultModelRetryStrategy,
    ExponentialBackoff,
    AfterModelCallEvent,
    AfterToolCallEvent,
    MockModelThrottledError,
  };
});

jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('@strands-agents/sdk/models/bedrock', () => ({
  BedrockModel: jest.fn().mockImplementation(() => ({})),
}));

function baseArgs(overrides = {}) {
  return {
    modelId: 'global.anthropic.claude-sonnet-5',
    region: 'us-east-1',
    mantleApiKey: 'test-bedrock-api-key',
    systemPrompt: 'test prompt',
    tools: [],
    ...overrides,
  };
}

/** Construct an agent and return the BedrockModel constructor's call args. */
function bedrockModelArgsFor(createAgent, overrides = {}) {
  const { BedrockModel } = require('@strands-agents/sdk/models/bedrock');
  BedrockModel.mockClear();
  createAgent(baseArgs(overrides));
  return BedrockModel.mock.calls[0][0];
}

describe('strandsAgentFactory', () => {
  let createAgent, isRetryableToolError, supportsExtendedThinking, isAnthropicModel;
  let HiveModelRetryStrategy, MockModelThrottledError;

  beforeEach(() => {
    jest.resetModules();
    const mod = require('../../src/main/models/strandsAgentFactory');
    createAgent = mod.createAgent;
    isRetryableToolError = mod.isRetryableToolError;
    supportsExtendedThinking = mod.supportsExtendedThinking;
    isAnthropicModel = mod.isAnthropicModel;

    // HiveModelRetryStrategy itself isn't exported — exercise it indirectly
    // via createAgent(), which constructs one and passes it to Agent(). We
    // capture the instance via the mocked Agent constructor's call args.
    const sdkMock = require('@strands-agents/sdk');
    MockModelThrottledError = sdkMock.MockModelThrottledError;
    createAgent(baseArgs());
    const agentCallArgs = sdkMock.Agent.mock.calls[0][0];
    HiveModelRetryStrategy = agentCallArgs.retryStrategy;
  });

  describe('HiveModelRetryStrategy.isRetryable (Bedrock error classification)', () => {
    test("retries the base strategy's own retryable errors (throttling, already normalized to ModelThrottledError by the SDK)", () => {
      expect(HiveModelRetryStrategy.isRetryable(new MockModelThrottledError('throttled'))).toBe(true);
    });

    test('does not retry a plain Error with no matching name or message', () => {
      expect(HiveModelRetryStrategy.isRetryable(new Error('some other failure'))).toBe(false);
    });

    test('handles undefined/null error gracefully', () => {
      expect(HiveModelRetryStrategy.isRetryable(undefined)).toBe(false);
      expect(HiveModelRetryStrategy.isRetryable(null)).toBe(false);
    });

    // AWS SDK exceptions keep their `.name` (unlike the removed
    // openai/@anthropic-ai classes, which reported plain 'Error' and needed
    // instanceof) — so classification is by name.
    test.each([
      'ServiceUnavailableException',
      'InternalServerException',
      'ModelNotReadyException',
      'TimeoutError',
    ])('retries AWS exception by name: %s', (name) => {
      const err = new Error('server-side transient failure');
      err.name = name;
      expect(HiveModelRetryStrategy.isRetryable(err)).toBe(true);
    });

    test.each([
      'ValidationException',
      'AccessDeniedException',
      'ResourceNotFoundException',
    ])('does NOT retry non-transient AWS exception: %s', (name) => {
      const err = new Error('permanent failure');
      err.name = name;
      expect(HiveModelRetryStrategy.isRetryable(err)).toBe(false);
    });

    test.each([
      'ECONNRESET while streaming',
      'getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com',
      'TypeError: fetch failed',
      'socket hang up',
    ])('retries network-level failures by message pattern: %s', (message) => {
      expect(HiveModelRetryStrategy.isRetryable(new Error(message))).toBe(true);
    });

    test('retries a request-timeout AbortError but never a user cancellation', () => {
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'AbortError';
      expect(HiveModelRetryStrategy.isRetryable(timeout)).toBe(true);

      const cancel = new Error('Request cancelled by user');
      cancel.name = 'AbortError';
      expect(HiveModelRetryStrategy.isRetryable(cancel)).toBe(false);
    });
  });

  describe('isRetryableToolError (unchanged tool-level retry logic)', () => {
    test('retries on throttling and timeout patterns', () => {
      expect(isRetryableToolError(new Error('Request timed out'))).toBe(true);
      expect(isRetryableToolError(new Error('ThrottlingException: rate exceeded'))).toBe(true);
    });

    test('does not retry unrelated errors', () => {
      expect(isRetryableToolError(new Error('SyntaxError in generated code'))).toBe(false);
    });
  });

  describe('region validation', () => {
    test('throws for a malformed region rather than constructing a request', () => {
      expect(() => createAgent(baseArgs({ region: 'not a region' }))).toThrow(/Invalid AWS region/);
    });

    test('throws for a region containing URL control characters (security guard)', () => {
      expect(() => createAgent(baseArgs({ region: 'us-east-1@evil.example.com' }))).toThrow(/Invalid AWS region/);
    });

    test('accepts a well-formed region', () => {
      expect(() => createAgent(baseArgs({ region: 'ap-southeast-2' }))).not.toThrow();
    });
  });

  describe('BedrockModel construction', () => {
    test('every model family goes through BedrockModel — no protocol split by model identity', () => {
      const { BedrockModel } = require('@strands-agents/sdk/models/bedrock');
      for (const modelId of [
        'global.anthropic.claude-opus-5',
        'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        'openai.gpt-6-sol',
        'moonshot.kimi-k3',
        'amazon.nova-pro-v1:0',
      ]) {
        BedrockModel.mockClear();
        createAgent(baseArgs({ modelId }));
        expect(BedrockModel).toHaveBeenCalledTimes(1);
        expect(BedrockModel.mock.calls[0][0].modelId).toBe(modelId);
      }
    });

    test('authenticates with the API key as bearer auth — no credentials object, no URL construction', () => {
      const args = bedrockModelArgsFor(createAgent, { mantleApiKey: 'the-long-term-key' });
      expect(args.apiKey).toBe('the-long-term-key');
      expect(args.clientConfig).toBeUndefined();
      // Region is passed for endpoint derivation; Hive builds no URL itself.
      expect(args.region).toBe('us-east-1');
      expect(JSON.stringify(args)).not.toContain('bedrock-mantle');
    });

    test('prompt caching is requested unconditionally with strategy auto (SDK no-ops per model where unsupported)', () => {
      const anthropic = bedrockModelArgsFor(createAgent, { modelId: 'global.anthropic.claude-sonnet-5' });
      expect(anthropic.cacheConfig).toEqual({ strategy: 'auto' });
      const openai = bedrockModelArgsFor(createAgent, { modelId: 'openai.gpt-6-sol' });
      expect(openai.cacheConfig).toEqual({ strategy: 'auto' });
    });
  });

  describe('maxTokens (output token ceiling)', () => {
    test('defaults to 120000 when not specified by the caller', () => {
      expect(bedrockModelArgsFor(createAgent, {}).maxTokens).toBe(120000);
    });

    test('caller can override the default', () => {
      expect(bedrockModelArgsFor(createAgent, { maxTokens: 64 }).maxTokens).toBe(64);
    });
  });

  describe('supportsExtendedThinking (allowlist)', () => {
    test.each([
      'us.anthropic.claude-sonnet-4-6',
      'global.anthropic.claude-opus-4-6-v1',
      'anthropic.claude-3-7-sonnet-20250219-v1:0',
    ])('anthropic family: %s', (modelId) => {
      expect(supportsExtendedThinking(modelId)).toBe('anthropic');
    });

    test.each([
      'openai.gpt-5.6-sol',
      'us.openai.gpt-5.6-luna',
    ])('openai family (region prefix allowed): %s', (modelId) => {
      expect(supportsExtendedThinking(modelId)).toBe('openai');
    });

    test.each([
      'openai.gpt-oss-120b',
      'amazon.nova-pro-v1:0',
      'moonshot.kimi-k3',
    ])('not in the allowlist: %s', (modelId) => {
      expect(supportsExtendedThinking(modelId)).toBe(null);
    });

    test('returns null for falsy/missing modelId', () => {
      expect(supportsExtendedThinking(undefined)).toBe(null);
      expect(supportsExtendedThinking('')).toBe(null);
    });
  });

  describe('isAnthropicModel', () => {
    test.each([
      'us.anthropic.claude-sonnet-4-6',
      'global.anthropic.claude-opus-5',
      'anthropic.claude-haiku-4-5',
    ])('true for Anthropic IDs: %s', (modelId) => {
      expect(isAnthropicModel(modelId)).toBe(true);
    });

    test.each([
      'openai.gpt-6-sol',
      'amazon.nova-pro-v1:0',
      '',
      undefined,
    ])('false otherwise: %s', (modelId) => {
      expect(isAnthropicModel(modelId)).toBe(false);
    });
  });

  describe('createAgent({ enableThinking }) via additionalRequestFields', () => {
    test('attaches the Anthropic thinking block for an allowlisted Claude model', () => {
      const args = bedrockModelArgsFor(createAgent, {
        modelId: 'us.anthropic.claude-sonnet-4-6',
        enableThinking: true,
      });
      expect(args.additionalRequestFields).toEqual({
        thinking: { type: 'enabled', budget_tokens: 4096 },
      });
    });

    test('attaches reasoning effort for an allowlisted GPT-5-class model', () => {
      const args = bedrockModelArgsFor(createAgent, {
        modelId: 'openai.gpt-5.6-sol',
        enableThinking: true,
      });
      expect(args.additionalRequestFields).toEqual({ reasoning: { effort: 'medium' } });
    });

    test('does NOT attach thinking fields when enableThinking is false', () => {
      const args = bedrockModelArgsFor(createAgent, {
        modelId: 'us.anthropic.claude-sonnet-4-6',
        enableThinking: false,
      });
      expect(args.additionalRequestFields).toBeUndefined();
    });

    test('silently ignores enableThinking for a model not in the allowlist (no fields attached, no error)', () => {
      const args = bedrockModelArgsFor(createAgent, {
        modelId: 'moonshot.kimi-k3',
        enableThinking: true,
      });
      expect(args.additionalRequestFields).toBeUndefined();
    });
  });

  describe('createAgent({ contextManager })', () => {
    // SDK context management ('auto' = SummarizingConversationManager with
    // proactive compression + ContextOffloader) is endpoint-agnostic and
    // survives the Mantle -> Bedrock switch unchanged.
    function agentArgsFor(overrides) {
      const sdkMock = require('@strands-agents/sdk');
      sdkMock.Agent.mockClear();
      createAgent(baseArgs(overrides));
      return sdkMock.Agent.mock.calls[0][0];
    }

    test("defaults to 'auto' when not specified", () => {
      expect(agentArgsFor({}).contextManager).toBe('auto');
    });

    test('passing false omits the field entirely (SDK enum rejects false — opt-out is absence)', () => {
      const args = agentArgsFor({ contextManager: false });
      expect('contextManager' in args).toBe(false);
    });

    test('an explicit strategy string is passed through verbatim', () => {
      expect(agentArgsFor({ contextManager: 'agentic' }).contextManager).toBe('agentic');
    });
  });
});
