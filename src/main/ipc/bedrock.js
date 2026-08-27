const CodeInterpreterManager = require('../models/codeInterpreterManager');
const transcriptionRunner = require('../models/transcriptionRunner');
const { createAgent, isAnthropicModel } = require('../models/strandsAgentFactory');
const { buildFileContentBlocks } = require('../utils');
const logger = require('electron-log/main');

/**
 * Chat tab model invocation — simple, non-agentic back-and-forth with any
 * configured model. Uses the same createAgent() factory as Work/Swarm (so
 * Mantle routing, retry classification, and thinking support all come for
 * free and never drift out of sync with those tabs), but with an empty
 * `tools: []` array and no persistent memory — the whole point of Chat is
 * a single model call with no tool loop.
 *
 * Previously this hand-rolled a Bedrock Converse streaming loop directly
 * against ConverseStreamCommand. Now that Bedrock Converse/BedrockModel has
 * been removed entirely in favor of Mantle-only routing, this goes through
 * createAgent()/agent.stream() like every other model call in Hive.
 */
async function invokeChatModel(ctx, model, prompt, conversationHistory, files = [], event = null, signal = null) {
  const settings = ctx.currentSettings || await ctx.settingsManager.loadSettings();
  if (!settings.mantleApiKey) {
    throw new Error('Mantle API key not configured — set it in Settings > Mantle API Key');
  }

  if (files && files.length > 5) {
    throw new Error('Maximum 5 documents allowed per message');
  }

  const messageContent = [{ text: prompt }];

  if (files && files.length > 0) {
    // File extraction spins up a Code Interpreter session and can take a
    // while — don't start it if the user already hit Stop.
    if (signal?.aborted) return '';
    logger.info(`Processing ${files.length} files for Chat analysis`);
    const ci = new CodeInterpreterManager(ctx.awsClients.agentCoreConfig);
    const fileBlocks = await buildFileContentBlocks(files, {
      codeInterpreter: ci,
      stopSession: true,
      isAnthropicModel: isAnthropicModel(model),
    });
    messageContent.push(...fileBlocks);
  }

  const { agent, dispose } = createAgent({
    modelId: model,
    region: settings.region,
    mantleApiKey: settings.mantleApiKey,
    systemPrompt: 'You are a helpful assistant. Answer questions clearly and concisely based on the conversation and any attached files.',
    tools: [],
    id: 'chat',
    // No maxTokens override — inherit createAgent()'s DEFAULT_MAX_OUTPUT_TOKENS
    // (120,000), same as Work/Swarm. Previously hardcoded to 4096 here, which
    // was ~30x smaller than every other tab and could contribute to
    // MaxTokensError failures on longer responses.
  });

  const userInput = [
    ...(conversationHistory || []),
    { role: 'user', content: messageContent },
  ];

  let fullText = '';
  try {
    // cancelSignal gives the SDK real cancellation: it aborts the in-flight
    // model HTTP request rather than waiting for the next stream event to
    // arrive (which, for reasoning models, can be a long gap). The in-loop
    // aborted check is kept as a cheap fallback.
    for await (const streamEvent of agent.stream(userInput, { cancelSignal: signal ?? undefined })) {
      if (signal?.aborted) break;
      if (streamEvent.type === 'modelStreamUpdateEvent') {
        const inner = streamEvent.event;
        if (inner.type === 'modelContentBlockDeltaEvent' && inner.delta?.type === 'textDelta') {
          fullText += inner.delta.text;
          if (event) event.sender.send('bedrock-stream-chunk', inner.delta.text);
        }
      }
    }
  } catch (err) {
    // A user-requested stop can surface as a thrown AbortError on some
    // paths — treat it as a graceful stop (partial text, stream-complete
    // still fires below) rather than an error bubble in the UI.
    if (!signal?.aborted) throw err;
    logger.info(`Chat invocation cancelled by user (${err.name || err.message})`);
  } finally {
    dispose();
  }

  if (event) event.sender.send('bedrock-stream-complete');
  return fullText;
}

