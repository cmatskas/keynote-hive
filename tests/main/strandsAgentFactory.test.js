/**
 * Tests for strandsAgentFactory.js — Mantle-only model routing.
 *
 * Bedrock Converse (BedrockModel) has been removed entirely. Every model
 * call now goes through Amazon Bedrock's Mantle endpoint via one of two
 * Strands model providers, chosen purely by model identity:
 *   - AnthropicModel for any model ID containing "anthropic." (Claude)
 *   - OpenAIModel for every other model ID (GPT-5.x, gpt-oss, xAI Grok,
 *     Google Gemma, etc. — all of these speak Mantle's OpenAI-compatible
 *     wire protocol regardless of which company makes the underlying model)
 * Both branches authenticate with the same one-off, long-term mantleApiKey
 * from Settings — no bearer-token minting/refresh.
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

jest.mock('@strands-agents/sdk/models/openai', () => ({
  OpenAIModel: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@strands-agents/sdk/models/anthropic', () => ({
  AnthropicModel: jest.fn().mockImplementation(() => ({})),
}));

// Minimal stand-ins matching the real openai SDK's error classes closely
// enough to verify instanceof-based retry classification, without depending
// on the real package (which uses ESM syntax Jest can't parse directly).
jest.mock('openai', () => {
  class InternalServerError extends Error {}
  class APIConnectionError extends Error {}
  class APIConnectionTimeoutError extends APIConnectionError {}
  return { InternalServerError, APIConnectionError, APIConnectionTimeoutError };
});

// Same reasoning for @anthropic-ai/sdk, which also uses ESM syntax.
jest.mock('@anthropic-ai/sdk', () => {
  class InternalServerError extends Error {}
  class APIConnectionError extends Error {}
  class APIConnectionTimeoutError extends APIConnectionError {}
  class RateLimitError extends Error {}
  return { InternalServerError, APIConnectionError, APIConnectionTimeoutError, RateLimitError };
});

function baseArgs(overrides = {}) {
  return {
    modelId: 'us.anthropic.claude-sonnet-4-6',
    region: 'us-east-1',
    mantleApiKey: 'test-key',
    systemPrompt: 'test',
    tools: [],
    id: 'test-agent',
    ...overrides,
  };
}

describe('strandsAgentFactory', () => {
  let createAgent, isRetryableToolError, HiveModelRetryStrategy, MockModelThrottledError;

  beforeEach(() => {
    jest.resetModules();
    const mod = require('../../src/main/models/strandsAgentFactory');
    createAgent = mod.createAgent;
    isRetryableToolError = mod.isRetryableToolError;

    // HiveModelRetryStrategy itself isn't exported — exercise it indirectly
    // via createAgent(), which constructs one and passes it to Agent(). We
    // capture the instance via the mocked Agent constructor's call args.
    const sdkMock = require('@strands-agents/sdk');
    MockModelThrottledError = sdkMock.MockModelThrottledError;
    createAgent(baseArgs());
    const agentCallArgs = sdkMock.Agent.mock.calls[0][0];
    HiveModelRetryStrategy = agentCallArgs.retryStrategy;
  });

  describe('HiveModelRetryStrategy.isRetryable', () => {
    test('retries the base strategy\'s own retryable errors (throttling)', () => {
      expect(HiveModelRetryStrategy.isRetryable(new MockModelThrottledError('throttled'))).toBe(true);
    });

    test('does not retry a plain Error with no matching class', () => {
      expect(HiveModelRetryStrategy.isRetryable(new Error('some other failure'))).toBe(false);
    });

    test('handles undefined/null error gracefully', () => {
      expect(HiveModelRetryStrategy.isRetryable(undefined)).toBe(false);
      expect(HiveModelRetryStrategy.isRetryable(null)).toBe(false);
    });

    test.each([
      ['InternalServerError', () => new (require('openai').InternalServerError)('server error')],
      ['APIConnectionError', () => new (require('openai').APIConnectionError)('connection failed')],
      ['APIConnectionTimeoutError', () => new (require('openai').APIConnectionTimeoutError)('timed out')],
    ])('retries transient OpenAI SDK error via instanceof: %s', (_name, buildErr) => {
      expect(HiveModelRetryStrategy.isRetryable(buildErr())).toBe(true);
    });

    test.each([
      ['InternalServerError', () => new (require('@anthropic-ai/sdk').InternalServerError)('server error')],
      ['APIConnectionError', () => new (require('@anthropic-ai/sdk').APIConnectionError)('connection failed')],
      ['APIConnectionTimeoutError', () => new (require('@anthropic-ai/sdk').APIConnectionTimeoutError)('timed out')],
    ])('retries transient Anthropic SDK error via instanceof: %s', (_name, buildErr) => {
      expect(HiveModelRetryStrategy.isRetryable(buildErr())).toBe(true);
    });

    test('does not retry Anthropic RateLimitError directly (already normalized to ModelThrottledError upstream)', () => {
      // Confirmed via the installed Strands SDK's anthropic.js source: HTTP
      // 429 responses are converted to ModelThrottledError before Hive's
      // retry strategy ever sees them, so RateLimitError itself is
      // deliberately NOT in RETRYABLE_ANTHROPIC_ERROR_CLASSES.
      const err = new (require('@anthropic-ai/sdk').RateLimitError)('rate limited');
      expect(HiveModelRetryStrategy.isRetryable(err)).toBe(false);
    });

    test('does not retry a plain Error even though provider error classes are also Error subclasses', () => {
      expect(HiveModelRetryStrategy.isRetryable(new Error('unrelated failure'))).toBe(false);
    });
  });

  describe('isRetryableToolError (unchanged tool-level retry logic)', () => {
    test('retries on throttling and timeout patterns', () => {
      expect(isRetryableToolError({ name: 'Error', message: 'Request throttled' })).toBe(true);
      expect(isRetryableToolError({ name: 'TimeoutError', message: 'timed out' })).toBe(true);
    });

    test('does not retry unrelated errors', () => {
      expect(isRetryableToolError({ name: 'Error', message: 'invalid input' })).toBe(false);
    });
  });

  describe('region validation', () => {
    test('throws for a malformed region rather than constructing a request', () => {
      const { AnthropicModel } = require('@strands-agents/sdk/models/anthropic');
      AnthropicModel.mockClear();
      expect(() => createAgent(baseArgs({ region: 'not-a-region!' }))).toThrow(/[Ii]nvalid.*region/);
      expect(AnthropicModel).not.toHaveBeenCalled();
    });

    test('throws for a region containing URL control characters (security guard)', () => {
      expect(() => createAgent(baseArgs({ region: 'us-east-1@evil.com' }))).toThrow();
    });

    test('accepts a well-formed region', () => {
      expect(() => createAgent(baseArgs({ region: 'ap-southeast-2' }))).not.toThrow();
    });
  });

  describe('model family routing (Anthropic vs OpenAI-compatible)', () => {
    test.each([
      'us.anthropic.claude-sonnet-4-6',
      'global.anthropic.claude-opus-4-6-v1',
      'anthropic.claude-haiku-4-5-20251001-v1:0',
    ])('routes Anthropic model IDs through AnthropicModel: %s', (modelId) => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      const { AnthropicModel } = require('@strands-agents/sdk/models/anthropic');
      const { OpenAIModel } = require('@strands-agents/sdk/models/openai');

      mod.createAgent(baseArgs({ modelId, id: 'claude-agent' }));

      expect(AnthropicModel).toHaveBeenCalledTimes(1);
      expect(AnthropicModel.mock.calls[0][0].modelId).toBe(modelId);
      expect(OpenAIModel).not.toHaveBeenCalled();
    });

    test.each([
      'openai.gpt-5.6-sol',
      'openai.gpt-oss-120b',
      'xai.grok-4.3',
      'google.gemma-3-27b',
      'deepseek.v3.2',
    ])('routes every non-Anthropic model ID through OpenAIModel: %s', (modelId) => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      const { AnthropicModel } = require('@strands-agents/sdk/models/anthropic');
      const { OpenAIModel } = require('@strands-agents/sdk/models/openai');

      mod.createAgent(baseArgs({ modelId, id: 'other-agent' }));

      expect(OpenAIModel).toHaveBeenCalledTimes(1);
      expect(OpenAIModel.mock.calls[0][0].modelId).toBe(modelId);
      expect(AnthropicModel).not.toHaveBeenCalled();
    });

    test('both branches authenticate with the same mantleApiKey, no credentials/token-minting object', () => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      const { AnthropicModel } = require('@strands-agents/sdk/models/anthropic');

      mod.createAgent(baseArgs({ mantleApiKey: 'super-secret-key' }));

      expect(AnthropicModel.mock.calls[0][0].apiKey).toBe('super-secret-key');
      expect(AnthropicModel.mock.calls[0][0].bedrockMantleConfig).toBeUndefined();
    });
  });

  describe('Mantle base URL / path construction', () => {
    // Table verified against the real Mantle endpoint and against
    // @strands-agents/sdk 1.12.0's own internal routing fix
    // (github.com/strands-agents/harness-sdk#3691) — prefixes are scoped to
    // a specific model LINE, not a vendor, since a vendor can straddle both
    // base paths (google.gemma-4-* is on /openai/v1, google.gemma-3-* is on
    // /v1 — a vendor-wide `google.` match would mis-route the latter).
    test.each(['openai.gpt-5.6-sol', 'google.gemma-4-31b', 'xai.grok-4.3'])('models on verified /openai/v1 lines use that base path: %s', (modelId) => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      const { OpenAIModel } = require('@strands-agents/sdk/models/openai');

      mod.createAgent(baseArgs({ modelId, region: 'us-east-1' }));

      expect(OpenAIModel.mock.calls[0][0].clientConfig.baseURL).toBe('https://bedrock-mantle.us-east-1.api.aws/openai/v1');
    });

    test.each(['openai.gpt-oss-120b', 'google.gemma-3-27b-it'])('other OpenAI-compatible models use the /v1 base path: %s', (modelId) => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      const { OpenAIModel } = require('@strands-agents/sdk/models/openai');

      mod.createAgent(baseArgs({ modelId, region: 'us-east-1' }));

      expect(OpenAIModel.mock.calls[0][0].clientConfig.baseURL).toBe('https://bedrock-mantle.us-east-1.api.aws/v1');
    });

    test('Anthropic models use the /anthropic base path (confirmed via live testing against Mantle — bare host alone now 404s, Mantle added a provider-prefix requirement for Anthropic same as it already had for openai.gpt-5.*/google.*)', () => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      const { AnthropicModel } = require('@strands-agents/sdk/models/anthropic');

      mod.createAgent(baseArgs({ modelId: 'us.anthropic.claude-sonnet-4-6', region: 'eu-west-1' }));

      expect(AnthropicModel.mock.calls[0][0].clientConfig.baseURL).toBe('https://bedrock-mantle.eu-west-1.api.aws/anthropic');
    });
  });

  describe('maxTokens (output token ceiling)', () => {
    test('defaults to 120000 when not specified by the caller', () => {
      const { AnthropicModel } = require('@strands-agents/sdk/models/anthropic');
      const modelCallArgs = AnthropicModel.mock.calls[0][0];
      expect(modelCallArgs.maxTokens).toBe(120000);
    });

    test('caller can override the default', () => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      const { AnthropicModel } = require('@strands-agents/sdk/models/anthropic');
      mod.createAgent(baseArgs({ id: 'test-agent-2', maxTokens: 50000 }));
      const modelCallArgs = AnthropicModel.mock.calls[0][0];
      expect(modelCallArgs.maxTokens).toBe(50000);
    });
  });

  describe('supportsExtendedThinking (allowlist)', () => {
    test.each([
      'us.anthropic.claude-sonnet-4-6',
      'global.anthropic.claude-opus-4-6-v1',
      'anthropic.claude-3-7-sonnet-20250219-v1:0',
    ])('returns "anthropic" for Claude 3.7+/opus-4/sonnet-4 model IDs: %s', (modelId) => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      expect(mod.supportsExtendedThinking(modelId)).toBe('anthropic');
    });

    test.each([
      'openai.gpt-5.6-sol',
      'openai.gpt-5.4',
    ])('returns "openai" for GPT-5-class Mantle model IDs: %s', (modelId) => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      expect(mod.supportsExtendedThinking(modelId)).toBe('openai');
    });

    test.each([
      'deepseek.v3.2',
      'mistral.mistral-large-3-675b-instruct',
      'anthropic.claude-3-5-sonnet-20241022-v2:0', // pre-3.7, not in allowlist
      'openai.gpt-4o', // non-reasoning OpenAI model
    ])('returns null for models not in the allowlist: %s', (modelId) => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      expect(mod.supportsExtendedThinking(modelId)).toBeNull();
    });

    test('returns null for falsy/missing modelId', () => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      expect(mod.supportsExtendedThinking(undefined)).toBeNull();
      expect(mod.supportsExtendedThinking('')).toBeNull();
    });
  });

  describe('isAnthropicModel', () => {
    test.each([
      'us.anthropic.claude-sonnet-4-6',
      'global.anthropic.claude-opus-4-6-v1',
    ])('returns true for Anthropic model IDs: %s', (modelId) => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      expect(mod.isAnthropicModel(modelId)).toBe(true);
    });

    test.each([
      'openai.gpt-5.6-sol',
      'xai.grok-4.3',
      'deepseek.v3.2',
      '',
      undefined,
    ])('returns false for non-Anthropic model IDs: %s', (modelId) => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      expect(mod.isAnthropicModel(modelId)).toBe(false);
    });
  });

  describe('createAgent({ enableThinking })', () => {
    test('attaches params.thinking to AnthropicModel for an allowlisted Anthropic model', () => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      const { AnthropicModel } = require('@strands-agents/sdk/models/anthropic');

      mod.createAgent(baseArgs({ id: 'thinking-agent', enableThinking: true }));

      const modelCallArgs = AnthropicModel.mock.calls[0][0];
      expect(modelCallArgs.params).toEqual({
        thinking: { type: 'enabled', budget_tokens: 4096 },
      });
    });

    test('does NOT attach thinking fields when enableThinking is false', () => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      const { AnthropicModel } = require('@strands-agents/sdk/models/anthropic');

      mod.createAgent(baseArgs({ id: 'no-thinking-agent', enableThinking: false }));

      const modelCallArgs = AnthropicModel.mock.calls[0][0];
      expect(modelCallArgs.params).toBeUndefined();
    });

    test('silently ignores enableThinking for a model not in the allowlist (no fields attached, no error)', () => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      const { OpenAIModel } = require('@strands-agents/sdk/models/openai');

      expect(() => mod.createAgent(baseArgs({
        modelId: 'deepseek.v3.2',
        id: 'unsupported-thinking-agent',
        enableThinking: true,
      }))).not.toThrow();

      const modelCallArgs = OpenAIModel.mock.calls[0][0];
      expect(modelCallArgs.params).toBeUndefined();
    });

    test('attaches params.reasoning.effort to OpenAIModel for an allowlisted GPT-5 Mantle model', () => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      const { OpenAIModel } = require('@strands-agents/sdk/models/openai');

      mod.createAgent(baseArgs({
        modelId: 'openai.gpt-5.6-sol',
        id: 'thinking-openai-agent',
        enableThinking: true,
      }));

      const openAiCallArgs = OpenAIModel.mock.calls[0][0];
      expect(openAiCallArgs.params).toEqual({ reasoning: { effort: 'medium' } });
    });

    test('does NOT attach reasoning params to OpenAIModel for a non-reasoning Mantle model', () => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      const { OpenAIModel } = require('@strands-agents/sdk/models/openai');

      mod.createAgent(baseArgs({
        modelId: 'openai.gpt-4o',
        id: 'non-reasoning-openai-agent',
        enableThinking: true,
      }));

      const openAiCallArgs = OpenAIModel.mock.calls[0][0];
      expect(openAiCallArgs.params).toBeUndefined();
    });

    test('an Anthropic model never gets OpenAI reasoning params, and vice versa (branches are family-exclusive)', () => {
      jest.resetModules();
      const mod = require('../../src/main/models/strandsAgentFactory');
      const { AnthropicModel } = require('@strands-agents/sdk/models/anthropic');
      const { OpenAIModel } = require('@strands-agents/sdk/models/openai');

      mod.createAgent(baseArgs({
        modelId: 'us.anthropic.claude-sonnet-4-6',
        id: 'family-exclusive-agent',
        enableThinking: true,
      }));

      // AnthropicModel was constructed, and OpenAIModel was never touched at all.
      expect(AnthropicModel).toHaveBeenCalledTimes(1);
      expect(OpenAIModel).not.toHaveBeenCalled();
      expect(AnthropicModel.mock.calls[0][0].params).toEqual({
        thinking: { type: 'enabled', budget_tokens: 4096 },
      });
    });
  });
});
