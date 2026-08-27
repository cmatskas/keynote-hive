/**
 * transcriptionRegistry.js — local index of everything Hive has transcribed.
 *
 * This is what stops users re-running transcriptions they have already paid for.
 * A completed job on AWS was previously unreachable from Hive the moment the
 * renderer moved on: nothing recorded that it existed, what it was called, or
 * where its transcript lived.
 *
 * Storage follows the same convention as the conversation and work-history
 * managers — plain JSON under the app's userData directory, so everything here
 * is readable offline and survives losing AWS access entirely.
 *
 * Metadata and transcript are deliberately **separate files**. `list()` renders a
 * sidebar, and a transcript can run to hundreds of kilobytes; keeping them apart
 * means listing reads a few hundred bytes per entry instead of the whole corpus.
 * (Work history reads whole files in its list(), which is fine for chat messages
 * and would not be here.)
 *
 * This registry is the fast, offline tier. It is not the only one — the runner
 * also writes a sidecar object next to the transcript in the user's own output
 * bucket, so the index can be rebuilt from AWS if userData is ever lost. See the
 * storage-model notes in RELEASE_NOTES.
 */

const { app } = require('electron');
const fs = require('fs').promises;
const path = require('path');
const log = require('electron-log/main');

class TranscriptionRegistry {
  constructor(dir = null) {
    this.dir = dir || path.join(app.getPath('userData'), 'transcriptions');
  }

  async _ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  _recordPath(jobId) {
    return path.join(this.dir, `${jobId}.json`);
  }

  _transcriptPath(jobId) {
    return path.join(this.dir, `${jobId}.transcript.json`);
  }

  /**
   * Duration of a transcript, from the last segment's end time. Cheap to compute
   * once and worth storing, because the sidebar wants to show it without loading
   * the transcript itself.
   */
  static durationOf(transcript) {
    if (!Array.isArray(transcript) || transcript.length === 0) return null;
    const last = transcript[transcript.length - 1];
    const end = Number(last?.endTime);
    return Number.isFinite(end) ? end : null;
  }

  /**
   * Record a finished job. `transcript` may be omitted for a job that has no
   * transcript to store — an abandoned one is still worth recording, because it
   * is still running on AWS and still retrievable later.
   */
  async save(record, transcript = null) {
    await this._ensureDir();
    if (!record?.jobId) throw new Error('A transcription record needs a jobId');

    const stored = {
      ...record,
      savedAt: new Date().toISOString(),
      hasTranscript: Array.isArray(transcript) && transcript.length > 0,
      segmentCount: Array.isArray(transcript) ? transcript.length : 0,
      durationSeconds: TranscriptionRegistry.durationOf(transcript),
    };

    if (stored.hasTranscript) {
      await fs.writeFile(this._transcriptPath(record.jobId), JSON.stringify(transcript));
    }
    await fs.writeFile(this._recordPath(record.jobId), JSON.stringify(stored, null, 2));
    log.info(`[registry] saved transcription ${record.jobId} (${stored.segmentCount} segments)`);
    return stored;
  }

  /** Metadata only, newest first. Deliberately does not read transcripts. */
  async list() {
    await this._ensureDir();
    let files;
    try {
      files = await fs.readdir(this.dir);
    } catch {
      return [];
    }

    const records = [];
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.transcript.json')) continue;
      try {
        records.push(JSON.parse(await fs.readFile(path.join(this.dir, f), 'utf8')));
      } catch {
        // Skip a corrupt record rather than failing the whole list — one bad
        // file shouldn't hide every other transcript.
        log.warn(`[registry] skipping unreadable record: ${f}`);
      }
    }
    return records.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }

  async getRecord(jobId) {
    try {
      return JSON.parse(await fs.readFile(this._recordPath(jobId), 'utf8'));
    } catch {
      return null;
    }
  }

  async getTranscript(jobId) {
    try {
      return JSON.parse(await fs.readFile(this._transcriptPath(jobId), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Full entry — metadata plus transcript. Null if there's no such record. */
  async get(jobId) {
    const record = await this.getRecord(jobId);
    if (!record) return null;
    return { ...record, transcript: await this.getTranscript(jobId) };
  }

  async rename(jobId, displayName) {
    const trimmed = (displayName || '').trim();
    if (!trimmed) return null;

    const record = await this.getRecord(jobId);
    if (!record) return null;

    record.displayName = trimmed;
    record.renamedAt = new Date().toISOString();
    await fs.writeFile(this._recordPath(jobId), JSON.stringify(record, null, 2));
    return record;
  }

  /**
   * Remove the local copy. Deliberately local-only: the transcript in the user's
   * output bucket is the durable copy and deleting it is irreversible, so that
   * has to be an explicit, separate choice.
   */
  async remove(jobId) {
    for (const p of [this._recordPath(jobId), this._transcriptPath(jobId)]) {
      try { await fs.unlink(p); } catch { /* already gone */ }
    }
  }

  async has(jobId) {
    return (await this.getRecord(jobId)) !== null;
  }
}

module.exports = TranscriptionRegistry;
