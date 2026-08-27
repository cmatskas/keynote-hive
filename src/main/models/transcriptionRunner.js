/**
 * transcriptionRunner.js — owns a transcription job for its whole lifetime.
 *
 * Extracted from ipc/bedrock.js, which had accumulated the entire transcription
 * state machine alongside unrelated Chat model code. The move is not cosmetic:
 * it establishes the seam this feature needs, where **the main process owns the
 * job and the renderer merely observes it**.
 *
 * Why that matters. Result delivery used to be tied to the renderer's in-flight
 * `invoke('transcribe-media')` promise, so *any* renderer teardown — the
 * credential-expiry navigation, a reload, a crash — discarded a transcript the
 * main process had already successfully retrieved. The job kept running and
 * billing on AWS with nobody to hand the result to.
 *
 * Two consequences visible in this module:
 *
 *  1. Progress and terminal events are emitted through `ctx.mainWindow` looked
 *     up *at send time*, never through the `event.sender` that started the job.
 *     A captured sender is stale after a reload; the live window is not. This is
 *     what lets a reloaded renderer re-attach and still receive the outcome.
 *  2. `runTranscription()` resolves or rejects with the outcome, but nothing
 *     about delivering that outcome to the renderer lives here — the IPC layer
 *     turns it into an event. Running the job and delivering its result are
 *     deliberately separate concerns.
 *
 * The pausable job state (a network drop or an expired token parks the job
 * rather than failing it) is unchanged from v3.4.0 and sits underneath all of
 * this.
 */

const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const {
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  DeleteTranscriptionJobCommand,
} = require('@aws-sdk/client-transcribe');
const TranscriptMapper = require('./transcriptMapper');
const { notify } = require('../notify');
const { classifyAwsError, isNetworkError } = require('../awsErrors');
const logger = require('electron-log/main');

/** Total time a job may spend paused before we give up and report it. */
const MAX_PAUSED_MS = 30 * 60 * 1000;
/** While paused, retry on this cadence even without an explicit resume signal. */
const PAUSED_RETRY_MS = 60 * 1000;
/** Answered polls only — paused time has its own budget above. */
const MAX_POLL_ATTEMPTS = 60;
const POLL_INTERVAL_MS = 5000;

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

// ── Emitting to whatever renderer is currently live ─────────────────────────

/**
 * Send to the renderer, resolving the window at send time.
 *
 * Deliberately not `event.sender.send`: the webContents that started a job is
 * stale after a reload, so a captured sender silently drops every subsequent
 * event — including the terminal one carrying the transcript.
 */
function emitToRenderer(ctx, channel, payload) {
  const win = ctx.mainWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

/**
 * Emit a progress update and record it on the job, so a renderer that reloaded
 * mid-job can ask for the current state and rebuild its pane rather than showing
 * nothing while a job runs invisibly.
 */
function emitProgress(ctx, job, { status, message, reason = null }) {
  job.status = status;
  job.lastMessage = message;
  job.pauseReason = reason;
  emitToRenderer(ctx, 'transcription-progress', {
    jobId: job.jobId,
    status,
    message,
    ...(reason ? { reason } : {}),
  });
}

/**
 * OS notification for a job reaching a notable state. Clicking it focuses the
 * window and switches to the Transcribe tab — the point of a non-blocking job is
 * that the user is expected to be elsewhere when this fires.
 */
function transcriptionNotify(ctx, title, body, urgency = 'normal') {
  notify({
    title,
    body,
    urgency,
    window: ctx.mainWindow,
    onClick: () => emitToRenderer(ctx, 'transcription-focus-request', { jobId: ctx.transcriptionJob?.jobId || null }),
  });
}

// ── Media upload ────────────────────────────────────────────────────────────

function getMediaFormat(uri) {
  const lowerUri = uri.toLowerCase();
  const formats = { '.mp3': 'mp3', '.wav': 'wav', '.flac': 'flac', '.ogg': 'ogg', '.amr': 'amr', '.webm': 'webm', '.mp4': 'mp4', '.mov': 'mov', '.avi': 'avi', '.mkv': 'mkv', '.flv': 'flv' };
  for (const [ext, fmt] of Object.entries(formats)) {
    if (lowerUri.endsWith(ext)) return fmt;
  }
  return 'mp4';
}

async function uploadMedia(ctx, file, bucket, key, onStart = null) {
  const upload = new Upload({
    client: ctx.awsClients.s3,
    params: { Bucket: bucket, Key: key, Body: file.buffer, ContentType: file.mimetype },
    ...(file.buffer.length >= 20 * 1024 * 1024 ? { queueSize: 4, partSize: 5 * 1024 * 1024 } : {}),
  });
  // Hand the Upload back so an in-flight upload can be aborted (Cancel button)
  // instead of having to run to completion first.
  if (onStart) onStart(upload);
  await upload.done();
  return `s3://${bucket}/${key}`;
}

/**
 * Interruptible sleep. Resolves after `ms` or as soon as `job.wake()` is called,
 * so Cancel doesn't have to wait out the remainder of the current poll interval.
 */
function cancellableSleep(job, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { job.wake = null; resolve(); }, ms);
    job.wake = () => { clearTimeout(timer); job.wake = null; resolve(); };
  });
}

