const { app, BrowserWindow, ipcMain, dialog, Notification, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const logger = require('electron-log/main');

process.stdout.on('error', err => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', err => { if (err.code !== 'EPIPE') throw err; });
const { autoUpdater } = require('electron-updater');

const AppContext = require('./src/main/appContext');
const AWSValidator = require('./src/main/models/awsValidator');
const CredentialMonitor = require('./src/main/models/credentialMonitor');

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

// ── Credential monitor ──────────────────────────────────────────────────────

ctx.startCredentialMonitor = function () {
  if (ctx.credentialMonitor) ctx.credentialMonitor.stop();
  ctx.credentialMonitor = new CredentialMonitor({
    getCredentials: () => ctx.currentCredentials,
    getMainWindow: () => ctx.mainWindow,
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

async function validateAndRoute() {
  const hasCredentials = await ctx.credentialsManager.hasCredentials();
  let credentialsValid = false;

  if (hasCredentials) {
    try {
      ctx.currentCredentials = await ctx.credentialsManager.loadCredentials();
      ctx.initializeAWSClients(ctx.currentCredentials);
      const validator = new AWSValidator(ctx.currentCredentials);
      const result = await validator.quickValidate();
      credentialsValid = result.valid;
    } catch (err) {
      console.error('Error validating credentials:', err);
    }
  }

  if (!hasCredentials || !credentialsValid) {
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
  const [, loadedSettings, hasCredentials] = await Promise.all([
    ctx.skillsManager.init()
      .then(() => console.info(`Loaded ${ctx.skillsManager.getSkills().length} skills`))
      .catch(err => console.error('Error loading skills:', err)),
    ctx.settingsManager.loadSettings()
      .catch(err => { console.error('Error loading settings:', err); return ctx.settingsManager.getDefaultSettings(); }),
    ctx.credentialsManager.hasCredentials(),
  ]);
  ctx.currentSettings = loadedSettings;

  if (!ctx.currentSettings.userId) {
    ctx.currentSettings.userId = require('crypto').randomUUID();
    await ctx.settingsManager.saveSettings(ctx.currentSettings);
  }

  // Validate credentials
  let credentialsValid = false;
  if (hasCredentials) {
    try {
      ctx.currentCredentials = await ctx.credentialsManager.loadCredentials();
      ctx.initializeAWSClients(ctx.currentCredentials);
      const validator = new AWSValidator(ctx.currentCredentials);
      const result = await validator.quickValidate();
      credentialsValid = result.valid;
    } catch (error) {
      console.error('Error validating credentials:', error);
    }
  }

  // Ensure splash visible for minimum time
  const MIN_SPLASH_MS = 1500;
  const elapsed = Date.now() - splashStart;
  if (elapsed < MIN_SPLASH_MS) {
    await new Promise(r => setTimeout(r, MIN_SPLASH_MS - elapsed));
  }

  // Route to correct page
  if (!hasCredentials || !credentialsValid) {
    createCredentialsWindow();
  } else {
    createWindow();
    ctx.startCredentialMonitor();
  }
  splashWindow.close();

  // ── Register all IPC handlers ───────────────────────────
  credentialsIPC.register(ipcMain, ctx);
  settingsIPC.register(ipcMain, ctx);
  conversationsIPC.register(ipcMain, ctx, { invokeBedrockNoKB: (model, prompt) => bedrockIPC.invokeBedrockNoKB(ctx, model, prompt) });
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
