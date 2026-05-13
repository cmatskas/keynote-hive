const { app, BrowserWindow, ipcMain, dialog, Notification, Menu } = require('electron');
const path = require('path');
const config = require('./config.js');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const logger = require('electron-log/main');
const { autoUpdater } = require('electron-updater');

const { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');
//const { BedrockClient } = require('@aws-sdk/client-bedrock');
const { BedrockAgentClient, ListKnowledgeBasesCommand } = require('@aws-sdk/client-bedrock-agent');
const { BedrockAgentRuntimeClient, RetrieveAndGenerateCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } = require('@aws-sdk/client-transcribe');

// Import credential management
const CredentialsManager = require('./src/main/models/credentialsManager');
const AWSValidator = require('./src/main/models/awsValidator');
const TranscriptMapper = require('./src/main/models/transcriptMapper.js');
const SettingsManager = require('./src/main/models/settingsManager');
const ConversationManager = require('./src/main/models/conversationManager');
const CustomPromptsManager = require('./src/main/models/customPromptsManager');
const SkillsManager = require('./src/main/models/skillsManager');
const CodeInterpreterManager = require('./src/main/models/codeInterpreterManager');
const AgentToolExecutor = require('./src/main/models/agentToolExecutor');
const BrowserManager = require('./src/main/models/browserManager');
const MemoryManager = require('./src/main/models/memoryManager');
const WorkHistoryManager = require('./src/main/models/workHistoryManager');
const SwarmOrchestrator = require('./src/main/models/swarmOrchestrator');
const { getTemplate, getAllTemplates, resolveModels } = require('./src/main/models/pipelineTemplates');

let conversationManager;
let customPromptsManager;
let skillsManager;
let workHistoryManager;
let swarmOrchestrator;

// Global variables for credential and settings management
let credentialsManager;
let settingsManager;
let currentCredentials = null;
let currentSettings = null;
let awsClients = {};

// Initialize credential and settings managers
function initializeCredentialsManager() {
  credentialsManager = new CredentialsManager();
}

function initializeSettingsManager() {
  settingsManager = new SettingsManager();
}

function initializeConversationManager() {
  conversationManager = new ConversationManager();
}

function initializeCustomPromptsManager() {
  customPromptsManager = new CustomPromptsManager();
}

function initializeSkillsManager() {
  skillsManager = new SkillsManager();
}

// Initialize AWS clients with credentials
function initializeAWSClients(credentials) {
  const clientConfig = {
    region: credentials.region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken
    }
  };

  awsClients = {
    bedrock: new BedrockRuntimeClient(clientConfig),
    bedrockAgent: new BedrockAgentClient(clientConfig),
    bedrockAgentRuntime: new BedrockAgentRuntimeClient(clientConfig),
    transcribe: new TranscribeClient(clientConfig),
    s3: new S3Client({
      ...clientConfig,
      endpoint: `https://s3.${credentials.region}.amazonaws.com`
    }),
    agentCoreConfig: clientConfig, // stored for CodeInterpreterManager
  };
}

let mainWindow;

// Helper function to get the appropriate icon path for the current platform
function getIconPath() {
  const fs = require('fs');
  
  let iconPath;
  if (process.platform === 'win32') {
    iconPath = path.join(__dirname, 'src/assets/favicon.ico');
  } else if (process.platform === 'darwin') {
    iconPath = path.join(__dirname, 'src/assets/favicon.icns');
  } else {
    // Use the largest PNG for Linux
    iconPath = path.join(__dirname, 'src/assets/favicon_512x512.png');
  }
  
  // Fallback to SVG if the platform-specific icon doesn't exist
  if (!fs.existsSync(iconPath)) {
    iconPath = path.join(__dirname, 'src/assets/favicon.svg');
  }
  
  return iconPath;
}

