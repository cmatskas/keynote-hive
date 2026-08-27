const { app, BrowserWindow, ipcMain, dialog, Notification, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const logger = require('electron-log/main');

process.stdout.on('error', err => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', err => { if (err.code !== 'EPIPE') throw err; });
const { autoUpdater } = require('electron-updater');

const AppContext = require('./src/main/appContext');
const CredentialMonitor = require('./src/main/models/credentialMonitor');
const ConnectivityMonitor = require('./src/main/models/connectivityMonitor');
const { resolveStartupRoute } = require('./src/main/startupRoute');

// IPC handler modules
const credentialsIPC = require('./src/main/ipc/credentials');
const settingsIPC = require('./src/main/ipc/settings');
const conversationsIPC = require('./src/main/ipc/conversations');
const memoryIPC = require('./src/main/ipc/memory');
const workHistoryIPC = require('./src/main/ipc/workHistory');
const skillsIPC = require('./src/main/ipc/skills');
const showflowIPC = require('./src/main/ipc/showflow');
const swarmIPC = require('./src/main/ipc/swarm');
const agentIPC = require('./src/main/ipc/agent');
const bedrockIPC = require('./src/main/ipc/bedrock');
const setupWizardIPC = require('./src/main/ipc/setupWizard');
const adminSetupIPC = require('./src/main/ipc/adminSetup');

const ctx = new AppContext();

// ── Window helpers ──────────────────────────────────────────────────────────

function getIconPath() {
  let iconPath;
  if (process.platform === 'win32') {
    iconPath = path.join(__dirname, 'src/assets/favicon.ico');
  } else if (process.platform === 'darwin') {
    iconPath = path.join(__dirname, 'src/assets/favicon.icns');
  } else {
    iconPath = path.join(__dirname, 'src/assets/favicon_512x512.png');
  }
  if (!fs.existsSync(iconPath)) {
    iconPath = path.join(__dirname, 'src/assets/favicon.svg');
  }
  return iconPath;
}

function webPrefs() {
  return { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js') };
}

function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 600, height: 400, frame: false, resizable: false, center: true,
    icon: getIconPath(), webPreferences: webPrefs(),
  });
  splash.loadFile('src/pages/splash.html');
  return splash;
}

function createWindow() {
  ctx.mainWindow = new BrowserWindow({
    width: 1200, height: 800, icon: getIconPath(), webPreferences: webPrefs(),
  });
  ctx.mainWindow.loadFile('src/pages/index.html');
}

function createCredentialsWindow() {
  ctx.mainWindow = new BrowserWindow({
    width: 800, height: 600, center: true, icon: getIconPath(), webPreferences: webPrefs(),
  });
  ctx.mainWindow.loadFile('src/pages/credentials.html');
}

// ── Connectivity monitor ────────────────────────────────────────────────────

/**
 * Broadcast a connectivity transition to the renderer and run the work that
 * has to happen on reconnect. Everything here is best-effort: a failure in one
 * reconnect task must not prevent the others or the banner update.
 */
function handleConnectivityChange(online) {
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
    ctx.mainWindow.webContents.send('connectivity-changed', { online });
  }

  if (!online) return;

  // Web search init runs once at credential load and, if it failed because we
  // were offline, previously stayed dead for the rest of the session with no
  // retry. Reconnecting is exactly the moment to try again.
  if (ctx.webSearchManager && !ctx.webSearchManager.ready) {
    ctx.initializeWebSearch().catch(err => logger.warn('[connectivity] web search retry failed:', err.message));
  }

  // A credential poll that was paused while offline can resume now.
  if (ctx.credentialMonitor) ctx.credentialMonitor.resumeAfterOffline();

  // A transcription parked waiting for the network can resume polling.
  if (ctx.transcriptionJob?.resume) ctx.transcriptionJob.resume('network');

  // Deletes for jobs cancelled while offline couldn't reach AWS at the time.
  // Retry them now so a cancellation during an outage still stops the billing.
  bedrockIPC.flushPendingTranscriptionDeletes(ctx)
    .catch(err => logger.warn('[connectivity] flushing queued job deletes failed:', err.message));
}

ctx.startConnectivityMonitor = function () {
  if (ctx.connectivityMonitor) ctx.connectivityMonitor.stop();
  ctx.connectivityMonitor = new ConnectivityMonitor({
    getRegion: () => ctx.currentSettings?.region || ctx.currentCredentials?.region,
    onChange: handleConnectivityChange,
  });
  ctx.connectivityMonitor.start();
};

// ── Credential monitor ──────────────────────────────────────────────────────

ctx.startCredentialMonitor = function () {
  if (ctx.credentialMonitor) ctx.credentialMonitor.stop();
  ctx.credentialMonitor = new CredentialMonitor({
    getCredentials: () => ctx.currentCredentials,
    getMainWindow: () => ctx.mainWindow,
    isOnline: () => ctx.isOnline(),
    // Veto the destructive navigation while a transcription is mid-flight:
    // the job's result would be lost with the renderer, and the user is far
    // better served by the banner plus Settings → Credentials in place.
    shouldDeferNavigation: () => !!ctx.transcriptionJob,
    onExpired: () => {
      if (ctx.credentialMonitor) { ctx.credentialMonitor.stop(); ctx.credentialMonitor = null; }
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.setSize(800, 600);
        ctx.mainWindow.center();
        ctx.mainWindow.loadFile('src/pages/credentials.html');
      }
    },
  });
  ctx.credentialMonitor.start();
};

// ── Validate + route to credentials or main ─────────────────────────────────
//
// The routing decision itself lives in src/main/startupRoute.js so it can be
// unit tested — main.js isn't requirable under Jest.

