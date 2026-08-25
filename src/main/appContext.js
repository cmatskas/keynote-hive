const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime');
const { TranscribeClient } = require('@aws-sdk/client-transcribe');
const { S3Client } = require('@aws-sdk/client-s3');
const log = require('electron-log/main');

const CredentialsManager = require('./models/credentialsManager');
const SettingsManager = require('./models/settingsManager');
const ConversationManager = require('./models/conversationManager');
const CustomPromptsManager = require('./models/customPromptsManager');
const SkillsManager = require('./models/skillsManager');
const WorkHistoryManager = require('./models/workHistoryManager');
const CodeInterpreterManager = require('./models/codeInterpreterManager');
const WebSearchManager = require('./models/webSearchManager');

class AppContext {
  constructor() {
    this.currentCredentials = null;
    this.currentSettings = null;
    this.webSearchManager = null;
    this.webSearchInitError = null;
    this.awsClients = {};
    this.mainWindow = null;
    this.credentialMonitor = null;
    this.swarmOrchestrator = null;
    this.transcriptionJob = null;

    this.credentialsManager = new CredentialsManager();
    this.settingsManager = new SettingsManager();
    this.conversationManager = new ConversationManager();
    this.customPromptsManager = new CustomPromptsManager();
    this.skillsManager = new SkillsManager();
    this.workHistoryManager = new WorkHistoryManager();

    this.workSandboxes = new Map();
    this.agentAbortControllers = new Map();
    this.bedrockAbortController = null;
  }

  initializeAWSClients(credentials) {
    const clientConfig = {
      region: credentials.region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    };

    this.awsClients = {
      // Used as a lightweight "are credentials configured" guard elsewhere
      // (ipc/agent.js, ipc/swarm.js) — actual model invocation no longer
      // goes through this client at all (Bedrock Converse/BedrockModel has
      // been removed; every model call now goes through createAgent()'s
      // Mantle-based routing instead).
      bedrock: new BedrockRuntimeClient(clientConfig),
      transcribe: new TranscribeClient(clientConfig),
      s3: new S3Client({
        ...clientConfig,
        endpoint: `https://s3.${credentials.region}.amazonaws.com`,
      }),
      agentCoreConfig: clientConfig,
    };

    // Initialize web search (async, non-blocking). Reads webSearchGatewayRoleArn
    // from settings — required only for first-time Gateway creation in this AWS
    // account (WebSearchManager reuses an existing 'hive-web-search' Gateway if
    // one is already READY, in which case no role is needed at all). Previously
    // this was never supplied, so first-time init in any fresh account/region
    // failed immediately with "roleArn required to create web search gateway",
    // silently left webSearchManager.ready === false for the rest of the app
    // session, and the model would fall back to writing its own HTTP/scraping
    // code via execute_code instead of the web tool — indistinguishable from
    // "the agent is using the sandbox for web search" from the user's side.
    this.webSearchManager = new WebSearchManager(credentials);
    this.initializeWebSearch();
  }

  /**
   * (Re-)initialize the web search Gateway using the role ARN from settings,
   * if any. Safe to call multiple times — e.g. after the user sets/updates
   * webSearchGatewayRoleArn in Settings, to retry without restarting the app.
   */
  async initializeWebSearch() {
    if (!this.webSearchManager) return;
    try {
      const settings = await this.settingsManager.loadSettings();
      await this.webSearchManager.initialize(settings.webSearchGatewayRoleArn || undefined);
      this.webSearchInitError = null;
    } catch (err) {
      this.webSearchInitError = err.message;
      log.warn(`[web-search] Initialization failed: ${err.message}`);
    }
  }

  /**
   * Returns the CodeInterpreterManager for a session, creating one if none
   * exists yet. Deliberately synchronous with no `await` in the body — the
   * check-then-set on `this.workSandboxes` is a single, uninterrupted tick
   * of the event loop, so it cannot race even if invoke-agent fires more
   * than once for the same sessionId in close succession. If this function
   * ever needs to become async (e.g. to validate something before
   * creating the manager), it MUST gain the same in-flight-promise-lock
   * pattern used in CodeInterpreterManager.startSession() — see that
   * function's comment for why: an `if (!has) { await ...; set(...) }`
   * shape reintroduces exactly the race this comment is warning against.
   */
  getOrCreateSandbox(sessionId) {
    if (!this.workSandboxes.has(sessionId)) {
      this.workSandboxes.set(sessionId, new CodeInterpreterManager(this.awsClients.agentCoreConfig));
    }
    return this.workSandboxes.get(sessionId);
  }

  async cleanupSandbox(sessionId) {
    const ci = this.workSandboxes.get(sessionId);
    if (ci?.sessionId) await ci.stopSession().catch(() => {});
    this.workSandboxes.delete(sessionId);
  }
}

module.exports = AppContext;
