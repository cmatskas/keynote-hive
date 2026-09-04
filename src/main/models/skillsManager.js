const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const log = require('electron-log/main');

/**
 * SkillsManager — discovers, parses, and manages skills following the AgentSkills spec.
 * 
 * Skills use YAML frontmatter (name, description) + markdown body in SKILL.md files
 * inside named directories. Supports progressive disclosure:
 *   Tier 1 (catalog): name + description loaded at startup
 *   Tier 2 (instructions): full body loaded on activation
 *   Tier 3 (resources): bundled files loaded on demand
 */
class SkillsManager {
  constructor() {
    this.userSkillsDir = path.join(app.getPath('userData'), 'skills');
    this.bundledSkillsDir = path.join(__dirname, '..', '..', '..', 'skills');
    this.cache = null; // [{ name, description, location, metadata, body }]
    this.activated = new Set(); // track activated skill names per session
    this.disabledSkills = new Set(); // app-level disabled skills
  }

  async init() {
    await this._ensureDir(this.userSkillsDir);
    await this._seedBundledSkills();
    this.cache = await this._discoverAll();
    log.info(`[skills] Loaded ${this.cache.length} skills (${this.disabledSkills.size} disabled)`);
    return this.cache;
  }

  /** Tier 1: catalog for system prompt — name + description only */
  getCatalog() {
    return (this.cache || [])
      .filter(s => !this.disabledSkills.has(s.name))
      .map(({ name, description }) => ({ name, description }));
  }

  /** Return skills marked auto-activate with their full bodies loaded */
  async getAutoActivateSkills() {
    const auto = (this.cache || []).filter(s => s.autoActivate && !this.disabledSkills.has(s.name));
    const results = [];
    for (const s of auto) {
      const body = await this.getSkillBody(s.name);
      if (body) results.push({ name: s.name, body });
    }
    return results;
  }

  /** Tier 2: full body for activation */
  async getSkillBody(name) {
    const skill = (this.cache || []).find(s => s.name === name);
    if (!skill) return null;
    if (skill.body !== undefined) return skill.body;
    // Lazy-load body from disk
    const content = await fs.readFile(skill.location, 'utf8');
    skill.body = this._extractBody(content);
    return skill.body;
  }

  /** Get the base directory of a skill (for resolving relative paths) */
  getSkillDir(name) {
    const skill = (this.cache || []).find(s => s.name === name);
    return skill ? path.dirname(skill.location) : null;
  }

  /** List bundled resource files in a skill directory */
  async listResources(name) {
    const dir = this.getSkillDir(name);
    if (!dir) return [];
    const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
    return entries
      // Dotfiles are bookkeeping, not content. The seed marker (.hive-seed.json)
      // lives here, and advertising it as a resource would invite the model to
      // read our internal state and treat it as reference material. Backups of a
      // replaced skill are excluded for the same reason.
      .filter(e => e.isFile()
        && e.name !== 'SKILL.md'
        && !e.name.startsWith('.')
        && !e.name.includes('SKILL.md.backup'))
      .map(e => path.relative(dir, path.join(e.parentPath || e.path, e.name)));
  }

  /** Track activation — returns false if already activated (dedup) */
  markActivated(name) {
    if (this.activated.has(name)) return false;
    this.activated.add(name);
    return true;
  }

  isActivated(name) {
    return this.activated.has(name);
  }

  resetActivations() {
    this.activated.clear();
  }

  getSkills() {
    return (this.cache || []).map(s => ({
      ...s,
      disabled: this.disabledSkills.has(s.name),
    }));
  }

  getSkill(name) {
    return (this.cache || []).find(s => s.name === name) || null;
  }

  async toggleSkill(name, enabled) {
    if (enabled) {
      this.disabledSkills.delete(name);
    } else {
      this.disabledSkills.add(name);
    }
    return { name, enabled };
  }

  async refresh() {
    this.cache = await this._discoverAll();
    return this.cache;
  }

