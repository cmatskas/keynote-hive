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
  const send = jest.fn();
  const monitor = new CredentialMonitor({
    getCredentials: () => CREDS,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }),
    isOnline: () => state.online,
    onExpired,
  });
  return { monitor, onExpired, send, state };
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
