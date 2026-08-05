/**
 * adminSetup.js — Flow 2 of Hive's two-tier setup system: admin-only
 * management of shared, organization-wide resources (a Managed Knowledge
 * Base and its AgentCore Gateway cross-account resource policy).
 *
 * Unlike setupWizard.js (Flow 1, per-user, runs against whatever account
 * the user's own credentials point at), every function here is intended to
 * be called ONLY while the currently-loaded credentials belong to the
 * shared admin AWS account (gated in the renderer by isAdminAccount from
 * awsValidator.js — see that file for the account-ID constant). This
 * module does not itself enforce that gate; AWS IAM does, by rejecting
 * these calls outright if the loaded credentials don't have permissions in
 * that account. The renderer-side gate is a UX convenience (don't show the
 * tab to people who can't use it), not the security boundary.
 *
 * Scope deliberately excludes Managed Knowledge Base *creation* — creating
 * one involves real one-time decisions (connectors, embedding model,
 * storage config) that are better made deliberately in the AWS console
 * once, not wrapped in an automated wizard. This module only checks status
 * of an already-created KB and manages the recurring, lower-stakes task of
 * granting/revoking individual IAM principals' access to the Gateway that
 * fronts it — that's the part that benefits from an in-app flow, since
 * it's something that recurs every time team membership changes.
 */
const {
  BedrockAgentCoreControlClient,
  GetResourcePolicyCommand,
  PutResourcePolicyCommand,
  ListGatewaysCommand,
  ListGatewayTargetsCommand,
} = require('@aws-sdk/client-bedrock-agentcore-control');
const { BedrockAgentClient, ListKnowledgeBasesCommand, GetKnowledgeBaseCommand } = require('@aws-sdk/client-bedrock-agent');
const log = require('electron-log/main');

function buildClients(credentials, region) {
  const clientConfig = {
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  };
  return {
    agentCoreControl: new BedrockAgentCoreControlClient(clientConfig),
    bedrockAgent: new BedrockAgentClient(clientConfig),
  };
}

/**
 * Read-only check: does a Managed Knowledge Base exist in this account
 * (by name), and what's its status? Does not create one — see module doc
 * comment for why.
 */
async function checkKnowledgeBaseStatus(credentials, region, kbName) {
  const { bedrockAgent } = buildClients(credentials, region);
  try {
    const resp = await bedrockAgent.send(new ListKnowledgeBasesCommand({ maxResults: 100 }));
    const match = (resp.knowledgeBaseSummaries || []).find(kb => kb.name === kbName);
    if (!match) return { status: 'missing', detail: `No knowledge base named '${kbName}' found` };

    const detail = await bedrockAgent.send(new GetKnowledgeBaseCommand({ knowledgeBaseId: match.knowledgeBaseId }));
    return {
      status: detail.knowledgeBase?.status === 'ACTIVE' ? 'ready' : 'pending',
      detail: `'${kbName}' (${match.knowledgeBaseId}) — ${detail.knowledgeBase?.status || 'unknown status'}`,
      knowledgeBaseId: match.knowledgeBaseId,
      knowledgeBaseArn: detail.knowledgeBase?.knowledgeBaseArn,
    };
  } catch (err) {
    return { status: 'unknown', detail: `Could not check: ${err.message}` };
  }
}

/**
 * Read-only check: does the named Gateway have a Knowledge Base target
 * attached? Returns the gateway's id/ARN alongside the target status so
 * callers have what they need for the resource-policy functions below.
 */
async function checkGatewayKbTarget(credentials, region, gatewayName, kbTargetName) {
  const { agentCoreControl } = buildClients(credentials, region);
  try {
    const gwResp = await agentCoreControl.send(new ListGatewaysCommand({ maxResults: 100 }));
    const gateway = (gwResp.items || []).find(g => g.name === gatewayName && g.status !== 'CREATE_FAILED' && g.status !== 'DELETE_FAILED');
    if (!gateway) {
      return { status: 'missing', detail: `No gateway named '${gatewayName}' found` };
    }

    const targetsResp = await agentCoreControl.send(new ListGatewayTargetsCommand({ gatewayIdentifier: gateway.gatewayId }));
    const target = (targetsResp.items || []).find(t => t.name === kbTargetName);
    if (!target) {
      return {
        status: 'missing',
        detail: `Gateway '${gatewayName}' exists but has no '${kbTargetName}' target yet`,
        gatewayId: gateway.gatewayId,
        gatewayArn: gateway.gatewayArn,
      };
    }

    return {
      status: target.status === 'READY' ? 'ready' : 'pending',
      detail: `Target '${kbTargetName}' on gateway '${gatewayName}' — ${target.status}`,
      gatewayId: gateway.gatewayId,
      gatewayArn: gateway.gatewayArn,
      targetId: target.targetId,
    };
  } catch (err) {
    return { status: 'unknown', detail: `Could not check: ${err.message}` };
  }
}

