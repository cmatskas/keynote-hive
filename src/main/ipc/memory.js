const MemoryManager = require('../models/memoryManager');

function register(ipcMain, ctx) {
  ipcMain.handle('memory-connect', async (event, memoryId) => {
    if (!ctx.awsClients.agentCoreConfig) throw new Error('AWS credentials not configured');
    const mm = new MemoryManager(ctx.awsClients.agentCoreConfig);
    mm.setMemoryId(memoryId);
    const status = await mm.getStatus();
    const settings = await ctx.settingsManager.loadSettings();
    settings.memoryId = memoryId;
    settings.memoryEnabled = true;
    await ctx.settingsManager.saveSettings(settings);
    return { id: memoryId, status };
  });

  ipcMain.handle('memory-list', async () => {
    if (!ctx.awsClients.agentCoreConfig) throw new Error('AWS credentials not configured');
    const mm = new MemoryManager(ctx.awsClients.agentCoreConfig);
    const { ListMemoriesCommand } = require('@aws-sdk/client-bedrock-agentcore-control');
    const res = await mm.controlClient.send(new ListMemoriesCommand({ maxResults: 50 }));
    return (res.memories || []).map(m => ({ id: m.id, name: m.name, status: m.status }));
  });

  ipcMain.handle('memory-enable', async () => {
    if (!ctx.awsClients.agentCoreConfig) throw new Error('AWS credentials not configured');
    const settings = await ctx.settingsManager.loadSettings();

    if (settings.memoryId) {
      settings.memoryEnabled = true;
      await ctx.settingsManager.saveSettings(settings);
      return { id: settings.memoryId, status: 'ACTIVE', alreadyExisted: true };
    }

    const mm = new MemoryManager(ctx.awsClients.agentCoreConfig);
    mm.setActorId(settings.userId);
    const result = await mm.createMemory();
    if (result.status !== 'ACTIVE' && !result.alreadyExisted) {
      await mm.waitForActive();
    }
    settings.memoryId = result.id;
    settings.memoryEnabled = true;
    await ctx.settingsManager.saveSettings(settings);
    return result;
  });

  ipcMain.handle('memory-disable', async () => {
    const settings = await ctx.settingsManager.loadSettings();
    settings.memoryEnabled = false;
    await ctx.settingsManager.saveSettings(settings);
    return { enabled: false };
  });

  ipcMain.handle('memory-delete', async () => {
    const settings = await ctx.settingsManager.loadSettings();
    if (settings.memoryId && ctx.awsClients.agentCoreConfig) {
      const mm = new MemoryManager(ctx.awsClients.agentCoreConfig);
      mm.setMemoryId(settings.memoryId);
      await mm.deleteMemory();
    }
    settings.memoryId = '';
    settings.memoryEnabled = false;
    await ctx.settingsManager.saveSettings(settings);
    return { enabled: false };
  });

  ipcMain.handle('memory-status', async () => {
    const settings = await ctx.settingsManager.loadSettings();
    if (!settings.memoryId) return { enabled: false, memoryEnabled: false };
    if (!ctx.awsClients.agentCoreConfig) return { enabled: false, memoryEnabled: false };
    try {
      const mm = new MemoryManager(ctx.awsClients.agentCoreConfig);
      mm.setMemoryId(settings.memoryId);
      const status = await mm.getStatus();
      return { enabled: true, memoryEnabled: settings.memoryEnabled, memoryId: settings.memoryId, status };
    } catch {
      return { enabled: false, memoryEnabled: false, memoryId: settings.memoryId, status: 'UNREACHABLE' };
    }
  });

  ipcMain.handle('memory-extract', async (event, { sessionId }) => {
    const settings = await ctx.settingsManager.loadSettings();
    if (!settings.memoryId || !ctx.awsClients.agentCoreConfig) return;
    const mm = new MemoryManager(ctx.awsClients.agentCoreConfig);
    mm.setMemoryId(settings.memoryId);
    mm.setActorId(settings.userId);
    await mm.startExtraction(sessionId);
  });
}

module.exports = { register };
