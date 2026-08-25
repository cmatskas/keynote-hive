const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { StartTranscriptionJobCommand, GetTranscriptionJobCommand, DeleteTranscriptionJobCommand } = require('@aws-sdk/client-transcribe');
const CodeInterpreterManager = require('../models/codeInterpreterManager');
const TranscriptMapper = require('../models/transcriptMapper');
const { createAgent, isAnthropicModel } = require('../models/strandsAgentFactory');
const { buildFileContentBlocks } = require('../utils');
const { notify } = require('../notify');
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

function getMediaFormat(uri) {
  const lowerUri = uri.toLowerCase();
  const formats = { '.mp3': 'mp3', '.wav': 'wav', '.flac': 'flac', '.ogg': 'ogg', '.amr': 'amr', '.webm': 'webm', '.mp4': 'mp4', '.mov': 'mov', '.avi': 'avi', '.mkv': 'mkv', '.flv': 'flv' };
  for (const [ext, fmt] of Object.entries(formats)) {
    if (lowerUri.endsWith(ext)) return fmt;
  }
  return 'mp4';
}

async function uploadFile(ctx, file, bucket, key, onStart = null) {
  const upload = new Upload({
    client: ctx.awsClients.s3,
    params: { Bucket: bucket, Key: key, Body: file.buffer, ContentType: file.mimetype },
    ...(file.buffer.length >= 20 * 1024 * 1024 ? { queueSize: 4, partSize: 5 * 1024 * 1024 } : {}),
  });
  // Hand the Upload back to the caller so an in-flight upload can be aborted
  // (Cancel button) instead of having to run to completion first.
  if (onStart) onStart(upload);
  await upload.done();
  return `s3://${bucket}/${key}`;
}

/**
 * Interruptible sleep. Resolves either after `ms` or as soon as
 * `job.wake()` is called, so hitting Cancel doesn't have to wait out the
 * remainder of the current 5s poll interval before the loop notices.
 */
function cancellableSleep(job, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { job.wake = null; resolve(); }, ms);
    job.wake = () => { clearTimeout(timer); job.wake = null; resolve(); };
  });
}

/**
 * Notify the renderer that a transcription job reached a terminal state, via
 * an OS notification. Clicking it focuses the window and switches to the
 * Transcribe tab — the whole point of no longer blocking the UI is that the
 * user is expected to be somewhere else when this fires.
 */
function transcriptionNotify(ctx, title, body, urgency = 'normal') {
  notify({
    title,
    body,
    urgency,
    window: ctx.mainWindow,
    onClick: () => {
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('transcription-focus-request');
      }
    },
  });
}

