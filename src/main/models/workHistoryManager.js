const { app } = require('electron');
const fs = require('fs').promises;
const path = require('path');

class WorkHistoryManager {
  constructor() {
    this.dir = path.join(app.getPath('userData'), 'work-history');
  }

  async _ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  _filePath(id) {
    return path.join(this.dir, `${id}.json`);
  }

  async save(session) {
    await this._ensureDir();
    // Only update timestamp if messages changed
    try {
      const existing = JSON.parse(await fs.readFile(this._filePath(session.id), 'utf8'));
      if (existing.starred !== undefined && session.starred === undefined) session.starred = existing.starred;
      if (existing.customTitle && !session.customTitle) session.customTitle = existing.customTitle;
      const changed = (existing.messages || []).length !== (session.messages || []).length;
      session.updatedAt = changed ? new Date().toISOString() : existing.updatedAt;
    } catch {
      // New session
      session.updatedAt = new Date().toISOString();
    }
    if (!session.title && session.messages.length > 0) {
      const first = session.messages.find(m => m.role === 'user');
      session.title = first ? first.content.slice(0, 50) : 'Untitled';
    }
    await fs.writeFile(this._filePath(session.id), JSON.stringify(session));
  }

  /**
   * Load a saved session, or null if it was never written.
   *
   * A missing file is an ordinary state here rather than a failure: save() skips
   * sessions with no messages, so every launch that creates a session id and
   * quits before sending anything leaves that id in the renderer's localStorage
   * with nothing on disk. Throwing meant the app logged an unhandled handler
   * error on startup for a case that is entirely expected — the renderer already
   * treated a falsy result as "show the greeting".
   *
   * Anything other than a missing file still throws: an unreadable or corrupt
   * session is a real problem and should not be silently indistinguishable from
   * a new one.
   */
  async load(id) {
    let data;
    try {
      data = await fs.readFile(this._filePath(id), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    return JSON.parse(data);
  }

  async list() {
    await this._ensureDir();
    const files = await fs.readdir(this.dir);
    const sessions = [];
    for (const f of files.filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(await fs.readFile(path.join(this.dir, f), 'utf8'));
        sessions.push({ id: data.id, title: data.customTitle || data.title, createdAt: data.createdAt, updatedAt: data.updatedAt, starred: !!data.starred });
      } catch { /* skip corrupt */ }
    }
    return sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  async rename(id, newTitle) {
    const data = JSON.parse(await fs.readFile(this._filePath(id), 'utf8'));
    data.customTitle = newTitle;
    await fs.writeFile(this._filePath(id), JSON.stringify(data));
  }

  async toggleStar(id) {
    const data = JSON.parse(await fs.readFile(this._filePath(id), 'utf8'));
    data.starred = !data.starred;
    await fs.writeFile(this._filePath(id), JSON.stringify(data));
    return data.starred;
  }

  async remove(id) {
    try { await fs.unlink(this._filePath(id)); } catch { /* already gone */ }
  }
}

module.exports = WorkHistoryManager;
