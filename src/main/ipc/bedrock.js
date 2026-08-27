const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { StartTranscriptionJobCommand, GetTranscriptionJobCommand, DeleteTranscriptionJobCommand } = require('@aws-sdk/client-transcribe');
const CodeInterpreterManager = require('../models/codeInterpreterManager');
const TranscriptMapper = require('../models/transcriptMapper');
const { createAgent, isAnthropicModel } = require('../models/strandsAgentFactory');
const { buildFileContentBlocks } = require('../utils');
const { notify } = require('../notify');
const { classifyAwsError, isNetworkError } = require('../awsErrors');
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

// ── Pausable job state ──────────────────────────────────────────────────────
//
// A transcription job accepted by AWS runs to completion server-side and bills
// regardless of what Hive is doing. Losing the connection, or having the
// session token expire mid-poll, does not break the *job* — it only breaks
// Hive's ability to observe it. Treating either as a job failure (which is what
// used to happen) threw away work the user had already paid for and left an
// orphaned job billing with nobody watching.
//
// So both conditions park the job in a "paused, waiting on X" state instead:
//   'network' — resumes when connectivity returns
//   'auth'    — resumes when the user saves new credentials
// The poll loop re-reads ctx.awsClients on every iteration, so refreshed
// credentials are picked up with no extra plumbing.

/** Total time a job may spend paused before we give up and report it. */
const MAX_PAUSED_MS = 30 * 60 * 1000;
/** While paused, retry on this cadence even without an explicit resume signal. */
const PAUSED_RETRY_MS = 60 * 1000;

class TranscriptionCancelled extends Error {
  constructor() {
    super('Transcription cancelled');
    this.name = 'TranscriptionCancelled';
  }
}

class TranscriptionPauseExpired extends Error {
  constructor(jobName, reason) {
    super(
      reason === 'auth'
        ? `Transcription paused for too long waiting for valid credentials. The job "${jobName}" is still running on AWS.`
        : `Transcription paused for too long waiting for a connection. The job "${jobName}" is still running on AWS.`
    );
    this.name = 'TranscriptionPauseExpired';
    this.jobName = jobName;
  }
}

const PAUSE_MESSAGES = {
  network: 'Waiting for a connection — your transcription is still running on AWS.',
  auth: 'Waiting for valid AWS credentials — your transcription is still running on AWS.',
};

/**
 * Park the job until something makes it worth retrying: an explicit resume
 * signal, the slow auto-retry tick, cancellation, or the paused budget running
 * out.
 */
function parkUntilResumable(ctx, job, event, reason) {
  job.paused = reason;

  // Notify once per job, not once per pause — a flapping connection would
  // otherwise produce a stream of notifications.
  if (!job.pauseNotified) {
    job.pauseNotified = true;
    logger.warn(`[transcribe] pausing job ${job.jobName} (${reason}) — not treating as failure`);
    transcriptionNotify(
      ctx,
      'Transcription Paused',
      reason === 'auth'
        ? 'Your AWS credentials need updating. The transcription is still running and will resume.'
        : 'Hive is offline. The transcription is still running on AWS and will resume.'
    );
  }

  event.sender.send('transcription-progress', {
    status: 'PAUSED',
    reason,
    message: PAUSE_MESSAGES[reason] || PAUSE_MESSAGES.network,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(retryTimer);
      // `paused` means "parked right now", so clear it on the way out — leaving
      // it set while we're actively retrying would make the job's state lie to
      // anything inspecting it (and to resume()/cancel callers).
      job.paused = null;
      job.resume = null;
      job.wake = null;
      fn(arg);
    };

    // Budget is cumulative across pauses, not per pause, so a flapping
    // connection can't extend the wait indefinitely.
    const remaining = MAX_PAUSED_MS - job.pausedTotalMs;
    if (remaining <= 0) {
      finish(reject, new TranscriptionPauseExpired(job.jobName, reason));
      return;
    }

    const pauseStart = Date.now();
    const accrue = () => { job.pausedTotalMs += Date.now() - pauseStart; };

    const retryTimer = setTimeout(() => {
      accrue();
      finish(resolve);
    }, Math.min(PAUSED_RETRY_MS, remaining));

    // Called by main.js on reconnect, and by the credentials IPC handler after
    // new credentials are saved.
    job.resume = (why = reason) => {
      logger.info(`[transcribe] resume signal (${why}) for job ${job.jobName}`);
      accrue();
      finish(resolve);
    };

    // Cancel has to break the park too, or Cancel would appear to do nothing
    // until the next retry tick.
    job.wake = () => {
      accrue();
      finish(reject, new TranscriptionCancelled());
    };
  });
}

/**
 * Run one AWS observation step, parking and retrying rather than failing when
 * the error means "we temporarily can't look at this job". Genuine failures
 * (throttling, validation, service errors) propagate as before.
 */
