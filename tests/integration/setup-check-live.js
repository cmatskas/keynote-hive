#!/usr/bin/env node
/**
 * Live integration check for Setup Check's resource creation, against real AWS.
 *
 * WHY THIS FILE EXISTS
 * ---------------------
 * tests/main/setupWizard.test.js mocks the AWS SDK entirely. It can verify that
 * Hive sends what Hive *intends* to send, but it can never verify that AWS still
 * *accepts* it — nothing in that suite makes a real API call.
 *
 * That gap let a real failure reach a user on a brand-new install: creating the
 * Web Search Gateway died with
 *
 *   ValidationError: Value at 'description' failed to satisfy constraint:
 *   Member must satisfy regular expression pattern:
 *   [\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF]*
 *
 * The IAM role's Description contained an em dash. The pattern permits tab,
 * newline, carriage return, printable ASCII and Latin-1, and excludes the whole
 * U+2000 block where em dashes, curly quotes and ellipses live — so a
 * description written in ordinary prose was enough to break setup. A second,
 * unhit instance was waiting in the AgentCore Memory description.
 *
 * Unit tests now guard the specific fields (asserting the value handed to the
 * SDK, so the guard holds however the string is built), and src/main/awsText.js
 * sanitises on the way out. But only a real call can catch AWS *changing* or
 * extending a constraint, or a new required field, which is the same class of
 * problem tests/integration/mantle-live.js exists to catch for model routing.
 *
 * WHAT IT COVERS
 * ---------------
 * The two Setup Check paths that send free-text metadata to AWS, since those are
 * the ones exposed to this class of bug:
 *   1. setupWizard.createWebSearchGatewayRole() — IAM CreateRole + PutRolePolicy.
 *      Free, instant, cleanly deletable. This is the one that broke.
 *   2. MemoryManager.createMemory() — AgentCore CreateMemory. Behind its own flag
 *      because it is billable and its deletion is asynchronous.
 *
 * The transcription buckets are deliberately not covered: CreateBucket has no
 * free-text field, so there is nothing here to catch, and throwaway buckets would
 * pollute a global namespace for no coverage gain.
 *
 * SAFETY
 * -------
 * This creates and deletes REAL AWS resources, so:
 *   - Testing the real path means using the real resource names, which are
 *     hardcoded in the source. Pre-existence is therefore checked FIRST, and
 *     anything that already exists is verified and reported but NEVER deleted —
 *     it is not ours to remove.
 *   - Only what this run created is cleaned up. The role's inline policy is
 *     removed before the role itself, since DeleteRole fails otherwise.
 *   - Creation requires ALLOW_AWS_WRITES=1 in addition to working credentials,
 *     so nothing is provisioned by accident.
 *   - If interrupted between create and delete, the leftover is exactly the role
 *     Setup Check would have created legitimately — harmless, and the next run
 *     sees it as pre-existing and leaves it alone.
 *   - Credentials come from the environment or an AWS profile. Hive's own
 *     encrypted credential store is never read: safeStorage is bound to the
 *     signed app's identity, and a test has no business decrypting it.
 *
 * USAGE
 * ------
 *   npm run test:integration:aws                        # dry run: reports what it would do
 *   ALLOW_AWS_WRITES=1 npm run test:integration:aws     # actually create and clean up
 *   ALLOW_AWS_WRITES=1 INCLUDE_MEMORY=1 npm run test:integration:aws
 *
 * Needs credentials with iam:CreateRole, iam:PutRolePolicy, iam:GetRole,
 * iam:DeleteRole, iam:DeleteRolePolicy (and bedrock-agentcore:CreateMemory /
 * DeleteMemory for the memory check). An Admin role covers all of it.
 *
 * Exits 0 with a clear message when credentials are absent, so it never blocks
 * anyone. Set REQUIRE_AWS_CREDS=1 to make a missing credential a hard failure
 * instead — use that if this is ever wired into CI.
 */

const path = require('path');

// electron-log/main requires an Electron runtime; this is a plain Node script.
// Stub it before anything under src/main is loaded.
require.cache[require.resolve('electron-log/main')] = {
  id: 'electron-log/main',
  filename: 'electron-log/main',
  loaded: true,
  exports: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
};

const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const {
  IAMClient, GetRoleCommand, DeleteRoleCommand, DeleteRolePolicyCommand, ListRolePoliciesCommand,
} = require('@aws-sdk/client-iam');

const setupWizard = require('../../src/main/models/setupWizard');
const MemoryManager = require('../../src/main/models/memoryManager');
const { isAwsSafeText } = require('../../src/main/awsText');

const REGION = process.env.AWS_REGION || 'us-east-1';
const ALLOW_WRITES = process.env.ALLOW_AWS_WRITES === '1';
const INCLUDE_MEMORY = process.env.INCLUDE_MEMORY === '1';

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function credentialsFromEnvironment() {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) return null;
  return {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
    sessionToken: AWS_SESSION_TOKEN || undefined,
  };
}

function clientConfig(credentials) {
  return { region: REGION, credentials };
}

/** Confirm the credentials work at all, and report who they are. */
async function whoAmI(credentials) {
  const sts = new STSClient(clientConfig(credentials));
  const id = await sts.send(new GetCallerIdentityCommand({}));
  return id;
}

// ── Web Search Gateway role (the path that broke) ────────────────────────────

async function roleExists(iam, roleName) {
  try {
    const resp = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    return resp.Role;
  } catch (err) {
    if (err.name === 'NoSuchEntityException') return null;
    throw err;
  }
}

async function deleteRoleCompletely(iam, roleName) {
  // Inline policies must go first; DeleteRole fails while any remain.
  const { PolicyNames = [] } = await iam.send(new ListRolePoliciesCommand({ RoleName: roleName }));
  for (const PolicyName of PolicyNames) {
    await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName }));
  }
  await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
}

