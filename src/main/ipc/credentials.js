const AWSValidator = require('../models/awsValidator');

function register(ipcMain, ctx) {
  ipcMain.handle('save-credentials', async (event, credentials) => {
    await ctx.credentialsManager.saveCredentials(credentials);
    ctx.currentCredentials = credentials;
    ctx.initializeAWSClients(credentials);
    if (ctx.credentialMonitor) ctx.credentialMonitor.reset();
    else ctx.startCredentialMonitor();
    return true;
  });

  ipcMain.handle('load-credentials', async () => {
    return await ctx.credentialsManager.loadCredentials();
  });

  ipcMain.handle('has-credentials', async () => {
    return await ctx.credentialsManager.hasCredentials();
  });

  ipcMain.handle('delete-credentials', async () => {
    await ctx.credentialsManager.deleteCredentials();
    ctx.currentCredentials = null;
    ctx.awsClients = {};
    return true;
  });

  ipcMain.handle('validate-credentials', async () => {
    if (!ctx.currentCredentials) {
      ctx.currentCredentials = await ctx.credentialsManager.loadCredentials();
    }
    const validator = new AWSValidator(ctx.currentCredentials);
    return await validator.validateCredentials();
  });

  ipcMain.handle('quick-validate-credentials', async () => {
    try {
      if (!ctx.currentCredentials) {
        ctx.currentCredentials = await ctx.credentialsManager.loadCredentials();
      }
      const validator = new AWSValidator(ctx.currentCredentials);
      return await validator.quickValidate();
    } catch (error) {
      return { valid: false, identity: null, errors: [error.message] };
    }
  });

  // Jina API key
  ipcMain.handle('save-jina-key', async (_event, key) => {
    await ctx.credentialsManager.saveJinaApiKey(key);
    ctx.currentJinaApiKey = key;
    return true;
  });

  ipcMain.handle('load-jina-key', async () => {
    if (!ctx.currentJinaApiKey) ctx.currentJinaApiKey = await ctx.credentialsManager.loadJinaApiKey();
    return ctx.currentJinaApiKey ? '••••••••' : null;
  });

  ipcMain.handle('delete-jina-key', async () => {
    await ctx.credentialsManager.deleteJinaApiKey();
    ctx.currentJinaApiKey = null;
    return true;
  });
}

module.exports = { register };