function register(ipcMain, ctx) {
  ipcMain.handle('cancel-bedrock', () => {
    if (ctx.bedrockAbortController) { ctx.bedrockAbortController.abort(); ctx.bedrockAbortController = null; }
  });

  ipcMain.handle('send-to-bedrock', async (event, { model, prompt, conversationHistory, files = [] }) => {
    ctx.assertOnline('Sending a message');
    ctx.bedrockAbortController = new AbortController();
    const { signal } = ctx.bedrockAbortController;
    try {
      return await invokeChatModel(ctx, model, prompt, conversationHistory, files, event, signal);
    } finally {
      ctx.bedrockAbortController = null;
    }
  });

  ipcMain.handle('get-bedrock-models', async () => {
    const settings = ctx.currentSettings || await ctx.settingsManager.loadSettings();
    // settingsManager.loadSettings() already merges in defaultSettings.bedrockModels
    // (the current Claude/GPT-5 Mantle-era default list) for any missing field, so
    // no separate fallback is needed here. This used to fall back to config.js's
    // bedrockModels, which was pre-Mantle (Nova/DeepSeek, inference-profile IDs) and
    // has since been removed as dead, stale test-only infrastructure.
    return settings.bedrockModels;
  });

  // ── Transcription ─────────────────────────────────────────────────────────
  //
  // The main process owns the job; the renderer observes it. `transcribe-media`
  // starts a job and returns as soon as it is running — the outcome arrives as a
  // terminal event instead of as this call's resolution.
  //
  // That split is the point. Result delivery used to be the renderer's in-flight
  // promise, so any renderer teardown (credential-expiry navigation, reload,
  // crash) discarded a transcript the main process had already retrieved, while
  // the job kept running and billing on AWS. Events go to whatever window is
  // live at send time, so the result survives a renderer that has gone away.

  ipcMain.handle('cancel-transcription', async () => {
    return await transcriptionRunner.cancelTranscription(ctx);
  });

  /**
   * Current job state, so a renderer that just loaded — or reloaded mid-job —
   * can restore its pane instead of showing nothing while a job runs invisibly.
   */
  ipcMain.handle('get-transcription-state', () => {
    return transcriptionRunner.getTranscriptionState(ctx);
  });

  /**
   * Rename a transcription — in flight or already finished. See
   * renameTranscription() for why both cases are handled in one place.
   */
  ipcMain.handle('rename-transcription', async (_event, { jobId, displayName }) => {
    return await transcriptionRunner.renameTranscription(ctx, jobId, displayName);
  });

  /** Metadata for every transcription Hive has recorded, newest first. */
  ipcMain.handle('transcription-list', async () => {
    return await ctx.transcriptionRegistry.list();
  });

  /** A single transcription, transcript included. */
  ipcMain.handle('transcription-get', async (_event, jobId) => {
    return await ctx.transcriptionRegistry.get(jobId);
  });

  ipcMain.handle('transcribe-media', async (event, { file, displayName = null }) => {
    if (!ctx.awsClients.transcribe) throw new Error('AWS credentials not configured');
    ctx.assertOnline('Transcription');
    if (ctx.transcriptionJob) throw new Error('A transcription is already in progress');

    // Single-slot job state: there is one transcript pane, so a concurrent job
    // is rejected above rather than tracked in a map.
    const job = transcriptionRunner.createJob({ sourceFile: file?.name, displayName });
    ctx.transcriptionJob = job;

    // Deliberately not awaited. The renderer gets the job's identity immediately
    // and everything else by event, so it is free to navigate, reload, or close
    // the tab without taking the job or its result down with it.
    transcriptionRunner.runTranscription(ctx, job, { file })
      .then((result) => {
        switch (result.status) {
          case 'COMPLETED':
            transcriptionRunner.emitToRenderer(ctx, 'transcription-complete', result);
            break;
          case 'CANCELLED':
            transcriptionRunner.emitToRenderer(ctx, 'transcription-cancelled', { jobId: result.jobId });
            break;
          case 'ABANDONED':
            transcriptionRunner.emitToRenderer(ctx, 'transcription-abandoned', result);
            break;
          default:
            logger.warn(`[transcribe] unexpected terminal status: ${result.status}`);
        }
      })
      .catch((err) => {
        transcriptionRunner.emitToRenderer(ctx, 'transcription-failed', {
          jobId: job.jobId,
          error: err.message || 'Transcription failed',
          code: err.code || null,
        });
      })
      .finally(() => {
        ctx.transcriptionJob = null;
      });

    return {
      status: 'STARTED',
      jobId: job.jobId,
      displayName: job.displayName,
      sourceFile: job.sourceFile,
    };
  });
}

module.exports = { register, invokeChatModel };
