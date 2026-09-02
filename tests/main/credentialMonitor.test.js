/**
 * Tests for CredentialMonitor.
 *
 * Two histories converge here.
 *
 * The poll used to conclude expiry from any `valid: false`, and quickValidate()
 * reports a DNS failure that way — so closing a laptop lid could escalate to
 * "your credentials expired" and, back when expiry replaced the renderer with
 * the credentials page, silently wipe unsaved work. A transport failure must
 * pause the poll, never escalate.
 *
 * Expiry itself is now reported rather than acted on: no navigation, and the
 * monitor keeps polling afterwards so it can notice the credentials being fixed.
 * The advance-warning paths (T-15min, T-2min) are gone — they depended on
 * decoding an expiry out of the STS session token, which is an opaque blob, so
 * they never fired once in production.
 */

jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockNotify = jest.fn();
jest.mock('../../src/main/notify', () => ({ notify: (...args) => mockNotify(...args) }));

const mockQuickValidate = jest.fn();
jest.mock('../../src/main/models/awsValidator', () => {
  const MockValidator = jest.fn().mockImplementation(() => ({
    quickValidate: mockQuickValidate,
  }));
  return MockValidator;
});

const AWSValidator = require('../../src/main/models/awsValidator');
const CredentialMonitor = require('../../src/main/models/credentialMonitor');

const CREDS = { accessKeyId: 'AKIA', secretAccessKey: 'secret', region: 'us-east-1' };

function build({ online = true } = {}) {
  const state = { online };
  const onExpired = jest.fn();
  const onRecovered = jest.fn();
  const onStateSettled = jest.fn();
  const send = jest.fn();
  const monitor = new CredentialMonitor({
    getCredentials: () => CREDS,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }),
    isOnline: () => state.online,
    onExpired,
    onRecovered,
    onStateSettled,
  });
  return { monitor, onExpired, onRecovered, onStateSettled, send, state };
}

/** The renderer message for a given level, if it was sent. */
function bannerLevels(send) {
  return send.mock.calls
    .filter(([channel]) => channel === 'credential-expiry-warning')
    .map(([, data]) => data.level);
}