// ── Pausable job state ──────────────────────────────────────────────────────
//
// A job accepted by AWS runs to completion server-side and bills regardless of
// what Hive is doing. Losing the connection, or having the session token expire
// mid-poll, does not break the *job* — it only breaks Hive's ability to observe
// it. Treating either as a failure threw away work the user had already paid for
// and left an orphaned job billing with nobody watching.
//
//   'network' — resumes when connectivity returns
//   'auth'    — resumes when the user saves new credentials
//
// The poll loop re-reads ctx.awsClients every iteration, so refreshed
// credentials are picked up with no extra plumbing.

/**
 * Park the job until something makes it worth retrying: an explicit resume
 * signal, the slow auto-retry tick, cancellation, or the paused budget expiring.
 */
function parkUntilResumable(ctx, job, reason) {
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

  emitProgress(ctx, job, {
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
      // it set while actively retrying would make the job's state lie to
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
 * (throttling, validation, service errors) propagate.
 */
async function observeWithPause(ctx, job, fn) {
  let wasPaused = false;
  for (;;) {
    if (job.cancelled) throw new TranscriptionCancelled();
    try {
      const result = await fn();
      if (wasPaused) {
        logger.info(`[transcribe] resumed job ${job.jobName}`);
        wasPaused = false;
        emitProgress(ctx, job, {
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
      await parkUntilResumable(ctx, job, kind);
    }
  }
}

// ── Job deletion (stops billing) ────────────────────────────────────────────

function _queueDelete(ctx, jobName, why) {
  ctx.pendingTranscriptionDeletes = ctx.pendingTranscriptionDeletes || [];
  if (!ctx.pendingTranscriptionDeletes.includes(jobName)) {
    ctx.pendingTranscriptionDeletes.push(jobName);
  }
  logger.info(`[transcribe] ${why} — queued delete of job ${jobName} for reconnect`);
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
    _queueDelete(ctx, jobName, 'offline');
    return false;
  }

  try {
    await ctx.awsClients.transcribe.send(new DeleteTranscriptionJobCommand({ TranscriptionJobName: jobName }));
    logger.info(`[transcribe] deleted cancelled job ${jobName}`);
    return true;
  } catch (err) {
    if (isNetworkError(err)) {
      _queueDelete(ctx, jobName, 'delete failed on network');
      return false;
    }
    logger.warn(`[transcribe] could not delete job ${jobName}: ${err.message}`);
    return false;
  }
}

/**
 * Retry deletes queued while offline. Called on reconnect from main.js. Jobs
 * that still can't be deleted stay queued for the next attempt.
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

// ── Configuration guard ─────────────────────────────────────────────────────

/**
 * Reject a transcription that can't possibly succeed, before spending anything
 * on it.
 *
 * Both bucket settings default to empty — there's no possible default, since
 * bucket names are unique across all of AWS. `OutputBucketName` was once passed
 * through unconditionally, so a blank setting sent an empty string, which cannot
 * satisfy the parameter's documented pattern. Nothing validated it and Setup
 * Check only looked at the input bucket, so the job failed at AWS with an opaque
 * error.
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

// ── Job lifecycle ───────────────────────────────────────────────────────────

/**
 * Derive a default display name from the media file name: strip the extension,
 * keep the rest as the user wrote it. Deliberately not slugified — this is the
 * human-facing label, and it is editable the moment the job starts.
 */
function deriveDisplayName(fileName) {
  if (!fileName) return 'Untitled transcription';
  const withoutExt = fileName.replace(/\.[^.]+$/, '');
  return withoutExt.trim() || fileName;
}

/**
 * Create the job record. `jobId` is Hive's own identifier, assigned up front so
 * every event can be attributed — the AWS `jobName` isn't known until the media
 * has uploaded, which is far too late for the first progress events.
 */
function createJob({ sourceFile, displayName = null }) {
  return {
    jobId: `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    jobName: null,          // AWS TranscriptionJobName, set after upload
    displayName: displayName || deriveDisplayName(sourceFile),
    sourceFile: sourceFile || null,
    mediaKey: null,         // S3 key of the uploaded media — recorded for later playback
    status: 'STARTING',
    lastMessage: 'Preparing transcription...',
    cancelled: false,
    upload: null,
    wake: null,
    // Pause bookkeeping — see parkUntilResumable().
    paused: null,
    pauseReason: null,
    pausedTotalMs: 0,
    pauseNotified: false,
    resume: null,
  };
}

/**
 * Run a transcription to completion.
 *
 * Resolves with the outcome (`COMPLETED` / `CANCELLED` / `ABANDONED`) or rejects
 * for a genuine failure. Nothing here delivers that outcome to the renderer —
 * see the `transcribe-media` handler, which turns it into a terminal event so
 * the result survives a renderer that has gone away.
 */
async function runTranscription(ctx, job, { file }) {
  const fileObj = {
    buffer: Buffer.from(file.buffer),
    originalname: file.name,
    mimetype: file.type,
  };

  try {
    // Configuration check first: no upload, no job, no S3 charges for something
    // that can't start.
    const settings = ctx.currentSettings || await ctx.settingsManager.loadSettings();
    assertTranscriptionConfigured(settings);

    emitProgress(ctx, job, { status: 'UPLOADING', message: 'Uploading file to S3...' });

    // Recorded on the job so a past transcript can find its media later. The
    // key is not derivable from the AWS job name, so failing to capture it here
    // is effectively unrecoverable.
    job.mediaKey = `${Date.now()}-${fileObj.originalname}`;
    const mediaUri = await uploadMedia(
      ctx, fileObj, settings.bucketName, job.mediaKey,
      (upload) => { job.upload = upload; }
    );
    job.upload = null;
    if (job.cancelled) return { status: 'CANCELLED', jobId: job.jobId };

    const mediaFormat = getMediaFormat(mediaUri);
    job.jobName = `transcription-${Date.now()}`;

    await ctx.awsClients.transcribe.send(new StartTranscriptionJobCommand({
      TranscriptionJobName: job.jobName,
      Media: { MediaFileUri: mediaUri },
      MediaFormat: mediaFormat,
      LanguageCode: settings.transcriptionLanguage,
      OutputBucketName: settings.outputBucketName,
      Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: 5 },
    }));

    emitProgress(ctx, job, { status: 'IN_PROGRESS', message: 'Transcription job started. Processing audio...' });

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      if (job.cancelled) return { status: 'CANCELLED', jobId: job.jobId };

      const jobStatus = await observeWithPause(ctx, job, async () => {
        const res = await ctx.awsClients.transcribe.send(
          new GetTranscriptionJobCommand({ TranscriptionJobName: job.jobName })
        );
        return res.TranscriptionJob;
      });

      if (jobStatus.TranscriptionJobStatus === 'COMPLETED') {
        emitProgress(ctx, job, { status: 'RETRIEVING', message: 'Retrieving transcription results...' });
        // Fetching the result is as interruptible as polling was, and failing
        // here would discard a transcript AWS has already produced — so it goes
        // through the same pause-and-retry path.
        const transcript = await observeWithPause(ctx, job, async () => {
          const url = new URL(jobStatus.Transcript.TranscriptFileUri);
          const bucket = url.pathname.split('/')[1];
          const key = url.pathname.split('/').slice(2).join('/');
          const objRes = await ctx.awsClients.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
          return JSON.parse(await objRes.Body.transformToString());
        });
        const mapper = new TranscriptMapper(transcript);
        if (job.cancelled) return { status: 'CANCELLED', jobId: job.jobId };

        transcriptionNotify(ctx, 'Transcription Complete', `${job.displayName} is ready to read.`);
        return {
          status: 'COMPLETED',
          jobId: job.jobId,
          jobName: job.jobName,
          displayName: job.displayName,
          sourceFile: job.sourceFile,
          mediaKey: job.mediaKey,
          transcript: mapper.getAllTimestampedText(),
        };
      } else if (jobStatus.TranscriptionJobStatus === 'FAILED') {
        throw new Error(`Transcription job failed: ${jobStatus.FailureReason || 'Unknown error'}`);
      }

      const elapsed = Math.floor((attempt + 1) * POLL_INTERVAL_MS / 1000);
      emitProgress(ctx, job, { status: 'IN_PROGRESS', message: `Processing audio... (${elapsed}s elapsed)` });
      await cancellableSleep(job, POLL_INTERVAL_MS);
    }

    if (job.cancelled) return { status: 'CANCELLED', jobId: job.jobId };
    throw new Error('Transcription job timed out after 5 minutes');
  } catch (err) {
    // A cancel surfaces either as the flag (upload abort) or as the thrown
    // TranscriptionCancelled that breaks a pause — both are a clean stop.
    if (job.cancelled || err instanceof TranscriptionCancelled) {
      return { status: 'CANCELLED', jobId: job.jobId };
    }

    // The paused budget ran out. The job is still alive on AWS, so say so and
    // hand back the name rather than implying the work is gone.
    if (err instanceof TranscriptionPauseExpired) {
      transcriptionNotify(ctx, 'Transcription Paused Too Long', err.message.slice(0, 140), 'critical');
      return { status: 'ABANDONED', jobId: job.jobId, jobName: err.jobName, message: err.message };
    }

    transcriptionNotify(ctx, 'Transcription Failed', err.message ? err.message.slice(0, 140) : 'An error occurred.', 'critical');
    throw err;
  }
}

/**
 * Cancel the in-flight job: abort the upload if it's still running, wake the
 * poll loop (or an offline pause) immediately, and best-effort delete the
 * Transcribe job so it stops billing.
 */
async function cancelTranscription(ctx) {
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
  return { cancelled: true, jobId: job.jobId };
}

/**
 * Current job state, for a renderer that has just loaded (or reloaded) and needs
 * to know whether a job is running before it can decide what to show. Without
 * this a reload during a job leaves the UI blank while the job runs invisibly.
 */
function getTranscriptionState(ctx) {
  const job = ctx.transcriptionJob;
  if (!job) return { active: false };
  return {
    active: true,
    jobId: job.jobId,
    jobName: job.jobName,
    displayName: job.displayName,
    sourceFile: job.sourceFile,
    status: job.status,
    message: job.lastMessage,
    paused: job.paused,
    pauseReason: job.pauseReason,
  };
}

/** Rename the in-flight job. The display name is Hive-side, so this is local. */
function renameActiveTranscription(ctx, jobId, displayName) {
  const job = ctx.transcriptionJob;
  if (!job || job.jobId !== jobId) return { renamed: false };
  const trimmed = (displayName || '').trim();
  if (!trimmed) return { renamed: false };
  job.displayName = trimmed;
  return { renamed: true, displayName: trimmed };
}

module.exports = {
  runTranscription,
  cancelTranscription,
  getTranscriptionState,
  renameActiveTranscription,
  createJob,
  deriveDisplayName,
  flushPendingTranscriptionDeletes,
  deleteTranscriptionJob,
  assertTranscriptionConfigured,
  emitToRenderer,
  TranscriptionCancelled,
  TranscriptionPauseExpired,
  MAX_PAUSED_MS,
  PAUSED_RETRY_MS,
  MAX_POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
};