  async openSkillsFolder() {
    await shell.openPath(this.userSkillsDir);
  }

  // ── Discovery ──────────────────────────────────────────────────────────

  async _discoverAll() {
    const seen = new Map(); // name → skill (first wins for collision)
    const scanPaths = this._getScanPaths();

    for (const { dir, scope } of scanPaths) {
      const skills = await this._scanDirectory(dir);
      for (const skill of skills) {
        if (!seen.has(skill.name)) {
          seen.set(skill.name, { ...skill, scope });
        }
        // Project-level overrides user-level (project scanned first)
      }
    }
    return Array.from(seen.values());
  }

  _getScanPaths() {
    const home = os.homedir();
    const project = process.cwd();
    return [
      // Project-level (higher priority)
      { dir: path.join(project, '.agents', 'skills'), scope: 'project' },
      // User-level
      { dir: path.join(home, '.agents', 'skills'), scope: 'user' },
      // App-specific user dir (seeded from bundled)
      { dir: this.userSkillsDir, scope: 'app' },
    ];
  }

  async _scanDirectory(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return []; // Directory doesn't exist
    }

    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const skillFile = path.join(dir, entry.name, 'SKILL.md');
      try {
        // Read only the first 1KB — enough for frontmatter, avoids loading full body
        const fh = await fs.open(skillFile, 'r');
        const buf = Buffer.alloc(1024);
        const { bytesRead } = await fh.read(buf, 0, 1024, 0);
        await fh.close();
        const header = buf.toString('utf8', 0, bytesRead);
        const skill = this._parseSkillFile(header, skillFile);
        if (skill) skills.push(skill);
      } catch (err) {
        if (err.code !== 'ENOENT') log.warn(`[skills] Failed to load ${entry.name}: ${err.message}`);
      }
    }
    return skills;
  }

  // ── Parsing ────────────────────────────────────────────────────────────

  _parseSkillFile(content, filePath) {
    const frontmatter = this._extractFrontmatter(content);
    if (!frontmatter) return null;

    const { name, description } = frontmatter;
    if (!description || !description.trim()) return null; // spec: skip if no description

    const skillName = name || path.basename(path.dirname(filePath));

    return {
      name: skillName,
      description: description.trim(),
      location: filePath,
      metadata: frontmatter.metadata || {},
      license: frontmatter.license || null,
      compatibility: frontmatter.compatibility || null,
      allowedTools: frontmatter['allowed-tools'] || null,
      autoActivate: frontmatter['auto-activate'] === 'true',
      // body intentionally omitted — lazy-loaded by getSkillBody()
    };
  }

  _extractFrontmatter(content) {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return null;

    try {
      return this._parseSimpleYaml(match[1]);
    } catch {
      // Try fixing common issue: unquoted colons
      try {
        const fixed = match[1].replace(
          /^(\w[\w-]*):\s+(.+:.+)$/gm,
          (_, key, val) => `${key}: "${val.replace(/"/g, '\\"')}"`
        );
        return this._parseSimpleYaml(fixed);
      } catch {
        return null;
      }
    }
  }

  /** Lightweight YAML parser for frontmatter (no dependency needed) */
  _parseSimpleYaml(text) {
    const result = {};
    let currentKey = null;
    let currentIndent = 0;
    let nestedObj = null;

    for (const line of text.split('\n')) {
      if (line.trim() === '' || line.trim().startsWith('#')) continue;

      const topMatch = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (topMatch) {
        if (nestedObj && currentKey) {
          result[currentKey] = nestedObj;
          nestedObj = null;
        }
        const [, key, value] = topMatch;
        if (value.trim() === '') {
          // Could be start of nested map
          currentKey = key;
          currentIndent = 0;
          nestedObj = {};
        } else {
          result[key] = value.trim().replace(/^["']|["']$/g, '');
          currentKey = null;
          nestedObj = null;
        }
        continue;
      }

      // Nested key-value
      const nestedMatch = line.match(/^\s+(\w[\w-]*):\s*(.+)$/);
      if (nestedMatch && nestedObj) {
        nestedObj[nestedMatch[1]] = nestedMatch[2].trim().replace(/^["']|["']$/g, '');
      }
    }

    if (nestedObj && currentKey) {
      result[currentKey] = nestedObj;
    }

    return result;
  }

  _extractBody(content) {
    const match = content.match(/^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/);
    return match ? match[1].trim() : content.trim();
  }

  // ── Seeding ────────────────────────────────────────────────────────────

  /**
   * Copy bundled skills into userData, and carry forward updates to them.
   *
   * This used to seed only when SKILL.md was absent, which meant a revised
   * bundled skill reached new installs and nobody else — every existing user kept
   * whatever shipped the day they first ran Hive. Silently, and forever.
   *
   * Skills are user-editable, so an update cannot simply overwrite. Three cases:
   *
   *   1. Nothing installed        → seed it.
   *   2. Installed and untouched  → replace silently. There is nothing to
   *                                 reconcile and nothing to ask about.
   *   3. Installed and edited     → leave it strictly alone and record that an
   *                                 update is available, for Settings > Skills to
   *                                 offer as an explicit choice.
   *
   * "Untouched" is decided by hashing against `.hive-seed.json`, written whenever
   * we seed or update. A skill installed before that marker existed has no hash to
   * compare, so it is treated as edited — the cautious reading, since guessing
   * wrong in that direction costs a notification and guessing wrong the other way
   * destroys someone's work.
   */
  async _seedBundledSkills() {
    let entries;
    try {
      entries = await fs.readdir(this.bundledSkillsDir, { withFileTypes: true });
    } catch {
      return;
    }

    this.updatesAvailable = new Map();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const srcDir = path.join(this.bundledSkillsDir, entry.name);
      const destDir = path.join(this.userSkillsDir, entry.name);
      const destSkill = path.join(destDir, 'SKILL.md');

      let installed;
      try {
        installed = await fs.readFile(destSkill, 'utf8');
      } catch {
        // Case 1: not installed.
        await this._ensureDir(destDir);
        await this._copyDirRecursive(srcDir, destDir);
        await this._writeSeedMarker(destDir, srcDir);
        continue;
      }

      const bundledVersion = await this._bundledVersion(srcDir);
      const marker = await this._readSeedMarker(destDir);

      // What the installed copy claims to be. The marker records what we *wrote*,
      // but a skill installed before the marker existed has none — and that is
      // every user who already had Hive, so it is the common case rather than an
      // edge one. Falling back to the file's own frontmatter means those installs
      // are still told an update exists; keying only off the marker meant they
      // silently got nothing forever, which is the exact failure this replaced.
      const installedVersion = marker?.version || this._declaredVersion(installed);

      // Nothing to offer unless the bundled copy is genuinely newer.
      if (!bundledVersion || !this._isNewer(bundledVersion, installedVersion)) continue;

      // A choice the user already made sticks; do not ask again for this version.
      if (marker?.declinedVersion && !this._isNewer(bundledVersion, marker.declinedVersion)) continue;

      // Provably untouched only when we have a hash to compare against. Without a
      // marker we cannot know, so the update is offered rather than applied — that
      // way an edited copy is never destroyed, and the backup makes accepting safe
      // even for someone who did edit it.
      if (marker?.hash && this._hash(installed) === marker.hash) {
        // Case 2: untouched since we wrote it.
        await this._copyDirRecursive(srcDir, destDir);
        await this._writeSeedMarker(destDir, srcDir);
        log.info(`[skills] updated '${entry.name}' to v${bundledVersion} (local copy was unmodified)`);
      } else {
        // Case 3: edited. Record only; never overwrite.
        this.updatesAvailable.set(entry.name, {
          name: entry.name,
          installedVersion: installedVersion || null,
          availableVersion: bundledVersion,
        });
        log.info(`[skills] '${entry.name}' v${bundledVersion} available; local copy is modified, leaving it alone`);
      }
    }
  }

  /** Bundled skills whose update is waiting on the user because they edited theirs. */
  getAvailableUpdates() {
    return [...(this.updatesAvailable?.values() || [])];
  }

  /**
   * Install the bundled version of a skill, keeping the user's copy as a backup.
   *
   * The backup is the whole point: "replace" has to be reversible, or the only
   * safe answer to the prompt is always "keep mine".
   */
  async applySkillUpdate(name) {
    const srcDir = path.join(this.bundledSkillsDir, name);
    const destDir = path.join(this.userSkillsDir, name);
    const destSkill = path.join(destDir, 'SKILL.md');

    const bundledVersion = await this._bundledVersion(srcDir);
    const marker = await this._readSeedMarker(destDir);
    const backupName = `SKILL.md.backup-${marker?.version || 'previous'}`;

    try {
      await fs.copyFile(destSkill, path.join(destDir, backupName));
    } catch (err) {
      log.warn(`[skills] could not back up '${name}' before update: ${err.message}`);
    }

    await this._copyDirRecursive(srcDir, destDir);
    await this._writeSeedMarker(destDir, srcDir);
    this.updatesAvailable?.delete(name);
    this.cache = await this._discoverAll();

    return { name, version: bundledVersion, backup: backupName };
  }

  /** Keep the user's version, and stop offering this one. */
  async declineSkillUpdate(name) {
    const srcDir = path.join(this.bundledSkillsDir, name);
    const destDir = path.join(this.userSkillsDir, name);
    const bundledVersion = await this._bundledVersion(srcDir);
    const marker = (await this._readSeedMarker(destDir)) || {};

    await this._writeMarkerRaw(destDir, { ...marker, declinedVersion: bundledVersion });
    this.updatesAvailable?.delete(name);

    return { name, declinedVersion: bundledVersion };
  }

  _hash(content) {
    return require('crypto').createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /** Semver-ish compare, tolerant of "2" and "2.0" and "2.0.1". */
  _isNewer(a, b) {
    if (!b) return true;
    const parts = v => String(v).split('.').map(n => parseInt(n, 10) || 0);
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] || 0) > (y[i] || 0)) return true;
      if ((x[i] || 0) < (y[i] || 0)) return false;
    }
    return false;
  }

  /** The version a SKILL.md declares in its own frontmatter, or null. */
  _declaredVersion(content) {
    const fm = String(content).match(/^---\n([\s\S]*?)\n---/);
    return fm ? (fm[1].match(/version:\s*["']?([\d.]+)/) || [])[1] || null : null;
  }

  async _bundledVersion(srcDir) {
    try {
      return this._declaredVersion(await fs.readFile(path.join(srcDir, 'SKILL.md'), 'utf8'));
    } catch {
      return null;
    }
  }

  async _readSeedMarker(destDir) {
    try {
      return JSON.parse(await fs.readFile(path.join(destDir, '.hive-seed.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async _writeMarkerRaw(destDir, data) {
    try {
      await fs.writeFile(path.join(destDir, '.hive-seed.json'), JSON.stringify(data, null, 2));
    } catch (err) {
      log.warn(`[skills] could not write seed marker: ${err.message}`);
    }
  }

  async _writeSeedMarker(destDir, srcDir) {
    const version = await this._bundledVersion(srcDir);
    let hash = null;
    try {
      hash = this._hash(await fs.readFile(path.join(destDir, 'SKILL.md'), 'utf8'));
    } catch { /* nothing to hash */ }
    await this._writeMarkerRaw(destDir, { version, hash, seededAt: new Date().toISOString() });
  }

  async _ensureDir(dir) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }

  async _copyDirRecursive(src, dest) {
    await this._ensureDir(dest);
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await this._copyDirRecursive(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }
}

module.exports = SkillsManager;
