function register(ipcMain, ctx) {
  ipcMain.handle('save-settings', async (event, settings) => {
    const existing = await ctx.settingsManager.loadSettings();
    const merged = { ...existing, ...settings };
    await ctx.settingsManager.saveSettings(merged);
    ctx.currentSettings = merged;
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
}

module.exports = { register };
