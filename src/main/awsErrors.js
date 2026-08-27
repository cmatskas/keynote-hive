/**
 * AWS error classification — "we couldn't reach AWS" vs "AWS rejected us".
 *
 * Hive used to conflate these. `AWSValidator.quickValidate()` wrapped every
 * failure into `{ valid: false, errors: ['Invalid AWS credentials: ...'] }`,
 * so a DNS failure on a sleeping laptop was indistinguishable from an expired
 * session token. Three things acted on that false signal: startup routing sent
 * the user to the credentials page (making local conversations and work history
 * unreachable), the credential monitor's 10-minute poll escalated it to
 * "expired" and navigated away — destroying the renderer and any unsaved work —
 * and the pre-send gates told the user their credentials were invalid when they
 * were fine.
 *
 * The discriminator is whether an HTTP response came back at all. The AWS SDK
 * attaches `$metadata.httpStatusCode` when it got a response to parse; a
 * genuine transport failure never reaches that point and instead surfaces an
 * OS-level errno or an SDK timeout.
 */

/**
 * Node/undici transport-level error codes. These mean the request never
 * reached AWS, so nothing can be inferred about the credentials.
 */
const TRANSPORT_CODES = new Set([
  'ENOTFOUND',      // DNS resolution failed (typical when fully offline)
  'EAI_AGAIN',      // DNS lookup timed out (flaky/captive-portal networks)
  'ECONNREFUSED',   // nothing listening (proxy down)
  'ECONNRESET',     // connection dropped mid-flight
  'ENETUNREACH',    // no route to host
  'ENETDOWN',       // interface down
  'EHOSTUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'EPROTO',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * SDK error names that indicate a transport/timeout failure rather than a
 * rejection by the service.
 */
const TRANSPORT_NAMES = new Set([
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
  'NetworkingError',
  'AbortError', // only reached when not user-initiated; callers check their own signals first
]);

/**
 * AWS error names that mean the credentials themselves are the problem —
 * expired, revoked, or wrong. These are NOT recoverable by waiting; they need
 * the user to supply new credentials.
 */
const AUTH_ERROR_NAMES = new Set([
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidClientTokenId',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'TokenRefreshRequired',
  'CredentialsProviderError',
  'AccessDenied',
  'AccessDeniedException',
  'AuthFailure',
  'MissingAuthenticationToken',
  'IncompleteSignature',
]);

/** Walks the `cause` chain, since the SDK often wraps the underlying socket error. */
function _codesOf(error) {
  const found = [];
  let e = error;
  for (let depth = 0; e && depth < 5; depth++) {
    if (e.code) found.push(String(e.code));
    if (e.errno && typeof e.errno === 'string') found.push(e.errno);
    if (e.name) found.push(String(e.name));
    e = e.cause;
  }
  return found;
}

/**
 * True when the request never got a response from AWS — i.e. we're offline,
 * DNS is broken, or the connection timed out.
 *
 * @param {Error} error
 * @returns {boolean}
 */
function isNetworkError(error) {
  if (!error) return false;

  const codes = _codesOf(error);
  if (codes.some(c => TRANSPORT_CODES.has(c))) return true;
  if (codes.some(c => TRANSPORT_NAMES.has(c))) return true;

  // An HTTP status means AWS answered — whatever went wrong, it wasn't transport.
  const status = error.$metadata?.httpStatusCode;
  if (status) return false;

  // The SDK's own "I never got a usable response" signals.
  if (error.$metadata && error.$metadata.attempts && !status) return true;

  return false;
}

/**
 * True when AWS answered and rejected the credentials (expired, revoked,
 * wrong). Deliberately excludes network failures, which say nothing about
 * credential validity.
 *
 * @param {Error} error
 * @returns {boolean}
 */
function isAuthError(error) {
  if (!error) return false;
  if (isNetworkError(error)) return false;

  if (AUTH_ERROR_NAMES.has(error.name)) return true;
  if (error.__type && AUTH_ERROR_NAMES.has(String(error.__type).split('#').pop())) return true;

  const status = error.$metadata?.httpStatusCode;
  return status === 401 || status === 403;
}

/**
 * Classify an AWS SDK error into one of three buckets.
 *
 * - `'network'` — never reached AWS; retry later, tells us nothing about creds
 * - `'auth'`    — AWS rejected the credentials; needs user action
 * - `'other'`   — reached AWS and failed for some other reason (throttling,
 *                 validation, a genuine service error)
 *
 * @param {Error} error
 * @returns {'network'|'auth'|'other'}
 */
function classifyAwsError(error) {
  if (isNetworkError(error)) return 'network';
  if (isAuthError(error)) return 'auth';
  return 'other';
}

/**
 * User-facing message for an error, phrased so a transport failure never
 * reads as a credentials problem.
 *
 * @param {Error} error
 * @param {string} [fallback] - used for the 'other' bucket
 * @returns {string}
 */
function describeAwsError(error, fallback = null) {
  switch (classifyAwsError(error)) {
    case 'network':
      return 'Hive is offline — could not reach AWS. Check your connection and try again.';
    case 'auth':
      return 'Your AWS credentials were rejected. Update them in Settings → Credentials.';
    default:
      return fallback || error?.message || 'An unexpected error occurred.';
  }
}

module.exports = {
  isNetworkError,
  isAuthError,
  classifyAwsError,
  describeAwsError,
  // exported for tests
  TRANSPORT_CODES,
  AUTH_ERROR_NAMES,
};
