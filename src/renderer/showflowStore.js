/**
 * showflowStore.js — plain JS port of showStore.ts + showDefaults.ts
 * No framework dependencies. State persisted to localStorage.
 */

// ── Defaults (from showDefaults.ts) ──────────────────────────────────────────

const DEFAULT_ELEMENT_TYPES = {
  keynote: [
    { id: 'et-presentation', name: 'Presentation', icon: '📊', color: '#5B8DEF', isChapterMark: false, isDefault: true },
    { id: 'et-demo',         name: 'Demo',         icon: '💻', color: '#7C6AFA', isChapterMark: false, isDefault: true },
    { id: 'et-video',        name: 'Video',        icon: '🎬', color: '#F06292', isChapterMark: false, isDefault: true },
    { id: 'et-fireside',     name: 'Fireside',     icon: '🎤', color: '#4DB6AC', isChapterMark: false, isDefault: true },
  ],
  dance_recital: [
    { id: 'et-number',       name: 'Dance Number',  icon: '💃', color: '#F48FB1', isChapterMark: false, isDefault: true },
    { id: 'et-costume',      name: 'Costume Change',icon: '👗', color: '#CE93D8', isChapterMark: false, isDefault: true },
    { id: 'et-announcement', name: 'Announcement',  icon: '📢', color: '#80CBC4', isChapterMark: false, isDefault: true },
    { id: 'et-intermission', name: 'Intermission',  icon: '⏸️', color: '#FFCC80', isChapterMark: false, isDefault: true },
  ],
  play: [
    { id: 'et-scene',        name: 'Scene',        icon: '🎭', color: '#EF9A9A', isChapterMark: false, isDefault: true },
    { id: 'et-song',         name: 'Song',         icon: '🎵', color: '#F48FB1', isChapterMark: false, isDefault: true },
    { id: 'et-blackout',     name: 'Blackout',     icon: '⚫', color: '#616161', isChapterMark: false, isDefault: true },
    { id: 'et-scene-change', name: 'Scene Change', icon: '🔄', color: '#80CBC4', isChapterMark: false, isDefault: true },
    { id: 'et-intermission-play', name: 'Intermission', icon: '⏸️', color: '#FFCC80', isChapterMark: false, isDefault: true },
  ],
  concert: [
    { id: 'et-song-c',   name: 'Song',      icon: '🎸', color: '#EF9A9A', isChapterMark: false, isDefault: true },
    { id: 'et-set-break',name: 'Set Break', icon: '⏸️', color: '#FFCC80', isChapterMark: false, isDefault: true },
    { id: 'et-intro',    name: 'Intro',     icon: '🎙️', color: '#80DEEA', isChapterMark: false, isDefault: true },
    { id: 'et-outro',    name: 'Outro',     icon: '🎤', color: '#A5D6A7', isChapterMark: false, isDefault: true },
    { id: 'et-encore',   name: 'Encore',    icon: '⭐', color: '#FFD54F', isChapterMark: false, isDefault: true },
  ],
  custom: [
    { id: 'et-item', name: 'Item', icon: '📋', color: '#90CAF9', isChapterMark: false, isDefault: true },
  ],
};

// Set of all built-in element type IDs that should not be deletable
const DEFAULT_ET_IDS = new Set([
  'et-sys-chapter',
  'et-presentation', 'et-demo', 'et-video', 'et-fireside',
  'et-number', 'et-costume', 'et-announcement', 'et-intermission',
  'et-scene', 'et-song', 'et-blackout', 'et-scene-change', 'et-intermission-play',
  'et-song-c', 'et-set-break', 'et-intro', 'et-outro', 'et-encore',
  'et-item',
]);

function isDefaultElementType(id) { return DEFAULT_ET_IDS.has(id); }

const CHAPTER_MARK_TYPE = {
  id: 'et-sys-chapter', name: 'Chapter Mark', icon: '📍',
  color: '#8E8E93', isChapterMark: true, isSystem: true, customFieldDefs: [],
};

const PERFORMER_LABELS = {
  keynote: 'Speaker', dance_recital: 'Dancer', play: 'Actor',
  concert: 'Performer', custom: 'Performer',
};

