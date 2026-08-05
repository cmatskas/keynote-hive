/**
 * Tests for adminSetup.js (Flow 2 — Admin tab, aws-keynote-only).
 *
 * Covers: KB/Gateway-target status checks are read-only (never call a
 * mutating command), previewGatewayPolicyChange() never calls
 * PutResourcePolicy/DeleteResourcePolicy itself (only applyGatewayResourcePolicy
 * does), and the diff correctly adds/removes principals including the
 * "remove the statement entirely when the last principal is revoked" edge
 * case.
 */
jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockAgentCoreSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: jest.fn().mockImplementation(() => ({ send: mockAgentCoreSend })),
  GetResourcePolicyCommand: jest.fn((input) => ({ __type: 'GetResourcePolicyCommand', input })),
  PutResourcePolicyCommand: jest.fn((input) => ({ __type: 'PutResourcePolicyCommand', input })),
  DeleteResourcePolicyCommand: jest.fn((input) => ({ __type: 'DeleteResourcePolicyCommand', input })),
  ListGatewaysCommand: jest.fn((input) => ({ __type: 'ListGatewaysCommand', input })),
  ListGatewayTargetsCommand: jest.fn((input) => ({ __type: 'ListGatewayTargetsCommand', input })),
}));

const mockBedrockAgentSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: jest.fn().mockImplementation(() => ({ send: mockBedrockAgentSend })),
  ListKnowledgeBasesCommand: jest.fn((input) => ({ __type: 'ListKnowledgeBasesCommand', input })),
  GetKnowledgeBaseCommand: jest.fn((input) => ({ __type: 'GetKnowledgeBaseCommand', input })),
}));

const adminSetup = require('../../src/main/models/adminSetup');

