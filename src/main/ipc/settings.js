function register(ipcMain, ctx) {
  ipcMain.handle('save-settings', async (event, settings) => {
    const existing = await ctx.settingsManager.loadSettings();
    const merged = { ...existing, ...settings };
    await ctx.settingsManager.saveSettings(merged);
    ctx.currentSettings = merged;

    // Retry web search Gateway init if the role ARN changed and it isn't
    // already up — lets the user fix a missing/invalid roleArn from Settings
    // without restarting the app.
    if (
      'webSearchGatewayRoleArn' in settings &&
      settings.webSearchGatewayRoleArn !== existing.webSearchGatewayRoleArn &&
      ctx.webSearchManager &&
      !ctx.webSearchManager.ready
    ) {
      await ctx.initializeWebSearch();
    }

    return true;
  });

  ipcMain.handle('load-settings', async () => {
    return await ctx.settingsManager.loadSettings();
  });

  ipcMain.handle('get-default-settings', async () => {
    return ctx.settingsManager.getDefaultSettings();
  });

  ipcMain.handle('delete-settings', async () => {
    await ctx.settingsManager.deleteSettings();
    ctx.currentSettings = ctx.settingsManager.getDefaultSettings();
    return true;
  });

  ipcMain.handle('get-web-search-status', async () => {
    return {
      ready: !!ctx.webSearchManager?.ready,
      error: ctx.webSearchInitError || null,
    };
  });

  ipcMain.handle('retry-web-search-init', async () => {
    await ctx.initializeWebSearch();
    return {
      ready: !!ctx.webSearchManager?.ready,
      error: ctx.webSearchInitError || null,
    };
  });
}

module.exports = { register };
