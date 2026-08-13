/**
 * Tests for CodeInterpreterManager, specifically:
 *
 * 1. The startSession() in-flight-promise lock — regression test for a real
 *    bug where concurrent tool calls (the Strands SDK's default
 *    ConcurrentToolExecutor firing several read_local_file calls in one
 *    turn, e.g. when processing multiple files from a workspace directory)
 *    could each see `sessionId` as null at the same time and each issue
 *    their own StartCodeInterpreterSessionCommand — observed in production
 *    logs as a burst of several near-simultaneous "Session started" log
 *    lines for what should be a single session.
 *
 * 2. withRetry()/isRetryableError() — retrying transient AgentCore
 *    failures, including the exact malformed-response symptom (a
 *    SyntaxError from JSON.parse choking on a raw HTTP status line instead
 *    of a JSON body) that concurrent session-start races were observed to
 *    trigger under load.
 */

jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  StartCodeInterpreterSessionCommand: jest.fn().mockImplementation((input) => ({ input, __type: 'Start' })),
  InvokeCodeInterpreterCommand: jest.fn().mockImplementation((input) => ({ input, __type: 'Invoke' })),
  StopCodeInterpreterSessionCommand: jest.fn().mockImplementation((input) => ({ input, __type: 'Stop' })),
}));

const CodeInterpreterManager = require('../../src/main/models/codeInterpreterManager');
const { isRetryableError, withRetry } = CodeInterpreterManager;

/** An empty async-iterable stream, matching the shape _collectStreamResults expects. */
function emptyStream() {
  return { async *[Symbol.asyncIterator]() {} };
}

describe('CodeInterpreterManager.startSession — concurrency lock', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  test('concurrent startSession() calls result in exactly one StartCodeInterpreterSessionCommand', async () => {
    let startCallCount = 0;
    mockSend.mockImplementation((command) => {
      if (command.__type === 'Start') {
        startCallCount += 1;
        return Promise.resolve({ sessionId: 'session-abc' });
      }
      // The pip-install executeCode call fired inside _doStartSession.
      if (command.__type === 'Invoke') {
        return Promise.resolve({ stream: emptyStream() });
      }
      return Promise.resolve({});
    });

    const manager = new CodeInterpreterManager({});

    // Simulate 5 concurrent tool calls (e.g. 5 read_local_file calls from
    // one directory attachment) all racing to start the session.
    const results = await Promise.all([
      manager.startSession(),
      manager.startSession(),
      manager.startSession(),
      manager.startSession(),
      manager.startSession(),
    ]);

    expect(startCallCount).toBe(1);
    expect(results).toEqual(['session-abc', 'session-abc', 'session-abc', 'session-abc', 'session-abc']);
    expect(manager.sessionId).toBe('session-abc');
    expect(manager._startPromise).toBeNull();
  });

  test('startSession() is a no-op if a session is already active', async () => {
    mockSend.mockResolvedValue({});
    const manager = new CodeInterpreterManager({});
    manager.sessionId = 'already-started';

    const result = await manager.startSession();

    expect(result).toBe('already-started');
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a failed session start clears _startPromise so a later call can retry', async () => {
    mockSend.mockImplementation((command) => {
      if (command.__type === 'Start') return Promise.reject(new Error('boom'));
      return Promise.resolve({});
    });

    const manager = new CodeInterpreterManager({});
    await expect(manager.startSession()).rejects.toThrow('boom');
    expect(manager._startPromise).toBeNull();
    expect(manager.sessionId).toBeNull();
  });

  test('sequential (non-concurrent) startSession() calls after success both return the cached sessionId without re-invoking AWS', async () => {
    mockSend.mockImplementation((command) => {
      if (command.__type === 'Start') return Promise.resolve({ sessionId: 'session-xyz' });
      if (command.__type === 'Invoke') return Promise.resolve({ stream: emptyStream() });
      return Promise.resolve({});
    });

    const manager = new CodeInterpreterManager({});
    const first = await manager.startSession();
    const startCallsAfterFirst = mockSend.mock.calls.filter(([cmd]) => cmd.__type === 'Start').length;
    const second = await manager.startSession();
    const startCallsAfterSecond = mockSend.mock.calls.filter(([cmd]) => cmd.__type === 'Start').length;

    expect(first).toBe('session-xyz');
    expect(second).toBe('session-xyz');
    expect(startCallsAfterFirst).toBe(1);
    expect(startCallsAfterSecond).toBe(1);
  });
});