async function checkWebSearchRole(credentials) {
  const roleName = setupWizard.WEB_SEARCH_ROLE_NAME;
  const iam = new IAMClient(clientConfig(credentials));

  const preExisting = await roleExists(iam, roleName);
  if (preExisting) {
    // Verify what is actually stored on the live resource, then leave it alone.
    const description = preExisting.Description || '';
    record(
      `IAM role '${roleName}' already exists — not modified`,
      isAwsSafeText(description),
      description
        ? `live description is ${isAwsSafeText(description) ? 'within' : 'OUTSIDE'} the accepted range`
        : 'no description set',
    );
    return;
  }

  if (!ALLOW_WRITES) {
    record(`IAM role '${roleName}' absent — would create it`, true, 'set ALLOW_AWS_WRITES=1 to actually test creation');
    return;
  }

  let created = false;
  try {
    // The real function, not a reimplementation — that is the entire point.
    const arn = await setupWizard.createWebSearchGatewayRole(credentials, REGION);
    created = true;
    record(`CreateRole accepted by AWS`, true, arn);

    // Read it back: confirms the description survived the round trip rather than
    // just that the call did not throw.
    const live = await roleExists(iam, roleName);
    const description = live?.Description || '';
    record('description stored and within the accepted range', isAwsSafeText(description), description || '(empty)');
  } catch (err) {
    const isTheOldBug = /failed to satisfy constraint/i.test(err.message || '');
    record(
      'CreateRole accepted by AWS',
      false,
      isTheOldBug
        ? `${err.message}  <-- this is the v3.12.0 bug class: check descriptions against src/main/awsText.js`
        : err.message,
    );
  } finally {
    if (created) {
      try {
        await deleteRoleCompletely(iam, roleName);
        record('cleaned up the role this run created', true);
      } catch (err) {
        record('cleaned up the role this run created', false, `${err.message} — remove '${roleName}' by hand`);
      }
    }
  }
}

// ── AgentCore Memory (the second, unhit instance) ────────────────────────────

async function checkMemory(credentials) {
  const manager = new MemoryManager(clientConfig(credentials));

  const existing = await manager.findExistingMemory();
  if (existing) {
    record(`AgentCore Memory already exists — not modified`, true, `id ${existing.id}, status ${existing.status}`);
    return;
  }

  if (!ALLOW_WRITES) {
    record('AgentCore Memory absent — would create it', true, 'set ALLOW_AWS_WRITES=1 to actually test creation');
    return;
  }

  let createdId = null;
  try {
    const res = await manager.createMemory();
    if (res.alreadyExisted) {
      record('AgentCore Memory already existed — not modified', true, `id ${res.id}`);
      return;
    }
    createdId = res.id;
    record('CreateMemory accepted by AWS (description included)', true, `id ${res.id}, status ${res.status}`);
  } catch (err) {
    const isTheOldBug = /failed to satisfy constraint/i.test(err.message || '');
    record(
      'CreateMemory accepted by AWS (description included)',
      false,
      isTheOldBug
        ? `${err.message}  <-- same bug class as the Gateway failure: see src/main/awsText.js`
        : err.message,
    );
  } finally {
    if (createdId) {
      try {
        manager.setMemoryId(createdId);
        await manager.deleteMemory();
        // Deletion is asynchronous; the call returning is as much as we can assert.
        record('requested deletion of the memory this run created', true, 'deletion completes asynchronously');
      } catch (err) {
        record('requested deletion of the memory this run created', false, `${err.message} — delete ${createdId} by hand`);
      }
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Live Setup Check integration test ===\n');

  const credentials = credentialsFromEnvironment();
  if (!credentials) {
    const message =
      'No AWS credentials in the environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).\n' +
      "Hive's own stored credentials are deliberately not read — safeStorage is bound to the signed app.\n" +
      'Export credentials for the account you want to test against and re-run.';
    if (process.env.REQUIRE_AWS_CREDS === '1') {
      console.error(`${message}\nREQUIRE_AWS_CREDS=1 is set, so this is a failure.`);
      process.exit(1);
    }
    console.log(`${message}\nSkipping (exit 0) so this never blocks normal development.\n`);
    process.exit(0);
  }

  let identity;
  try {
    identity = await whoAmI(credentials);
  } catch (err) {
    console.error(`Credentials did not work: ${err.message}\n`);
    process.exit(1);
  }

  console.log(`Account : ${identity.Account}`);
  console.log(`Identity: ${identity.Arn}`);
  console.log(`Region  : ${REGION}`);
  console.log(`Mode    : ${ALLOW_WRITES ? 'CREATE + CLEAN UP (ALLOW_AWS_WRITES=1)' : 'dry run — nothing will be created'}`);
  console.log(`Memory  : ${INCLUDE_MEMORY ? 'included (billable)' : 'skipped (set INCLUDE_MEMORY=1 to include)'}`);
  console.log('');

  console.log('Web Search Gateway execution role:');
  try {
    await checkWebSearchRole(credentials);
  } catch (err) {
    record('Web Search Gateway role check', false, err.message);
  }

  if (INCLUDE_MEMORY) {
    console.log('\nAgentCore Memory:');
    try {
      await checkMemory(credentials);
    } catch (err) {
      record('AgentCore Memory check', false, err.message);
    }
  }

  const failures = results.filter(r => !r.ok);
  console.log('');
  if (failures.length > 0) {
    console.error(`${failures.length}/${results.length} checks failed.`);
    process.exit(1);
  }
  console.log(`All ${results.length} checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[setup-check-live] Unexpected error:', err);
  process.exit(1);
});
