function register(ipcMain, ctx) {
  ipcMain.handle('work-history-list', async () => {
    return await ctx.workHistoryManager.list();
  });

  ipcMain.handle('work-history-load', async (event, { id }) => {
    return await ctx.workHistoryManager.load(id);
  });

  ipcMain.handle('work-history-save', async (event, session) => {
    await ctx.workHistoryManager.save(session);
  });

  ipcMain.handle('work-history-delete', async (event, { id }) => {
    await ctx.workHistoryManager.remove(id);
  });

  ipcMain.handle('work-history-rename', async (event, { id, title }) => {
    await ctx.workHistoryManager.rename(id, title);
  });

  ipcMain.handle('work-history-star', async (event, { id }) => {
    return await ctx.workHistoryManager.toggleStar(id);
  });
}

module.exports = { register };