async function observeWithPause(ctx, job, event, fn) {
  let wasPaused = false;
  for (;;) {
    if (job.cancelled) throw new TranscriptionCancelled();
    try {
      const result = await fn();
      if (wasPaused) {
        logger.info(`[transcribe] resumed job ${job.jobName}`);
        wasPaused = false;
        event.sender.send('transcription-progress', {
          status: 'IN_PROGRESS',
          message: 'Connection restored — resuming transcription...',
        });
      }
      return result;
    } catch (err) {
      if (job.cancelled) throw new TranscriptionCancelled();
      const kind = classifyAwsError(err);
      if (kind !== 'network' && kind !== 'auth') throw err;
      // Let the connectivity monitor re-evaluate rather than inferring global
      // state from this one failure.
      if (kind === 'network') ctx.connectivityMonitor?.reportNetworkFailure();
      wasPaused = true;
      await parkUntilResumable(ctx, job, event, kind);
    }
  }
}

/**
 * Delete a Transcribe job so it stops billing. When offline the call can't be
 * made, so the job name is queued and retried on reconnect — otherwise
 * cancelling during an outage would silently leak a billing job.
 *
 * Never throws: a missing `transcribe:DeleteTranscriptionJob` permission is an
 * accepted outcome (documented in the README), and cancellation must succeed
 * from Hive's point of view regardless.
 */
async function deleteTranscriptionJob(ctx, jobName) {
  if (!ctx.awsClients.transcribe || !ctx.isOnline()) {
    ctx.pendingTranscriptionDeletes = ctx.pendingTranscriptionDeletes || [];
    if (!ctx.pendingTranscriptionDeletes.includes(jobName)) {
      ctx.pendingTranscriptionDeletes.push(jobName);
    }
    logger.info(`[transcribe] offline — queued delete of job ${jobName} for reconnect`);
    return false;
  }

  try {
    await ctx.awsClients.transcribe.send(new DeleteTranscriptionJobCommand({ TranscriptionJobName: jobName }));
    logger.info(`[transcribe] deleted cancelled job ${jobName}`);
    return true;
  } catch (err) {
    if (isNetworkError(err)) {
      ctx.pendingTranscriptionDeletes = ctx.pendingTranscriptionDeletes || [];
      if (!ctx.pendingTranscriptionDeletes.includes(jobName)) {
        ctx.pendingTranscriptionDeletes.push(jobName);
      }
      logger.info(`[transcribe] delete of ${jobName} failed on network — queued for reconnect`);
      return false;
    }
    logger.warn(`[transcribe] could not delete job ${jobName}: ${err.message}`);
    return false;
  }
}

/**
 * Retry deletes that were queued while offline. Called on reconnect from
 * main.js. Jobs that still can't be deleted stay queued for the next attempt.
 */
async function flushPendingTranscriptionDeletes(ctx) {
  const queued = ctx.pendingTranscriptionDeletes || [];
  if (!queued.length) return;
  ctx.pendingTranscriptionDeletes = [];
  logger.info(`[transcribe] flushing ${queued.length} queued job delete(s)`);
  for (const jobName of queued) {
    await deleteTranscriptionJob(ctx, jobName);
  }
}

/**
 * Reject a transcription that can't possibly succeed, before spending anything
 * on it.
 *
 * Both S3 bucket settings default to empty — there's no possible default,
 * since bucket names are unique across all of AWS. `OutputBucketName` was
 * nonetheless passed through unconditionally, so a blank setting sent an empty
 * string, which cannot satisfy the parameter's documented pattern
 * (`[a-z0-9][\.\-a-z0-9]{1,61}[a-z0-9]`). Nothing validated it: the only check
 * that ever existed lived in a settings page that is no longer reachable, and
 * Setup Check only ever looked at the input bucket. The result was a job that
 * failed at AWS with an opaque validation error.
 *
 * Deliberately runs *before* the upload. Failing after it would leave the media
 * sitting in S3, billed, for a job that was never startable.
 */
