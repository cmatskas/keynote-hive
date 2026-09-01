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

const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
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
/**
 * How long Hive keeps watching a job AWS has accepted.
 *
 * This was 60 attempts x 5s = exactly 5 minutes, which made long media
 * structurally impossible: Transcribe accepts up to 4 hours of audio and takes
 * real time roughly proportional to its length, so anything past a short clip
 * blew the cap and was reported as a failure while the job ran on to completion
 * and billed. The ceiling is now Transcribe's own maximum media duration plus
 * margin for queueing.
 *
 * Still bounded rather than open-ended, so a job that somehow never reaches a
 * terminal state ends rather than polling forever.
 *
 * Excludes time spent paused for connectivity or credentials — that has its own
 * budget in MAX_PAUSED_MS, and an outage must not eat the processing budget.
 */
const MAX_PROCESSING_MS = 5 * 60 * 60 * 1000;

/**
 * Poll cadence, widening as a job runs. Short files stay responsive (a
 * 30-second clip finishes within the first few polls) while a 4-hour job costs
 * roughly 270 GetTranscriptionJob calls instead of the ~2,880 a flat 5s would.
 */
const POLL_SCHEDULE = [
  { untilMs: 60 * 1000, everyMs: 5 * 1000 },
  { untilMs: 5 * 60 * 1000, everyMs: 15 * 1000 },
  { untilMs: 15 * 60 * 1000, everyMs: 30 * 1000 },
];
const POLL_INTERVAL_MAX_MS = 60 * 1000;

/** Poll interval for a job that has been processing for `elapsedMs`. */
function pollIntervalFor(elapsedMs) {
  for (const step of POLL_SCHEDULE) {
    if (elapsedMs < step.untilMs) return step.everyMs;
  }
  return POLL_INTERVAL_MAX_MS;
}

/**
 * Time spent actually observing the job, excluding pauses. Never negative, so a
 * clock adjustment cannot make the budget look already spent.
 */
function observedProcessingMs(job, now = Date.now()) {
  if (!job.pollStartedAt) return 0;
  return Math.max(0, now - job.pollStartedAt - (job.pausedTotalMs || 0));
}

/** Human-readable elapsed time: seconds, then minutes, then hours. */
function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

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

/**
 * The processing budget ran out. Deliberately its own type, and deliberately not
 * a generic failure: the job is alive on AWS and will finish and bill whatever
 * Hive does, so the only honest report names it and says where to collect it.
 */
