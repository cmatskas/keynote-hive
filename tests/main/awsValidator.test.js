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