describe('CredentialMonitor offline handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('a transport failure pauses the poll instead of declaring expiry', async () => {
    // This is the regression that lost work.
    mockQuickValidate.mockResolvedValue({ valid: false, offline: true, errors: ['offline'] });
    const { monitor, onExpired, send } = build();
    monitor.start();

    await monitor._runPollCheck();

    expect(monitor.isPausedOffline()).toBe(true);
    expect(onExpired).not.toHaveBeenCalled();
    expect(bannerLevels(send)).not.toContain('expired');
    expect(mockNotify).not.toHaveBeenCalled();
    monitor.stop();
  });

  test('checks credentials even when the connectivity monitor says offline', async () => {
    // This used to short-circuit — "don't bother with a doomed round trip" —
    // which made expired credentials undetectable for as long as the connectivity
    // monitor was wrong. In production it was wrong for three hours, so the app
    // blamed the network and could not tell the user whether their token had also
    // expired. quickValidate() already distinguishes the two cases itself.
    mockQuickValidate.mockResolvedValue({ valid: true, offline: false, errors: [] });
    const { monitor } = build({ online: false });
    monitor.start();

    await monitor._runPollCheck();

    expect(mockQuickValidate).toHaveBeenCalled();
    // AWS answered, so we are demonstrably not offline whatever the monitor thinks.
    expect(monitor.isPausedOffline()).toBe(false);
    monitor.stop();
  });

  test('a successful check nudges the connectivity monitor to re-evaluate', async () => {
    // Reaching AWS is proof the network works, so the credential poll becomes the
    // thing that corrects a wrong offline verdict rather than a casualty of it.
    mockQuickValidate.mockResolvedValue({ valid: true, offline: false, errors: [] });
    const onReachedAws = jest.fn();
    const monitor = new CredentialMonitor({
      getCredentials: () => CREDS,
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: jest.fn() } }),
      isOnline: () => false,
      onReachedAws,
      onExpired: jest.fn(),
    });
    monitor.start();

    await monitor._runPollCheck();

    expect(onReachedAws).toHaveBeenCalled();
    monitor.stop();
  });

  test('detects expiry even while the connectivity monitor believes it is offline', async () => {
    // The scenario that was undiagnosable before: a wrong offline verdict must not
    // hide a genuinely rejected token.
    mockQuickValidate.mockResolvedValue({ valid: false, offline: false, errors: ['Invalid'] });
    const { monitor, send } = build({ online: false });
    monitor.start();

    await monitor._runPollCheck();

    expect(bannerLevels(send)).toContain('expired');
    expect(monitor.getCredentialState()).toBe('rejected');
  });

  test('reports the credential state so the UI can name the real problem', async () => {
    const { monitor } = build();
    monitor.start();
    expect(monitor.getCredentialState()).toBe('unknown');

    mockQuickValidate.mockResolvedValue({ valid: true, offline: false, errors: [] });
    await monitor._runPollCheck();
    expect(monitor.getCredentialState()).toBe('valid');

    mockQuickValidate.mockResolvedValue({ valid: false, offline: true, errors: [] });
    await monitor._runPollCheck();
    // Unreachable tells us nothing about the credentials — don't claim it does.
    expect(monitor.getCredentialState()).toBe('unknown');
    monitor.stop();
  });

  test('a genuine rejection while online still declares expiry', async () => {
    mockQuickValidate.mockResolvedValue({ valid: false, offline: false, errors: ['Invalid AWS credentials'] });
    const { monitor, onExpired, send } = build();
    monitor.start();

    await monitor._runPollCheck();

    expect(bannerLevels(send)).toContain('expired');
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ title: 'AWS Credentials Expired' }));
    // Reported immediately — there is no longer a delay to let the user see a
    // banner before the app navigated away, because it no longer navigates.
    expect(onExpired).toHaveBeenCalled();
  });

  test('clears the paused state once AWS answers again', async () => {
    mockQuickValidate.mockResolvedValueOnce({ valid: false, offline: true, errors: [] });
    const { monitor } = build();
    monitor.start();

    await monitor._runPollCheck();
    expect(monitor.isPausedOffline()).toBe(true);

    mockQuickValidate.mockResolvedValueOnce({ valid: true, offline: false, errors: [] });
    await monitor._runPollCheck();

    expect(monitor.isPausedOffline()).toBe(false);
    monitor.stop();
  });

  test('resumeAfterOffline re-checks immediately rather than waiting for the next poll', async () => {
    mockQuickValidate.mockResolvedValue({ valid: false, offline: true, errors: [] });
    const { monitor, state } = build();
    monitor.start();
    await monitor._runPollCheck();
    expect(monitor.isPausedOffline()).toBe(true);

    // Connectivity returns, and the credentials turn out to have expired during
    // the outage — that must be caught promptly, not up to 10 minutes later.
    state.online = true;
    mockQuickValidate.mockResolvedValue({ valid: false, offline: false, errors: ['Invalid'] });
    monitor.resumeAfterOffline();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ title: 'AWS Credentials Expired' }));
  });

  test('resumeAfterOffline is a no-op when the monitor was never paused', async () => {
    const { monitor } = build();
    monitor.start();
    mockQuickValidate.mockClear();

    monitor.resumeAfterOffline();
    await Promise.resolve();

    expect(mockQuickValidate).not.toHaveBeenCalled();
    monitor.stop();
  });

  test('reset() clears a paused state so new credentials start clean', async () => {
    mockQuickValidate.mockResolvedValue({ valid: false, offline: true, errors: [] });
    const { monitor } = build();
    monitor.start();
    await monitor._runPollCheck();
    expect(monitor.isPausedOffline()).toBe(true);

    monitor.reset();

    expect(monitor.isPausedOffline()).toBe(false);
    monitor.stop();
  });
});