function credentials() {
  return { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' };
}

function notFoundError(name) {
  const err = new Error('not found');
  err.name = name;
  return err;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('checkKnowledgeBaseStatus()', () => {
  test('reports ready with the resolved id/arn when the KB exists and is ACTIVE', async () => {
    mockBedrockAgentSend.mockImplementation((cmd) => {
      if (cmd.__type === 'ListKnowledgeBasesCommand') {
        return Promise.resolve({ knowledgeBaseSummaries: [{ name: 'hive-shared-kb', knowledgeBaseId: 'KB123' }] });
      }
      if (cmd.__type === 'GetKnowledgeBaseCommand') {
        return Promise.resolve({ knowledgeBase: { status: 'ACTIVE', knowledgeBaseArn: 'arn:aws:bedrock:us-east-1:123:knowledge-base/KB123' } });
      }
    });

    const status = await adminSetup.checkKnowledgeBaseStatus(credentials(), 'us-east-1', 'hive-shared-kb');

    expect(status.status).toBe('ready');
    expect(status.knowledgeBaseId).toBe('KB123');
    expect(status.knowledgeBaseArn).toBe('arn:aws:bedrock:us-east-1:123:knowledge-base/KB123');
  });

  test('reports missing when no KB with that name exists', async () => {
    mockBedrockAgentSend.mockResolvedValue({ knowledgeBaseSummaries: [] });

    const status = await adminSetup.checkKnowledgeBaseStatus(credentials(), 'us-east-1', 'hive-shared-kb');

    expect(status.status).toBe('missing');
  });

  test('never calls a mutating command', async () => {
    mockBedrockAgentSend.mockResolvedValue({ knowledgeBaseSummaries: [{ name: 'hive-shared-kb', knowledgeBaseId: 'KB123' }] });

    await adminSetup.checkKnowledgeBaseStatus(credentials(), 'us-east-1', 'hive-shared-kb');

    mockBedrockAgentSend.mock.calls.forEach(([cmd]) => {
      expect(['ListKnowledgeBasesCommand', 'GetKnowledgeBaseCommand']).toContain(cmd.__type);
    });
  });
});

describe('checkGatewayKbTarget()', () => {
  test('returns gatewayArn alongside status when the gateway exists', async () => {
    mockAgentCoreSend.mockImplementation((cmd) => {
      if (cmd.__type === 'ListGatewaysCommand') {
        return Promise.resolve({ items: [{ name: 'hive-shared-gateway', gatewayId: 'gw-1', gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:123:gateway/gw-1', status: 'READY' }] });
      }
      if (cmd.__type === 'ListGatewayTargetsCommand') {
        return Promise.resolve({ items: [{ name: 'hive-knowledge-base', targetId: 't-1', status: 'READY' }] });
      }
    });

    const status = await adminSetup.checkGatewayKbTarget(credentials(), 'us-east-1', 'hive-shared-gateway', 'hive-knowledge-base');

    expect(status.status).toBe('ready');
    expect(status.gatewayArn).toBe('arn:aws:bedrock-agentcore:us-east-1:123:gateway/gw-1');
  });

  test('reports missing when the gateway has no matching target yet, but still returns gatewayArn', async () => {
    mockAgentCoreSend.mockImplementation((cmd) => {
      if (cmd.__type === 'ListGatewaysCommand') {
        return Promise.resolve({ items: [{ name: 'hive-shared-gateway', gatewayId: 'gw-1', gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:123:gateway/gw-1', status: 'READY' }] });
      }
      if (cmd.__type === 'ListGatewayTargetsCommand') {
        return Promise.resolve({ items: [] });
      }
    });

    const status = await adminSetup.checkGatewayKbTarget(credentials(), 'us-east-1', 'hive-shared-gateway', 'hive-knowledge-base');

    expect(status.status).toBe('missing');
    expect(status.gatewayArn).toBe('arn:aws:bedrock-agentcore:us-east-1:123:gateway/gw-1');
  });
});

describe('previewGatewayPolicyChange()', () => {
  const gatewayArn = 'arn:aws:bedrock-agentcore:us-east-1:123:gateway/gw-1';

  test('adds a new statement when granting access and no policy exists yet', async () => {
    mockAgentCoreSend.mockRejectedValue(notFoundError('ResourceNotFoundException'));

    const result = await adminSetup.previewGatewayPolicyChange(credentials(), 'us-east-1', gatewayArn, 'grant', 'arn:aws:iam::999:role/some-role');

    expect(result.changed).toBe(true);
    expect(result.before).toBeNull();
    expect(result.after.Statement).toHaveLength(1);
    expect(result.after.Statement[0].Principal.AWS).toEqual(['arn:aws:iam::999:role/some-role']);
    expect(result.after.Statement[0].Action).toBe('bedrock-agentcore:InvokeGateway');
  });

  test('appends to an existing principal list when granting a second role', async () => {
    mockAgentCoreSend.mockResolvedValue({
      policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Sid: 'HiveAdminGrantedPrincipals', Effect: 'Allow', Principal: { AWS: ['arn:aws:iam::999:role/existing'] }, Action: 'bedrock-agentcore:InvokeGateway', Resource: gatewayArn }],
      }),
    });

    const result = await adminSetup.previewGatewayPolicyChange(credentials(), 'us-east-1', gatewayArn, 'grant', 'arn:aws:iam::999:role/new-role');

    expect(result.changed).toBe(true);
    expect(result.after.Statement[0].Principal.AWS).toEqual(['arn:aws:iam::999:role/existing', 'arn:aws:iam::999:role/new-role']);
  });

  test('reports no change when granting a role that already has access', async () => {
    mockAgentCoreSend.mockResolvedValue({
      policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Sid: 'HiveAdminGrantedPrincipals', Effect: 'Allow', Principal: { AWS: ['arn:aws:iam::999:role/existing'] }, Action: 'bedrock-agentcore:InvokeGateway', Resource: gatewayArn }],
      }),
    });

    const result = await adminSetup.previewGatewayPolicyChange(credentials(), 'us-east-1', gatewayArn, 'grant', 'arn:aws:iam::999:role/existing');

    expect(result.changed).toBe(false);
    expect(result.reason).toMatch(/already has access/);
  });

  test('reports no change when revoking a role that does not currently have access', async () => {
    mockAgentCoreSend.mockRejectedValue(notFoundError('ResourceNotFoundException'));

    const result = await adminSetup.previewGatewayPolicyChange(credentials(), 'us-east-1', gatewayArn, 'revoke', 'arn:aws:iam::999:role/never-granted');

    expect(result.changed).toBe(false);
    expect(result.reason).toMatch(/does not currently have access/);
  });

  test('removes the statement entirely when revoking the last remaining principal', async () => {
    mockAgentCoreSend.mockResolvedValue({
      policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Sid: 'HiveAdminGrantedPrincipals', Effect: 'Allow', Principal: { AWS: ['arn:aws:iam::999:role/only-one'] }, Action: 'bedrock-agentcore:InvokeGateway', Resource: gatewayArn }],
      }),
    });

    const result = await adminSetup.previewGatewayPolicyChange(credentials(), 'us-east-1', gatewayArn, 'revoke', 'arn:aws:iam::999:role/only-one');

    expect(result.changed).toBe(true);
    expect(result.after.Statement).toEqual([]);
  });

  test('preserves unrelated statements already on the policy', async () => {
    mockAgentCoreSend.mockResolvedValue({
      policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          { Sid: 'SomeOtherStatement', Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::555:role/other' }, Action: 'bedrock-agentcore:GetGateway', Resource: gatewayArn },
        ],
      }),
    });

    const result = await adminSetup.previewGatewayPolicyChange(credentials(), 'us-east-1', gatewayArn, 'grant', 'arn:aws:iam::999:role/new-role');

    expect(result.after.Statement).toHaveLength(2);
    expect(result.after.Statement.some(s => s.Sid === 'SomeOtherStatement')).toBe(true);
  });

  test('never calls PutResourcePolicy or DeleteResourcePolicy itself', async () => {
    mockAgentCoreSend.mockRejectedValue(notFoundError('ResourceNotFoundException'));

    await adminSetup.previewGatewayPolicyChange(credentials(), 'us-east-1', gatewayArn, 'grant', 'arn:aws:iam::999:role/some-role');

    mockAgentCoreSend.mock.calls.forEach(([cmd]) => {
      expect(['PutResourcePolicyCommand', 'DeleteResourcePolicyCommand']).not.toContain(cmd.__type);
    });
  });
});

