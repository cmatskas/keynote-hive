/**
 * Tests for setupWizard.js (Flow 1 — per-user Setup Check).
 *
 * Covers the idempotent check-then-create pattern for all three items:
 * Web Search Gateway execution role, transcription S3 bucket, and
 * AgentCore Memory. checkStatus() must never call a mutating API (Create*)
 * — only Get/List/Head — and create* functions must detect an existing
 * resource and return it rather than erroring or duplicating it.
 */
jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockIamSend = jest.fn();
jest.mock('@aws-sdk/client-iam', () => ({
  IAMClient: jest.fn().mockImplementation(() => ({ send: mockIamSend })),
  GetRoleCommand: jest.fn((input) => ({ __type: 'GetRoleCommand', input })),
  CreateRoleCommand: jest.fn((input) => ({ __type: 'CreateRoleCommand', input })),
  PutRolePolicyCommand: jest.fn((input) => ({ __type: 'PutRolePolicyCommand', input })),
}));

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  HeadBucketCommand: jest.fn((input) => ({ __type: 'HeadBucketCommand', input })),
  CreateBucketCommand: jest.fn((input) => ({ __type: 'CreateBucketCommand', input })),
}));

const mockAgentCoreSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: jest.fn().mockImplementation(() => ({ send: mockAgentCoreSend })),
  ListGatewaysCommand: jest.fn((input) => ({ __type: 'ListGatewaysCommand', input })),
  GetMemoryCommand: jest.fn((input) => ({ __type: 'GetMemoryCommand', input })),
  CreateMemoryCommand: jest.fn((input) => ({ __type: 'CreateMemoryCommand', input })),
}));

const setupWizard = require('../../src/main/models/setupWizard');