function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 600,
    height: 400,
    frame: false,
    resizable: false,
    center: true,
    icon: getIconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  splash.loadFile('src/pages/splash.html');
  return splash;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: getIconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('src/pages/index.html');
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.transcribely.app');
  }

  initializeCredentialsManager();
  initializeSettingsManager();
  initializeConversationManager();
  initializeCustomPromptsManager();
  initializeSkillsManager();
  workHistoryManager = new WorkHistoryManager();

  // Show splash immediately — auth check runs in parallel
  const splashWindow = createSplashWindow();

  // Track when splash signals it's rendered
  let splashReady = false;
  ipcMain.handleOnce('splash-ready', () => { splashReady = true; });

  // Run all startup work in parallel while splash is visible
  const [, loadedSettings, hasCredentials] = await Promise.all([
    skillsManager.init()
      .then(() => console.info(`Loaded ${skillsManager.getSkills().length} skills`))
      .catch(err => console.error('Error loading skills:', err)),
    settingsManager.loadSettings()
      .catch(err => { console.error('Error loading settings:', err); return settingsManager.getDefaultSettings(); }),
    credentialsManager.hasCredentials(),
  ]);
  currentSettings = loadedSettings;

  // Generate a unique userId for this installation if not already set
  if (!currentSettings.userId) {
    currentSettings.userId = require('crypto').randomUUID();
    await settingsManager.saveSettings(currentSettings);
  }

  // Validate credentials if they exist
  let credentialsValid = false;
  if (hasCredentials) {
    try {
      currentCredentials = await credentialsManager.loadCredentials();
      initializeAWSClients(currentCredentials);
      const validator = new AWSValidator(currentCredentials);
      const result = await validator.quickValidate();
      credentialsValid = result.valid;
    } catch (error) {
      console.error('Error validating credentials:', error);
    }
  }

  // Load Jina API key if available
  try {
    currentJinaApiKey = await credentialsManager.loadJinaApiKey();
  } catch { /* no key yet */ }

  // Ensure splash has been visible for at least 1.5s (animation needs time to render)
  const MIN_SPLASH_MS = 1500;
  const splashStart = splashWindow.webContents.getURL ? Date.now() : Date.now();
  const elapsed = Date.now() - splashStart;
  if (elapsed < MIN_SPLASH_MS) {
    await new Promise(r => setTimeout(r, MIN_SPLASH_MS - elapsed));
  }

  // Route to correct page then close splash
  if (!hasCredentials || !credentialsValid) {
    mainWindow = new BrowserWindow({
      width: 800,
      height: 600,
      center: true,
      icon: getIconPath(),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        preload: path.join(__dirname, 'preload.js')
      }
    });
    mainWindow.loadFile('src/pages/credentials.html');
  } else {
    createWindow();
  }

  splashWindow.close();

  // Application menu with Check for Updates
  const menuTemplate = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Check for Updates...',
          click: () => {
            autoUpdater.checkForUpdates().catch(err => logger.warn('Manual update check failed:', err.message));
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // ── Auto-updater ──────────────────────────────────────────
  // Only run in packaged app, not in dev
  if (app.isPackaged) {
    autoUpdater.logger = logger;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      mainWindow?.webContents.send('update-available', info.version);
    });

    autoUpdater.on('update-downloaded', () => {
      mainWindow?.webContents.send('update-downloaded');
    });

    autoUpdater.on('error', (err) => {
      logger.warn(`Auto-updater error: ${err.message}`);
    });

    // Check for updates 10 seconds after launch, then every 4 hours
    setTimeout(() => autoUpdater.checkForUpdates(), 10000);
    setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
  }
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-before-quit');
  }
  // Clean up all persistent sandboxes
  for (const [id, ci] of workSandboxes) {
    if (ci?.sessionId) ci.stopSession().catch(() => {});
  }
  workSandboxes.clear();
});

// Credential management IPC handlers
ipcMain.handle('save-credentials', async (event, credentials) => {
  try {
    await credentialsManager.saveCredentials(credentials);
    currentCredentials = credentials;
    initializeAWSClients(credentials);
    return true;
  } catch (error) {
    throw new Error(`Failed to save credentials: ${error.message}`);
  }
});

ipcMain.handle('load-credentials', async () => {
  try {
    return await credentialsManager.loadCredentials();
  } catch (error) {
    throw new Error(`Failed to load credentials: ${error.message}`);
  }
});

ipcMain.handle('has-credentials', async () => {
  return await credentialsManager.hasCredentials();
});

ipcMain.handle('delete-credentials', async () => {
  try {
    await credentialsManager.deleteCredentials();
    currentCredentials = null;
    awsClients = {};
    return true;
  } catch (error) {
    throw new Error(`Failed to delete credentials: ${error.message}`);
  }
});

// Jina API key IPC handlers
let currentJinaApiKey = null;

ipcMain.handle('save-jina-key', async (_event, key) => {
  await credentialsManager.saveJinaApiKey(key);
  currentJinaApiKey = key;
  return true;
});

ipcMain.handle('load-jina-key', async () => {
  if (!currentJinaApiKey) currentJinaApiKey = await credentialsManager.loadJinaApiKey();
  return currentJinaApiKey ? '••••••••' : null; // never send raw key to renderer
});

ipcMain.handle('delete-jina-key', async () => {
  await credentialsManager.deleteJinaApiKey();
  currentJinaApiKey = null;
  return true;
});

ipcMain.handle('validate-credentials', async () => {
  try {
    if (!currentCredentials) {
      currentCredentials = await credentialsManager.loadCredentials();
    }
    const validator = new AWSValidator(currentCredentials);
    return await validator.validateCredentials();
  } catch (error) {
    throw new Error(`Failed to validate credentials: ${error.message}`);
  }
});

// Quick credential check — single STS call, ~100ms
ipcMain.handle('quick-validate-credentials', async () => {
  try {
    if (!currentCredentials) {
      currentCredentials = await credentialsManager.loadCredentials();
    }
    const validator = new AWSValidator(currentCredentials);
    return await validator.quickValidate();
  } catch (error) {
    return { valid: false, identity: null, errors: [error.message] };
  }
});

// ── AgentCore Memory handlers ──────────────────────────────────

ipcMain.handle('memory-enable', async () => {
  if (!awsClients.agentCoreConfig) throw new Error('AWS credentials not configured');
  const settings = await settingsManager.loadSettings();

  // If memoryId already exists, just re-enable — no need to create
  if (settings.memoryId) {
    settings.memoryEnabled = true;
    await settingsManager.saveSettings(settings);
    return { id: settings.memoryId, status: 'ACTIVE', alreadyExisted: true };
  }

  const mm = new MemoryManager(awsClients.agentCoreConfig);
  mm.setActorId(settings.userId);
  const result = await mm.createMemory();
  if (result.status !== 'ACTIVE' && !result.alreadyExisted) {
    await mm.waitForActive();
  }
  settings.memoryId = result.id;
  settings.memoryEnabled = true;
  await settingsManager.saveSettings(settings);
  return result;
});

