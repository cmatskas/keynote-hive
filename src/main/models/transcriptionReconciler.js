/**
 * transcriptionReconciler.js — rebuild the local index from AWS.
 *
 * The registry (v3.7.0) only knows about jobs transcribed since it existed, and
 * it lives in `userData`, which a reinstall or a new machine takes with it. This
 * closes both gaps by asking AWS what is actually there.
 *
 * Two sources, deliberately in this order:
 *
 *  1. **The output bucket.** Since v3.5.0 that bucket is guaranteed to exist and
 *     belong to the user, and since v3.7.0 each completed job leaves a
 *     `<jobName>.hive.json` sidecar next to its transcript. A sidecar carries the
 *     display name and the original `jobId`, so re-importing restores an entry
 *     exactly as it was — and this works even after Transcribe has aged the job
 *     metadata out of its own history. A transcript with no sidecar is a
 *     pre-v3.7.0 job: still importable, just unnamed.
 *  2. **Transcribe's job history.** Covers jobs whose output went to a
 *     service-managed bucket, or whose objects have since been deleted. Metadata
 *     only — there is no transcript to attach.
 *
 * Existing local records are never overwritten. A local record may carry a name
 * the user typed, and AWS has no idea about that.
 *
 * Each source is attempted independently and its failure reported rather than
 * thrown: listing the bucket needs `s3:ListBucket`, which a scoped-down role may
 * not have, and that must not prevent the other source from working.
 */

const { ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { ListTranscriptionJobsCommand } = require('@aws-sdk/client-transcribe');
const TranscriptMapper = require('./transcriptMapper');
const logger = require('electron-log/main');

const SIDECAR_SUFFIX = '.hive.json';
const TRANSCRIPT_SUFFIX = '.json';

/** Guards against an unbounded walk if a bucket holds a very large history. */
const MAX_PAGES = 20;

/**
 * Group the output bucket's objects by AWS job name, noting which of the two
 * objects (transcript, sidecar) each job has.
 */
async function _scanOutputBucket(ctx, bucket) {
  const jobs = new Map(); // jobName -> { transcriptKey, sidecarKey, lastModified }
  let token;
  let pages = 0;

  do {
    const res = await ctx.awsClients.s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: token,
    }));

    for (const obj of res.Contents || []) {
      const key = obj.Key || '';
      if (key.endsWith(SIDECAR_SUFFIX)) {
        const jobName = key.slice(0, -SIDECAR_SUFFIX.length);
        const entry = jobs.get(jobName) || {};
        entry.sidecarKey = key;
        entry.lastModified = entry.lastModified || obj.LastModified;
        jobs.set(jobName, entry);
      } else if (key.endsWith(TRANSCRIPT_SUFFIX)) {
        const jobName = key.slice(0, -TRANSCRIPT_SUFFIX.length);
        const entry = jobs.get(jobName) || {};
        entry.transcriptKey = key;
        entry.lastModified = obj.LastModified || entry.lastModified;
        jobs.set(jobName, entry);
      }
    }

    token = res.IsTruncated ? res.NextContinuationToken : undefined;
    pages++;
  } while (token && pages < MAX_PAGES);

  if (token) {
    logger.warn(`[reconcile] stopped scanning ${bucket} after ${MAX_PAGES} pages`);
  }
  return jobs;
}

async function _readJson(ctx, bucket, key) {
  const res = await ctx.awsClients.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse(await res.Body.transformToString());
}

/**
 * Turn a raw Transcribe output document into the timestamped segments the rest of
 * Hive uses, via the same mapper the live path uses so imported transcripts are
 * indistinguishable from freshly-made ones.
 */
function _toSegments(raw) {
  try {
    return new TranscriptMapper(raw).getAllTimestampedText();
  } catch (err) {
    logger.warn(`[reconcile] could not map a transcript: ${err.message}`);
    return null;
  }
}

/** Import everything the output bucket knows about that the registry doesn't. */
async function _importFromBucket(ctx, bucket, knownJobNames, result) {
  const jobs = await _scanOutputBucket(ctx, bucket);

  for (const [jobName, entry] of jobs) {
    if (knownJobNames.has(jobName)) {
      result.skipped++;
      continue;
    }

    try {
      let record = null;
      if (entry.sidecarKey) {
        // Best case: the sidecar restores the entry as it was, name and all.
        record = await _readJson(ctx, bucket, entry.sidecarKey);
      }

      let transcript = null;
      if (entry.transcriptKey) {
        transcript = _toSegments(await _readJson(ctx, bucket, entry.transcriptKey));
      }

      if (!record) {
        // A transcript with no sidecar predates naming. Import it unnamed rather
        // than inventing a name — the sidebar shows it with a prompt to name it.
        record = {
          jobId: `imported-${jobName}`,
          jobName,
          displayName: jobName,
          sourceFile: null,
          mediaKey: null,
          outputBucket: bucket,
          status: 'COMPLETED',
          createdAt: entry.lastModified ? new Date(entry.lastModified).toISOString() : null,
        };
      }

      record.importedAt = new Date().toISOString();
      record.importedFrom = entry.sidecarKey ? 'sidecar' : 'transcript';
      await ctx.transcriptionRegistry.save(record, transcript);

      knownJobNames.add(jobName);
      result.imported++;
      if (entry.sidecarKey) result.fromSidecar++; else result.fromTranscript++;
    } catch (err) {
      logger.warn(`[reconcile] could not import ${jobName}: ${err.message}`);
      result.failed++;
    }
  }
}