const CHAPTER_LABELS = {
  keynote: 'Section', dance_recital: 'Act', play: 'Act',
  concert: 'Set', custom: 'Chapter',
};

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (s > 0) return `${m}:${String(s).padStart(2, '0')}`;
  return `${m}m`;
}

function parseDuration(input) {
  const c = input.trim().toLowerCase();
  if (/^\d+$/.test(c)) return parseInt(c) * 60;
  const hm = c.match(/^(\d+)h\s*(\d+)m?$/);   if (hm) return parseInt(hm[1]) * 3600 + parseInt(hm[2]) * 60;
  const h  = c.match(/^(\d+)h$/);              if (h)  return parseInt(h[1]) * 3600;
  const m  = c.match(/^(\d+)m$/);              if (m)  return parseInt(m[1]) * 60;
  const ms = c.match(/^(\d+):(\d{2})$/);       if (ms) return parseInt(ms[1]) * 60 + parseInt(ms[2]);
  const hms= c.match(/^(\d+):(\d{2}):(\d{2})$/); if (hms) return parseInt(hms[1])*3600 + parseInt(hms[2])*60 + parseInt(hms[3]);
  return 0;
}

function uuid() {
  return crypto.randomUUID();
}

// ── Storage ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'showflow_current_show';

function saveToStorage(show) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(show)); } catch {}
}

function loadFromStorage() {
  try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}

// ── State ─────────────────────────────────────────────────────────────────────

let _state = {
  show: null, // always start with no show — user must explicitly open one
  selectedItemId: null,
  expandedItemId: null,
  orphanCount: 0,
};

// Subscribers notified on every state change
const _listeners = new Set();

function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function _notify(structural = true, changeType = false) {
  _listeners.forEach(fn => fn(_state, structural, changeType));
}

function _set(updater, structural = true, changeType = false) {
  _state = { ..._state, ...updater(_state) };
  _notify(structural, changeType);
}

// ── Getters ───────────────────────────────────────────────────────────────────

function getShow()          { return _state.show; }
function getExpandedItemId(){ return _state.expandedItemId; }
function getOrphanCount()   { return _state.orphanCount || 0; }

function getRunItems() {
  if (!_state.show) return [];
  return _state.show.items.filter(i => !i.inParkingLot).sort((a, b) => a.position - b.position);
}

function getParkingLotItems() {
  if (!_state.show) return [];
  return _state.show.items.filter(i => i.inParkingLot);
}

function getTotalDuration() {
  if (!_state.show) return 0;
  return _state.show.items
    .filter(i => !i.inParkingLot && !i.isChapterMark)
    .reduce((s, i) => s + (i.durationSeconds || 0), 0);
}

function getTotalEstimatedDuration() {
  if (!_state.show) return 0;
  if ((_state.show.estimatedDurationSeconds || 0) > 0) return _state.show.estimatedDurationSeconds;
  return _state.show.items
    .filter(i => !i.inParkingLot && i.isChapterMark && (i.estimatedDurationSeconds || 0) > 0)
    .reduce((s, i) => s + (i.estimatedDurationSeconds || 0), 0);
}

function getChapterDuration(chapterItemId) {
  if (!_state.show) return 0;
  const run = getRunItems();
  const idx = run.findIndex(i => i.id === chapterItemId);
  if (idx === -1) return 0;
  let total = 0;
  for (let i = idx + 1; i < run.length; i++) {
    if (run[i].isChapterMark) break;
    total += run[i].durationSeconds || 0;
  }
  return total;
}

function getPerformerSuggestions() {
  if (!_state.show) return [];
  const seen = new Set();
  _state.show.items.forEach(i => { if (i.performer?.trim()) seen.add(i.performer.trim()); });
  return Array.from(seen).sort();
}

// ── Actions ───────────────────────────────────────────────────────────────────

function setShow(show) {
  if (show) saveToStorage(show);
  else { try { localStorage.removeItem(STORAGE_KEY); } catch {} }
  const orphanCount = show ? _countOrphans(show) : 0;
  _set(() => ({ show, selectedItemId: null, expandedItemId: null, orphanCount }));
}

