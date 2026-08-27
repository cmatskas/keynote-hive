const setupWizard = require('../models/setupWizard');
const AWSValidator = require('../models/awsValidator');

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

  /**
   * Account-scoped bucket-name suggestions for the Settings form. Neither
   * bucket setting can have a default (S3 names are globally unique), so this
   * gives the user an editable starting point instead of a blank field.
   */
  ipcMain.handle('get-suggested-bucket-names', async () => {
    if (!ctx.isOnline()) return null;
    if (!ctx.currentCredentials) {
      ctx.currentCredentials = await ctx.credentialsManager.loadCredentials();
    }
    if (!ctx.currentCredentials) return null;

    const validator = new AWSValidator(ctx.currentCredentials);
    const result = await validator.quickValidate();
    const accountId = result.identity?.account;
    if (!accountId) return null;

    return {
      input: setupWizard.suggestBucketName(accountId, 'input'),
      output: setupWizard.suggestBucketName(accountId, 'output'),
    };
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
      case 'transcriptionBucket':
      case 'transcriptionOutputBucket': {
        const isOutput = itemId === 'transcriptionOutputBucket';
        const settingKey = isOutput ? 'outputBucketName' : 'bucketName';
        const label = isOutput ? 'Output S3 Bucket' : 'Input S3 Bucket';

        // Fall back to the account-scoped suggestion when nothing is
        // configured, so Setup Check can complete in one click rather than
        // bouncing the user to Settings to invent a globally-unique name.
        // Whatever name is used is persisted, so Settings and the bucket that
        // actually exists can't disagree afterwards.
        let bucketName = settings[settingKey];
        if (!bucketName) {
          const validator = new AWSValidator(ctx.currentCredentials);
          const identity = await validator.quickValidate();
          bucketName = setupWizard.suggestBucketName(identity.identity?.account, isOutput ? 'output' : 'input');
          if (!bucketName) {
            throw new Error(`No ${label} configured in Settings, and the AWS account ID could not be resolved to suggest one — set a name in Settings → Configuration first`);
          }
        }

        const created = await setupWizard.createTranscriptionBucket(ctx.currentCredentials, region, bucketName);

        if (settings[settingKey] !== created) {
          const merged = { ...settings, [settingKey]: created };
          await ctx.settingsManager.saveSettings(merged);
          ctx.currentSettings = merged;
        }
        return { success: true, detail: `Created bucket: ${created}`, bucketName: created };
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