async function validateAndRoute() {
  const route = await resolveStartupRoute(ctx);
  if (route === 'credentials') {
    createCredentialsWindow();
  } else {
    createWindow();
    ctx.startCredentialMonitor();
  }
}

// ── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.hive.app');

  const splashWindow = createSplashWindow();
  const splashStart = Date.now();

  let splashReady = false;
  ipcMain.handleOnce('splash-ready', () => { splashReady = true; });

  // Startup work in parallel
  const [, loadedSettings] = await Promise.all([
    ctx.skillsManager.init()
      .then(() => console.info(`Loaded ${ctx.skillsManager.getSkills().length} skills`))
      .catch(err => console.error('Error loading skills:', err)),
    ctx.settingsManager.loadSettings()
      .catch(err => { console.error('Error loading settings:', err); return ctx.settingsManager.getDefaultSettings(); }),
  ]);
  ctx.currentSettings = loadedSettings;

  if (!ctx.currentSettings.userId) {
    ctx.currentSettings.userId = require('crypto').randomUUID();
    await ctx.settingsManager.saveSettings(ctx.currentSettings);
  }

  // Start connectivity detection before validating, so the startup route and
  // the first banner state are decided against a known connectivity state
  // rather than being inferred from a failed AWS call.
  ctx.startConnectivityMonitor();

  // Decide the startup route. Shares resolveStartupRoute() with
  // validateAndRoute() so the offline-aware behaviour can't drift between the
  // two entry points (this one, and the macOS activate/re-open path).
  const route = await resolveStartupRoute(ctx);

  // Ensure splash visible for minimum time
  const MIN_SPLASH_MS = 1500;
  const elapsed = Date.now() - splashStart;
  if (elapsed < MIN_SPLASH_MS) {
    await new Promise(r => setTimeout(r, MIN_SPLASH_MS - elapsed));
  }

  // Route to correct page
  if (route === 'credentials') {
    createCredentialsWindow();
  } else {
    createWindow();
    ctx.startCredentialMonitor();
  }
  splashWindow.close();

  // ── Register all IPC handlers ───────────────────────────
  credentialsIPC.register(ipcMain, ctx);
  settingsIPC.register(ipcMain, ctx);
  setupWizardIPC.register(ipcMain, ctx);
  adminSetupIPC.register(ipcMain, ctx);
  conversationsIPC.register(ipcMain, ctx, { invokeChatModel: (model, prompt) => bedrockIPC.invokeChatModel(ctx, model, prompt) });
  memoryIPC.register(ipcMain, ctx);
  workHistoryIPC.register(ipcMain, ctx);
  skillsIPC.register(ipcMain, ctx);
  showflowIPC.register(ipcMain, ctx);
  swarmIPC.register(ipcMain, ctx);
  agentIPC.register(ipcMain, ctx);
  bedrockIPC.register(ipcMain, ctx);

  // Misc handlers
  ipcMain.handle('navigate-to-main', async () => {
    if (ctx.mainWindow) {
      ctx.mainWindow.setSize(1200, 800);
      ctx.mainWindow.center();
      ctx.mainWindow.setResizable(true);
      ctx.mainWindow.loadFile('src/pages/index.html');
    }
  });

  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      properties: ['openDirectory'], title: 'Select workspace directory',
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('select-files', async () => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      properties: ['openFile', 'multiSelections'], title: 'Select files to attach',
    });
    if (result.canceled || !result.filePaths.length) return [];
    return result.filePaths.map(fp => ({
      name: path.basename(fp), path: fp, size: fs.statSync(fp).size,
    }));
  });

  ipcMain.handle('get-app-version', () => app.getVersion());
  ipcMain.handle('install-update', () => autoUpdater.quitAndInstall());

  // ── Connectivity ───────────────────────────────────────
  // The renderer asks for the current state on load (it can't rely on having
  // been present for the last transition) and forwards its own OS
  // online/offline events, which fire sooner than our recheck timer.
  ipcMain.handle('get-connectivity-status', () => ({ online: ctx.isOnline() }));

  ipcMain.handle('renderer-connectivity-hint', async () => {
    // Deliberately ignores the renderer's own verdict and re-probes:
    // navigator.onLine reports interface state, which is true on a captive
    // portal. The hint is a prompt to check, not the answer.
    if (!ctx.connectivityMonitor) return { online: ctx.isOnline() };
    const online = await ctx.connectivityMonitor.recheck();
    return { online };
  });

  // ── Application menu ───────────────────────────────────
  const menuTemplate = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Check for Updates...', click: () => autoUpdater.checkForUpdates().catch(err => logger.warn('Manual update check failed:', err.message)) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  // ── App activate (macOS dock click) ────────────────────
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await validateAndRoute();
    }
  });

  // ── Auto-updater ──────────────────────────────────────
  if (app.isPackaged) {
    autoUpdater.logger = logger;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      ctx.mainWindow?.webContents.send('update-available', info.version);
    });
    autoUpdater.on('update-downloaded', () => {
      ctx.mainWindow?.webContents.send('update-downloaded');
    });
    autoUpdater.on('error', (err) => {
      logger.warn(`Auto-updater error: ${err.message}`);
    });

    setTimeout(() => autoUpdater.checkForUpdates(), 10000);
    setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
    ctx.mainWindow.webContents.send('app-before-quit');
  }
  for (const [id, ci] of ctx.workSandboxes) {
    if (ci?.sessionId) ci.stopSession().catch(() => {});
  }
  ctx.workSandboxes.clear();
});
