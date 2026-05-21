const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime');
const { BedrockAgentClient } = require('@aws-sdk/client-bedrock-agent');
const { BedrockAgentRuntimeClient } = require('@aws-sdk/client-bedrock-agent-runtime');
const { TranscribeClient } = require('@aws-sdk/client-transcribe');
const { S3Client } = require('@aws-sdk/client-s3');

const CredentialsManager = require('./models/credentialsManager');
const SettingsManager = require('./models/settingsManager');
const ConversationManager = require('./models/conversationManager');
const CustomPromptsManager = require('./models/customPromptsManager');
const SkillsManager = require('./models/skillsManager');
const WorkHistoryManager = require('./models/workHistoryManager');
const CodeInterpreterManager = require('./models/codeInterpreterManager');

class AppContext {
  constructor() {
    this.currentCredentials = null;
    this.currentSettings = null;
    this.currentJinaApiKey = null;
    this.awsClients = {};
    this.mainWindow = null;
    this.credentialMonitor = null;
    this.swarmOrchestrator = null;

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
      bedrock: new BedrockRuntimeClient(clientConfig),
      bedrockAgent: new BedrockAgentClient(clientConfig),
      bedrockAgentRuntime: new BedrockAgentRuntimeClient(clientConfig),
      transcribe: new TranscribeClient(clientConfig),
      s3: new S3Client({
        ...clientConfig,
        endpoint: `https://s3.${credentials.region}.amazonaws.com`,
      }),
      agentCoreConfig: clientConfig,
    };
  }

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