describe('applyGatewayResourcePolicy()', () => {
  const gatewayArn = 'arn:aws:bedrock-agentcore:us-east-1:123:gateway/gw-1';

  test('calls PutResourcePolicy with the exact document passed in', async () => {
    mockAgentCoreSend.mockResolvedValue({});
    const doc = { Version: '2012-10-17', Statement: [{ Sid: 'X', Effect: 'Allow', Principal: { AWS: ['a'] }, Action: 'bedrock-agentcore:InvokeGateway', Resource: gatewayArn }] };

    const result = await adminSetup.applyGatewayResourcePolicy(credentials(), 'us-east-1', gatewayArn, doc);

    expect(result.applied).toBe(true);
    const call = mockAgentCoreSend.mock.calls.find(([cmd]) => cmd.__type === 'PutResourcePolicyCommand');
    expect(JSON.parse(call[0].input.policy)).toEqual(doc);
  });

  test('calls DeleteResourcePolicy instead of PutResourcePolicy when the document has no statements left', async () => {
    mockAgentCoreSend.mockResolvedValue({});
    const doc = { Version: '2012-10-17', Statement: [] };

    const result = await adminSetup.applyGatewayResourcePolicy(credentials(), 'us-east-1', gatewayArn, doc);

    expect(result.applied).toBe(true);
    expect(result.policy).toBeNull();
    expect(mockAgentCoreSend.mock.calls.some(([cmd]) => cmd.__type === 'DeleteResourcePolicyCommand')).toBe(true);
    expect(mockAgentCoreSend.mock.calls.some(([cmd]) => cmd.__type === 'PutResourcePolicyCommand')).toBe(false);
  });
});