/**
 * Fetch the Gateway's current resource-based policy. Returns null if none
 * is attached (not an error — a Gateway with no resource policy simply
 * isn't cross-account-accessible yet).
 */
async function getGatewayResourcePolicy(credentials, region, gatewayArn) {
  const { agentCoreControl } = buildClients(credentials, region);
  try {
    const resp = await agentCoreControl.send(new GetResourcePolicyCommand({ resourceArn: gatewayArn }));
    return resp.policy ? JSON.parse(resp.policy) : null;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

const INVOKE_GATEWAY_ACTION = 'bedrock-agentcore:InvokeGateway';
const GRANT_SID = 'HiveAdminGrantedPrincipals';

/**
 * Compute the resulting policy document for adding or removing a role ARN
 * from the Gateway's resource policy, WITHOUT applying it — this is the
 * "preview" half of the preview-then-apply pattern the Admin wizard's
 * review step depends on. Callers must pass the returned `after` document
 * to applyGatewayResourcePolicy() to actually apply it; nothing here
 * mutates the Gateway.
 *
 * @param {'grant'|'revoke'} action
 * @returns {Promise<{before: object|null, after: object, changed: boolean}>}
 */
async function previewGatewayPolicyChange(credentials, region, gatewayArn, action, roleArn) {
  const before = await getGatewayResourcePolicy(credentials, region, gatewayArn);

  let statement = (before?.Statement || []).find(s => s.Sid === GRANT_SID);
  let principals = statement ? _normalizePrincipalList(statement.Principal) : [];

  const already = principals.includes(roleArn);
  if (action === 'grant' && already) {
    return { before, after: before, changed: false, reason: `${roleArn} already has access` };
  }
  if (action === 'revoke' && !already) {
    return { before, after: before, changed: false, reason: `${roleArn} does not currently have access` };
  }

  principals = action === 'grant'
    ? [...principals, roleArn]
    : principals.filter(p => p !== roleArn);

  const otherStatements = (before?.Statement || []).filter(s => s.Sid !== GRANT_SID);

  let after;
  if (principals.length === 0) {
    // Revoking the last principal removes the statement entirely rather
    // than leaving an empty-Principal statement, which AWS would reject.
    after = { Version: '2012-10-17', Statement: otherStatements };
  } else {
    after = {
      Version: '2012-10-17',
      Statement: [
        ...otherStatements,
        {
          Sid: GRANT_SID,
          Effect: 'Allow',
          Principal: { AWS: principals },
          Action: INVOKE_GATEWAY_ACTION,
          Resource: gatewayArn,
        },
      ],
    };
  }

  return { before, after, changed: true };
}

function _normalizePrincipalList(principal) {
  if (!principal) return [];
  const aws = principal.AWS;
  if (!aws) return [];
  return Array.isArray(aws) ? aws : [aws];
}

/**
 * Apply a previously-previewed policy document. Takes the exact `after`
 * document from previewGatewayPolicyChange() rather than re-deriving it,
 * so the applied policy is guaranteed to be exactly what the admin
 * reviewed — no re-computation, no window for drift between preview and
 * apply.
 */
async function applyGatewayResourcePolicy(credentials, region, gatewayArn, policyDocument) {
  const { agentCoreControl } = buildClients(credentials, region);

  if (policyDocument.Statement.length === 0) {
    const { DeleteResourcePolicyCommand } = require('@aws-sdk/client-bedrock-agentcore-control');
    await agentCoreControl.send(new DeleteResourcePolicyCommand({ resourceArn: gatewayArn }));
    log.info(`[adminSetup] Removed resource policy from gateway ${gatewayArn} (no principals remaining)`);
    return { applied: true, policy: null };
  }

  await agentCoreControl.send(new PutResourcePolicyCommand({
    resourceArn: gatewayArn,
    policy: JSON.stringify(policyDocument),
  }));
  log.info(`[adminSetup] Updated resource policy on gateway ${gatewayArn}`);
  return { applied: true, policy: policyDocument };
}

module.exports = {
  checkKnowledgeBaseStatus,
  checkGatewayKbTarget,
  getGatewayResourcePolicy,
  previewGatewayPolicyChange,
  applyGatewayResourcePolicy,
  GRANT_SID,
  INVOKE_GATEWAY_ACTION,
};
