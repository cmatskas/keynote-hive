/**
 * Tests for CredentialMonitor's offline handling.
 *
 * The behaviour under test is the one that used to destroy user work.
 * `_handleExpired()` replaces the renderer with the credentials page, throwing
 * away unsaved Work tab state and any in-flight UI. The 10-minute poll used to
 * reach that conclusion from any `valid: false`, and `quickValidate()` reported
 * a DNS failure as `valid: false` — so closing a laptop lid or switching
 * networks could silently wipe the user's work within 10 minutes, with no
 * action on their part.
 *
 * A transport failure must therefore pause the poll, never escalate to expiry;
 * and even a genuine expiry must not navigate while doing so would lose work.
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
  MockValidator.parseTokenExpiry = jest.fn(() => null);
  return MockValidator;
});

const AWSValidator = require('../../src/main/models/awsValidator');
const CredentialMonitor = require('../../src/main/models/credentialMonitor');

const CREDS = { accessKeyId: 'AKIA', secretAccessKey: 'secret', region: 'us-east-1' };

function build({ online = true, deferNavigation = false } = {}) {
  const state = { online, deferNavigation };
  const onExpired = jest.fn();
  const send = jest.fn();
  const monitor = new CredentialMonitor({
    getCredentials: () => CREDS,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }),
    isOnline: () => state.online,
    shouldDeferNavigation: () => state.deferNavigation,
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
    AWSValidator.parseTokenExpiry.mockReturnValue(null);
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
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Session Expired' }));

    // Navigation is deliberately delayed to let the renderer show the banner.
    expect(onExpired).not.toHaveBeenCalled();
    jest.advanceTimersByTime(3000);
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

    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Session Expired' }));
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

describe('CredentialMonitor deferred navigation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    AWSValidator.parseTokenExpiry.mockReturnValue(null);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('does not navigate while offline — the user is told, but keeps their work', async () => {
    // Offline, the user can't validate new credentials anyway, so replacing the
    // renderer would cost them their work for no benefit.
    mockQuickValidate.mockResolvedValue({ valid: false, offline: false, errors: ['Invalid'] });
    const { monitor, onExpired, send, state } = build({ online: true });

    state.online = false;
    monitor._handleExpired();

    expect(bannerLevels(send)).toContain('expired');
    jest.advanceTimersByTime(10000);
    expect(onExpired).not.toHaveBeenCalled();
  });

  test('runs the deferred navigation once connectivity returns', () => {
    const { monitor, onExpired, state } = build({ online: false });

    monitor._handleExpired();
    expect(onExpired).not.toHaveBeenCalled();

    state.online = true;
    monitor.resumeAfterOffline();

    expect(onExpired).toHaveBeenCalled();
  });

  test('a caller can veto navigation — e.g. a transcription mid-job', () => {
    // Navigating would discard a transcript the main process is about to
    // retrieve successfully.
    const { monitor, onExpired, state } = build({ online: true, deferNavigation: true });

    monitor._handleExpired();
    jest.advanceTimersByTime(10000);
    expect(onExpired).not.toHaveBeenCalled();

    // Once the transcription finishes, the veto lifts.
    state.deferNavigation = false;
    monitor.retryDeferredNavigation();
    expect(onExpired).toHaveBeenCalled();
  });

  test('retryDeferredNavigation does nothing when no navigation is outstanding', () => {
    const { monitor, onExpired } = build();
    monitor.retryDeferredNavigation();
    expect(onExpired).not.toHaveBeenCalled();
  });

  test('retryDeferredNavigation stays deferred while the veto holds', () => {
    const { monitor, onExpired } = build({ online: true, deferNavigation: true });
    monitor._handleExpired();

    monitor.retryDeferredNavigation();

    expect(onExpired).not.toHaveBeenCalled();
  });
});
