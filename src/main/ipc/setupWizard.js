const setupWizard = require('../models/setupWizard');

/**
 * IPC handlers for Flow 1's per-user Setup Check (see setupWizard.js).
 * All handlers operate on whatever credentials/settings are currently
 * loaded in ctx — never accept credentials/settings from the renderer
 * directly, consistent with every other IPC module in this app.
 */
function register(ipcMain, ctx) {
  ipcMain.handle('setup-wizard-check-status', async () => {
    if (!ctx.isOnline()) {
      return { error: 'Hive is offline — Setup Check needs an internet connection.', offline: true };
    }
    if (!ctx.currentCredentials) {
      ctx.currentCredentials = await ctx.credentialsManager.loadCredentials();
    }
    if (!ctx.currentCredentials) {
      return { error: 'No AWS credentials configured yet' };
    }
    const settings = ctx.currentSettings || await ctx.settingsManager.loadSettings();
    return await setupWizard.checkStatus(ctx.currentCredentials, settings);
  });

  ipcMain.handle('setup-wizard-create-item', async (event, itemId) => {
    ctx.assertOnline('Setup Check');
    if (!ctx.currentCredentials) {
      ctx.currentCredentials = await ctx.credentialsManager.loadCredentials();
    }
    if (!ctx.currentCredentials) {
      throw new Error('No AWS credentials configured yet');
    }
    const settings = ctx.currentSettings || await ctx.settingsManager.loadSettings();
    const region = ctx.currentCredentials.region || settings.region || 'us-east-1';

    switch (itemId) {
      case 'webSearchGateway': {
        const arn = await setupWizard.createWebSearchGatewayRole(ctx.currentCredentials, region);
        const merged = { ...settings, webSearchGatewayRoleArn: arn };
        await ctx.settingsManager.saveSettings(merged);
        ctx.currentSettings = merged;
        return { success: true, detail: `Created role: ${arn}`, arn };
      }
      case 'transcriptionBucket': {
        if (!settings.bucketName) {
          throw new Error('No bucket name configured in Settings — set one before creating it');
        }
        const bucketName = await setupWizard.createTranscriptionBucket(ctx.currentCredentials, region, settings.bucketName);
        return { success: true, detail: `Created bucket: ${bucketName}` };
      }
      case 'memory': {
        const memoryId = await setupWizard.createMemory(ctx.currentCredentials, region);
        const merged = { ...settings, memoryId, memoryEnabled: true };
        await ctx.settingsManager.saveSettings(merged);
        ctx.currentSettings = merged;
        return { success: true, detail: `Created memory: ${memoryId}` };
      }
      default:
        throw new Error(`Unknown setup item: ${itemId}`);
    }
  });
}

module.exports = { register };
