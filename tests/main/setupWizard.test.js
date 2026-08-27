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

const mockStsSend = jest.fn();
jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({ send: mockStsSend })),
  GetCallerIdentityCommand: jest.fn((input) => ({ __type: 'GetCallerIdentityCommand', input })),
}));

const mockAgentCoreSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: jest.fn().mockImplementation(() => ({ send: mockAgentCoreSend })),
  ListGatewaysCommand: jest.fn((input) => ({ __type: 'ListGatewaysCommand', input })),
  GetMemoryCommand: jest.fn((input) => ({ __type: 'GetMemoryCommand', input })),
  CreateMemoryCommand: jest.fn((input) => ({ __type: 'CreateMemoryCommand', input })),
}));

const mockAgentCoreDataSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn().mockImplementation(() => ({ send: mockAgentCoreDataSend })),
  StartCodeInterpreterSessionCommand: jest.fn((input) => ({ __type: 'StartCodeInterpreterSessionCommand', input })),
  StopCodeInterpreterSessionCommand: jest.fn((input) => ({ __type: 'StopCodeInterpreterSessionCommand', input })),
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
  // Default: Code Interpreter permission check succeeds (start + stop both
  // resolve) — existing tests above don't care about this item's status,
  // so this keeps them from needing per-test stubs of a client they never
  // intended to exercise. Tests that specifically care about this item
  // override the implementation themselves.
  mockAgentCoreDataSend.mockImplementation((cmd) => {
    if (cmd.__type === 'StartCodeInterpreterSessionCommand') return Promise.resolve({ sessionId: 'session-abc' });
    if (cmd.__type === 'StopCodeInterpreterSessionCommand') return Promise.resolve({});
    return Promise.resolve({});
  });
  // Default: account ID resolves, so bucket-name suggestions are available.
  // Tests that care about the no-account-id path override this.
  mockStsSend.mockResolvedValue({ Account: '111122223333' });
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

  describe('codeInterpreterPermission item', () => {
    test('reports ready when a Code Interpreter session can be started (and is immediately stopped)', async () => {
      mockAgentCoreSend.mockRejectedValue(notFoundError('ResourceNotFoundException'));
      mockIamSend.mockRejectedValue(notFoundError('NoSuchEntityException'));
      mockS3Send.mockRejectedValue(notFoundError('NotFound'));
      mockAgentCoreDataSend.mockImplementation((cmd) => {
        if (cmd.__type === 'StartCodeInterpreterSessionCommand') return Promise.resolve({ sessionId: 'session-xyz' });
        if (cmd.__type === 'StopCodeInterpreterSessionCommand') return Promise.resolve({});
      });

      const status = await setupWizard.checkStatus(credentials(), { bucketName: '', memoryId: '' });

      expect(status.codeInterpreterPermission.status).toBe('ready');
      // Must actually attempt a real start — this can't be verified any
      // other way (no IAM policy simulation call exists for this check).
      const startCall = mockAgentCoreDataSend.mock.calls.find(([cmd]) => cmd.__type === 'StartCodeInterpreterSessionCommand');
      expect(startCall).toBeDefined();
      expect(startCall[0].input.codeInterpreterIdentifier).toBe('aws.codeinterpreter.v1');
      // And must clean up the session it started rather than leaking it.
      const stopCall = mockAgentCoreDataSend.mock.calls.find(([cmd]) => cmd.__type === 'StopCodeInterpreterSessionCommand');
      expect(stopCall).toBeDefined();
      expect(stopCall[0].input.sessionId).toBe('session-xyz');
    });

    test('reports action_required (not missing) when starting a session is denied', async () => {
      mockAgentCoreSend.mockRejectedValue(notFoundError('ResourceNotFoundException'));
      mockIamSend.mockRejectedValue(notFoundError('NoSuchEntityException'));
      mockS3Send.mockRejectedValue(notFoundError('NotFound'));
      mockAgentCoreDataSend.mockImplementation((cmd) => {
        if (cmd.__type === 'StartCodeInterpreterSessionCommand') {
          const err = new Error('User is not authorized to perform: bedrock-agentcore:StartCodeInterpreterSession');
          err.name = 'AccessDeniedException';
          return Promise.reject(err);
        }
      });

      const status = await setupWizard.checkStatus(credentials(), { bucketName: '', memoryId: '' });

      expect(status.codeInterpreterPermission.status).toBe('action_required');
      expect(status.codeInterpreterPermission.detail).toMatch(/StartCodeInterpreterSession/);
      // A denied Start should never attempt a Stop — there's no session to stop.
      expect(mockAgentCoreDataSend.mock.calls.some(([cmd]) => cmd.__type === 'StopCodeInterpreterSessionCommand')).toBe(false);
    });

    test('reports action_required when denied via a 403 status code instead of AccessDeniedException name', async () => {
      mockAgentCoreSend.mockRejectedValue(notFoundError('ResourceNotFoundException'));
      mockIamSend.mockRejectedValue(notFoundError('NoSuchEntityException'));
      mockS3Send.mockRejectedValue(notFoundError('NotFound'));
      mockAgentCoreDataSend.mockImplementation((cmd) => {
        if (cmd.__type === 'StartCodeInterpreterSessionCommand') {
          const err = new Error('Forbidden');
          err.$metadata = { httpStatusCode: 403 };
          return Promise.reject(err);
        }
      });

      const status = await setupWizard.checkStatus(credentials(), { bucketName: '', memoryId: '' });

      expect(status.codeInterpreterPermission.status).toBe('action_required');
    });

    test('reports unknown for unrelated errors (not mistaken for a permission gap)', async () => {
      mockAgentCoreSend.mockRejectedValue(notFoundError('ResourceNotFoundException'));
      mockIamSend.mockRejectedValue(notFoundError('NoSuchEntityException'));
      mockS3Send.mockRejectedValue(notFoundError('NotFound'));
      mockAgentCoreDataSend.mockImplementation((cmd) => {
        if (cmd.__type === 'StartCodeInterpreterSessionCommand') {
          return Promise.reject(new Error('ServiceUnavailable: try again later'));
        }
      });

      const status = await setupWizard.checkStatus(credentials(), { bucketName: '', memoryId: '' });

      expect(status.codeInterpreterPermission.status).toBe('unknown');
    });

    test('still reports ready even if cleanup (Stop) fails — the permission itself was proven by Start succeeding', async () => {
      mockAgentCoreSend.mockRejectedValue(notFoundError('ResourceNotFoundException'));
      mockIamSend.mockRejectedValue(notFoundError('NoSuchEntityException'));
      mockS3Send.mockRejectedValue(notFoundError('NotFound'));
      mockAgentCoreDataSend.mockImplementation((cmd) => {
        if (cmd.__type === 'StartCodeInterpreterSessionCommand') return Promise.resolve({ sessionId: 'session-leaky' });
        if (cmd.__type === 'StopCodeInterpreterSessionCommand') return Promise.reject(new Error('stop failed'));
      });

      const status = await setupWizard.checkStatus(credentials(), { bucketName: '', memoryId: '' });

      expect(status.codeInterpreterPermission.status).toBe('ready');
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

/**
 * Transcription needs two buckets: the input one media is uploaded to, and the
 * output one Transcribe writes the transcript into. Only the input bucket used
 * to be checked, so a blank output bucket passed Setup Check silently and then
 * broke transcription at the point of use with an opaque AWS error.
 */
describe('suggestBucketName()', () => {
  test('scopes the name to the account so the global S3 namespace is not contended', () => {
    expect(setupWizard.suggestBucketName('111122223333', 'input')).toBe('hive-media-111122223333');
    expect(setupWizard.suggestBucketName('111122223333', 'output')).toBe('hive-transcripts-111122223333');
  });

  test('produces names that satisfy S3 naming rules', () => {
    for (const kind of ['input', 'output']) {
      const name = setupWizard.suggestBucketName('111122223333', kind);
      expect(name.length).toBeGreaterThanOrEqual(3);
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(/^[a-z0-9][.\-a-z0-9]{1,61}[a-z0-9]$/);
    }
  });

  test('returns null when the account id is unknown, rather than a bogus name', () => {
    expect(setupWizard.suggestBucketName(null, 'output')).toBeNull();
    expect(setupWizard.suggestBucketName('', 'output')).toBeNull();
  });
});

describe('checkStatus() transcription output bucket', () => {
  test('checks both buckets, not just the input one', async () => {
    mockS3Send.mockResolvedValue({});
    mockAgentCoreSend.mockRejectedValue(notFoundError('ResourceNotFoundException'));

    const status = await setupWizard.checkStatus(credentials(), {
      bucketName: 'my-input',
      outputBucketName: 'my-output',
    });

    expect(status.transcriptionBucket.status).toBe('ready');
    expect(status.transcriptionOutputBucket.status).toBe('ready');

    const headed = mockS3Send.mock.calls
      .filter(([cmd]) => cmd.__type === 'HeadBucketCommand')
      .map(([cmd]) => cmd.input.Bucket);
    expect(headed).toEqual(expect.arrayContaining(['my-input', 'my-output']));
  });

  test('reports the output bucket missing when unconfigured, with a suggestion', async () => {
    mockS3Send.mockResolvedValue({});
    mockAgentCoreSend.mockRejectedValue(notFoundError('ResourceNotFoundException'));

    const status = await setupWizard.checkStatus(credentials(), {
      bucketName: 'my-input',
      outputBucketName: '',
    });

    expect(status.transcriptionOutputBucket.status).toBe('missing');
    expect(status.transcriptionOutputBucket.suggested).toBe('hive-transcripts-111122223333');
    expect(status.transcriptionOutputBucket.detail).toMatch(/hive-transcripts-111122223333/);
  });

  test('reports the output bucket missing when the configured one does not exist', async () => {
    mockS3Send.mockImplementation((cmd) => {
      if (cmd.__type === 'HeadBucketCommand' && cmd.input.Bucket === 'gone') {
        return Promise.reject(notFoundError('NotFound'));
      }
      return Promise.resolve({});
    });
    mockAgentCoreSend.mockRejectedValue(notFoundError('ResourceNotFoundException'));

    const status = await setupWizard.checkStatus(credentials(), {
      bucketName: 'my-input',
      outputBucketName: 'gone',
    });

    expect(status.transcriptionOutputBucket.status).toBe('missing');
    expect(status.transcriptionOutputBucket.detail).toMatch(/'gone' not found/);
  });

  test('still reports statuses when the account id cannot be resolved — just without suggestions', async () => {
    mockStsSend.mockRejectedValue(new Error('AccessDenied'));
    mockS3Send.mockResolvedValue({});
    mockAgentCoreSend.mockRejectedValue(notFoundError('ResourceNotFoundException'));

    const status = await setupWizard.checkStatus(credentials(), { bucketName: '', outputBucketName: '' });

    expect(status.transcriptionOutputBucket.status).toBe('missing');
    expect(status.transcriptionOutputBucket.suggested).toBeNull();
  });

  test('resolving the account id does not make checkStatus mutate anything', async () => {
    mockS3Send.mockResolvedValue({});
    mockAgentCoreSend.mockRejectedValue(notFoundError('ResourceNotFoundException'));

    await setupWizard.checkStatus(credentials(), { bucketName: 'a', outputBucketName: 'b' });

    const mutating = [...mockS3Send.mock.calls, ...mockIamSend.mock.calls, ...mockAgentCoreSend.mock.calls]
      .map(([cmd]) => cmd.__type)
      .filter(type => /^Create/.test(type || ''));
    expect(mutating).toEqual([]);
  });
});

/**
 * Regression: a brand-new install could not create the Web Search Gateway role.
 * The IAM `Description` contained an em dash, and AWS rejected the whole
 * CreateRole call — "Value at 'description' failed to satisfy constraint" — so
 * setup failed with an opaque regex complaint and no way forward.
 *
 * Asserting on the value actually handed to the SDK, rather than on the source
 * literal, is what makes this a real guard: it holds however the string is built.
 */
describe('AWS text constraints on created resources', () => {
  const { isAwsSafeText } = require('../../src/main/awsText');

  test('the role description satisfies the constraint AWS enforces', async () => {
    mockIamSend.mockImplementation((cmd) => {
      if (cmd.__type === 'GetRoleCommand') return Promise.reject(notFoundError('NoSuchEntityException'));
      if (cmd.__type === 'CreateRoleCommand') return Promise.resolve({ Role: { Arn: 'arn:aws:iam::1:role/hive-web-search-gateway' } });
      return Promise.resolve({});
    });

    await setupWizard.createWebSearchGatewayRole(credentials(), 'us-east-1');

    const create = mockIamSend.mock.calls.find(([cmd]) => cmd.__type === 'CreateRoleCommand');
    expect(create).toBeDefined();
    const description = create[0].input.Description;
    expect(description).toBeTruthy();
    expect(isAwsSafeText(description)).toBe(true);
    // Specifically the character that broke it.
    expect(description).not.toMatch(/[\u2010-\u2015]/);
  });

  test('every string sent to CreateRole is within the accepted range', async () => {
    // Not just the description: role name and policy documents travel the same way.
    mockIamSend.mockImplementation((cmd) => {
      if (cmd.__type === 'GetRoleCommand') return Promise.reject(notFoundError('NoSuchEntityException'));
      if (cmd.__type === 'CreateRoleCommand') return Promise.resolve({ Role: { Arn: 'arn:aws:iam::1:role/x' } });
      return Promise.resolve({});
    });

    await setupWizard.createWebSearchGatewayRole(credentials(), 'us-east-1');

    for (const [cmd] of mockIamSend.mock.calls) {
      for (const value of Object.values(cmd.input || {})) {
        if (typeof value === 'string') expect(isAwsSafeText(value)).toBe(true);
      }
    }
  });
});
