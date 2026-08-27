/**
 * Tests for startup routing (src/main/startupRoute.js).
 *
 * The behaviour that matters most here is the offline case. Being unable to
 * *reach* AWS is not the same as having bad credentials, but startup used to
 * treat them identically and open the credentials page — which put every local
 * feature (conversations, work history, skills, showflows, all plain files
 * needing no network) behind a connection they don't require. Launching offline
 * must land on the main window.
 *
 * Also guarded here: the deliberate ordering of `initializeAWSClients()` before
 * validation. That's what lets a launch-while-offline start working the instant
 * connectivity returns, with no re-initialisation, and nothing else in the
 * codebase would catch a refactor that moved it.
 */

jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockQuickValidate = jest.fn();
jest.mock('../../src/main/models/awsValidator', () => {
  const MockValidator = jest.fn().mockImplementation(() => ({
    quickValidate: mockQuickValidate,
  }));
  MockValidator.parseTokenExpiry = jest.fn(() => null);
  return MockValidator;
});

const AWSValidator = require('../../src/main/models/awsValidator');
const { resolveStartupRoute } = require('../../src/main/startupRoute');

const STORED_CREDS = {
  accessKeyId: 'AKIA',
  secretAccessKey: 'secret',
  sessionToken: 'token',
  region: 'us-east-1',
};

/**
 * A stand-in for AppContext. The real one constructs managers that call
 * `app.getPath('userData')`, so routing takes the context as a parameter and
 * tests supply this instead — no Electron involved.
 */
function buildCtx({ hasCredentials = true, loadThrows = false } = {}) {
  return {
    currentCredentials: null,
    credentialsManager: {
      hasCredentials: jest.fn(async () => hasCredentials),
      loadCredentials: jest.fn(async () => {
        if (loadThrows) throw new Error('keychain unavailable');
        return STORED_CREDS;
      }),
    },
    initializeAWSClients: jest.fn(),
  };
}

describe('resolveStartupRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('routes to the credentials page when nothing is stored', async () => {
    const ctx = buildCtx({ hasCredentials: false });

    await expect(resolveStartupRoute(ctx)).resolves.toBe('credentials');

    // No point loading or validating credentials that don't exist.
    expect(ctx.credentialsManager.loadCredentials).not.toHaveBeenCalled();
    expect(mockQuickValidate).not.toHaveBeenCalled();
  });

  test('routes to the main window when stored credentials validate', async () => {
    mockQuickValidate.mockResolvedValue({ valid: true, offline: false, errors: [] });
    const ctx = buildCtx();

    await expect(resolveStartupRoute(ctx)).resolves.toBe('main');
  });

  test('routes to the main window when offline, rather than trapping the user', async () => {
    // The regression this whole release exists to fix: launching without a
    // connection must not hide local work behind the credentials page.
    mockQuickValidate.mockResolvedValue({
      valid: false,
      offline: true,
      errors: ['Hive is offline — could not reach AWS.'],
    });
    const ctx = buildCtx();

    await expect(resolveStartupRoute(ctx)).resolves.toBe('main');
  });

  test('routes to the credentials page when AWS genuinely rejects the credentials', async () => {
    mockQuickValidate.mockResolvedValue({
      valid: false,
      offline: false,
      errors: ['Invalid AWS credentials: ExpiredTokenException'],
    });
    const ctx = buildCtx();

    await expect(resolveStartupRoute(ctx)).resolves.toBe('credentials');
  });

  test('initializes AWS clients before validating, so reconnect needs no re-init', async () => {
    // Load-bearing ordering: offline, the clients must already exist so they
    // start working the moment connectivity returns.
    const callOrder = [];
    mockQuickValidate.mockImplementation(async () => {
      callOrder.push('validate');
      return { valid: false, offline: true, errors: [] };
    });
    const ctx = buildCtx();
    ctx.initializeAWSClients.mockImplementation(() => { callOrder.push('initClients'); });

    await resolveStartupRoute(ctx);

    expect(callOrder).toEqual(['initClients', 'validate']);
  });

  test('initializes AWS clients even when validation rejects the credentials', async () => {
    mockQuickValidate.mockResolvedValue({ valid: false, offline: false, errors: ['Invalid'] });
    const ctx = buildCtx();

    await resolveStartupRoute(ctx);

    expect(ctx.initializeAWSClients).toHaveBeenCalledWith(STORED_CREDS);
  });

  test('puts the loaded credentials on the context for later use', async () => {
    mockQuickValidate.mockResolvedValue({ valid: true, offline: false, errors: [] });
    const ctx = buildCtx();

    await resolveStartupRoute(ctx);

    expect(ctx.currentCredentials).toEqual(STORED_CREDS);
    expect(AWSValidator).toHaveBeenCalledWith(STORED_CREDS);
  });

  test('falls back to the credentials page if loading credentials throws', async () => {
    const ctx = buildCtx({ loadThrows: true });

    await expect(resolveStartupRoute(ctx)).resolves.toBe('credentials');
  });

  test('falls back to the credentials page if validation throws unexpectedly', async () => {
    // quickValidate() is not supposed to throw, but routing must not crash the
    // launch if it ever does.
    mockQuickValidate.mockRejectedValue(new Error('unexpected'));
    const ctx = buildCtx();

    await expect(resolveStartupRoute(ctx)).resolves.toBe('credentials');
  });
});