function register(ipcMain, ctx) {
  ipcMain.handle('cancel-bedrock', () => {
    if (ctx.bedrockAbortController) { ctx.bedrockAbortController.abort(); ctx.bedrockAbortController = null; }
  });

  ipcMain.handle('send-to-bedrock', async (event, { model, prompt, conversationHistory, files = [] }) => {
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

  /**
   * Cancel an in-flight transcription. Aborts the S3 upload if it's still
   * running, wakes the poll loop immediately, and best-effort deletes the
   * Transcribe job so it stops billing rather than running to completion
   * with nobody listening.
   *
   * `transcribe:DeleteTranscriptionJob` is not required — if the caller's
   * role lacks it the delete is logged and skipped, and cancellation still
   * works from Hive's point of view (the loop stops, the UI resets); the
   * job just finishes server-side unobserved.
   */
  ipcMain.handle('cancel-transcription', async () => {
    const job = ctx.transcriptionJob;
    if (!job) return { cancelled: false };

    job.cancelled = true;
    if (job.wake) job.wake();
    if (job.upload) {
      try { await job.upload.abort(); } catch (err) { logger.warn(`[transcribe] upload abort failed: ${err.message}`); }
    }
    if (job.jobName && ctx.awsClients.transcribe) {
      try {
        await ctx.awsClients.transcribe.send(new DeleteTranscriptionJobCommand({ TranscriptionJobName: job.jobName }));
        logger.info(`[transcribe] deleted cancelled job ${job.jobName}`);
      } catch (err) {
        logger.warn(`[transcribe] could not delete job ${job.jobName}: ${err.message}`);
      }
    }
    return { cancelled: true };
  });

  ipcMain.handle('transcribe-media', async (event, { file }) => {
    if (!ctx.awsClients.transcribe) throw new Error('AWS credentials not configured');
    if (ctx.transcriptionJob) throw new Error('A transcription is already in progress');

    // Single-slot job state: the renderer only has one transcript pane, so
    // concurrent jobs are rejected above rather than tracked in a map.
    const job = { cancelled: false, jobName: null, upload: null, wake: null };
    ctx.transcriptionJob = job;

    const fileBuffer = Buffer.from(file.buffer);
    const fileObj = { buffer: fileBuffer, originalname: file.name, mimetype: file.type };

    try {
      event.sender.send('transcription-progress', { status: 'UPLOADING', message: 'Uploading file to S3...' });

      const settings = ctx.currentSettings || await ctx.settingsManager.loadSettings();
      const mediaUri = await uploadFile(
        ctx, fileObj, settings.bucketName, `${Date.now()}-${fileObj.originalname}`,
        (upload) => { job.upload = upload; }
      );
      job.upload = null;
      if (job.cancelled) return { status: 'CANCELLED' };

      const mediaFormat = getMediaFormat(mediaUri);
      job.jobName = `transcription-${Date.now()}`;

      const startCmd = new StartTranscriptionJobCommand({
        TranscriptionJobName: job.jobName,
        Media: { MediaFileUri: mediaUri },
        MediaFormat: mediaFormat,
        LanguageCode: settings.transcriptionLanguage,
        OutputBucketName: settings.outputBucketName,
        Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: 5 },
      });
      await ctx.awsClients.transcribe.send(startCmd);

      event.sender.send('transcription-progress', { status: 'IN_PROGRESS', message: 'Transcription job started. Processing audio...' });

      const maxAttempts = 60;
      const pollInterval = 5000;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (job.cancelled) return { status: 'CANCELLED' };

        const statusCmd = new GetTranscriptionJobCommand({ TranscriptionJobName: job.jobName });
        const statusRes = await ctx.awsClients.transcribe.send(statusCmd);
        const jobStatus = statusRes.TranscriptionJob;

        if (jobStatus.TranscriptionJobStatus === 'COMPLETED') {
          event.sender.send('transcription-progress', { status: 'RETRIEVING', message: 'Retrieving transcription results...' });
          const url = new URL(jobStatus.Transcript.TranscriptFileUri);
          const bucket = url.pathname.split('/')[1];
          const key = url.pathname.split('/').slice(2).join('/');
          const getCmd = new GetObjectCommand({ Bucket: bucket, Key: key });
          const objRes = await ctx.awsClients.s3.send(getCmd);
          const transcript = JSON.parse(await objRes.Body.transformToString());
          const mapper = new TranscriptMapper(transcript);
          if (job.cancelled) return { status: 'CANCELLED' };
          transcriptionNotify(ctx, 'Transcription Complete', `${fileObj.originalname} is ready to read.`);
          return { status: 'COMPLETED', transcript: mapper.getAllTimestampedText(), jobName: job.jobName };
        } else if (jobStatus.TranscriptionJobStatus === 'FAILED') {
          throw new Error(`Transcription job failed: ${jobStatus.FailureReason || 'Unknown error'}`);
        }

        const elapsed = Math.floor((attempt + 1) * pollInterval / 1000);
        event.sender.send('transcription-progress', { status: 'IN_PROGRESS', message: `Processing audio... (${elapsed}s elapsed)` });
        await cancellableSleep(job, pollInterval);
      }

      if (job.cancelled) return { status: 'CANCELLED' };
      throw new Error('Transcription job timed out after 5 minutes');
    } catch (err) {
      // A cancel can surface as a thrown abort from the S3 upload — treat it
      // as a clean cancellation rather than an error bubble in the UI.
      if (job.cancelled) return { status: 'CANCELLED' };
      transcriptionNotify(ctx, 'Transcription Failed', err.message ? err.message.slice(0, 140) : 'An error occurred.', 'critical');
      throw err;
    } finally {
      ctx.transcriptionJob = null;
    }
  });
}

module.exports = { register, invokeChatModel };