describe('CredentialMonitor expiry is non-destructive', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => jest.useRealTimers());

  test('keeps polling after expiry, so recovery can be noticed', async () => {
    // Previously _handleExpired() called stop(). That was only safe because the
    // app navigated to the credentials page and restarted the monitor on save.
    // With no navigation, stopping would leave a stale "expired" banner forever.
    mockQuickValidate.mockResolvedValue({ valid: false, offline: false, errors: ['Invalid'] });
    const { monitor } = build();
    monitor.start();

    await monitor._runPollCheck();
    expect(monitor.getCredentialState()).toBe('rejected');

    mockQuickValidate.mockClear();
    await monitor._runPollCheck();

    expect(mockQuickValidate).toHaveBeenCalled();
    monitor.stop();
  });

  test('clears the warning when the credentials work again', async () => {
    mockQuickValidate.mockResolvedValue({ valid: false, offline: false, errors: ['Invalid'] });
    const { monitor, send } = build();
    monitor.start();
    await monitor._runPollCheck();
    expect(bannerLevels(send)).toContain('expired');

    mockQuickValidate.mockResolvedValue({ valid: true, offline: false, errors: [] });
    await monitor._runPollCheck();

    expect(bannerLevels(send)).toContain('ok');
    expect(monitor.getCredentialState()).toBe('valid');
    monitor.stop();
  });

  test('announces expiry only once, however many polls confirm it', async () => {
    mockQuickValidate.mockResolvedValue({ valid: false, offline: false, errors: ['Invalid'] });
    const { monitor, send } = build();
    monitor.start();

    await monitor._runPollCheck();
    await monitor._runPollCheck();
    await monitor._runPollCheck();

    expect(bannerLevels(send).filter(l => l === 'expired')).toHaveLength(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  test('can report expiry, recovery, and expiry again', async () => {
    const { monitor, send } = build();
    monitor.start();

    mockQuickValidate.mockResolvedValue({ valid: false, offline: false, errors: ['Invalid'] });
    await monitor._runPollCheck();
    mockQuickValidate.mockResolvedValue({ valid: true, offline: false, errors: [] });
    await monitor._runPollCheck();
    mockQuickValidate.mockResolvedValue({ valid: false, offline: false, errors: ['Invalid'] });
    await monitor._runPollCheck();

    expect(bannerLevels(send)).toEqual(['expired', 'ok', 'expired']);
    monitor.stop();
  });

  test('a throwing onExpired does not break the monitor', async () => {
    mockQuickValidate.mockResolvedValue({ valid: false, offline: false, errors: ['Invalid'] });
    const monitor = new CredentialMonitor({
      getCredentials: () => CREDS,
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: jest.fn() } }),
      onExpired: () => { throw new Error('boom'); },
    });
    monitor.start();

    await expect(monitor._runPollCheck()).resolves.toBeUndefined();
    expect(monitor.getCredentialState()).toBe('rejected');
    monitor.stop();
  });

  test('polls once a minute, so a dead credential is noticed promptly', async () => {
    // Detection, not prediction: GetCallerIdentity cannot say when a token will
    // expire, only that it already has, so the interval bounds the delay.
    expect(CredentialMonitor.POLL_INTERVAL_MS).toBe(60 * 1000);

    mockQuickValidate.mockResolvedValue({ valid: true, offline: false, errors: [] });
    const { monitor } = build();
    monitor.start();
    mockQuickValidate.mockClear();

    jest.advanceTimersByTime(60 * 1000);
    await Promise.resolve();

    expect(mockQuickValidate).toHaveBeenCalledTimes(1);
    monitor.stop();
  });
});


/**
 * Saving working credentials after an expiry.
 *
 * This is the path a user actually takes to recover, and it was broken in a way
 * that recovery-without-saving was not: reset() set `_lastStatus` back to 'valid',
 * and recovery is announced only on the transition out of 'expired'. So the
 * transition never happened, no `ok` was ever sent, and the renderer — which
 * caches the last verdict it was told — kept refusing every AWS action with
 * "needs working AWS credentials" against credentials that were provably fine.
 * Restarting the app was the only cure, since a fresh renderer asks for the state
 * rather than remembering it.
 *
 * It survived because the broken path is the one nobody re-tests: fixing your
 * credentials is precisely when you stop looking for bugs.
 */