ipcMain.handle('memory-disable', async () => {
  const settings = await settingsManager.loadSettings();
  settings.memoryEnabled = false;
  await settingsManager.saveSettings(settings);
  return { enabled: false };
});

ipcMain.handle('memory-delete', async () => {
  const settings = await settingsManager.loadSettings();
  if (settings.memoryId && awsClients.agentCoreConfig) {
    const mm = new MemoryManager(awsClients.agentCoreConfig);
    mm.setMemoryId(settings.memoryId);
    await mm.deleteMemory();
  }
  settings.memoryId = '';
  settings.memoryEnabled = false;
  await settingsManager.saveSettings(settings);
  return { enabled: false };
});

ipcMain.handle('memory-status', async () => {
  const settings = await settingsManager.loadSettings();
  if (!settings.memoryId) return { enabled: false, memoryEnabled: false };
  if (!awsClients.agentCoreConfig) return { enabled: false, memoryEnabled: false };
  try {
    const mm = new MemoryManager(awsClients.agentCoreConfig);
    mm.setMemoryId(settings.memoryId);
    const status = await mm.getStatus();
    return { enabled: true, memoryEnabled: settings.memoryEnabled, memoryId: settings.memoryId, status };
  } catch {
    return { enabled: false, memoryEnabled: false, memoryId: settings.memoryId, status: 'UNREACHABLE' };
  }
});

ipcMain.handle('memory-extract', async (event, { sessionId }) => {
  const settings = await settingsManager.loadSettings();
  if (!settings.memoryId || !awsClients.agentCoreConfig) return;
  const mm = new MemoryManager(awsClients.agentCoreConfig);
  mm.setMemoryId(settings.memoryId);
  mm.setActorId(settings.userId);
  await mm.startExtraction(sessionId);
});

// ── Work History handlers ──────────────────────────────────

ipcMain.handle('work-history-list', async () => {
  return await workHistoryManager.list();
});

ipcMain.handle('work-history-load', async (event, { id }) => {
  return await workHistoryManager.load(id);
});

ipcMain.handle('work-history-save', async (event, session) => {
  await workHistoryManager.save(session);
});

ipcMain.handle('work-history-delete', async (event, { id }) => {
  await workHistoryManager.remove(id);
});

ipcMain.handle('work-history-rename', async (event, { id, title }) => {
  await workHistoryManager.rename(id, title);
});

ipcMain.handle('work-history-star', async (event, { id }) => {
  return await workHistoryManager.toggleStar(id);
});

ipcMain.handle('navigate-to-main', async () => {
  if (mainWindow) {
    mainWindow.setSize(1200, 800);
    mainWindow.center();
    mainWindow.setResizable(true);
    mainWindow.loadFile('src/pages/index.html');
  }
});

// Settings management IPC handlers
ipcMain.handle('save-settings', async (event, settings) => {
  try {
    // Merge with existing settings to preserve fields not managed by the UI (e.g. memoryId)
    const existing = await settingsManager.loadSettings();
    const merged = { ...existing, ...settings };
    await settingsManager.saveSettings(merged);
    currentSettings = merged;
    return true;
  } catch (error) {
    throw new Error(`Failed to save settings: ${error.message}`);
  }
});

ipcMain.handle('load-settings', async () => {
  try {
    return await settingsManager.loadSettings();
  } catch (error) {
    throw new Error(`Failed to load settings: ${error.message}`);
  }
});

ipcMain.handle('get-default-settings', async () => {
  return settingsManager.getDefaultSettings();
});

ipcMain.handle('delete-settings', async () => {
  try {
    await settingsManager.deleteSettings();
    currentSettings = settingsManager.getDefaultSettings();
    return true;
  } catch (error) {
    throw new Error(`Failed to delete settings: ${error.message}`);
  }
});

// ── Abort controllers for cancellation ───────────────────────
const agentAbortControllers = new Map();  // sessionId → AbortController
let bedrockAbortController = null;        // single controller for Analyze tab

ipcMain.handle('cancel-agent', (event, { sessionId }) => {
  const ctrl = agentAbortControllers.get(sessionId);
  if (ctrl) { ctrl.abort(); agentAbortControllers.delete(sessionId); }
});

ipcMain.handle('cancel-bedrock', () => {
  if (bedrockAbortController) { bedrockAbortController.abort(); bedrockAbortController = null; }
});

ipcMain.handle('send-to-bedrock', async (event, { model, prompt, knowledgeBaseId, conversationHistory, files = [] }) => {
  bedrockAbortController = new AbortController();
  const { signal } = bedrockAbortController;
  try {
    if (knowledgeBaseId) {
      return await invokeBedrockWithKB(model, prompt, knowledgeBaseId);
    } else {
      return await invokeBedrockNoKB(model, prompt, conversationHistory, files, event, signal);
    }
  } finally {
    bedrockAbortController = null;
  }
});

