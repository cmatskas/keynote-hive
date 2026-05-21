const { app, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const SHOWFLOW_RECENT_PATH = path.join(app.getPath('userData'), 'showflow-recent.json');
const SHOWFLOW_MAX_RECENT = 10;

function loadShowflowRecent() {
  try {
    if (fs.existsSync(SHOWFLOW_RECENT_PATH)) return JSON.parse(fs.readFileSync(SHOWFLOW_RECENT_PATH, 'utf8'));
  } catch {}
  return [];
}

function saveShowflowRecent(list) {
  try { fs.writeFileSync(SHOWFLOW_RECENT_PATH, JSON.stringify(list), 'utf8'); } catch {}
}

function addToShowflowRecent(filePath, showName) {
  let list = loadShowflowRecent().filter(r => r.filePath !== filePath);
  list.unshift({ filePath, name: showName, openedAt: new Date().toISOString() });
  if (list.length > SHOWFLOW_MAX_RECENT) list = list.slice(0, SHOWFLOW_MAX_RECENT);
  saveShowflowRecent(list);
}

function register(ipcMain, ctx) {
  ipcMain.handle('show:save', async (event, { filePath, show }) => {
    try {
      fs.writeFileSync(filePath, JSON.stringify(show, null, 2), 'utf8');
      addToShowflowRecent(filePath, show.name);
      return { ok: true, filePath };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('show:saveAs', async (event, { show }) => {
    const result = await dialog.showSaveDialog(ctx.mainWindow, {
      title: 'Save Show',
      defaultPath: `${show.name || 'Untitled Show'}.showflow`,
      filters: [{ name: 'ShowFlow Files', extensions: ['showflow'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(result.filePath, JSON.stringify(show, null, 2), 'utf8');
      addToShowflowRecent(result.filePath, show.name);
      return { ok: true, filePath: result.filePath };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('show:open', async () => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Open Show',
      filters: [{ name: 'ShowFlow Files', extensions: ['showflow'] }, { name: 'All Files', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
    const filePath = result.filePaths[0];
    try {
      const show = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      addToShowflowRecent(filePath, show.name);
      return { ok: true, filePath, show };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('show:openPath', async (event, filePath) => {
    try {
      const show = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      addToShowflowRecent(filePath, show.name);
      return { ok: true, filePath, show };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('show:listRecent', async () => {
    const list = loadShowflowRecent();
    const valid = list.filter(r => fs.existsSync(r.filePath));
    if (valid.length !== list.length) saveShowflowRecent(valid);
    return valid;
  });

  ipcMain.handle('show:clearRecent', async () => {
    saveShowflowRecent([]);
    return { ok: true };
  });
}

module.exports = { register };