describe('CodeInterpreterManager — executeCode/writeFiles/stopSession require an active session', () => {
  test('executeCode throws if no session is active', async () => {
    const manager = new CodeInterpreterManager({});
    await expect(manager.executeCode('print(1)')).rejects.toThrow('No active Code Interpreter session');
  });

  test('writeFiles throws if no session is active', async () => {
    const manager = new CodeInterpreterManager({});
    await expect(manager.writeFiles([{ path: 'a.txt', blob: Buffer.from('x') }])).rejects.toThrow('No active Code Interpreter session');
  });

  test('stopSession is a no-op if no session is active', async () => {
    mockSend.mockReset();
    const manager = new CodeInterpreterManager({});
    await manager.stopSession();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('isRetryableError', () => {
  test('returns true for known AWS throttling/server error names', () => {
    expect(isRetryableError({ name: 'ThrottlingException' })).toBe(true);
    expect(isRetryableError({ name: 'ServiceUnavailableException' })).toBe(true);
    expect(isRetryableError({ name: 'InternalServerException' })).toBe(true);
    expect(isRetryableError({ name: 'TimeoutError' })).toBe(true);
  });

  test('returns true for 5xx HTTP status metadata', () => {
    expect(isRetryableError({ $metadata: { httpStatusCode: 503 } })).toBe(true);
    expect(isRetryableError({ $metadata: { httpStatusCode: 500 } })).toBe(true);
  });

  test('returns false for 4xx HTTP status metadata', () => {
    expect(isRetryableError({ $metadata: { httpStatusCode: 403 } })).toBe(false);
    expect(isRetryableError({ $metadata: { httpStatusCode: 400 } })).toBe(false);
  });

  test('returns true for the exact malformed-response SyntaxError symptom (JSON.parse on raw HTTP text)', () => {
    const err = new SyntaxError('Unexpected token \'H\', "HTTP conte"... is not valid JSON');
    expect(isRetryableError(err)).toBe(true);
  });

  test('returns false for an unrelated SyntaxError', () => {
    const err = new SyntaxError('some other parsing problem');
    expect(isRetryableError(err)).toBe(false);
  });

  test('returns true for connection-level error codes', () => {
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
  });

  test('returns false for an unrecognized error and for null/undefined', () => {
    expect(isRetryableError(new Error('validation failed'))).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe('withRetry', () => {
  test('returns the result immediately on first success without retrying', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on a retryable error and eventually succeeds', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce({ name: 'ThrottlingException' })
      .mockRejectedValueOnce({ name: 'ThrottlingException' })
      .mockResolvedValueOnce('ok-after-retries');

    const result = await withRetry(fn, { retries: 3, baseDelayMs: 1 });
    expect(result).toBe('ok-after-retries');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('throws immediately on a non-retryable error without retrying', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('permission denied'));
    await expect(withRetry(fn, { retries: 3, baseDelayMs: 1 })).rejects.toThrow('permission denied');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('gives up and throws the last error after exhausting retries', async () => {
    const fn = jest.fn().mockRejectedValue({ name: 'ThrottlingException', message: 'still throttled' });
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toEqual({ name: 'ThrottlingException', message: 'still throttled' });
    expect(fn).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  test('integration: executeCode retries once on the malformed-response SyntaxError, then succeeds', async () => {
    jest.useFakeTimers();
    mockSend.mockReset();
    let invokeCallCount = 0;
    mockSend.mockImplementation((command) => {
      if (command.__type === 'Invoke') {
        invokeCallCount += 1;
        if (invokeCallCount === 1) {
          return Promise.reject(new SyntaxError('Unexpected token \'H\', "HTTP conte"... is not valid JSON'));
        }
        return Promise.resolve({ stream: emptyStream() });
      }
      return Promise.resolve({});
    });

    const manager = new CodeInterpreterManager({});
    manager.sessionId = 'existing-session';

    const resultPromise = manager.executeCode('print(1)');
    await jest.runAllTimersAsync();
    const result = await resultPromise;

    expect(invokeCallCount).toBe(2);
    expect(result.success).toBe(true);
    jest.useRealTimers();
  });
});