// Conversation management IPC handlers
ipcMain.handle('list-conversations', async () => {
  return await conversationManager.list();
});

ipcMain.handle('load-conversation', async (event, id) => {
  return await conversationManager.load(id);
});

ipcMain.handle('save-conversation', async (event, conversation) => {
  return await conversationManager.save(conversation);
});

ipcMain.handle('delete-conversation', async (event, id) => {
  await conversationManager.delete(id);
  return true;
});

ipcMain.handle('create-conversation', async (event, firstPrompt) => {
  return conversationManager.create(firstPrompt);
});

ipcMain.handle('compress-conversation', async (event, { model, conversation }) => {
  const oldMessages = conversation.messages.slice(0, -4);
  const historyText = oldMessages.map(m => `${m.role}: ${m.content}`).join('\n\n');
  const summaryPrompt = `Summarize the following conversation history concisely, preserving all key facts, decisions, and context that would be needed to continue the conversation:\n\n${historyText}`;
  const summary = await invokeBedrockNoKB(model, summaryPrompt);
  return conversationManager.applyCompression(conversation, summary);
});

ipcMain.handle('transcribe-media', async (event, { file }) => {
  try {
    if (!awsClients.transcribe) {
      throw new Error('AWS credentials not configured');
    }

    // Convert the array buffer back to Buffer for processing
    const fileBuffer = Buffer.from(file.buffer);
    const fileObj = {
      buffer: fileBuffer,
      originalname: file.name,
      mimetype: file.type
    };

    // Send progress update
    event.sender.send('transcription-progress', {
      status: 'UPLOADING',
      message: 'Uploading file to S3...'
    });

    // Start transcription job
    const jobName = await startTranscription(fileObj);

    // Send progress update
    event.sender.send('transcription-progress', {
      status: 'IN_PROGRESS',
      message: 'Transcription job started. Processing audio...'
    });

    // Poll for job completion
    const maxAttempts = 60; // 5 minutes with 5-second intervals
    const pollInterval = 5000; // 5 seconds

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const jobStatus = await checkTranscriptionJobStatus(jobName);

      if (jobStatus.status === 'COMPLETED') {
        // Send progress update
        event.sender.send('transcription-progress', {
          status: 'RETRIEVING',
          message: 'Retrieving transcription results...'
        });

        // Get the transcription results
        const results = await getTranscriptionResults(jobStatus.outputUri);
        const transcriptMapper = new TranscriptMapper(results);
        const transcript = transcriptMapper.getAllTimestampedText();
        return {
          status: 'COMPLETED',
          transcript: transcript,
          jobName: jobName
        };
      } else if (jobStatus.status === 'FAILED') {
        throw new Error(`Transcription job failed: ${jobStatus.failureReason || 'Unknown error'}`);
      }

      // Send periodic progress updates
      const elapsed = Math.floor((attempt + 1) * pollInterval / 1000);
      event.sender.send('transcription-progress', {
        status: 'IN_PROGRESS',
        message: `Processing audio... (${elapsed}s elapsed)`
      });

      // Job is still in progress, wait before next check
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // If we get here, the job timed out
    throw new Error('Transcription job timed out after 5 minutes');

  } catch (error) {
    console.error('Error in transcribe-media:', error);
    throw new Error(`Transcription failed: ${error.message}`);
  }
});

ipcMain.handle('get-prompt-templates', async () => {
  return await customPromptsManager.getAll();
});

// Custom prompts handlers
ipcMain.handle('add-custom-prompt', async (event, prompt) => {
  return await customPromptsManager.add(prompt);
});

ipcMain.handle('update-custom-prompt', async (event, { id, updates }) => {
  return await customPromptsManager.update(id, updates);
});

ipcMain.handle('delete-custom-prompt', async (event, id) => {
  return await customPromptsManager.delete(id);
});

ipcMain.handle('get-custom-prompts', async () => {
  return await customPromptsManager.getAll();
});

// Skills handlers
ipcMain.handle('get-skills', async () => {
  return skillsManager.getSkills();
});

ipcMain.handle('toggle-skill', async (event, { name, enabled }) => {
  return await skillsManager.toggleSkill(name, enabled);
});

ipcMain.handle('refresh-skills', async () => {
  return await skillsManager.refresh();
});

ipcMain.handle('open-skills-folder', async () => {
  await skillsManager.openSkillsFolder();
});

ipcMain.handle('get-skill-content', async (event, name) => {
  const skill = skillsManager.getSkill(name);
  if (!skill) return null;
  const content = await require('fs').promises.readFile(skill.location, 'utf8');
  return content;
});

ipcMain.handle('save-skill-content', async (event, { name, content }) => {
  const skill = skillsManager.getSkill(name);
  if (!skill) throw new Error('Skill not found');
  await require('fs').promises.writeFile(skill.location, content, 'utf8');
  await skillsManager.refresh();
  return true;
});

ipcMain.handle('delete-skill', async (event, name) => {
  const skill = skillsManager.getSkill(name);
  if (!skill) throw new Error('Skill not found');
  await require('fs').promises.rm(require('path').dirname(skill.location), { recursive: true, force: true });
  await skillsManager.refresh();
  return true;
});

