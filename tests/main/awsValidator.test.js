/**
 * Tests for awsValidator.js, focused on the isAdminAccount derived field
 * added for Flow 2's Admin tab gate (see adminSetup.js / settingsTab.js).
 * isAdminAccount must be computed from the same GetCallerIdentity call
 * quickValidate()/validateCredentials() already make — no additional AWS
 * call — and must be strictly account-ID equality, not a prefix/substring
 * match, so a similarly-numbered account can never be mistaken for the
 * admin account.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  GetCallerIdentityCommand: jest.fn((input) => ({ __type: 'GetCallerIdentityCommand', input })),
}));
jest.mock('@aws-sdk/client-bedrock', () => ({
  BedrockClient: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  ListFoundationModelsCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-transcribe', () => ({
  TranscribeClient: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  ListTranscriptionJobsCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  ListBucketsCommand: jest.fn(),
}));

const AWSValidator = require('../../src/main/models/awsValidator');

function credentials() {
  return { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token', region: 'us-east-1' };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AWS_KEYNOTE_ACCOUNT_ID export', () => {
  test('is exported and matches the known admin account id', () => {
    expect(AWSValidator.AWS_KEYNOTE_ACCOUNT_ID).toBe('448778737104');
  });
});

describe('quickValidate() isAdminAccount', () => {
  test('is true when the caller identity account matches AWS_KEYNOTE_ACCOUNT_ID', async () => {
    mockSend.mockResolvedValue({ UserId: 'U1', Account: '448778737104', Arn: 'arn:aws:sts::448778737104:assumed-role/Admin/x' });

    const validator = new AWSValidator(credentials());
    const result = await validator.quickValidate();

    expect(result.valid).toBe(true);
    expect(result.isAdminAccount).toBe(true);
  });

  test('is false when the caller identity account does not match', async () => {
    mockSend.mockResolvedValue({ UserId: 'U1', Account: '111111111111', Arn: 'arn:aws:sts::111111111111:assumed-role/Admin/x' });

    const validator = new AWSValidator(credentials());
    const result = await validator.quickValidate();

    expect(result.isAdminAccount).toBe(false);
  });

  test('is false (not a substring/prefix match) for an account id that merely contains the admin id as a substring', async () => {
    mockSend.mockResolvedValue({ UserId: 'U1', Account: '4487787371049999', Arn: 'arn:...' });

    const validator = new AWSValidator(credentials());
    const result = await validator.quickValidate();

    expect(result.isAdminAccount).toBe(false);
  });
});

describe('validateCredentials() isAdminAccount', () => {
  test('is true when the caller identity account matches AWS_KEYNOTE_ACCOUNT_ID', async () => {
    mockSend.mockResolvedValue({ UserId: 'U1', Account: '448778737104', Arn: 'arn:...' });

    const validator = new AWSValidator(credentials());
    const result = await validator.validateCredentials();

    expect(result.isAdminAccount).toBe(true);
  });

  test('defaults to false when credentials are invalid and identity never resolves', async () => {
    mockSend.mockRejectedValue(new Error('invalid credentials'));

    const validator = new AWSValidator(credentials());
    const result = await validator.validateCredentials();

    expect(result.valid).toBe(false);
    expect(result.isAdminAccount).toBe(false);
  });
});

/**
 * The three-state result. `{ valid: false }` alone was ambiguous — it meant
 * both "AWS rejected these credentials" and "we never reached AWS" — and
 * callers acted on the first reading when it was really the second: startup
 * routing opened the credentials page, the credential monitor escalated to
 * expiry and replaced the renderer (losing unsaved work), and the pre-send
 * gates told users their working credentials were invalid.
 */
describe('quickValidate() offline vs invalid', () => {
  test('reports offline for a transport failure, and never as a credentials problem', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND sts.us-east-1.amazonaws.com'), {
      code: 'ENOTFOUND',
    }));

    const result = await new AWSValidator(credentials()).quickValidate();

    expect(result.valid).toBe(false);
    expect(result.offline).toBe(true);
    expect(result.errors[0]).toMatch(/offline/i);
    expect(result.errors[0]).not.toMatch(/Invalid AWS credentials/);
  });

  test('reports a genuine rejection as invalid, not offline', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('The security token included in the request is expired'), {
      name: 'ExpiredTokenException',
      $metadata: { httpStatusCode: 403, attempts: 1 },
    }));

    const result = await new AWSValidator(credentials()).quickValidate();

    expect(result.valid).toBe(false);
    expect(result.offline).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid AWS credentials/);
  });

  test('a successful validation is explicitly not offline', async () => {
    mockSend.mockResolvedValue({ UserId: 'AIDA', Account: '111122223333', Arn: 'arn:aws:iam::111122223333:role/Dev' });

    const result = await new AWSValidator(credentials()).quickValidate();

    expect(result.valid).toBe(true);
    expect(result.offline).toBe(false);
  });

  test('a timeout is treated as offline rather than bad credentials', async () => {
    const err = new Error('Connection timed out');
    err.name = 'TimeoutError';
    mockSend.mockRejectedValue(err);

    const result = await new AWSValidator(credentials()).quickValidate();

    expect(result.offline).toBe(true);
  });
});

describe('validateCredentials() offline flag', () => {
  test('flags offline on a transport failure so Connection Status does not blame the credentials', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' }));

    const result = await new AWSValidator(credentials()).validateCredentials();

    expect(result.valid).toBe(false);
    expect(result.offline).toBe(true);
    expect(result.errors[0]).toMatch(/offline/i);
  });

  test('does not flag offline for a genuine rejection', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('invalid'), {
      name: 'InvalidClientTokenId',
      $metadata: { httpStatusCode: 403 },
    }));

    const result = await new AWSValidator(credentials()).validateCredentials();

    expect(result.offline).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid AWS credentials/);
  });
});
