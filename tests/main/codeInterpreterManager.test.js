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

describe('cancellation (abort signal threading)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  test('executeCode passes the signal to client.send() as abortSignal', async () => {
    mockSend.mockResolvedValue({ stream: emptyStream() });
    const manager = new CodeInterpreterManager({});
    manager.sessionId = 'sess-1';

    const controller = new AbortController();
    await manager.executeCode('print(1)', { signal: controller.signal });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ __type: 'Invoke' }),
      { abortSignal: controller.signal },
    );
  });

  test('writeFiles passes the signal to client.send() as abortSignal', async () => {
    mockSend.mockResolvedValue({ stream: emptyStream() });
    const manager = new CodeInterpreterManager({});
    manager.sessionId = 'sess-1';

    const controller = new AbortController();
    await manager.writeFiles([{ path: '/tmp/a.txt', text: 'hi' }], { signal: controller.signal });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ __type: 'Invoke' }),
      { abortSignal: controller.signal },
    );
  });

  test('startSession passes the signal through to the start command and bootstrap executeCode', async () => {
    mockSend.mockImplementation((command) => {
      if (command.__type === 'Start') return Promise.resolve({ sessionId: 'sess-abc' });
      return Promise.resolve({ stream: emptyStream() });
    });
    const manager = new CodeInterpreterManager({});

    const controller = new AbortController();
    await manager.startSession(900, { signal: controller.signal });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ __type: 'Start' }),
      { abortSignal: controller.signal },
    );
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ __type: 'Invoke' }),
      { abortSignal: controller.signal },
    );
  });

  test('executeCode without a signal still calls send with abortSignal: undefined (backward compatible)', async () => {
    mockSend.mockResolvedValue({ stream: emptyStream() });
    const manager = new CodeInterpreterManager({});
    manager.sessionId = 'sess-1';

    await manager.executeCode('print(1)');

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ __type: 'Invoke' }),
      { abortSignal: undefined },
    );
  });

  test('withRetry never retries after the signal has aborted, even for a retryable error', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = new Error('boom');
    err.name = 'ThrottlingException'; // normally retryable
    const fn = jest.fn(async () => { throw err; });

    await expect(withRetry(fn, { signal: controller.signal })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('withRetry still retries retryable errors when the signal is not aborted', async () => {
    const controller = new AbortController();
    const err = new Error('boom');
    err.name = 'ThrottlingException';
    const fn = jest.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');

    const result = await withRetry(fn, { signal: controller.signal, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('session-expiry recovery ("ValidationException: ... is not active")', () => {
  const { isSessionExpiredError } = CodeInterpreterManager;

  function sessionExpiredError(sid = 'sess-old') {
    const err = new Error(`Code interpreter session ${sid} is not active`);
    err.name = 'ValidationException';
    return err;
  }

  /** A stream yielding the given content items, matching _collectStreamResults' shape. */
  function streamWith(items) {
    return {
      async *[Symbol.asyncIterator]() {
        yield { result: { content: items } };
      },
    };
  }

  beforeEach(() => {
    mockSend.mockReset();
  });

  describe('isSessionExpiredError', () => {
    test('matches the exact production error shape', () => {
      expect(isSessionExpiredError(sessionExpiredError('01M0AEVN6ENN7RJ2EPQ65VKE9Z'))).toBe(true);
    });

    test('does not match a ValidationException with an unrelated message', () => {
      const err = new Error('Invalid arguments: language must be python');
      err.name = 'ValidationException';
      expect(isSessionExpiredError(err)).toBe(false);
    });

    test('does not match other error types with a similar message, or null', () => {
      const err = new Error('session x is not active');
      err.name = 'ResourceNotFoundException';
      expect(isSessionExpiredError(err)).toBe(false);
      expect(isSessionExpiredError(null)).toBe(false);
    });
  });

  test('executeCode transparently recreates the session and retries once on an expired session', async () => {
    let invokeCount = 0;
    mockSend.mockImplementation((command) => {
      if (command.__type === 'Start') return Promise.resolve({ sessionId: 'sess-new' });
      invokeCount += 1;
      // 1st Invoke = the failing call against the dead session.
      if (invokeCount === 1) return Promise.reject(sessionExpiredError('sess-old'));
      // Later Invokes = the pip-install bootstrap in _doStartSession + the retried call.
      return Promise.resolve({ stream: streamWith([{ type: 'text', text: 'ok' }]) });
    });

    const manager = new CodeInterpreterManager({});
    manager.sessionId = 'sess-old';

    const result = await manager.executeCode('print(1)');

    expect(result.success).toBe(true);
    expect(result.text).toBe('ok');
    expect(result.sessionRecreated).toBe(true);
    expect(manager.sessionId).toBe('sess-new');
    expect(mockSend.mock.calls.filter(([c]) => c.__type === 'Start')).toHaveLength(1);
  });

  test('the retried command is sent with the NEW session ID, not the stale one', async () => {
    const invokeSessionIds = [];
    mockSend.mockImplementation((command) => {
      if (command.__type === 'Start') return Promise.resolve({ sessionId: 'sess-new' });
      invokeSessionIds.push(command.input.sessionId);
      if (invokeSessionIds.length === 1) return Promise.reject(sessionExpiredError());
      return Promise.resolve({ stream: emptyStream() });
    });

    const manager = new CodeInterpreterManager({});
    manager.sessionId = 'sess-old';
    await manager.executeCode('print(1)');

    expect(invokeSessionIds[0]).toBe('sess-old');
    // Every Invoke after recovery (bootstrap + retry) targets the new session.
    expect(invokeSessionIds.slice(1).every(sid => sid === 'sess-new')).toBe(true);
  });

  test('writeFiles also recovers from an expired session', async () => {
    let failed = false;
    mockSend.mockImplementation((command) => {
      if (command.__type === 'Start') return Promise.resolve({ sessionId: 'sess-new' });
      if (command.input?.arguments?.content && !failed) {
        failed = true;
        return Promise.reject(sessionExpiredError());
      }
      return Promise.resolve({ stream: emptyStream() });
    });

    const manager = new CodeInterpreterManager({});
    manager.sessionId = 'sess-old';

    const result = await manager.writeFiles([{ path: 'a.txt', text: 'hi' }]);

    expect(result.sessionRecreated).toBe(true);
    expect(manager.sessionId).toBe('sess-new');
  });

  test('recovery is attempted exactly once — a second expiry failure propagates', async () => {
    mockSend.mockImplementation((command) => {
      if (command.__type === 'Start') return Promise.resolve({ sessionId: 'sess-new' });
      // Let the bootstrap pip-install succeed so session recreation completes,
      // but fail the actual target code both before AND after recovery.
      if (command.input?.arguments?.code?.includes('pip')) {
        return Promise.resolve({ stream: emptyStream() });
      }
      return Promise.reject(sessionExpiredError());
    });

    const manager = new CodeInterpreterManager({});
    manager.sessionId = 'sess-old';

    await expect(manager.executeCode('print(1)')).rejects.toThrow(/is not active/);
    expect(mockSend.mock.calls.filter(([c]) => c.__type === 'Start')).toHaveLength(1);
  });

  test('an unrelated ValidationException does NOT trigger recovery', async () => {
    const err = new Error('Invalid arguments: language must be python');
    err.name = 'ValidationException';
    mockSend.mockRejectedValue(err);

    const manager = new CodeInterpreterManager({});
    manager.sessionId = 'sess-1';

    await expect(manager.executeCode('print(1)')).rejects.toThrow('Invalid arguments');
    expect(mockSend.mock.calls.filter(([c]) => c.__type === 'Start')).toHaveLength(0);
  });

  test('recovery is skipped when the user has already aborted', async () => {
    mockSend.mockRejectedValue(sessionExpiredError());

    const manager = new CodeInterpreterManager({});
    manager.sessionId = 'sess-old';
    const controller = new AbortController();
    controller.abort();

    await expect(manager.executeCode('print(1)', { signal: controller.signal })).rejects.toThrow(/is not active/);
    expect(mockSend.mock.calls.filter(([c]) => c.__type === 'Start')).toHaveLength(0);
  });

  test('a recreated session reuses the timeout the original session was started with', async () => {
    const startTimeouts = [];
    let invokeFailed = false;
    mockSend.mockImplementation((command) => {
      if (command.__type === 'Start') {
        startTimeouts.push(command.input.sessionTimeoutSeconds);
        return Promise.resolve({ sessionId: `sess-${startTimeouts.length}` });
      }
      if (command.input?.arguments?.code?.includes('pip')) {
        return Promise.resolve({ stream: emptyStream() });
      }
      if (!invokeFailed) {
        invokeFailed = true;
        return Promise.reject(sessionExpiredError());
      }
      return Promise.resolve({ stream: emptyStream() });
    });

    const manager = new CodeInterpreterManager({});
    await manager.startSession(7200);
    await manager.executeCode('print(1)');

    expect(startTimeouts).toEqual([7200, 7200]);
  });

  test('proactive recovery: a session provably past its own lifetime is recreated before invoking', async () => {
    const invokedSessionIds = [];
    mockSend.mockImplementation((command) => {
      if (command.__type === 'Start') return Promise.resolve({ sessionId: 'sess-new' });
      invokedSessionIds.push(command.input.sessionId);
      return Promise.resolve({ stream: emptyStream() });
    });

    const manager = new CodeInterpreterManager({});
    manager.sessionId = 'sess-old';
    manager._sessionTimeoutSeconds = 300;
    manager._sessionStartedAt = Date.now() - 300 * 1000; // past lifetime

    const result = await manager.executeCode('print(1)');

    expect(result.sessionRecreated).toBe(true);
    // The dead session must never be invoked at all — no doomed round trip.
    expect(invokedSessionIds).not.toContain('sess-old');
    expect(manager.sessionId).toBe('sess-new');
  });

  test('a fresh session is NOT proactively recreated', async () => {
    mockSend.mockResolvedValue({ stream: emptyStream() });

    const manager = new CodeInterpreterManager({});
    manager.sessionId = 'sess-1';
    manager._sessionTimeoutSeconds = 7200;
    manager._sessionStartedAt = Date.now() - 60 * 1000; // 1 minute old

    const result = await manager.executeCode('print(1)');

    expect(result.sessionRecreated).toBeUndefined();
    expect(mockSend.mock.calls.filter(([c]) => c.__type === 'Start')).toHaveLength(0);
  });

  test('readFileBase64 throws on a failed read instead of returning empty text (would write a 0-byte file)', async () => {
    mockSend.mockResolvedValue({
      stream: streamWith([{ type: 'error', text: "FileNotFoundError: No such file or directory: '/tmp/out.docx'" }]),
    });

    const manager = new CodeInterpreterManager({});
    manager.sessionId = 'sess-1';

    await expect(manager.readFileBase64('/tmp/out.docx')).rejects.toThrow(/FileNotFoundError/);
  });

  test('stopSession clears session lifetime bookkeeping', async () => {
    mockSend.mockResolvedValue({});
    const manager = new CodeInterpreterManager({});
    manager.sessionId = 'sess-1';
    manager._sessionTimeoutSeconds = 7200;
    manager._sessionStartedAt = Date.now();

    await manager.stopSession();

    expect(manager.sessionId).toBeNull();
    expect(manager._sessionTimeoutSeconds).toBeNull();
    expect(manager._sessionStartedAt).toBeNull();
  });
});
