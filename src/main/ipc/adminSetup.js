const adminSetup = require('../models/adminSetup');

const KB_NAME = 'hive-shared-kb';
const GATEWAY_NAME = 'hive-shared-gateway'; // distinct from web search's per-user 'hive-web-search' Gateway — this one lives only in aws-keynote and exists solely to front the shared Knowledge Base
const KB_TARGET_NAME = 'hive-knowledge-base';

/**
 * IPC handlers for Flow 2's Admin tab (see adminSetup.js). Every handler
 * operates on whatever credentials are currently loaded in ctx — same as
 * every other IPC module — which is what makes the account-ID gate real:
 * if the loaded credentials aren't the admin account, every one of these
 * calls fails with a genuine AWS AccessDenied/ResourceNotFound, not a
 * client-side block.
 */
function register(ipcMain, ctx) {
  ipcMain.handle('admin-check-kb-status', async () => {
    if (!ctx.currentCredentials) throw new Error('No AWS credentials configured');
    const region = ctx.currentCredentials.region || 'us-east-1';
    return await adminSetup.checkKnowledgeBaseStatus(ctx.currentCredentials, region, KB_NAME);
  });

  ipcMain.handle('admin-check-gateway-kb-target', async () => {
    if (!ctx.currentCredentials) throw new Error('No AWS credentials configured');
    const region = ctx.currentCredentials.region || 'us-east-1';
    return await adminSetup.checkGatewayKbTarget(ctx.currentCredentials, region, GATEWAY_NAME, KB_TARGET_NAME);
  });

  ipcMain.handle('admin-get-gateway-policy', async (event, gatewayArn) => {
    if (!ctx.currentCredentials) throw new Error('No AWS credentials configured');
    const region = ctx.currentCredentials.region || 'us-east-1';
    return await adminSetup.getGatewayResourcePolicy(ctx.currentCredentials, region, gatewayArn);
  });

  // Preview step (wizard step 3, "Review & confirm") — computes the
  // resulting policy but does NOT apply it. The renderer shows this diff
  // and only calls admin-apply-policy-change if the admin explicitly clicks
  // Apply.
  ipcMain.handle('admin-preview-policy-change', async (event, { gatewayArn, action, roleArn }) => {
    if (!ctx.currentCredentials) throw new Error('No AWS credentials configured');
    const region = ctx.currentCredentials.region || 'us-east-1';
    return await adminSetup.previewGatewayPolicyChange(ctx.currentCredentials, region, gatewayArn, action, roleArn);
  });

  // Apply step — takes the exact `after` document returned by the preview
  // call above, not a freshly-recomputed one, so what's applied is
  // guaranteed to match what the admin reviewed.
  ipcMain.handle('admin-apply-policy-change', async (event, { gatewayArn, policyDocument }) => {
    if (!ctx.currentCredentials) throw new Error('No AWS credentials configured');
    const region = ctx.currentCredentials.region || 'us-east-1';
    return await adminSetup.applyGatewayResourcePolicy(ctx.currentCredentials, region, gatewayArn, policyDocument);
  });
}

module.exports = { register, KB_NAME, GATEWAY_NAME, KB_TARGET_NAME };
