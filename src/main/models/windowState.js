/**
 * windowState.js — remember window size and position across launches.
 *
 * Hive opened at a fixed size every time, so anyone whose screen or taste
 * differed from the default resized it on every single launch.
 *
 * Stored in its own small file under userData rather than in `settings.json`:
 * these are per-machine UI state, not user configuration, and they have to be
 * readable in the main process before any renderer (so `localStorage`, where the
 * sidebar widths live, isn't available either).
 *
 * The failure this feature usually ships with is restoring a position onto a
 * display that has since been unplugged, leaving the window invisible off-screen
 * with no way to retrieve it. Saved bounds are therefore only honoured if they
 * still overlap a currently-connected display by a usable margin.
 */

const { app, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const log = require('electron-log/main');

const FILE_NAME = 'window-state.json';
// How much of the window must remain on a display for the bounds to be usable.
// A few pixels of overlap is not enough to grab and drag it back.
const MIN_VISIBLE_PX = 120;
// Writes are debounced: resize and move fire continuously while dragging.
const SAVE_DEBOUNCE_MS = 400;

function statePath() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8')) || {};
  } catch {
    return {};   // absent or corrupt — fall back to defaults
  }
}

function writeAll(state) {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
  } catch (err) {
    log.warn(`[windowState] could not persist: ${err.message}`);
  }
}

function isSaneBounds(b) {
  return b
    && Number.isFinite(b.width) && Number.isFinite(b.height)
    && Number.isFinite(b.x) && Number.isFinite(b.y)
    && b.width > 0 && b.height > 0;
}

/**
 * Is enough of these bounds on a connected display to be reachable?
 *
 * Guards the unplugged-monitor case: a window restored to a coordinate that no
 * longer exists is invisible and, on macOS, effectively unrecoverable without
 * deleting the state file.
 */
function isVisibleOnSomeDisplay(bounds) {
  let displays;
  try {
    displays = screen.getAllDisplays();
  } catch {
    return false;   // can't verify, so don't gamble
  }
  // Guard a non-throwing but unusable answer too: this runs during window
  // creation, so a crash here would break startup entirely.
  if (!Array.isArray(displays) || displays.length === 0) return false;

  return displays.some(display => {
    const area = display?.workArea;
    if (!area) return false;
    const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapX >= MIN_VISIBLE_PX && overlapY >= MIN_VISIBLE_PX;
  });
}

/**
 * Saved bounds for a window kind ('main' / 'credentials'), or null if there are
 * none, they're nonsense, they're smaller than the window's minimum, or they'd
 * land off-screen.
 *
 * @param {string} name
 * @param {{width:number,height:number}} minimum
 */
function load(name, minimum = { width: 0, height: 0 }) {
  const saved = readAll()[name];
  if (!isSaneBounds(saved)) return null;
  if (saved.width < minimum.width || saved.height < minimum.height) return null;
  if (!isVisibleOnSomeDisplay(saved)) {
    log.info(`[windowState] ignoring saved ${name} bounds — not on any connected display`);
    return null;
  }
  return saved;
}

/** Persist a window's current bounds. Never throws. */
function save(name, win) {
  if (!win || win.isDestroyed()) return;
  try {
    const state = readAll();
    // While maximized or full-screen, getBounds() reports the filled screen,
    // which would become the restored size forever. Keep the underlying bounds.
    const bounds = win.isMaximized() || win.isFullScreen()
      ? (state[name] ? { ...state[name] } : win.getNormalBounds?.() || win.getBounds())
      : win.getBounds();

    state[name] = {
      ...bounds,
      isMaximized: win.isMaximized(),
    };
    writeAll(state);
  } catch (err) {
    log.warn(`[windowState] could not read bounds for ${name}: ${err.message}`);
  }
}

/**
 * Persist this window's geometry as the user changes it.
 *
 * Saves on close as well as on debounced resize/move, because a window closed
 * during the debounce window would otherwise lose the last adjustment.
 */
function track(name, win) {
  if (!win) return () => {};

  let timer = null;
  const queueSave = () => {
    clearTimeout(timer);
    timer = setTimeout(() => save(name, win), SAVE_DEBOUNCE_MS);
  };

  win.on('resize', queueSave);
  win.on('move', queueSave);
  win.on('maximize', queueSave);
  win.on('unmaximize', queueSave);
  win.on('close', () => {
    clearTimeout(timer);
    save(name, win);
  });

  return () => {
    clearTimeout(timer);
    win.removeListener('resize', queueSave);
    win.removeListener('move', queueSave);
    win.removeListener('maximize', queueSave);
    win.removeListener('unmaximize', queueSave);
  };
}

module.exports = {
  load,
  save,
  track,
  isVisibleOnSomeDisplay,
  MIN_VISIBLE_PX,
  SAVE_DEBOUNCE_MS,
  FILE_NAME,
};