function assertTranscriptionConfigured(settings) {
  const missing = [];
  if (!settings.bucketName) missing.push('Input S3 Bucket');
  if (!settings.outputBucketName) missing.push('Output S3 Bucket');
  if (!missing.length) return;

  const err = new Error(
    `Transcription is not configured: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
    'Set them in Settings → Configuration, or run Setup Check to create them for you.'
  );
  err.code = 'HIVE_TRANSCRIPTION_UNCONFIGURED';
  throw err;
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

  /**
   * Cancel an in-flight transcription. Aborts the S3 upload if it's still
   * running, wakes the poll loop (or an offline pause) immediately, and
   * best-effort deletes the Transcribe job so it stops billing rather than
   * running to completion with nobody listening.
   *
   * `transcribe:DeleteTranscriptionJob` is not required — if the caller's
   * role lacks it the delete is logged and skipped, and cancellation still
   * works from Hive's point of view (the loop stops, the UI resets); the
   * job just finishes server-side unobserved.
   *
   * Cancelling while offline can't reach AWS to delete, so the delete is
   * queued and flushed on reconnect. Otherwise "cancel" would silently leak a
   * billing job every time the user cancelled during an outage.
   */
  ipcMain.handle('cancel-transcription', async () => {
    const job = ctx.transcriptionJob;
    if (!job) return { cancelled: false };

    job.cancelled = true;
    if (job.wake) job.wake();
    if (job.upload) {
      try { await job.upload.abort(); } catch (err) { logger.warn(`[transcribe] upload abort failed: ${err.message}`); }
    }
    if (job.jobName) {
      await deleteTranscriptionJob(ctx, job.jobName);
    }
    return { cancelled: true };
  });

  ipcMain.handle('transcribe-media', async (event, { file }) => {
    if (!ctx.awsClients.transcribe) throw new Error('AWS credentials not configured');
    ctx.assertOnline('Transcription');
    if (ctx.transcriptionJob) throw new Error('A transcription is already in progress');

    // Single-slot job state: the renderer only has one transcript pane, so
    // concurrent jobs are rejected above rather than tracked in a map.
    const job = {
      cancelled: false,
      jobName: null,
      upload: null,
      wake: null,
      // Pause bookkeeping — see parkUntilResumable().
      paused: null,
      pausedTotalMs: 0,
      pauseNotified: false,
      resume: null,
    };
    ctx.transcriptionJob = job;

    const fileBuffer = Buffer.from(file.buffer);
    const fileObj = { buffer: fileBuffer, originalname: file.name, mimetype: file.type };

    try {
      // Configuration check first: no upload, no job, no S3 charges for a job
      // that can't start. Deliberately not swallowed or defaulted — the user
      // gets a message naming exactly what to fix.
      const settings = ctx.currentSettings || await ctx.settingsManager.loadSettings();
      assertTranscriptionConfigured(settings);

      event.sender.send('transcription-progress', { status: 'UPLOADING', message: 'Uploading file to S3...' });

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

      // The attempt budget bounds how long the *job* may take, so it must only
      // be consumed by answered polls. Time spent paused waiting for a
      // connection or for credentials has its own separate budget
      // (MAX_PAUSED_MS) and doesn't count against this one.
      const maxAttempts = 60;
      const pollInterval = 5000;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (job.cancelled) return { status: 'CANCELLED' };

        const jobStatus = await observeWithPause(ctx, job, event, async () => {
          const statusCmd = new GetTranscriptionJobCommand({ TranscriptionJobName: job.jobName });
          const statusRes = await ctx.awsClients.transcribe.send(statusCmd);
          return statusRes.TranscriptionJob;
        });

        if (jobStatus.TranscriptionJobStatus === 'COMPLETED') {
          event.sender.send('transcription-progress', { status: 'RETRIEVING', message: 'Retrieving transcription results...' });
          // Fetching the result is just as interruptible as polling was, and
          // failing here would discard a transcript that AWS has already
          // produced — so it goes through the same pause-and-retry path.
          const transcript = await observeWithPause(ctx, job, event, async () => {
            const url = new URL(jobStatus.Transcript.TranscriptFileUri);
            const bucket = url.pathname.split('/')[1];
            const key = url.pathname.split('/').slice(2).join('/');
            const getCmd = new GetObjectCommand({ Bucket: bucket, Key: key });
            const objRes = await ctx.awsClients.s3.send(getCmd);
            return JSON.parse(await objRes.Body.transformToString());
          });
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
      // A cancel can surface as a thrown abort from the S3 upload, or as the
      // TranscriptionCancelled thrown to break an offline pause — treat both as
      // a clean cancellation rather than an error bubble in the UI.
      if (job.cancelled || err instanceof TranscriptionCancelled) return { status: 'CANCELLED' };

      // The paused budget ran out. The job is still alive on AWS, so say so
      // and hand back the name rather than implying the work is gone.
      if (err instanceof TranscriptionPauseExpired) {
        transcriptionNotify(ctx, 'Transcription Paused Too Long', err.message.slice(0, 140), 'critical');
        return { status: 'ABANDONED', jobName: err.jobName, message: err.message };
      }

      transcriptionNotify(ctx, 'Transcription Failed', err.message ? err.message.slice(0, 140) : 'An error occurred.', 'critical');
      throw err;
    } finally {
      ctx.transcriptionJob = null;
    }
  });
}

module.exports = { register, invokeChatModel, flushPendingTranscriptionDeletes };
