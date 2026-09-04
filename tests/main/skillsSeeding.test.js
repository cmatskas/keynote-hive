/**
 * Tests for skill seeding — how a revised bundled skill reaches an existing install.
 *
 * This used to seed only when SKILL.md was absent, which meant an updated bundled
 * skill reached new installs and nobody else: every existing user kept whatever
 * shipped the day they first ran Hive, silently and permanently. The StoryBrand 2.0
 * rewrite would have gone out to nobody.
 *
 * Skills are user-editable, so an update cannot simply overwrite. The three cases
 * below are the whole design, and the one that matters most is the third — losing
 * somebody's edits to deliver an update they did not ask for is far worse than not
 * updating them.
 *
 * Run against a real temp directory rather than a mocked filesystem: the logic is
 * almost entirely about what is on disk, and a mock would mostly be asserting that
 * my mock behaves the way I assumed a filesystem does.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;

let tmpRoot;

jest.mock('electron-log/main', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('electron', () => ({
  app: { getPath: () => global.__skillsTmp },
  shell: { openPath: jest.fn() },
}));

const SkillsManager = require('../../src/main/models/skillsManager');

/** The bundled storybrand skill's declared version, read from source. */
function bundledVersion() {
  const raw = fs.readFileSync(
    path.join(__dirname, '..', '..', 'skills', 'storybrand', 'SKILL.md'), 'utf8',
  );
  return raw.match(/version:\s*["']?([\d.]+)/)[1];
}

describe('skill seeding', () => {
  const skillDir = () => path.join(tmpRoot, 'skills', 'storybrand');
  const skillFile = () => path.join(skillDir(), 'SKILL.md');
  const markerFile = () => path.join(skillDir(), '.hive-seed.json');

  /** A fresh manager over the same userData, as a relaunch would produce. */
  const relaunch = async () => {
    const m = new SkillsManager();
    await m.init();
    return m;
  };

  const readMarker = async () => JSON.parse(await fsp.readFile(markerFile(), 'utf8'));
  const installedVersion = async () =>
    (await fsp.readFile(skillFile(), 'utf8')).match(/version:\s*["']?([\d.]+)/)[1];

  /** Rewrite the marker to claim an older version was seeded. */
  const pretendSeeded = async (version) => {
    const marker = await readMarker();
    await fsp.writeFile(markerFile(), JSON.stringify({ ...marker, version }));
  };

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hive-skills-'));
    global.__skillsTmp = tmpRoot;
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  describe('case 1: nothing installed', () => {
    test('seeds the skill and records what it wrote', async () => {
      await relaunch();

      expect(await installedVersion()).toBe(bundledVersion());
      const marker = await readMarker();
      expect(marker.version).toBe(bundledVersion());
      expect(marker.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    test('copies the companion resources too, not just SKILL.md', async () => {
      // The skill is useless without them — it tells the agent to read
      // KERNEL-BRAND.md and the rest by name.
      await relaunch();

      const files = fs.readdirSync(skillDir());
      expect(files).toContain('REFERENCE.md');
      expect(files).toContain('KERNEL-BRAND.md');
      expect(files).toContain('MESSAGING-CANVAS.md');
      expect(files).toContain('WRITING-STYLE.md');
    });
  });

  describe('case 2: installed and untouched', () => {
    test('replaces it silently when the bundled copy is newer', async () => {
      await relaunch();
      await pretendSeeded('1.0');

      const m = await relaunch();

      expect(await installedVersion()).toBe(bundledVersion());
      // Silently: nothing to reconcile, so asking would be noise.
      expect(m.getAvailableUpdates()).toEqual([]);
      expect((await readMarker()).version).toBe(bundledVersion());
    });

    test('leaves it alone when the bundled copy is not newer', async () => {
      await relaunch();
      const before = await fsp.readFile(skillFile(), 'utf8');

      const m = await relaunch();

      expect(await fsp.readFile(skillFile(), 'utf8')).toBe(before);
      expect(m.getAvailableUpdates()).toEqual([]);
    });
  });

  describe('case 3: installed and edited', () => {
    /** Seed, then edit the local copy, then make the bundled copy look newer. */
    async function withLocalEdits() {
      await relaunch();
      await fsp.appendFile(skillFile(), '\n\n## My own section\n\nDo it my way.\n');
      await pretendSeeded('1.0');
      return fsp.readFile(skillFile(), 'utf8');
    }

    test('never overwrites the edited copy', async () => {
      const before = await withLocalEdits();

      await relaunch();

      expect(await fsp.readFile(skillFile(), 'utf8')).toBe(before);
    });

    test('offers the update instead', async () => {
      await withLocalEdits();

      const m = await relaunch();
      const updates = m.getAvailableUpdates();

      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        name: 'storybrand',
        installedVersion: '1.0',
        availableVersion: bundledVersion(),
      });
    });

    test('applying it keeps their version as a backup', async () => {
      // The backup is what makes "replace" reversible. Without it the only safe
      // answer to the prompt is always "keep mine".
      await withLocalEdits();
      const m = await relaunch();

      const res = await m.applySkillUpdate('storybrand');

      expect(await installedVersion()).toBe(bundledVersion());
      const backup = await fsp.readFile(path.join(skillDir(), res.backup), 'utf8');
      expect(backup).toContain('## My own section');
      expect(m.getAvailableUpdates()).toEqual([]);
    });

    test('declining stops it being offered again', async () => {
      // Asked once, answered once. A prompt that returns every launch is a prompt
      // people learn to dismiss without reading.
      await withLocalEdits();
      const m = await relaunch();

      await m.declineSkillUpdate('storybrand');

      expect((await relaunch()).getAvailableUpdates()).toEqual([]);
    });

    test('declining does not touch their file', async () => {
      const before = await withLocalEdits();
      const m = await relaunch();

      await m.declineSkillUpdate('storybrand');

      expect(await fsp.readFile(skillFile(), 'utf8')).toBe(before);
    });

    test('a later version is offered again after an earlier one was declined', async () => {
      // Declining 2.0 says nothing about 3.0.
      await withLocalEdits();
      const m = await relaunch();
      await m.declineSkillUpdate('storybrand');

      const marker = await readMarker();
      await fsp.writeFile(markerFile(), JSON.stringify({ ...marker, declinedVersion: '0.9' }));

      expect((await relaunch()).getAvailableUpdates()).toHaveLength(1);
    });
  });

  describe('installs from before the marker existed', () => {
    /**
     * Every user who already had Hive is in this state: a skill on disk, no marker
     * beside it. So this is the common case, not an edge one — and getting it wrong
     * means the update reaches new installs only, which is the exact failure the
     * marker was introduced to fix.
     */
    async function preMarkerInstall(declaredVersion) {
      await relaunch();
      await fsp.rm(markerFile());
      const current = await fsp.readFile(skillFile(), 'utf8');
      // Rewrite the frontmatter version, as an older shipped copy would have.
      await fsp.writeFile(skillFile(), current.replace(/version:\s*"[\d.]+"/, `version: "${declaredVersion}"`));
      return fsp.readFile(skillFile(), 'utf8');
    }

    test('are never overwritten, since we cannot prove they are unmodified', async () => {
      // Guessing "unmodified" without a hash would destroy someone's edits.
      // Guessing "modified" costs a notification. Only one of those is recoverable.
      const before = await preMarkerInstall('1.0');

      await relaunch();

      expect(await fsp.readFile(skillFile(), 'utf8')).toBe(before);
    });

    test('are still offered the update, read from the file\'s own version', async () => {
      // The regression that matters. Keying the comparison off the marker alone
      // meant these installs were silently skipped forever — no update, and no
      // offer either, so the user would never learn a new version existed.
      await preMarkerInstall('1.0');

      const updates = (await relaunch()).getAvailableUpdates();

      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        name: 'storybrand',
        installedVersion: '1.0',
        availableVersion: bundledVersion(),
      });
    });

    test('are left alone when the file already declares the current version', async () => {
      await preMarkerInstall(bundledVersion());

      expect((await relaunch()).getAvailableUpdates()).toEqual([]);
    });

    test('accepting the offer backs up their copy first', async () => {
      // They may well have edited it — we simply cannot tell — so the backup is
      // what makes accepting safe.
      await preMarkerInstall('1.0');
      await fsp.appendFile(skillFile(), '\n## Mine\n');
      const m = await relaunch();

      const res = await m.applySkillUpdate('storybrand');

      expect(await installedVersion()).toBe(bundledVersion());
      expect(await fsp.readFile(path.join(skillDir(), res.backup), 'utf8')).toContain('## Mine');
    });
  });

  describe('listResources', () => {
    test('excludes the seed marker', async () => {
      // Resources are advertised to the model by name. The marker is our
      // bookkeeping, and offering it invites the agent to read internal state and
      // treat it as reference material.
      const m = await relaunch();

      const resources = await m.listResources('storybrand');

      expect(resources.some(r => r.startsWith('.'))).toBe(false);
      expect(resources).toContain('REFERENCE.md');
    });

    test('excludes a backup left by an applied update', async () => {
      await relaunch();
      await fsp.appendFile(skillFile(), '\nedited\n');
      await pretendSeeded('1.0');
      const m = await relaunch();
      await m.applySkillUpdate('storybrand');

      const resources = await m.listResources('storybrand');

      expect(resources.some(r => r.includes('backup'))).toBe(false);
    });
  });

  describe('version comparison', () => {
    test('orders versions numerically, not as strings', async () => {
      // '10.0' > '9.0' is false as a string comparison, and a skill that stopped
      // updating at version 9 would be a slow, silent failure.
      const m = await relaunch();

      expect(m._isNewer('2.0', '1.0')).toBe(true);
      expect(m._isNewer('10.0', '9.0')).toBe(true);
      expect(m._isNewer('2.0.1', '2.0')).toBe(true);
      expect(m._isNewer('2', '2.0')).toBe(false);
      expect(m._isNewer('1.0', '2.0')).toBe(false);
      expect(m._isNewer('2.0', null)).toBe(true);
    });
  });
});