function credentials(overrides = {}) {
  return { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token', region: 'us-east-1', ...overrides };
}

function notFoundError(name) {
  const err = new Error('not found');
  err.name = name;
  return err;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('checkStatus()', () => {
  test('reports webSearchGateway ready when the gateway already exists', async () => {
    mockAgentCoreSend.mockImplementation((cmd) => {
      if (cmd.__type === 'ListGatewaysCommand') {
        return Promise.resolve({ items: [{ name: 'hive-web-search', status: 'READY' }] });
      }
      return Promise.reject(notFoundError('ResourceNotFoundException'));
    });
    mockS3Send.mockRejectedValue(notFoundError('NotFound'));

    const status = await setupWizard.checkStatus(credentials(), { bucketName: '', memoryId: '' });

    expect(status.webSearchGateway.status).toBe('ready');
  });

  test('reports webSearchGateway ready when only the IAM role exists yet (gateway not created yet)', async () => {
    mockAgentCoreSend.mockImplementation((cmd) => {
      if (cmd.__type === 'ListGatewaysCommand') return Promise.resolve({ items: [] });
      return Promise.reject(notFoundError('ResourceNotFoundException'));
    });
    mockIamSend.mockImplementation((cmd) => {
      if (cmd.__type === 'GetRoleCommand') return Promise.resolve({ Role: { Arn: 'arn:aws:iam::123:role/hive-web-search-gateway' } });
    });
    mockS3Send.mockRejectedValue(notFoundError('NotFound'));

    const status = await setupWizard.checkStatus(credentials(), { bucketName: '', memoryId: '' });

    expect(status.webSearchGateway.status).toBe('ready');
  });

  test('reports webSearchGateway missing when neither gateway nor role exist', async () => {
    mockAgentCoreSend.mockImplementation((cmd) => {
      if (cmd.__type === 'ListGatewaysCommand') return Promise.resolve({ items: [] });
      return Promise.reject(notFoundError('ResourceNotFoundException'));
    });
    mockIamSend.mockRejectedValue(notFoundError('NoSuchEntityException'));
    mockS3Send.mockRejectedValue(notFoundError('NotFound'));

    const status = await setupWizard.checkStatus(credentials(), { bucketName: '', memoryId: '' });

    expect(status.webSearchGateway.status).toBe('missing');
  });

  test('reports transcriptionBucket missing when no bucketName is configured', async () => {
    mockAgentCoreSend.mockRejectedValue(notFoundError('ResourceNotFoundException'));
    mockIamSend.mockRejectedValue(notFoundError('NoSuchEntityException'));

    const status = await setupWizard.checkStatus(credentials(), { bucketName: '', memoryId: '' });

    expect(status.transcriptionBucket.status).toBe('missing');
    // Must not call S3 at all when there's no bucket name to check.
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('reports transcriptionBucket ready when the configured bucket exists', async () => {
    mockAgentCoreSend.mockRejectedValue(notFoundError('ResourceNotFoundException'));
    mockIamSend.mockRejectedValue(notFoundError('NoSuchEntityException'));
    mockS3Send.mockResolvedValue({});

    const status = await setupWizard.checkStatus(credentials(), { bucketName: 'my-bucket', memoryId: '' });

    expect(status.transcriptionBucket.status).toBe('ready');
    expect(mockS3Send).toHaveBeenCalledWith(expect.objectContaining({ __type: 'HeadBucketCommand', input: { Bucket: 'my-bucket' } }));
  });

  test('reports transcriptionBucket missing when HeadBucket 404s', async () => {
    mockAgentCoreSend.mockRejectedValue(notFoundError('ResourceNotFoundException'));
    mockIamSend.mockRejectedValue(notFoundError('NoSuchEntityException'));
    mockS3Send.mockRejectedValue(notFoundError('NotFound'));

    const status = await setupWizard.checkStatus(credentials(), { bucketName: 'my-bucket', memoryId: '' });

    expect(status.transcriptionBucket.status).toBe('missing');
  });

  test('reports memory missing when no memoryId is configured', async () => {
    mockAgentCoreSend.mockImplementation((cmd) => {
      if (cmd.__type === 'ListGatewaysCommand') return Promise.resolve({ items: [] });
      if (cmd.__type === 'GetMemoryCommand') throw new Error('should not be called without a memoryId');
      return Promise.reject(notFoundError('ResourceNotFoundException'));
    });
    mockIamSend.mockRejectedValue(notFoundError('NoSuchEntityException'));
    mockS3Send.mockRejectedValue(notFoundError('NotFound'));

    const status = await setupWizard.checkStatus(credentials(), { bucketName: '', memoryId: '' });

    expect(status.memory.status).toBe('missing');
  });

  test('reports memory ready when the configured memoryId exists', async () => {
    mockAgentCoreSend.mockImplementation((cmd) => {
      if (cmd.__type === 'ListGatewaysCommand') return Promise.resolve({ items: [] });
      if (cmd.__type === 'GetMemoryCommand') return Promise.resolve({ memory: { status: 'ACTIVE' } });
      return Promise.reject(notFoundError('ResourceNotFoundException'));
    });
    mockIamSend.mockRejectedValue(notFoundError('NoSuchEntityException'));
    mockS3Send.mockRejectedValue(notFoundError('NotFound'));

    const status = await setupWizard.checkStatus(credentials(), { bucketName: '', memoryId: 'mem-123' });

    expect(status.memory.status).toBe('ready');
  });

  test('reports memory missing when the configured memoryId does not exist', async () => {
    mockAgentCoreSend.mockImplementation((cmd) => {
      if (cmd.__type === 'ListGatewaysCommand') return Promise.resolve({ items: [] });
      if (cmd.__type === 'GetMemoryCommand') return Promise.reject(notFoundError('ResourceNotFoundException'));
      return Promise.reject(notFoundError('ResourceNotFoundException'));
    });
    mockIamSend.mockRejectedValue(notFoundError('NoSuchEntityException'));
    mockS3Send.mockRejectedValue(notFoundError('NotFound'));

    const status = await setupWizard.checkStatus(credentials(), { bucketName: '', memoryId: 'mem-gone' });

    expect(status.memory.status).toBe('missing');
  });

  test('never calls a mutating command during checkStatus()', async () => {
    mockAgentCoreSend.mockResolvedValue({ items: [] });
    mockIamSend.mockRejectedValue(notFoundError('NoSuchEntityException'));
    mockS3Send.mockRejectedValue(notFoundError('NotFound'));

    await setupWizard.checkStatus(credentials(), { bucketName: 'b', memoryId: 'm' });

    const mutatingTypes = ['CreateRoleCommand', 'PutRolePolicyCommand', 'CreateBucketCommand', 'CreateMemoryCommand'];
    [mockIamSend, mockS3Send, mockAgentCoreSend].forEach(mockFn => {
      mockFn.mock.calls.forEach(([cmd]) => {
        expect(mutatingTypes).not.toContain(cmd.__type);
      });
    });
  });
});

describe('createWebSearchGatewayRole()', () => {
  test('creates the role and attaches the permissions policy when it does not exist', async () => {
    mockIamSend.mockImplementation((cmd) => {
      if (cmd.__type === 'GetRoleCommand') return Promise.reject(notFoundError('NoSuchEntityException'));
      if (cmd.__type === 'CreateRoleCommand') return Promise.resolve({ Role: { Arn: 'arn:aws:iam::123:role/hive-web-search-gateway' } });
      if (cmd.__type === 'PutRolePolicyCommand') return Promise.resolve({});
    });

    const arn = await setupWizard.createWebSearchGatewayRole(credentials(), 'us-east-1');

    expect(arn).toBe('arn:aws:iam::123:role/hive-web-search-gateway');
    const createCall = mockIamSend.mock.calls.find(([cmd]) => cmd.__type === 'CreateRoleCommand');
    expect(JSON.parse(createCall[0].input.AssumeRolePolicyDocument)).toEqual({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: 'bedrock-agentcore.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    });
    const policyCall = mockIamSend.mock.calls.find(([cmd]) => cmd.__type === 'PutRolePolicyCommand');
    expect(JSON.parse(policyCall[0].input.PolicyDocument)).toEqual({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: ['bedrock-agentcore:InvokeGateway', 'bedrock-agentcore:InvokeWebSearch'], Resource: '*' }],
    });
  });

  test('is idempotent — returns the existing ARN without creating anything when the role already exists', async () => {
    mockIamSend.mockImplementation((cmd) => {
      if (cmd.__type === 'GetRoleCommand') return Promise.resolve({ Role: { Arn: 'arn:aws:iam::123:role/hive-web-search-gateway' } });
    });

    const arn = await setupWizard.createWebSearchGatewayRole(credentials(), 'us-east-1');

    expect(arn).toBe('arn:aws:iam::123:role/hive-web-search-gateway');
    expect(mockIamSend.mock.calls.some(([cmd]) => cmd.__type === 'CreateRoleCommand')).toBe(false);
  });

  test('propagates unexpected IAM errors instead of swallowing them', async () => {
    mockIamSend.mockRejectedValue(new Error('AccessDenied'));

    await expect(setupWizard.createWebSearchGatewayRole(credentials(), 'us-east-1')).rejects.toThrow('AccessDenied');
  });
});

describe('createTranscriptionBucket()', () => {
  test('creates the bucket with a LocationConstraint when the region is not us-east-1', async () => {
    mockS3Send.mockImplementation((cmd) => {
      if (cmd.__type === 'HeadBucketCommand') return Promise.reject(notFoundError('NotFound'));
      if (cmd.__type === 'CreateBucketCommand') return Promise.resolve({});
    });

    const name = await setupWizard.createTranscriptionBucket(credentials(), 'eu-west-1', 'my-bucket');

    expect(name).toBe('my-bucket');
    const createCall = mockS3Send.mock.calls.find(([cmd]) => cmd.__type === 'CreateBucketCommand');
    expect(createCall[0].input).toEqual({
      Bucket: 'my-bucket',
      CreateBucketConfiguration: { LocationConstraint: 'eu-west-1' },
    });
  });

  test('omits LocationConstraint for us-east-1 (AWS rejects it for that region specifically)', async () => {
    mockS3Send.mockImplementation((cmd) => {
      if (cmd.__type === 'HeadBucketCommand') return Promise.reject(notFoundError('NotFound'));
      if (cmd.__type === 'CreateBucketCommand') return Promise.resolve({});
    });

    await setupWizard.createTranscriptionBucket(credentials(), 'us-east-1', 'my-bucket');

    const createCall = mockS3Send.mock.calls.find(([cmd]) => cmd.__type === 'CreateBucketCommand');
    expect(createCall[0].input).toEqual({ Bucket: 'my-bucket' });
  });

  test('is idempotent — returns the bucket name without creating anything when it already exists', async () => {
    mockS3Send.mockImplementation((cmd) => {
      if (cmd.__type === 'HeadBucketCommand') return Promise.resolve({});
    });

    const name = await setupWizard.createTranscriptionBucket(credentials(), 'us-east-1', 'my-bucket');

    expect(name).toBe('my-bucket');
    expect(mockS3Send.mock.calls.some(([cmd]) => cmd.__type === 'CreateBucketCommand')).toBe(false);
  });
});

describe('createMemory()', () => {
  test('creates a memory resource with semantic + summary strategies and returns its id', async () => {
    mockAgentCoreSend.mockImplementation((cmd) => {
      if (cmd.__type === 'CreateMemoryCommand') return Promise.resolve({ memory: { id: 'mem-abc123' } });
    });

    const memoryId = await setupWizard.createMemory(credentials(), 'us-east-1', 'HiveMemory');

    expect(memoryId).toBe('mem-abc123');
    const call = mockAgentCoreSend.mock.calls.find(([cmd]) => cmd.__type === 'CreateMemoryCommand');
    expect(call[0].input.name).toBe('HiveMemory');
    expect(call[0].input.memoryStrategies).toEqual([
      { semanticMemoryStrategy: { name: 'semantic_strategy' } },
      { summaryMemoryStrategy: { name: 'summary_strategy' } },
    ]);
  });
});