describe('recovery after saving new credentials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  /** Expire the credentials, exactly as the monitor would observe it. */
  async function expire(monitor) {
    mockQuickValidate.mockResolvedValue({ valid: false, offline: false, errors: ['ExpiredToken'] });
    await monitor._runPollCheck();
  }

  test('announces recovery after reset(), which is what saving credentials does', async () => {
    const { monitor, send } = build();
    monitor.start();
    await expire(monitor);
    expect(bannerLevels(send)).toContain('expired');

    // The user pastes working credentials and hits Save & Test.
    mockQuickValidate.mockResolvedValue({ valid: true, offline: false, errors: [] });
    monitor.reset();
    await Promise.resolve();
    await Promise.resolve();

    expect(bannerLevels(send)).toContain('ok');
    expect(monitor.getCredentialState()).toBe('valid');
    monitor.stop();
  });

  test('re-checks immediately on reset rather than waiting out the poll interval', async () => {
    // A minute of a disabled Send button, after being told the credentials are
    // fine, reads as the fix not having worked.
    const { monitor } = build();
    monitor.start();
    await expire(monitor);

    mockQuickValidate.mockClear();
    mockQuickValidate.mockResolvedValue({ valid: true, offline: false, errors: [] });
    monitor.reset();
    await Promise.resolve();

    expect(mockQuickValidate).toHaveBeenCalled();
    monitor.stop();
  });

  test('notifies the host so a cached renderer verdict is corrected', async () => {
    // The banner event alone left one message between a correct UI and a
    // permanently disabled one.
    const { monitor, onRecovered } = build();
    monitor.start();
    await expire(monitor);

    mockQuickValidate.mockResolvedValue({ valid: true, offline: false, errors: [] });
    monitor.reset();
    await Promise.resolve();
    await Promise.resolve();

    expect(onRecovered).toHaveBeenCalled();
    monitor.stop();
  });

  test('a settled valid verdict still notifies, so a stale cache cannot persist', async () => {
    // No expiry, no transition — but the renderer may still be holding a stale
    // 'rejected' from before. Something has to say otherwise.
    const { monitor, onStateSettled } = build();
    mockQuickValidate.mockResolvedValue({ valid: true, offline: false, errors: [] });
    monitor.start();

    await monitor._runPollCheck();

    expect(onStateSettled).toHaveBeenCalled();
    monitor.stop();
  });

  test('does not announce a recovery that never happened', async () => {
    // Rotating perfectly good credentials must not produce a "credentials
    // working again" notification for a problem the user never had.
    const { monitor, send, onRecovered } = build();
    mockQuickValidate.mockResolvedValue({ valid: true, offline: false, errors: [] });
    monitor.start();
    await monitor._runPollCheck();

    monitor.reset();
    await Promise.resolve();
    await Promise.resolve();

    expect(bannerLevels(send)).not.toContain('ok');
    expect(onRecovered).not.toHaveBeenCalled();
    monitor.stop();
  });

  test('still clears a paused state, so new credentials start clean', async () => {
    // The behaviour reset() was originally written for, preserved.
    mockQuickValidate.mockResolvedValue({ valid: false, offline: true, errors: [] });
    const { monitor } = build();
    monitor.start();
    await monitor._runPollCheck();
    expect(monitor.isPausedOffline()).toBe(true);

    monitor.reset();

    expect(monitor.isPausedOffline()).toBe(false);
    monitor.stop();
  });

  test('saving credentials that are also bad keeps reporting rejected', async () => {
    const { monitor } = build();
    monitor.start();
    await expire(monitor);

    mockQuickValidate.mockResolvedValue({ valid: false, offline: false, errors: ['ExpiredToken'] });
    monitor.reset();
    await Promise.resolve();
    await Promise.resolve();

    expect(monitor.getCredentialState()).toBe('rejected');
    monitor.stop();
  });
});
