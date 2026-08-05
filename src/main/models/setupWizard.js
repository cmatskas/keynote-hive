/**
 * setupWizard.js — one-time, per-user AWS resource bootstrapping for Hive.
 *
 * This is Flow 1 of Hive's two-tier setup system (see README's "Setup
 * Check" section): a non-sequential checklist of independent AWS resources
 * that Hive needs in the *current user's own account* — the Web Search
 * Gateway execution role, a transcription S3 bucket, and an AgentCore
 * Memory resource. Each item is checked and created independently; there is
 * no ordering dependency between them, which is why the UI built on top of
 * this module is a checklist rather than a linear wizard (see design notes
 * in chat history — a forced Step 1→2→3 flow would add friction without
 * adding safety, since nothing here depends on anything else completing
 * first).
 *
 * This module intentionally requires MORE IAM permission than the rest of
 * Hive's normal runtime operation (iam:CreateRole, iam:PutRolePolicy,
 * s3:CreateBucket) — those are setup-only capabilities, used exclusively by
 * the functions in this file, not by any other part of the app. This is a
 * deliberate, documented scope expansion (see README), not an oversight.
 *
 * Distinct from adminSetup.js (Flow 2), which operates on shared,
 * organization-wide resources in a specific admin AWS account and is gated
 * by account ID — this module only ever touches whatever account the
 * user's own currently-loaded credentials point at.
 */
const { IAMClient, GetRoleCommand, CreateRoleCommand, PutRolePolicyCommand } = require('@aws-sdk/client-iam');
const { S3Client, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
const {
  BedrockAgentCoreControlClient,
  ListGatewaysCommand,
  GetMemoryCommand,
  CreateMemoryCommand,
} = require('@aws-sdk/client-bedrock-agentcore-control');
const log = require('electron-log/main');

const WEB_SEARCH_GATEWAY_NAME = 'hive-web-search';
const WEB_SEARCH_ROLE_NAME = 'hive-web-search-gateway';

// Exact trust policy documented in README's "AgentCore Gateway Setup (Web
// Search)" section — must trust bedrock-agentcore.amazonaws.com so the
// Gateway service can assume this role.
const WEB_SEARCH_TRUST_POLICY = {
  Version: '2012-10-17',
  Statement: [{
    Effect: 'Allow',
    Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
    Action: 'sts:AssumeRole',
  }],
};

// Exact permissions policy documented in the same README section.
const WEB_SEARCH_PERMISSIONS_POLICY = {
  Version: '2012-10-17',
  Statement: [{
    Effect: 'Allow',
    Action: [
      'bedrock-agentcore:InvokeGateway',
      'bedrock-agentcore:InvokeWebSearch',
    ],
    Resource: '*',
  }],
};

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
    iam: new IAMClient(clientConfig),
    s3: new S3Client(clientConfig),
    agentCoreControl: new BedrockAgentCoreControlClient(clientConfig),
  };
}

/**
 * Check-only pass (no mutating calls) across all Flow 1 items. Returns a
 * status object safe to call on every app launch / Settings visit — never
 * creates anything itself.
 *
 * @param {object} credentials - { accessKeyId, secretAccessKey, sessionToken, region }
 * @param {object} settings - Hive settings (reads bucketName, outputBucketName, memoryId)
 * @returns {Promise<{webSearchGateway: object, transcriptionBucket: object, memory: object}>}
 */
async function checkStatus(credentials, settings) {
  const region = credentials.region || settings.region || 'us-east-1';
  const { iam, s3, agentCoreControl } = buildClients(credentials, region);

  const [webSearchGateway, transcriptionBucket, memory] = await Promise.all([
    _checkWebSearchGateway(agentCoreControl, iam),
    _checkTranscriptionBucket(s3, settings.bucketName),
    _checkMemory(agentCoreControl, settings.memoryId),
  ]);

  return { webSearchGateway, transcriptionBucket, memory };
}

async function _checkWebSearchGateway(agentCoreControl, iam) {
  try {
    // Web Search Gateway always lives in us-east-1 regardless of the
    // user's configured region (same constraint webSearchManager.js
    // documents) — but the role itself can be created in any region since
    // IAM is a global service; we still check role existence via the
    // caller's region-scoped IAM client since IAM calls aren't region-
    // sensitive in practice.
    const resp = await agentCoreControl.send(new ListGatewaysCommand({ maxResults: 100 }));
    const exists = (resp.items || []).some(g => g.name === WEB_SEARCH_GATEWAY_NAME && g.status !== 'CREATE_FAILED' && g.status !== 'DELETE_FAILED');
    if (exists) return { status: 'ready', detail: `Gateway '${WEB_SEARCH_GATEWAY_NAME}' already exists` };
  } catch (err) {
    log.warn(`[setupWizard] Gateway lookup failed, falling back to role check: ${err.message}`);
  }

  try {
    await iam.send(new GetRoleCommand({ RoleName: WEB_SEARCH_ROLE_NAME }));
    return { status: 'ready', detail: `Role '${WEB_SEARCH_ROLE_NAME}' exists — Gateway will be created on first web search use` };
  } catch (err) {
    if (err.name === 'NoSuchEntityException') {
      return { status: 'missing', detail: `No Gateway or execution role found — needed for Work/Swarm web search` };
    }
    return { status: 'unknown', detail: `Could not check: ${err.message}` };
  }
}