ipcMain.handle('create-skill', async (event, { name, content }) => {
  const dir = require('path').join(skillsManager.userSkillsDir, name);
  await require('fs').promises.mkdir(dir, { recursive: true });
  await require('fs').promises.writeFile(require('path').join(dir, 'SKILL.md'), content, 'utf8');
  await skillsManager.refresh();
  return true;
});

// Swarm handlers
function createSwarmOrchestrator() {
  swarmOrchestrator = new SwarmOrchestrator({
    awsConfig: awsClients.agentCoreConfig,
    skillsManager,
    codeInterpreterManager: new (require('./src/main/models/codeInterpreterManager'))(awsClients.agentCoreConfig),
    browserManager: new (require('./src/main/models/browserManager'))(awsClients.agentCoreConfig),
    settings: { ...(currentSettings || {}), jinaApiKey: currentJinaApiKey },
    onEvent: (channel, data) => {
      if (mainWindow) mainWindow.webContents.send(channel, data);
      // System notifications for events needing user attention
      if (channel === 'swarm-review-pause') {
        swarmNotify('Review Required', `${data.agentIndex !== undefined ? 'Agent' : 'Pipeline'} output ready for your review.`);
      } else if (channel === 'swarm-input-request') {
        swarmNotify('Input Needed', data.question ? data.question.slice(0, 100) : 'An agent needs your input.');
      } else if (channel === 'swarm-pipeline-done') {
        swarmNotify('Pipeline Complete', 'All agents finished successfully.');
      } else if (channel === 'swarm-error') {
        swarmNotify('Pipeline Error', data.error ? data.error.slice(0, 100) : 'An error occurred.');
      }
    },
  });
  return swarmOrchestrator;
}

function swarmNotify(title, body) {
  if (Notification.isSupported()) {
    const n = new Notification({ title: `Transcribely — ${title}`, body, silent: false });
    n.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
    n.show();
  }
}

ipcMain.handle('swarm-get-templates', async () => getAllTemplates());

ipcMain.handle('swarm-get-analytics', async () => {
  const fs = require('fs').promises;
  const path = require('path');
  const runsDir = path.join(app.getPath('userData'), 'swarm-runs');
  const runs = [];
  try {
    const dirs = await fs.readdir(runsDir);
    for (const dir of dirs) {
      try {
        const raw = await fs.readFile(path.join(runsDir, dir, 'state.json'), 'utf8');
        runs.push(JSON.parse(raw));
      } catch { /* skip invalid */ }
    }
  } catch { /* no runs dir */ }

  if (!runs.length) return { summary: null, templates: {}, insights: [] };

  // Aggregate
  const completed = runs.filter(r => r.status === 'completed');
  const errored = runs.filter(r => r.status === 'error');
  const templates = {};

  for (const run of runs) {
    const tid = run.templateId || 'unknown';
    if (!templates[tid]) templates[tid] = { name: run.templateName || tid, runs: 0, completed: 0, errors: 0, scores: [], criteriaStats: {} };
    const t = templates[tid];
    t.runs++;
    if (run.status === 'completed') t.completed++;
    if (run.status === 'error') t.errors++;

    // Collect rubric scores
    for (const [gateId, attempts] of Object.entries(run.rubric_scores || {})) {
      for (const attempt of attempts) {
        t.scores.push(attempt.score);
        // Per-criteria tracking from axis_scores
        for (const [axis, score] of Object.entries(attempt.axis_scores || {})) {
          if (!t.criteriaStats[axis]) t.criteriaStats[axis] = { pass: 0, fail: 0 };
          if (score >= 0.75) t.criteriaStats[axis].pass++;
          else t.criteriaStats[axis].fail++;
        }
      }
    }
  }

  // Summary
  const allScores = Object.values(templates).flatMap(t => t.scores);
  const avgScore = allScores.length ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;
  const summary = {
    totalRuns: runs.length,
    completed: completed.length,
    errors: errored.length,
    passRate: runs.length ? Math.round((completed.length / runs.length) * 100) : 0,
    avgScore: Math.round(avgScore * 100),
  };

  // Insights
  const insights = [];
  for (const [tid, t] of Object.entries(templates)) {
    if (t.errors > 0 && t.errors / t.runs > 0.5) {
      insights.push({ severity: 'error', message: `${t.name}: ${t.errors}/${t.runs} runs failed — check tool configuration` });
    }
    for (const [axis, stats] of Object.entries(t.criteriaStats)) {
      const total = stats.pass + stats.fail;
      if (total >= 3 && stats.fail / total > 0.5) {
        insights.push({ severity: 'warn', message: `${t.name} → "${axis}" fails ${Math.round(stats.fail / total * 100)}% of the time — consider adjusting the writer prompt or rubric weight` });
      }
      if (total >= 5 && stats.pass === total) {
        insights.push({ severity: 'info', message: `${t.name} → "${axis}" passes 100% — consider removing to save evaluation tokens` });
      }
    }
  }

  return { summary, templates, insights };
});

