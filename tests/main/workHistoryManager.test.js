/**
 * Tests for workHistoryManager — the Work tab's on-disk conversation store.
 *
 * The behaviour that prompted these: load() threw ENOENT for a session that had
 * never been written, and the app logged an unhandled IPC handler error on every
 * launch as a result. That is not an edge case — save() skips sessions with no
 * messages, so any launch that creates a session id and quits before sending
 * anything produces exactly this state. A missing session is a state; an
 * unreadable one is an error, and the two must not look alike.
 */

const os = require('os');
const path = require('path');
const fs = require('fs').promises;

let tmpRoot;
jest.mock('electron', () => ({
  app: { getPath: () => global.__workHistoryTmp },
}));

const WorkHistoryManager = require('../../src/main/models/workHistoryManager');

describe('workHistoryManager', () => {
  let mgr;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-wh-'));
    global.__workHistoryTmp = tmpRoot;
    mgr = new WorkHistoryManager();
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  describe('load()', () => {
    test('returns null for a session that was never saved', async () => {
      // The startup case: an id in localStorage with nothing on disk behind it.
      await expect(mgr.load('session-never-written')).resolves.toBeNull();
    });

    test('returns the session when it exists', async () => {
      await mgr.save({ id: 's1', messages: [{ role: 'user', content: 'hello' }] });

      const loaded = await mgr.load('s1');

      expect(loaded.id).toBe('s1');
      expect(loaded.messages).toHaveLength(1);
      expect(loaded.messages[0].content).toBe('hello');
    });

    test('still throws when the file exists but cannot be read', async () => {
      // Pins the ENOENT-only carve-out at the readFile level. The corrupt-JSON
      // test below does not cover this: that failure comes from JSON.parse,
      // which sits outside the try, so swallowing every read error would leave
      // it passing while genuine I/O failures silently became "no such session".
      // A directory where the file should be is the portable way to produce a
      // non-ENOENT read error (EISDIR).
      await mgr._ensureDir();
      await fs.mkdir(path.join(tmpRoot, 'work-history', 'is-a-dir.json'));

      await expect(mgr.load('is-a-dir')).rejects.toThrow();
    });

    test('still throws for a corrupt session rather than reporting it as absent', async () => {
      // Reporting corruption as "no such session" would silently replace a real
      // conversation with an empty one, and the user would have no idea their
      // history had been lost.
      await mgr._ensureDir();
      await fs.writeFile(path.join(tmpRoot, 'work-history', 'broken.json'), '{ not json');

      await expect(mgr.load('broken')).rejects.toThrow();
    });
  });

  describe('save()', () => {
    test('creates a session that did not exist', async () => {
      await mgr.save({ id: 'fresh', messages: [{ role: 'user', content: 'first' }] });

      const loaded = await mgr.load('fresh');
      expect(loaded.updatedAt).toBeTruthy();
      expect(loaded.title).toBe('first');
    });

    test('preserves a custom title and starred flag across saves', async () => {
      await mgr.save({ id: 's2', messages: [{ role: 'user', content: 'q' }], customTitle: 'My name', starred: true });
      await mgr.save({ id: 's2', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] });

      const loaded = await mgr.load('s2');
      expect(loaded.customTitle).toBe('My name');
      expect(loaded.starred).toBe(true);
    });
  });

  describe('list()', () => {
    test('is empty rather than throwing when nothing has been saved', async () => {
      await expect(mgr.list()).resolves.toEqual([]);
    });

    test('skips a corrupt file instead of failing the whole listing', async () => {
      await mgr.save({ id: 'good', messages: [{ role: 'user', content: 'ok' }] });
      await fs.writeFile(path.join(tmpRoot, 'work-history', 'bad.json'), 'nope');

      const listed = await mgr.list();

      expect(listed.map(s => s.id)).toEqual(['good']);
    });
  });
});