/**
 * Import jobs Transcribe still remembers but the bucket doesn't account for —
 * typically output that went to a service-managed bucket. Metadata only.
 */
async function _importFromJobHistory(ctx, knownJobNames, result) {
  let token;
  let pages = 0;

  do {
    const res = await ctx.awsClients.transcribe.send(new ListTranscriptionJobsCommand({
      MaxResults: 100,
      NextToken: token,
    }));

    for (const summary of res.TranscriptionJobSummaries || []) {
      const jobName = summary.TranscriptionJobName;
      if (!jobName || knownJobNames.has(jobName)) {
        if (jobName) result.skipped++;
        continue;
      }

      try {
        await ctx.transcriptionRegistry.save({
          jobId: `imported-${jobName}`,
          jobName,
          displayName: jobName,
          sourceFile: null,
          mediaKey: null,
          // A service-managed transcript can only be reached through a fresh
          // GetTranscriptionJob, and only while AWS still holds the job.
          outputBucket: summary.OutputLocationType === 'CUSTOMER_BUCKET'
            ? (ctx.currentSettings?.outputBucketName || null)
            : null,
          outputLocationType: summary.OutputLocationType || null,
          language: summary.LanguageCode || null,
          status: summary.TranscriptionJobStatus === 'COMPLETED' ? 'COMPLETED' : (summary.TranscriptionJobStatus || null),
          createdAt: summary.CreationTime ? new Date(summary.CreationTime).toISOString() : null,
          completedAt: summary.CompletionTime ? new Date(summary.CompletionTime).toISOString() : null,
          importedAt: new Date().toISOString(),
          importedFrom: 'jobHistory',
        }, null);

        knownJobNames.add(jobName);
        result.imported++;
        result.fromJobHistory++;
      } catch (err) {
        logger.warn(`[reconcile] could not import ${jobName} from job history: ${err.message}`);
        result.failed++;
      }
    }

    token = res.NextToken;
    pages++;
  } while (token && pages < MAX_PAGES);
}

/**
 * Reconcile the local registry against AWS.
 *
 * @returns {Promise<object>} counts plus a per-source error list, so the UI can
 *   report a partial success honestly (e.g. "12 found, but the bucket couldn't be
 *   listed — s3:ListBucket is missing").
 */
async function reconcile(ctx) {
  ctx.assertOnline('Finding past transcriptions');

  const result = {
    imported: 0,
    skipped: 0,
    failed: 0,
    fromSidecar: 0,
    fromTranscript: 0,
    fromJobHistory: 0,
    errors: [],
  };

  const existing = await ctx.transcriptionRegistry.list();
  const knownJobNames = new Set(existing.map(r => r.jobName).filter(Boolean));

  const settings = ctx.currentSettings || await ctx.settingsManager.loadSettings();
  const bucket = settings.outputBucketName;

  if (bucket) {
    try {
      await _importFromBucket(ctx, bucket, knownJobNames, result);
    } catch (err) {
      // Most likely a missing s3:ListBucket on a scoped-down role. Say so plainly
      // rather than reporting a generic failure, and carry on to job history.
      const hint = /AccessDenied|Forbidden/i.test(err.name || err.message || '')
        ? ` — this needs s3:ListBucket on ${bucket}`
        : '';
      result.errors.push(`Could not list the output bucket${hint}: ${err.message}`);
      logger.warn(`[reconcile] bucket scan failed: ${err.message}`);
    }
  } else {
    result.errors.push('No output bucket is configured, so stored transcripts could not be scanned.');
  }

  try {
    await _importFromJobHistory(ctx, knownJobNames, result);
  } catch (err) {
    result.errors.push(`Could not list Transcribe jobs: ${err.message}`);
    logger.warn(`[reconcile] job history scan failed: ${err.message}`);
  }

  logger.info(`[reconcile] imported ${result.imported}, skipped ${result.skipped}, failed ${result.failed}`);
  return result;
}

module.exports = { reconcile, MAX_PAGES };
