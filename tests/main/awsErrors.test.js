/**
 * Tests for src/main/awsErrors.js — the transport-vs-auth discriminator.
 *
 * This is the load-bearing distinction for all of Hive's offline behaviour.
 * Before it existed, `quickValidate()` reported a DNS failure as invalid
 * credentials, and three separate systems acted on that: startup routing sent
 * users to the credentials page (hiding their local conversations and work
 * history behind a network connection they didn't need), the credential
 * monitor's poll escalated it to "expired" and replaced the renderer —
 * destroying unsaved work — and the pre-send gates told users their working
 * credentials were invalid.
 *
 * The rule under test: an HTTP status code means AWS answered, so the failure
 * is not transport-level, whatever else it was.
 */

const {
  isNetworkError,
  isAuthError,
  classifyAwsError,
  describeAwsError,
  TRANSPORT_CODES,
} = require('../../src/main/awsErrors');

/** Shapes an error the way the AWS SDK does when the service responded. */
function serviceError(name, httpStatusCode, extra = {}) {
  const err = new Error(`${name} occurred`);
  err.name = name;
  err.$metadata = { httpStatusCode, attempts: 1, totalRetryDelay: 0 };
  return Object.assign(err, extra);
}

/** Shapes an error the way Node does when the request never left the machine. */
function transportError(code) {
  const err = new Error(`request failed: ${code}`);
  err.code = code;
  return err;
}

describe('isNetworkError', () => {
  test.each([...TRANSPORT_CODES])('treats %s as a network failure', (code) => {
    expect(isNetworkError(transportError(code))).toBe(true);
  });

  test('finds a transport code wrapped in a cause chain', () => {
    // The SDK routinely wraps the underlying socket error.
    const inner = transportError('ENOTFOUND');
    const middle = new Error('socket hang up');
    middle.cause = inner;
    const outer = new Error('Could not connect to the endpoint URL');
    outer.cause = middle;

    expect(isNetworkError(outer)).toBe(true);
  });

  test('treats an SDK TimeoutError as a network failure', () => {
    const err = new Error('Connection timed out');
    err.name = 'TimeoutError';
    expect(isNetworkError(err)).toBe(true);
  });

  test('does NOT treat an expired token as a network failure', () => {
    expect(isNetworkError(serviceError('ExpiredTokenException', 403))).toBe(false);
  });

  test('does NOT treat any error carrying an HTTP status as a network failure', () => {
    // An HTTP status proves DNS resolved, TCP connected and TLS completed.
    expect(isNetworkError(serviceError('ThrottlingException', 429))).toBe(false);
    expect(isNetworkError(serviceError('InternalFailure', 500))).toBe(false);
  });

  test('is false for null/undefined', () => {
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });
});

describe('isAuthError', () => {
  test.each([
    'ExpiredToken',
    'ExpiredTokenException',
    'InvalidClientTokenId',
    'InvalidAccessKeyId',
    'SignatureDoesNotMatch',
    'UnrecognizedClientException',
    'AccessDeniedException',
  ])('recognises %s', (name) => {
    expect(isAuthError(serviceError(name, 403))).toBe(true);
  });

  test('recognises a bare 401/403 with an unfamiliar name', () => {
    expect(isAuthError(serviceError('SomeNewAuthError', 403))).toBe(true);
    expect(isAuthError(serviceError('SomeNewAuthError', 401))).toBe(true);
  });

  test('recognises the __type form the SDK sometimes surfaces', () => {
    const err = new Error('rejected');
    err.$metadata = { httpStatusCode: 400 };
    err.__type = 'com.amazon.coral.service#ExpiredTokenException';
    expect(isAuthError(err)).toBe(true);
  });

  test('does NOT claim a network failure is an auth problem', () => {
    // The whole point: being unable to reach AWS says nothing about whether
    // the credentials are still good.
    expect(isAuthError(transportError('ENOTFOUND'))).toBe(false);
    expect(isAuthError(transportError('EAI_AGAIN'))).toBe(false);
  });

  test('does not treat throttling or a service error as an auth problem', () => {
    expect(isAuthError(serviceError('ThrottlingException', 429))).toBe(false);
    expect(isAuthError(serviceError('InternalFailure', 500))).toBe(false);
  });
});

describe('classifyAwsError', () => {
  test('sorts errors into network, auth and other', () => {
    expect(classifyAwsError(transportError('ENOTFOUND'))).toBe('network');
    expect(classifyAwsError(serviceError('ExpiredTokenException', 403))).toBe('auth');
    expect(classifyAwsError(serviceError('ThrottlingException', 429))).toBe('other');
    expect(classifyAwsError(serviceError('ValidationException', 400))).toBe('other');
  });
});

describe('describeAwsError', () => {
  test('describes a network failure as being offline, never as a credentials problem', () => {
    const message = describeAwsError(transportError('ENOTFOUND'));
    expect(message).toMatch(/offline/i);
    expect(message).not.toMatch(/credential/i);
  });

  test('describes an auth failure as a credentials problem and points at Settings', () => {
    const message = describeAwsError(serviceError('ExpiredTokenException', 403));
    expect(message).toMatch(/credential/i);
    expect(message).toMatch(/Settings/);
  });

  test('uses the supplied fallback for anything else', () => {
    expect(describeAwsError(serviceError('ThrottlingException', 429), 'Rate limited'))
      .toBe('Rate limited');
  });

  test('falls back to the error message when no fallback is given', () => {
    expect(describeAwsError(serviceError('ValidationException', 400)))
      .toBe('ValidationException occurred');
  });
});