function _countOrphans(show) {
  const etIds = new Set(show.elementTypes.map(t => t.id));
  return show.items.filter(i => i.elementTypeId && !etIds.has(i.elementTypeId)).length;
}

function createShow(name, showType) {
  const defaults = DEFAULT_ELEMENT_TYPES[showType] || DEFAULT_ELEMENT_TYPES.custom;
  const elementTypes = [
    { ...CHAPTER_MARK_TYPE, customFieldDefs: [] },
    ...defaults.map(t => ({ ...t, customFieldDefs: [] })),
  ];
  const show = {
    id: uuid(), name, showType,
    performerLabel: PERFORMER_LABELS[showType],
    chapterLabel: CHAPTER_LABELS[showType],
    items: [], elementTypes,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveToStorage(show);
  _set(() => ({ show, selectedItemId: null, expandedItemId: null }));
}

function updateShowName(name) {
  _set(s => {
    if (!s.show) return s;
    const show = { ...s.show, name, updatedAt: new Date().toISOString() };
    saveToStorage(show);
    return { show };
  });
}

function updateShowEstimate(seconds) {
  _set(s => {
    if (!s.show) return s;
    const show = { ...s.show, estimatedDurationSeconds: seconds, updatedAt: new Date().toISOString() };
    saveToStorage(show);
    return { show };
  });
}

function addItem(elementTypeId, afterPosition) {
  _set(s => {
    if (!s.show) return s;
    const elType = s.show.elementTypes.find(t => t.id === elementTypeId);
    if (!elType) return s;

    const run = s.show.items.filter(i => !i.inParkingLot).sort((a, b) => a.position - b.position);
    let position;
    if (afterPosition !== undefined) {
      const idx = run.findIndex(i => i.position === afterPosition);
      const next = run[idx + 1];
      position = next ? (afterPosition + next.position) / 2 : afterPosition + 1;
    } else {
      const last = run[run.length - 1];
      position = last ? last.position + 1 : 1;
    }

    const newItem = {
      id: uuid(), elementTypeId,
      title: elType.isChapterMark ? 'New Chapter' : `New ${elType.name}`,
      durationSeconds: elType.isChapterMark ? 0 : 300,
      performer: '', notes: '', customFields: [],
      position, inParkingLot: false,
      isChapterMark: elType.isChapterMark,
      estimatedDurationSeconds: elType.isChapterMark ? 1800 : undefined,
    };

    const show = { ...s.show, items: [...s.show.items, newItem], updatedAt: new Date().toISOString() };
    saveToStorage(show);
    return { show, expandedItemId: newItem.id };
  });
}

function updateItem(id, updates) {
  const isDurationChange = 'durationSeconds' in updates || 'estimatedDurationSeconds' in updates;
  _set(s => {
    if (!s.show) return s;
    const show = {
      ...s.show,
      items: s.show.items.map(i => i.id === id ? { ...i, ...updates } : i),
      updatedAt: new Date().toISOString(),
    };
    saveToStorage(show);
    return { show };
  }, false, isDurationChange ? 'duration' : false);
}

function deleteItem(id) {
  _set(s => {
    if (!s.show) return s;
    const show = {
      ...s.show,
      items: s.show.items.filter(i => i.id !== id),
      updatedAt: new Date().toISOString(),
    };
    saveToStorage(show);
    return { show, expandedItemId: s.expandedItemId === id ? null : s.expandedItemId };
  });
}

function moveToParking(id) {
  _set(s => {
    if (!s.show) return s;
    const show = {
      ...s.show,
      items: s.show.items.map(i => i.id === id ? { ...i, inParkingLot: true } : i),
      updatedAt: new Date().toISOString(),
    };
    saveToStorage(show);
    return { show };
  });
}

function moveFromParking(id) {
  _set(s => {
    if (!s.show) return s;
    const run = s.show.items.filter(i => !i.inParkingLot);
    const maxPos = run.length > 0 ? Math.max(...run.map(i => i.position)) : 0;
    const show = {
      ...s.show,
      items: s.show.items.map(i => i.id === id ? { ...i, inParkingLot: false, position: maxPos + 1 } : i),
      updatedAt: new Date().toISOString(),
    };
    saveToStorage(show);
    return { show };
  });
}

function reorderItems(activeId, overId, insertAfter = false) {
  _set(s => {
    if (!s.show || activeId === overId) return s;
    const all = [...s.show.items];
    const run = all.filter(i => !i.inParkingLot).sort((a, b) => a.position - b.position);
    const activeIdx = run.findIndex(i => i.id === activeId);
    const overIdx   = run.findIndex(i => i.id === overId);
    if (activeIdx === -1 || overIdx === -1) return s;

    const [moved] = run.splice(activeIdx, 1);
    const target = insertAfter
      ? (overIdx >= activeIdx ? overIdx : overIdx + 1)
      : (overIdx > activeIdx ? overIdx - 1 : overIdx);
    run.splice(Math.max(0, target), 0, moved);
    run.forEach((item, idx) => { item.position = idx; });

    const runMap = new Map(run.map(i => [i.id, i]));
    const merged = all.map(i => runMap.get(i.id) ?? i);
    const show = { ...s.show, items: merged, updatedAt: new Date().toISOString() };
    saveToStorage(show);
    return { show };
  });
}

function addElementType(name, icon, color) {
  _set(s => {
    if (!s.show) return s;
    const newType = { id: uuid(), name, icon, color, isChapterMark: false, customFieldDefs: [] };
    const show = {
      ...s.show,
      elementTypes: [...s.show.elementTypes, newType],
      updatedAt: new Date().toISOString(),
    };
    saveToStorage(show);
    return { show };
  });
}

function updateElementType(id, updates) {
  _set(s => {
    if (!s.show) return s;
    const show = {
      ...s.show,
      elementTypes: s.show.elementTypes.map(t => t.id === id ? { ...t, ...updates } : t),
      updatedAt: new Date().toISOString(),
    };
    saveToStorage(show);
    return { show };
  });
}

function deleteElementType(id) {
  _set(s => {
    if (!s.show) return s;
    const show = {
      ...s.show,
      elementTypes: s.show.elementTypes.filter(t => t.id !== id),
      updatedAt: new Date().toISOString(),
    };
    saveToStorage(show);
    return { show };
  });
}

function setExpandedItem(id) {
  _set(s => ({ expandedItemId: s.expandedItemId === id ? null : id }), false, 'expand');
}

// ── File sync (auto-save debounced) ───────────────────────────────────────────

let _filePath = null;
let _lastSaved = '';
let _saveTimer = null;

function setCurrentFilePath(fp) { _filePath = fp; }
function getCurrentFilePath()   { return _filePath; }

subscribe(() => {
  const show = _state.show;
  if (!show || !_filePath) return;
  const snapshot = JSON.stringify(show);
  if (snapshot === _lastSaved) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    if (!_filePath) return;
    try {
      const result = await window.electronAPI.invoke('show:save', { filePath: _filePath, show });
      if (result.ok) _lastSaved = snapshot;
    } catch (e) { console.error('Showflow auto-save error:', e); }
  }, 600);
});

// ── Exports ───────────────────────────────────────────────────────────────────

window.ShowflowStore = {
  // Getters
  getShow, getExpandedItemId, getOrphanCount, getRunItems, getParkingLotItems,
  getTotalDuration, getTotalEstimatedDuration, getChapterDuration, getPerformerSuggestions,
  // Actions
  setShow, createShow, updateShowName, updateShowEstimate,
  addItem, updateItem, deleteItem, moveToParking, moveFromParking,
  reorderItems, addElementType, updateElementType, deleteElementType, setExpandedItem,
  // File
  setCurrentFilePath, getCurrentFilePath,
  // Subscribe
  subscribe,
  // Helpers
  formatDuration, parseDuration, isDefaultElementType,
  DEFAULT_ELEMENT_TYPES, CHAPTER_MARK_TYPE, PERFORMER_LABELS, CHAPTER_LABELS,
};