async function _checkTranscriptionBucket(s3, bucketName) {
  if (!bucketName) {
    return { status: 'missing', detail: 'No bucket configured — needed for the Transcribe tab' };
  }
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    return { status: 'ready', detail: `Bucket '${bucketName}' exists` };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return { status: 'missing', detail: `Bucket '${bucketName}' not found` };
    }
    return { status: 'unknown', detail: `Could not check: ${err.message}` };
  }
}

async function _checkMemory(agentCoreControl, memoryId) {
  if (!memoryId) {
    return { status: 'missing', detail: 'No memory resource configured — needed for Work tab conversation memory' };
  }
  try {
    const resp = await agentCoreControl.send(new GetMemoryCommand({ memoryId }));
    if (resp.memory?.status === 'ACTIVE' || resp.status === 'ACTIVE') {
      return { status: 'ready', detail: `Memory '${memoryId}' is active` };
    }
    return { status: 'ready', detail: `Memory '${memoryId}' exists (status: ${resp.memory?.status || resp.status || 'unknown'})` };
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      return { status: 'missing', detail: `Memory '${memoryId}' not found` };
    }
    return { status: 'unknown', detail: `Could not check: ${err.message}` };
  }
}

/**
 * Create the Web Search Gateway execution role (idempotent — safe to call
 * even if the role already exists, in which case it returns the existing
 * ARN rather than erroring). Does NOT create the Gateway itself — that
 * still happens on first web search use via webSearchManager.js, exactly
 * as before. This function only removes the manual "open the AWS console
 * and create an IAM role" step.
 *
 * @returns {Promise<string>} the role's ARN
 */
async function createWebSearchGatewayRole(credentials, region) {
  const { iam } = buildClients(credentials, region);

  try {
    const existing = await iam.send(new GetRoleCommand({ RoleName: WEB_SEARCH_ROLE_NAME }));
    return existing.Role.Arn;
  } catch (err) {
    if (err.name !== 'NoSuchEntityException') throw err;
  }

  const created = await iam.send(new CreateRoleCommand({
    RoleName: WEB_SEARCH_ROLE_NAME,
    AssumeRolePolicyDocument: JSON.stringify(WEB_SEARCH_TRUST_POLICY),
    Description: 'Created by Hive Setup Check — allows AgentCore Gateway to run the Web Search Tool target',
  }));

  await iam.send(new PutRolePolicyCommand({
    RoleName: WEB_SEARCH_ROLE_NAME,
    PolicyName: 'hive-web-search-gateway-permissions',
    PolicyDocument: JSON.stringify(WEB_SEARCH_PERMISSIONS_POLICY),
  }));

  log.info(`[setupWizard] Created IAM role '${WEB_SEARCH_ROLE_NAME}': ${created.Role.Arn}`);
  return created.Role.Arn;
}

/**
 * Create a transcription S3 bucket (idempotent — returns the existing
 * bucket name without erroring if it already exists and is accessible).
 *
 * @returns {Promise<string>} the bucket name
 */
async function createTranscriptionBucket(credentials, region, bucketName) {
  const { s3 } = buildClients(credentials, region);

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    return bucketName; // already exists
  } catch (err) {
    if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) throw err;
  }

  const createParams = { Bucket: bucketName };
  // us-east-1 is AWS's implicit default and rejects an explicit
  // LocationConstraint for that region specifically — every other region
  // requires it.
  if (region && region !== 'us-east-1') {
    createParams.CreateBucketConfiguration = { LocationConstraint: region };
  }
  await s3.send(new CreateBucketCommand(createParams));
  log.info(`[setupWizard] Created S3 bucket '${bucketName}' in ${region}`);
  return bucketName;
}

/**
 * Create an AgentCore Memory resource (idempotent — returns the existing
 * memoryId if one with this name already exists is not checked here since
 * Memory names aren't queried by name via a list call in this module;
 * callers should only invoke this when checkStatus() has already reported
 * 'missing' for a configured memoryId, or when no memoryId is configured
 * yet at all).
 *
 * @returns {Promise<string>} the created memory's ID
 */
async function createMemory(credentials, region, name = 'HiveMemory') {
  const { agentCoreControl } = buildClients(credentials, region);
  const created = await agentCoreControl.send(new CreateMemoryCommand({
    name,
    eventExpiryDuration: 30,
    memoryStrategies: [
      { semanticMemoryStrategy: { name: 'semantic_strategy' } },
      { summaryMemoryStrategy: { name: 'summary_strategy' } },
    ],
  }));
  const memoryId = created.memory?.id || created.id;
  log.info(`[setupWizard] Created AgentCore Memory '${name}': ${memoryId}`);
  return memoryId;
}

module.exports = {
  checkStatus,
  createWebSearchGatewayRole,
  createTranscriptionBucket,
  createMemory,
  WEB_SEARCH_GATEWAY_NAME,
  WEB_SEARCH_ROLE_NAME,
};