ipcMain.handle('swarm-run-pipeline', async (event, { templateId, brief, autonomyMode, files }) => {
  if (!awsClients.bedrock) throw new Error('AWS credentials not configured');
  // Resolve model roles from settings before fetching template
  const settings = currentSettings || await settingsManager.loadSettings();
  const models = (settings.bedrockModels || []);
  const overrides = {};
  for (const m of models) { if (m.role) overrides[m.role] = m.inferenceProfileId; }
  resolveModels(overrides);

  const orch = createSwarmOrchestrator();
  const template = getTemplate(templateId);
  if (!template) throw new Error(`Unknown template: ${templateId}`);
  const swarmId = `swarm-${Date.now()}`;
  orch.runPipeline(swarmId, template, brief, autonomyMode || 'guided', files || []);
  return { swarmId };
});

ipcMain.handle('swarm-continue', async (event, { swarmId, editedOutput }) => {
  if (swarmOrchestrator) swarmOrchestrator.continueAfterReview(swarmId, editedOutput);
});

ipcMain.handle('swarm-answer-input', async (event, { swarmId, answer }) => {
  if (swarmOrchestrator) swarmOrchestrator.answerInput(swarmId, answer);
});

ipcMain.handle('swarm-cancel', async (event, { swarmId }) => {
  if (swarmOrchestrator) swarmOrchestrator.cancel(swarmId);
});

// Directory picker
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select workspace directory',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: 'Select files to attach',
  });
  if (result.canceled || !result.filePaths.length) return [];
  const path = require('path');
  const fs = require('fs');
  return result.filePaths.map(fp => ({
    name: path.basename(fp),
    path: fp,
    size: fs.statSync(fp).size,
  }));
});

// Persistent sandbox sessions per work conversation
const workSandboxes = new Map(); // sessionId → CodeInterpreterManager

function getOrCreateSandbox(sessionId) {
  if (!workSandboxes.has(sessionId)) {
    workSandboxes.set(sessionId, new CodeInterpreterManager(awsClients.agentCoreConfig));
  }
  return workSandboxes.get(sessionId);
}

async function cleanupSandbox(sessionId) {
  const ci = workSandboxes.get(sessionId);
  if (ci?.sessionId) await ci.stopSession().catch(() => {});
  workSandboxes.delete(sessionId);
}

// Agent handler — runs the agentic tool-use loop
ipcMain.handle('invoke-agent', async (event, { model, prompt, conversationHistory, files = [], sessionId }) => {
  if (!awsClients.bedrock) {
    throw new Error('AWS credentials not configured');
  }

  const abortController = new AbortController();
  agentAbortControllers.set(sessionId, abortController);

  // Set up memory if configured
  const settings = await settingsManager.loadSettings();
  settings.jinaApiKey = currentJinaApiKey;
  let memManager = null;
  if (settings.memoryId && settings.memoryEnabled && awsClients.agentCoreConfig) {
    memManager = new MemoryManager(awsClients.agentCoreConfig);
    memManager.setMemoryId(settings.memoryId);
    memManager.setActorId(settings.userId);
    memManager._ensureStrategies().catch(err => console.warn('Strategy check failed:', err.message));
  }

  const ciManager = getOrCreateSandbox(sessionId);
  const brManager = new BrowserManager(awsClients.agentCoreConfig);
  const executor = new AgentToolExecutor({
    bedrockClient: awsClients.bedrock,
    skillsManager,
    codeInterpreterManager: ciManager,
    browserManager: brManager,
    memoryManager: memManager,
    sessionId,
    settings,
    signal: abortController.signal,
    onStatus: (status) => event.sender.send('agent-status', { sessionId, status }),
    onChunk: (chunk) => event.sender.send('agent-stream-chunk', { sessionId, chunk }),
  });

  skillsManager.resetActivations();
  try {
    return await executor.run(model, prompt, conversationHistory, files);
  } finally {
    agentAbortControllers.delete(sessionId);
  }
});

// Clean up sandbox when conversation ends
ipcMain.handle('work-cleanup-session', async (_event, { sessionId }) => {
  await cleanupSandbox(sessionId);
  return { success: true };
});

// Add handler to get Bedrock models from settings (falls back to config)
ipcMain.handle('get-bedrock-models', async () => {
  const settings = currentSettings || await settingsManager.loadSettings();
  return settings.bedrockModels || config.bedrockModels;
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall();
});

// Add handler to get Bedrock knowledge bases
ipcMain.handle('get-knowledge-bases', async () => {
  try {
    if (!awsClients.bedrockAgent) {
      throw new Error('AWS credentials not configured');
    }

    const command = new ListKnowledgeBasesCommand({
      maxResults: 20 // Adjust as needed
    });

    const response = await awsClients.bedrockAgent.send(command);

    // Format the knowledge bases for the dropdown
    const knowledgeBases = response.knowledgeBaseSummaries.map(kb => ({
      id: kb.knowledgeBaseId,
      name: kb.name || kb.knowledgeBaseId,
      description: kb.description || ''
    }));

    return knowledgeBases;
  } catch (error) {
    console.error('Error retrieving knowledge bases:', error);
    throw new Error(`Failed to retrieve knowledge bases: ${error.message}`);
  }
});

