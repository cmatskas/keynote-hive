const MemoryManager = require('../models/memoryManager');
const AgentToolExecutor = require('../models/agentToolExecutor');

function register(ipcMain, ctx) {
  ipcMain.handle('cancel-agent', (event, { sessionId }) => {
    const ctrl = ctx.agentAbortControllers.get(sessionId);
    if (ctrl) { ctrl.abort(); ctx.agentAbortControllers.delete(sessionId); }
  });

  ipcMain.handle('invoke-agent', async (event, { model, prompt, conversationHistory, files = [], sessionId }) => {
    if (!ctx.awsClients.bedrock) {
      throw new Error('AWS credentials not configured');
    }

    const abortController = new AbortController();
    ctx.agentAbortControllers.set(sessionId, abortController);

    const settings = await ctx.settingsManager.loadSettings();
    let memManager = null;
    if (settings.memoryId && settings.memoryEnabled && ctx.awsClients.agentCoreConfig) {
      memManager = new MemoryManager(ctx.awsClients.agentCoreConfig);
      memManager.setMemoryId(settings.memoryId);
      memManager.setActorId(settings.userId);
      memManager._ensureStrategies().catch(err => console.warn('Strategy check failed:', err.message));
    }

    const ciManager = ctx.getOrCreateSandbox(sessionId);
    const executor = new AgentToolExecutor({
      bedrockClient: ctx.awsClients.bedrock,
      skillsManager: ctx.skillsManager,
      codeInterpreterManager: ciManager,
      memoryManager: memManager,
      webSearchManager: ctx.webSearchManager,
      sessionId,
      settings,
      signal: abortController.signal,
      onStatus: (status) => event.sender.send('agent-status', { sessionId, status }),
      onChunk: (chunk) => event.sender.send('agent-stream-chunk', { sessionId, chunk }),
    });

    ctx.skillsManager.resetActivations();
    try {
      return await executor.run(model, prompt, conversationHistory, files);
    } finally {
      ctx.agentAbortControllers.delete(sessionId);
    }
  });

  ipcMain.handle('work-cleanup-session', async (_event, { sessionId }) => {
    await ctx.cleanupSandbox(sessionId);
    return { success: true };
  });
}

module.exports = { register };
