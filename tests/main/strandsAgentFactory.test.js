/**
 * Tests for strandsAgentFactory.js's retry classification.
 *
 * DefaultModelRetryStrategy (from the Strands SDK) only treats
 * ModelThrottledError as retryable out of the box. Bedrock also returns
 * several genuinely transient server-side error shapes on model calls —
 * InternalServerException, ServiceUnavailableException, ModelErrorException,
 * ModelTimeoutException, ModelStreamErrorException, ModelNotReadyException —
 * none of which were being retried, causing turns to fail outright on a
 * single transient blip. HiveModelRetryStrategy extends the base strategy to
 * also retry these, matched by error.name (stable across SDK versions).
 */

// Minimal stand-in matching the real DefaultModelRetryStrategy's observable
// shape (constructor stores opts, isRetryable() checks instanceof a marker
// "throttled" class) closely enough to verify the subclass's override logic
// without depending on the real SDK. Defined inside the mock factory (jest
// hoists jest.mock() calls above other statements, so factories can't close
// over module-scope variables — only over other `mock`-prefixed bindings).
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
    BedrockModel: jest.fn(),
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

describe('strandsAgentFactory', () => {
  let createAgent, isRetryableToolError, HiveModelRetryStrategy, MockModelThrottledError;

  beforeEach(() => {
    jest.resetModules();
    // Re-require after resetModules so the module-level class picks up fresh mocks.
    const mod = require('../../src/main/models/strandsAgentFactory');
    createAgent = mod.createAgent;
    isRetryableToolError = mod.isRetryableToolError;

    // HiveModelRetryStrategy itself isn't exported — exercise it indirectly
    // via createAgent(), which constructs one and passes it to Agent(). We
    // capture the instance via the mocked Agent constructor's call args.
    const sdkMock = require('@strands-agents/sdk');
    MockModelThrottledError = sdkMock.MockModelThrottledError;
    createAgent({
      modelId: 'test-model',
      region: 'us-east-1',
      credentials: {},
      systemPrompt: 'test',
      tools: [],
      id: 'test-agent',
    });
    const agentCallArgs = sdkMock.Agent.mock.calls[0][0];
    HiveModelRetryStrategy = agentCallArgs.retryStrategy;
  });

  describe('HiveModelRetryStrategy.isRetryable', () => {
    test('retries the base strategy\'s own retryable errors (throttling)', () => {
      expect(HiveModelRetryStrategy.isRetryable(new MockModelThrottledError('throttled'))).toBe(true);
    });

    test.each([
      'InternalServerException',
      'ServiceUnavailableException',
      'ModelErrorException',
      'ModelTimeoutException',
      'ModelStreamErrorException',
      'ModelNotReadyException',
    ])('retries transient Bedrock error: %s', (name) => {
      const err = new Error('The system encountered an unexpected error during processing. Try your request again.');
      err.name = name;
      expect(HiveModelRetryStrategy.isRetryable(err)).toBe(true);
    });

    test('does not retry non-transient errors (e.g. invalid model id)', () => {
      const err = new Error('The provided model identifier is invalid.');
      err.name = 'ValidationException';
      expect(HiveModelRetryStrategy.isRetryable(err)).toBe(false);
    });

    test('does not retry a plain Error with no matching name', () => {
      expect(HiveModelRetryStrategy.isRetryable(new Error('some other failure'))).toBe(false);
    });

    test('handles undefined/null error gracefully', () => {
      expect(HiveModelRetryStrategy.isRetryable(undefined)).toBe(false);
      expect(HiveModelRetryStrategy.isRetryable(null)).toBe(false);
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
});