async function startTranscription(file) {
  const bigFileSize = 20 * 1024 * 1024;
  let mediaUri;

  // Get current settings for bucket names
  const settings = currentSettings || await settingsManager.loadSettings();

  if (file.buffer.length >= bigFileSize) {
    console.info("File is larger than 20MB, using multipart upload");
    mediaUri = await uploadLargeFile(
      file,
      settings.bucketName,
      `${Date.now()}-${file.originalname}`
    );
  } else {
    console.info("File is smaller than 20MB, using regular upload");
    mediaUri = await uploadToS3(
      file,
      settings.bucketName,
      `${Date.now()}-${file.originalname}`
    );
  }
  // Determine media format from the file extension - supports all Amazon Transcribe formats
  const getMediaFormat = (uri) => {
    const lowerUri = uri.toLowerCase();

    // Audio formats
    if (lowerUri.endsWith('.mp3')) return 'mp3';
    if (lowerUri.endsWith('.wav')) return 'wav';
    if (lowerUri.endsWith('.flac')) return 'flac';
    if (lowerUri.endsWith('.ogg')) return 'ogg';
    if (lowerUri.endsWith('.amr')) return 'amr';
    if (lowerUri.endsWith('.webm')) return 'webm';

    // Video formats (audio will be extracted)
    if (lowerUri.endsWith('.mp4')) return 'mp4';
    if (lowerUri.endsWith('.mov')) return 'mov';
    if (lowerUri.endsWith('.avi')) return 'avi';
    if (lowerUri.endsWith('.mkv')) return 'mkv';
    if (lowerUri.endsWith('.flv')) return 'flv';

    // Default fallback
    return 'mp4';
  };

  const mediaFormat = getMediaFormat(mediaUri);

  const jobName = `transcription-${Date.now()}`;

  const command = new StartTranscriptionJobCommand({
    TranscriptionJobName: jobName,
    Media: { MediaFileUri: mediaUri },
    MediaFormat: mediaFormat,
    LanguageCode: settings.transcriptionLanguage,
    OutputBucketName: settings.outputBucketName,
    Settings: {
      ShowSpeakerLabels: true,
      MaxSpeakerLabels: 5
    }
  });

  let jobId;
  try {
    const transcribeJob = await awsClients.transcribe.send(command);
    jobId = transcribeJob.TranscriptionJob.TranscriptionJobName;
  } catch (error) {
    console.error('Error starting transcription job:', error);
    throw error;
  }

  return jobId;
}

// Check transcription job status
async function checkTranscriptionJobStatus(jobName) {
  const command = new GetTranscriptionJobCommand({
    TranscriptionJobName: jobName
  });

  try {
    const response = await awsClients.transcribe.send(command);
    const job = response.TranscriptionJob;

    return {
      status: job.TranscriptionJobStatus,
      outputUri: job.Transcript?.TranscriptFileUri,
      failureReason: job.FailureReason
    };
  } catch (error) {
    console.error('Error checking transcription job status:', error);
    throw error;
  }
}

// Get transcription results
async function getTranscriptionResults(outputUri) {

  // Extract bucket and key from the output URI
  const url = new URL(outputUri);
  const bucket = url.pathname.split("/")[1]; // Extract bucket name from pathname
  const key = url.pathname.split("/").slice(2).join("/"); // Extract the key from the pathname

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key
  });

  try {
    console.info("Retrieving trascription results from storage");
    const client = awsClients.s3;
    const response = await client.send(command);
    const transcript = await response.Body.transformToString();
    return JSON.parse(transcript);
  } catch (error) {
    console.error('Error getting transcription results from storage:', error);
    throw error;
  }
}

async function uploadLargeFile(file, bucket, key) {
  const chunkSize = 5 * 1024 * 1024; // 5MB chunks

  try {
    const client = awsClients.s3; // Use dynamic client or fallback
    const multipartUpload = new Upload({
      client: client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype
      },
      queueSize: 4, // number of concurrent uploads
      partSize: chunkSize
    });

    multipartUpload.on('httpUploadProgress', (progress) => {
      const percentage = Math.round((progress.loaded / progress.total) * 100);
      console.log(`Upload progress: ${percentage}%`);
    });

    await multipartUpload.done();
    return `s3://${bucket}/${key}`;
  } catch (error) {
    console.error('Large file upload to S3 failed: ', error);
    throw error;
  }
}

async function uploadToS3(file, bucket, key) {
  try {
    const client = awsClients.s3; // Use dynamic client or fallback
    const upload = new Upload({
      client: client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype
      }
    });

    upload.on('httpUploadProgress', (progress) => {
      const percentage = Math.round((progress.loaded / progress.total) * 100);
      console.log(`Upload progress: ${percentage}%`);
    });

    await upload.done();
    return `s3://${bucket}/${key}`;
  } catch (error) {
    console.error('Small file upload to S3 failed: ', error);
    throw error;
  }
}

