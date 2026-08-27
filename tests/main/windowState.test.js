/**
 * Tests for windowState.js — remembering window geometry across launches.
 *
 * The bug this feature usually ships with is restoring a window onto a display
 * that has since been unplugged, leaving it invisible off-screen with no way to
 * get it back. Most of these tests are about refusing bad bounds rather than
 * storing good ones.
 */

jest.mock('electron-log/main', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const os = require('os');
const path = require('path');
const fs = require('fs');

const mockUserData = { dir: '' };
const mockDisplays = { value: [] };
jest.mock('electron', () => ({
  app: { getPath: () => mockUserData.dir },
  screen: { getAllDisplays: () => mockDisplays.value },
}));

const windowState = require('../../src/main/models/windowState');
const { MIN_VISIBLE_PX } = windowState;

const display = (x, y, width, height) => ({ workArea: { x, y, width, height } });
const LAPTOP = display(0, 0, 1728, 1084);
const EXTERNAL = display(1728, 0, 2560, 1440);

const statePath = () => path.join(mockUserData.dir, windowState.FILE_NAME);
const readState = () => JSON.parse(fs.readFileSync(statePath(), 'utf8'));
const writeState = (state) => fs.writeFileSync(statePath(), JSON.stringify(state));

/** Minimal BrowserWindow stand-in. */
function fakeWindow({ bounds = { x: 100, y: 100, width: 1400, height: 900 }, maximized = false, fullScreen = false } = {}) {
  const handlers = {};
  return {
    getBounds: () => bounds,
    getNormalBounds: () => bounds,
    isMaximized: () => maximized,
    isFullScreen: () => fullScreen,
    isDestroyed: () => false,
    on: (event, fn) => { (handlers[event] = handlers[event] || []).push(fn); },
    removeListener: (event, fn) => {
      handlers[event] = (handlers[event] || []).filter(h => h !== fn);
    },
    emit: (event) => (handlers[event] || []).forEach(h => h()),
    listenerCount: (event) => (handlers[event] || []).length,
  };
}

beforeEach(() => {
  mockUserData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-winstate-'));
  mockDisplays.value = [LAPTOP];
  jest.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(mockUserData.dir, { recursive: true, force: true });
});

describe('save and load', () => {
  test('round-trips a window position and size', () => {
    windowState.save('main', fakeWindow({ bounds: { x: 120, y: 80, width: 1400, height: 950 } }));

    expect(windowState.load('main')).toMatchObject({ x: 120, y: 80, width: 1400, height: 950 });
  });

  test('keeps each window kind separate', () => {
    windowState.save('main', fakeWindow({ bounds: { x: 0, y: 0, width: 1500, height: 1000 } }));
    windowState.save('credentials', fakeWindow({ bounds: { x: 200, y: 150, width: 900, height: 700 } }));

    expect(windowState.load('main').width).toBe(1500);
    expect(windowState.load('credentials').width).toBe(900);
  });

  test('returns null when nothing has been saved', () => {
    expect(windowState.load('main')).toBeNull();
  });

  test('survives a corrupt state file', () => {
    fs.writeFileSync(statePath(), '{ not json');
    expect(windowState.load('main')).toBeNull();
  });

  test('never throws when the state file cannot be written', () => {
    mockUserData.dir = '/nonexistent-path-for-hive-test';
    expect(() => windowState.save('main', fakeWindow())).not.toThrow();
  });

  test('ignores a destroyed window', () => {
    const win = fakeWindow();
    win.isDestroyed = () => true;
    windowState.save('main', win);
    expect(windowState.load('main')).toBeNull();
  });
});

describe('refusing unusable bounds', () => {
  test('rejects bounds smaller than the window minimum', () => {
    // Otherwise a minimum raised in a later release would leave users stuck at a
    // size that now hides controls.
    writeState({ main: { x: 0, y: 0, width: 600, height: 400 } });

    expect(windowState.load('main', { width: 1100, height: 720 })).toBeNull();
  });

  test('accepts bounds at or above the minimum', () => {
    writeState({ main: { x: 0, y: 0, width: 1100, height: 720 } });
    expect(windowState.load('main', { width: 1100, height: 720 })).not.toBeNull();
  });

  test('rejects nonsense values', () => {
    for (const bad of [
      { x: 0, y: 0, width: 0, height: 800 },
      { x: 0, y: 0, width: 1200, height: -5 },
      { x: NaN, y: 0, width: 1200, height: 800 },
      { x: 0, y: 0, width: 'wide', height: 800 },
      {},
    ]) {
      writeState({ main: bad });
      expect(windowState.load('main')).toBeNull();
    }
  });

  test('rejects a position on a display that is no longer connected', () => {
    // The classic failure: saved on an external monitor, reopened on the laptop
    // alone, window invisible off-screen and effectively unrecoverable.
    mockDisplays.value = [LAPTOP, EXTERNAL];
    windowState.save('main', fakeWindow({ bounds: { x: 2000, y: 300, width: 1400, height: 900 } }));
    expect(windowState.load('main')).not.toBeNull();

    mockDisplays.value = [LAPTOP];      // external unplugged
    expect(windowState.load('main')).toBeNull();
  });

  test('accepts bounds that still overlap a display enough to be grabbed', () => {
    writeState({ main: { x: 1728 - (MIN_VISIBLE_PX + 40), y: 100, width: 1400, height: 900 } });
    expect(windowState.load('main')).not.toBeNull();
  });

  test('rejects bounds that only clip the very edge of a display', () => {
    // A few pixels of overlap is not enough to drag the window back.
    writeState({ main: { x: 1728 - 10, y: 100, width: 1400, height: 900 } });
    expect(windowState.load('main')).toBeNull();
  });

  test('does not gamble when the display list is unavailable', () => {
    mockDisplays.value = null;   // screen.getAllDisplays() throws
    writeState({ main: { x: 0, y: 0, width: 1400, height: 900 } });
    expect(windowState.load('main')).toBeNull();
  });
});

describe('maximized windows', () => {
  test('records that the window was maximized', () => {
    windowState.save('main', fakeWindow({ maximized: true }));
    expect(windowState.load('main').isMaximized).toBe(true);
  });

  test('keeps the pre-maximize size rather than the filled screen', () => {
    // getBounds() reports the whole screen while maximized; storing that would
    // make the restored (un-maximized) size wrong forever.
    windowState.save('main', fakeWindow({ bounds: { x: 150, y: 120, width: 1300, height: 850 } }));

    const filled = fakeWindow({ bounds: { x: 0, y: 0, width: 1728, height: 1084 }, maximized: true });
    windowState.save('main', filled);

    expect(windowState.load('main')).toMatchObject({ x: 150, y: 120, width: 1300, height: 850 });
    expect(windowState.load('main').isMaximized).toBe(true);
  });

  test('treats full-screen the same way', () => {
    windowState.save('main', fakeWindow({ bounds: { x: 150, y: 120, width: 1300, height: 850 } }));
    windowState.save('main', fakeWindow({ bounds: { x: 0, y: 0, width: 1728, height: 1084 }, fullScreen: true }));

    expect(windowState.load('main').width).toBe(1300);
  });
});

describe('tracking a window', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('saves after a debounce rather than on every pixel', () => {
    const win = fakeWindow({ bounds: { x: 10, y: 20, width: 1300, height: 850 } });
    windowState.track('main', win);

    for (let i = 0; i < 20; i++) win.emit('resize');
    expect(windowState.load('main')).toBeNull();   // nothing written yet

    jest.advanceTimersByTime(windowState.SAVE_DEBOUNCE_MS + 50);
    expect(windowState.load('main')).toMatchObject({ width: 1300 });
  });

  test('saves on move and on maximize', () => {
    const win = fakeWindow({ bounds: { x: 10, y: 20, width: 1300, height: 850 } });
    windowState.track('main', win);

    win.emit('move');
    jest.advanceTimersByTime(windowState.SAVE_DEBOUNCE_MS + 50);
    expect(windowState.load('main')).not.toBeNull();
  });

  test('saves immediately on close, so a pending debounce is not lost', () => {
    const win = fakeWindow({ bounds: { x: 10, y: 20, width: 1300, height: 850 } });
    windowState.track('main', win);

    win.emit('resize');
    win.emit('close');            // no timer advance

    expect(windowState.load('main')).toMatchObject({ width: 1300 });
  });

  test('the returned disposer detaches the listeners', () => {
    const win = fakeWindow();
    const stop = windowState.track('main', win);
    expect(win.listenerCount('resize')).toBe(1);

    stop();

    expect(win.listenerCount('resize')).toBe(0);
  });

  test('tolerates being given no window', () => {
    expect(() => windowState.track('main', null)()).not.toThrow();
  });
});

describe('isVisibleOnSomeDisplay', () => {
  test('is true for a window fully inside a display', () => {
    expect(windowState.isVisibleOnSomeDisplay({ x: 100, y: 100, width: 800, height: 600 })).toBe(true);
  });

  test('is true across a multi-display arrangement', () => {
    mockDisplays.value = [LAPTOP, EXTERNAL];
    expect(windowState.isVisibleOnSomeDisplay({ x: 2000, y: 200, width: 1200, height: 800 })).toBe(true);
  });

  test('is false for a window entirely off-screen', () => {
    expect(windowState.isVisibleOnSomeDisplay({ x: 5000, y: 5000, width: 800, height: 600 })).toBe(false);
  });

  test('is false for negative coordinates beyond the display', () => {
    expect(windowState.isVisibleOnSomeDisplay({ x: -2000, y: -2000, width: 800, height: 600 })).toBe(false);
  });
});
