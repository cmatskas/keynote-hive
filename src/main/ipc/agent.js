const MemoryManager = require('../models/memoryManager');
const AgentToolExecutor = require('../models/agentToolExecutor');
const { isNetworkError, describeAwsError } = require('../awsErrors');

function register(ipcMain, ctx) {
  ipcMain.handle('cancel-agent', (event, { sessionId }) => {
    const ctrl = ctx.agentAbortControllers.get(sessionId);
    if (ctrl) { ctrl.abort(); ctx.agentAbortControllers.delete(sessionId); }
  });

  ipcMain.handle('invoke-agent', async (event, { model, prompt, conversationHistory, files = [], sessionId, enableThinking = false }) => {
    if (!ctx.awsClients.bedrock) {
      throw new Error('AWS credentials not configured');
    }
    // Fail fast rather than waiting out the SDK's retries and timeouts. The
    // renderer's OfflineGuard should have prevented this, but a control that
    // slips past it should still produce a clear message in seconds.
    ctx.assertOnline('Sending a message');

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
      awsConfig: { ...ctx.awsClients.agentCoreConfig, s3Client: ctx.awsClients.s3 },
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
      return await executor.run(model, prompt, conversationHistory, files, enableThinking);
    } catch (err) {
      // An in-flight run is deliberately allowed to fail on its own rather than
      // being pre-emptively aborted when the network drops — a brief blip may
      // resolve inside the SDK's own retries. But when it does fail from a
      // transport error, say so plainly instead of surfacing a raw DNS or
      // socket error to the user.
      if (isNetworkError(err)) {
        ctx.connectivityMonitor?.reportNetworkFailure();
        throw new Error(describeAwsError(err));
      }
      throw err;
    } finally {
      ctx.agentAbortControllers.delete(sessionId);
      // Fired unconditionally (success, abort, or thrown error) so the
      // renderer's activity log always closes out rather than being left
      // stuck in "Working..." if the run fails.
      event.sender.send('agent-status', { sessionId, status: { tool: 'run', state: 'done' } });
    }
  });

  ipcMain.handle('work-cleanup-session', async (_event, { sessionId }) => {
    await ctx.cleanupSandbox(sessionId);
    return { success: true };
  });
}

module.exports = { register };