async function invokeBedrockNoKB(model, prompt, conversationHistory, files = [], event = null, signal = null) {
  try {
    if (!awsClients.bedrock) {
      throw new Error('AWS credentials not configured');
    }

    // Validate file count for Converse API
    if (files && files.length > 5) {
      throw new Error('Maximum 5 documents allowed for Bedrock Converse API');
    }

    // Build the message content starting with the prompt
    const messageContent = [{ text: prompt }];

    // Add documents if provided
    if (files && files.length > 0) {
      logger.info(`Processing ${files.length} files for Bedrock analysis`);

      // Extract pptx/ppt files via code interpreter sandbox
      const pptxFiles = files.filter(f => ['pptx', 'ppt'].includes(f.name.toLowerCase().split('.').pop()));
      if (pptxFiles.length > 0) {
        const clientConfig = { region: currentCredentials.region, credentials: { accessKeyId: currentCredentials.accessKeyId, secretAccessKey: currentCredentials.secretAccessKey, sessionToken: currentCredentials.sessionToken } };
        const ci = new CodeInterpreterManager(clientConfig);
        try {
          await ci.startSession(300);
          await ci.writeFiles(pptxFiles.map(f => ({ path: f.name, blob: Buffer.from(Array.isArray(f.content) ? f.content : f.content) })));
          for (const file of pptxFiles) {
            const result = await ci.executeCode(`
from pptx import Presentation
prs = Presentation("${file.name}")
slides = []
for i, slide in enumerate(prs.slides):
    texts = [shape.text_frame.text for shape in slide.shapes if shape.has_text_frame and shape.text_frame.text.strip()]
    if texts:
        slides.append(f"Slide {i+1}:\\n" + "\\n".join(texts))
print("\\n\\n".join(slides))
`);
            messageContent.push({ text: `\n\n--- Content from ${file.name} ---\n${result.text}\n--- End of ${file.name} ---\n` });
          }
        } finally {
          await ci.stopSession();
        }
      }

      for (const file of files) {
        const fileExtension = file.name.toLowerCase().split('.').pop();
        if (['pptx', 'ppt'].includes(fileExtension)) continue; // already handled above

        if (fileExtension === 'pdf') {
          const bytes = Buffer.from(Array.isArray(file.content) ? file.content : file.content);
          messageContent.push({
            document: {
              name: sanitizeFileName(file.name),
              format: 'pdf',
              source: { bytes }
            }
          });
        } else if (['doc', 'docx'].includes(fileExtension)) {
          const bytes = Buffer.from(Array.isArray(file.content) ? file.content : file.content);
          messageContent.push({
            document: {
              name: sanitizeFileName(file.name),
              format: fileExtension,
              source: { bytes }
            }
          });
        } else if (['xls', 'xlsx'].includes(fileExtension)) {
          const bytes = Buffer.from(Array.isArray(file.content) ? file.content : file.content);
          messageContent.push({
            document: {
              name: sanitizeFileName(file.name),
              format: fileExtension,
              source: { bytes }
            }
          });
        } else if (['txt', 'md', 'csv', 'html'].includes(fileExtension)) {
          let formattedContent = file.content;
          
          if (fileExtension === 'csv') {
            formattedContent = `CSV Data from ${file.name}:\n${file.content}`;
          } else if (fileExtension === 'html') {
            formattedContent = `HTML Content from ${file.name}:\n${file.content}`;
          } else if (fileExtension === 'md') {
            formattedContent = `Markdown Content from ${file.name}:\n${file.content}`;
          }

          messageContent.push({
            text: `\n\n--- Content from ${file.name} ---\n${formattedContent}\n--- End of ${file.name} ---\n`
          });
        }
      }
    }

    // Build messages: prior history + new user message with content
    const messages = [
      ...(conversationHistory || []),
      { role: 'user', content: messageContent }
    ];

    const inferenceConfig = { maxTokens: 4096 };
    if (!model.includes('opus-4-7')) {
      inferenceConfig.temperature = 0.7;
    }

    const command = new ConverseStreamCommand({
      modelId: model,
      messages,
      inferenceConfig
    });

    const response = await awsClients.bedrock.send(command, signal ? { abortSignal: signal } : {});
    
    // Stream the response
    let fullText = '';
    for await (const chunk of response.stream) {
      if (chunk.contentBlockDelta?.delta?.text) {
        const textChunk = chunk.contentBlockDelta.delta.text;
        fullText += textChunk;
        
        // Send chunk to renderer if event is provided
        if (event) {
          event.sender.send('bedrock-stream-chunk', textChunk);
        }
      }
    }
    
    // Send completion signal
    if (event) {
      event.sender.send('bedrock-stream-complete');
    }
    
    return fullText;
  } catch (error) {
    logger.error(`Bedrock query failed: ${error.message}`);
    throw new Error(`Bedrock query failed: ${error.message}`);
  }
}

// Helper function to sanitize file names for Bedrock
const { sanitizeFileName } = require('./src/main/utils');

async function invokeBedrockWithKB(model, prompt, knowledgeBaseId) {
  try {
    if (!awsClients.bedrockAgentRuntime) {
      throw new Error('AWS credentials not configured');
    }

    const params = {
      input: {
        text: prompt // The user's question or request
      },
      retrieveAndGenerateConfiguration: {
        knowledgeBaseConfiguration: {
          knowledgeBaseId: knowledgeBaseId, // The ID of your knowledge base
          modelArn: model // The ARN of the model to use (e.g., Anthropic Claude)
        },
        type: "KNOWLEDGE_BASE"
      }
    };

    const command = new RetrieveAndGenerateCommand(params);
    const response = await awsClients.bedrockAgentRuntime.send(command);
    return response;
  } catch (error) {
    logger.error(`Bedrock retrieve and generate call failed: ${error.message}`);
    throw new Error(`Bedrock retrieve and generate call failed: ${error.message}`);
  }
}