class TranscriptionStillProcessing extends Error {
  constructor(jobName, observedMs) {
    super(
      `Transcription is taking longer than ${formatElapsed(observedMs)}, so Hive has stopped waiting. ` +
      `The job "${jobName}" is still running on AWS — use "Find past transcriptions" to collect the ` +
      'transcript once it finishes. You will not be charged twice.'
    );
    this.name = 'TranscriptionStillProcessing';
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
    // Declared before finish() and initialised to null on purpose. The
    // budget-exhausted path below calls finish() *before* the timer is created,
    // and a `const` declared further down would put this reference in its
    // temporal dead zone — which turned the ABANDONED outcome into a
    // ReferenceError, surfacing as a generic failure instead of "paused too
    // long, the job is still on AWS". clearTimeout(null) is a no-op.
    let retryTimer = null;
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

    retryTimer = setTimeout(() => {
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

// ── Durable record: local registry + sidecar in the output bucket ───────────

/**
 * Write the sidecar object that sits next to the transcript in the user's own
 * output bucket.
 *
 * This is what makes the index rebuildable without Hive's local state and
 * without Transcribe's job history: a single `ListObjectsV2` over the output
 * bucket yields every transcript *and* its display name, which outlives the
 * retention window that eventually removes job metadata. It only became possible
 * once v3.5.0 guaranteed the output bucket exists and belongs to the user.
 *
 * Best-effort by design. The transcript has already been retrieved and is about
 * to be saved locally, so a failed sidecar write must not fail the job — it only
 * costs us the AWS-side recovery tier.
 */
async function writeSidecar(ctx, job, record) {
  const settings = ctx.currentSettings || await ctx.settingsManager.loadSettings();
  if (!settings.outputBucketName || !job.jobName) return false;

  try {
    await ctx.awsClients.s3.send(new PutObjectCommand({
      Bucket: settings.outputBucketName,
      Key: `${job.jobName}.hive.json`,
      Body: JSON.stringify(record, null, 2),
      ContentType: 'application/json',
    }));
    logger.info(`[transcribe] wrote sidecar ${job.jobName}.hive.json`);
    return true;
  } catch (err) {
    logger.warn(`[transcribe] could not write sidecar for ${job.jobName}: ${err.message}`);
    return false;
  }
}

/** The metadata both the local registry and the sidecar carry. */
function buildRecord(ctx, job, status, extra = {}) {
  const settings = ctx.currentSettings || {};
  return {
    jobId: job.jobId,
    jobName: job.jobName,
    displayName: job.displayName,
    sourceFile: job.sourceFile,
    // Not derivable from the AWS job name, so it has to be carried through.
    mediaKey: job.mediaKey,
    mediaBucket: settings.bucketName || null,
    outputBucket: settings.outputBucketName || null,
    language: settings.transcriptionLanguage || null,
    status,
    createdAt: job.createdAt,
    completedAt: new Date().toISOString(),
    ...extra,
  };
}

/**
 * Persist a finished job locally and, best-effort, to the output bucket.
 * Never throws — a job that succeeded must not be reported as failed because
 * bookkeeping afterwards went wrong.
 */
async function persistJob(ctx, job, status, transcript = null, extra = {}) {
  const record = buildRecord(ctx, job, status, extra);
  try {
    if (ctx.transcriptionRegistry) await ctx.transcriptionRegistry.save(record, transcript);
  } catch (err) {
    logger.error(`[transcribe] could not save registry record for ${job.jobId}: ${err.message}`);
  }
  await writeSidecar(ctx, job, record);
  return record;
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
    createdAt: new Date().toISOString(),
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

    job.pollStartedAt = Date.now();

    for (;;) {
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

        const segments = mapper.getAllTimestampedText();

        // Persist before announcing. If the app dies between the two, the
        // transcript is already on disk and in the output bucket — the opposite
        // order would report success for something unrecoverable.
        const record = await persistJob(ctx, job, 'COMPLETED', segments);

        transcriptionNotify(ctx, 'Transcription Complete', `${job.displayName} is ready to read.`);
        return {
          status: 'COMPLETED',
          jobId: job.jobId,
          jobName: job.jobName,
          displayName: job.displayName,
          sourceFile: job.sourceFile,
          mediaKey: job.mediaKey,
          record,
          transcript: segments,
        };
      } else if (jobStatus.TranscriptionJobStatus === 'FAILED') {
        throw new Error(`Transcription job failed: ${jobStatus.FailureReason || 'Unknown error'}`);
      }

      // Measured, not derived from the attempt count: the interval widens as a
      // job runs, so attempts x interval would report a duration that never
      // happened.
      const observedMs = observedProcessingMs(job);

      if (observedMs >= MAX_PROCESSING_MS) {
        if (job.cancelled) return { status: 'CANCELLED', jobId: job.jobId };
        throw new TranscriptionStillProcessing(job.jobName, observedMs);
      }

      emitProgress(ctx, job, {
        status: 'IN_PROGRESS',
        message: `Processing audio... (${formatElapsed(observedMs)} elapsed)`,
      });
      await cancellableSleep(job, pollIntervalFor(observedMs));
    }
  } catch (err) {
    // A cancel surfaces either as the flag (upload abort) or as the thrown
    // TranscriptionCancelled that breaks a pause — both are a clean stop.
    if (job.cancelled || err instanceof TranscriptionCancelled) {
      return { status: 'CANCELLED', jobId: job.jobId };
    }

    // The paused budget ran out. The job is still alive on AWS, so say so and
    // hand back the name rather than implying the work is gone. Recorded too —
    // an abandoned job is exactly the kind the user would otherwise re-run,
    // since it is still there to be collected.
    if (err instanceof TranscriptionPauseExpired) {
      await persistJob(ctx, job, 'ABANDONED', null, { abandonedReason: job.pauseReason || 'network' });
      transcriptionNotify(ctx, 'Transcription Paused Too Long', err.message.slice(0, 140), 'critical');
      return { status: 'ABANDONED', jobId: job.jobId, jobName: err.jobName, message: err.message };
    }

    // Same situation as above — Hive stopped watching, AWS did not stop working —
    // so it gets the same treatment. Reporting this as a failure (which it did)
    // told the user their transcript was gone while they were being billed for
    // one that was about to exist, and wrote no record, so nothing pointed at
    // the job that could still be collected.
    if (err instanceof TranscriptionStillProcessing) {
      await persistJob(ctx, job, 'ABANDONED', null, { abandonedReason: 'timeout' });
      transcriptionNotify(ctx, 'Transcription Still Running', err.message.slice(0, 140), 'critical');
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

/**
 * Rename a transcription, whether it is still running or already finished.
 *
 * Two targets because a rename can happen at either point: while the job runs
 * the name lives only in memory (the registry record isn't written until
 * completion, and it picks up whatever the name is by then), and afterwards it
 * lives in the registry. The sidecar in the output bucket is refreshed too so the
 * AWS-side recovery tier doesn't drift from the local one — best-effort, since
 * that tier is a backstop and a rename must still succeed offline.
 */
async function renameTranscription(ctx, jobId, displayName) {
  const active = renameActiveTranscription(ctx, jobId, displayName);
  if (active.renamed) return active;

  if (!ctx.transcriptionRegistry) return { renamed: false };
  const record = await ctx.transcriptionRegistry.rename(jobId, displayName);
  if (!record) return { renamed: false };

  if (record.jobName && ctx.isOnline()) {
    await writeSidecar(ctx, { jobName: record.jobName }, record);
  }
  return { renamed: true, displayName: record.displayName };
}

module.exports = {
  runTranscription,
  pollIntervalFor,
  observedProcessingMs,
  formatElapsed,
  MAX_PROCESSING_MS,
  persistJob,
  writeSidecar,
  buildRecord,
  cancelTranscription,
  getTranscriptionState,
  renameActiveTranscription,
  renameTranscription,
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
  TranscriptionStillProcessing,
};
