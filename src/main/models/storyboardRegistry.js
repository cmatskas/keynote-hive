/**
 * storyboardRegistry.js — local store for saved StoryBrand analyses.
 *
 * Deliberately independent of anything transcription does. It borrows the *shape*
 * of TranscriptionRegistry — a JSON store under userData with list/get/rename/
 * search/remove — and none of its machinery: no jobs, no S3, no sidecars, no
 * polling, no reconciliation. An analysis is a local artifact; the only thing that
 * ever went to AWS was the one classification call that produced it.
 *
 * WHY ANALYSES ARE PERSISTED AT ALL
 * ---------------------------------
 * Classification is not deterministic. Re-running the same script can land a
 * transitional paragraph on a different element, so if the result were recomputed
 * on open, the colours would shift under the user between viewings. Storing the
 * snapshot — the extracted units *and* the classification together — means what
 * you saw yesterday is what you see today.
 *
 * REVISIONS
 * ---------
 * The tab is read-only by design: editing happens in Word or wherever the script
 * actually lives, and the user re-uploads. `revisionOf` links the new analysis back
 * to the one it supersedes, which turns a flat list into a history — "did my
 * rewrite fix the Guide section?" is answerable by comparing two entries rather
 * than by remembering.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const log = require('electron-log/main');

/** Snippet size either side of a search hit. */
const CONTEXT_CHARS = 70;

class StoryboardRegistry {
  constructor(dir = null) {
    this.dir = dir || path.join(app.getPath('userData'), 'storyboard-analyses');
  }

  async _ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  _file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  /**
   * Reject anything that could escape the store directory. Ids are generated
   * here, but they also arrive back over IPC from the renderer.
   */
  static isValidId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(id);
  }

  static newId() {
    return `sb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Persist an analysis.
   *
   * @param {object} analysis
   * @param {Array}  analysis.units           - extracted units (the text of record)
   * @param {object} analysis.classifications - index -> element key
   * @param {object} analysis.audit
   * @param {string} analysis.sourceName
   * @param {string} analysis.format
   * @param {number} analysis.wordCount
   * @param {string} analysis.modelId
   * @param {string} [analysis.displayName]
   * @param {string} [analysis.revisionOf]    - id of the analysis this supersedes
   */
  async save(analysis) {
    await this._ensureDir();

    const id = analysis.id && StoryboardRegistry.isValidId(analysis.id)
      ? analysis.id
      : StoryboardRegistry.newId();

    const record = {
      id,
      displayName: analysis.displayName || analysis.sourceName || 'Untitled analysis',
      sourceName: analysis.sourceName || '',
      format: analysis.format || 'text',
      wordCount: analysis.wordCount || 0,
      unitCount: Array.isArray(analysis.units) ? analysis.units.length : 0,
      modelId: analysis.modelId || '',
      revisionOf: analysis.revisionOf || null,
      createdAt: analysis.createdAt || Date.now(),
      updatedAt: Date.now(),
      units: analysis.units || [],
      classifications: analysis.classifications || {},
      audit: analysis.audit || null,
    };

    await fs.writeFile(this._file(id), JSON.stringify(record, null, 2));
    log.info(`[storyboard] saved analysis ${id} (${record.unitCount} units)`);
    return record;
  }

  /**
   * Summaries for the sidebar, newest first.
   *
   * Deliberately omits `units`, `classifications` and `audit`: the list only needs
   * metadata, and a few dozen full analyses would be megabytes of payload crossing
   * IPC on every render.
   */
  async list() {
    await this._ensureDir();
    let names;
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }

    const records = [];
    for (const name of names.filter(n => n.endsWith('.json'))) {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8'));
        const { units, classifications, audit, ...summary } = raw;
        records.push({
          ...summary,
          // Enough for the sidebar to show a story-shape preview without the payload.
          elementCounts: countElements(classifications),
          hasAudit: !!audit,
        });
      } catch (err) {
        // One unreadable file must not hide the rest of the user's history.
        log.warn(`[storyboard] skipping unreadable ${name}: ${err.message}`);
      }
    }
    return records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /** Full analysis, or null when it doesn't exist. */
  async get(id) {
    if (!StoryboardRegistry.isValidId(id)) return null;
    try {
      return JSON.parse(await fs.readFile(this._file(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async rename(id, displayName) {
    const record = await this.get(id);
    if (!record) return null;
    const trimmed = String(displayName || '').trim();
    if (!trimmed) throw new Error('Name cannot be empty');
    record.displayName = trimmed;
    record.updatedAt = Date.now();
    await fs.writeFile(this._file(id), JSON.stringify(record, null, 2));
    return record;
  }

  async remove(id) {
    if (!StoryboardRegistry.isValidId(id)) return false;
    try {
      await fs.unlink(this._file(id));
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  /**
   * Search inside the saved scripts, not just their names.
   *
   * The point is to find a keynote by something said in it — the same reasoning as
   * the transcript search, reached independently: a name you typed months ago is a
   * worse handle on a document than a phrase you remember from it.
   */
  async search(query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];

    const summaries = await this.list();
    const results = [];

    for (const summary of summaries) {
      const record = await this.get(summary.id);
      if (!record) continue;

      const nameHit = (record.displayName || '').toLowerCase().includes(needle);
      const matches = [];

      for (const unit of record.units || []) {
        const haystack = [unit.text, ...(unit.children || [])].join(' ');
        const at = haystack.toLowerCase().indexOf(needle);
        if (at === -1) continue;
        matches.push({
          index: unit.index,
          element: record.classifications?.[unit.index] || null,
          snippet: snippetAround(haystack, at, needle.length),
        });
        if (matches.length >= 5) break;   // enough to identify the document
      }

      if (nameHit || matches.length) {
        results.push({ ...summary, nameHit, matches });
      }
    }
    return results;
  }

  /**
   * The most recent analysis of the same source file, if there is one.
   *
   * Used to chain a re-upload onto what it supersedes without asking the user to
   * declare it. Pasted text is excluded: its source name is always the same, so
   * chaining on it would string together unrelated snippets.
   */
  async findPredecessor({ sourceName, format }) {
    if (!sourceName || format === 'text') return null;
    const all = await this.list();
    return all.find(r => r.sourceName === sourceName) || null;   // list() is newest first
  }

  /**
   * The revision chain for an analysis, oldest first.
   *
   * Walks `revisionOf` backwards, guarding against a cycle — the ids are generated
   * here so a loop should be impossible, but a corrupted file should not hang the UI.
   */
  async revisionChain(id) {
    const chain = [];
    const seen = new Set();
    let current = await this.get(id);

    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      const { units, classifications, audit, ...summary } = current;
      chain.unshift(summary);
      current = current.revisionOf ? await this.get(current.revisionOf) : null;
    }
    return chain;
  }
}

/** How many units landed on each element — a cheap shape-of-the-story preview. */
function countElements(classifications) {
  const counts = {};
  for (const element of Object.values(classifications || {})) {
    counts[element] = (counts[element] || 0) + 1;
  }
  return counts;
}

function snippetAround(text, at, length) {
  const start = Math.max(0, at - CONTEXT_CHARS);
  const end = Math.min(text.length, at + length + CONTEXT_CHARS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

module.exports = StoryboardRegistry;
module.exports.countElements = countElements;
module.exports.CONTEXT_CHARS = CONTEXT_CHARS;
