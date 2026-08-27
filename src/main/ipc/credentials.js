const AWSValidator = require('../models/awsValidator');

function register(ipcMain, ctx) {
  ipcMain.handle('save-credentials', async (event, credentials) => {
    await ctx.credentialsManager.saveCredentials(credentials);
    ctx.currentCredentials = credentials;
    ctx.initializeAWSClients(credentials);
    if (ctx.credentialMonitor) ctx.credentialMonitor.reset();
    else ctx.startCredentialMonitor();

    // A transcription parked because AWS rejected the old credentials can
    // resume now. The poll loop re-reads ctx.awsClients on every iteration, so
    // initializeAWSClients() above is all it needs to start working again —
    // this just wakes it instead of waiting for the slow retry tick.
    if (ctx.transcriptionJob?.resume) ctx.transcriptionJob.resume('auth');

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

}

module.exports = { register };
