const { app } = require('electron');
const fs = require('fs').promises;
const path = require('path');
const log = require('electron-log/main');

class SettingsManager {
  constructor() {
    this.settingsDir = app.getPath('userData');
    this.settingsFile = path.join(this.settingsDir, 'settings.json');
    this.defaultSettings = {
      transcriptionLanguage: 'en-US',
      defaultTheme: 'auto',
      bucketName: '',
      outputBucketName: '',
      region: 'us-east-1',
      memoryId: '',
      memoryEnabled: false,
      userId: '',
      sagemakerImageEndpoint: '',
      sagemakerImageComponent: '',
      // IAM role ARN the AgentCore Gateway assumes to run the Web Search
      // Tool target. Required only for first-time Gateway creation in a
      // given AWS account — once the 'hive-web-search' Gateway exists,
      // WebSearchManager reuses it and this is no longer consulted. Must
      // trust bedrock-agentcore.amazonaws.com in its trust policy.
      webSearchGatewayRoleArn: '',
      // One-off, long-term Bedrock API key used to authenticate against the
      // bedrock-mantle endpoint (both the Anthropic Messages API branch and
      // the OpenAI-compatible Responses API branch in strandsAgentFactory.js
      // use this same key — Mantle is now Hive's only model-invocation path,
      // Bedrock Converse/BedrockModel has been removed entirely). AWS docs
      // note long-term Bedrock API keys are "recommended only for
      // exploration" — short-term keys expire in <=12h and would require
      // Hive to implement its own refresh loop, which this deliberately
      // avoids for now.
      mantleApiKey: '',
      // Models reachable via bedrock-mantle now that Bedrock Converse/
      // BedrockModel has been removed. Only two families are supported by
      // the installed Strands SDK: Anthropic (via AnthropicModel, matched by
      // "anthropic." in the model ID) and OpenAI-compatible (via
      // OpenAIModel, every other model ID — GPT-5.x, gpt-oss, etc.). Models
      // with no Strands provider that can reach Mantle at all (Nova,
      // DeepSeek, Mistral, Llama, etc.) are no longer offered by default.
      bedrockModels: [
        { id: 'Claude Opus 4.6', inferenceProfileId: 'us.anthropic.claude-opus-4-6-v1', role: 'creator' },
        { id: 'Claude Sonnet 4.6', inferenceProfileId: 'us.anthropic.claude-sonnet-4-6', role: 'worker' },
        { id: 'Claude Haiku 4.5', inferenceProfileId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', role: 'formatter' },
        { id: 'GPT-5.6 Sol', inferenceProfileId: 'openai.gpt-5.6-sol', role: '' },
      ],
    };
  }

  async ensureSettingsDirectory() {
    try {
      await fs.access(this.settingsDir);
    } catch (error) {
      if (error.code === 'ENOENT') {
        await fs.mkdir(this.settingsDir, { recursive: true });
      } else {
        throw error;
      }
    }
  }

  async hasSettings() {
    try {
      await fs.access(this.settingsFile);
      return true;
    } catch (error) {
      return false;
    }
  }

  async loadSettings() {
    try {
      const hasSettings = await this.hasSettings();
      if (!hasSettings) {
        return this.defaultSettings;
      }

      const settingsData = await fs.readFile(this.settingsFile, 'utf8');
      const settings = JSON.parse(settingsData);
      
      // Merge with defaults to ensure all required fields exist
      return { ...this.defaultSettings, ...settings };
    } catch (error) {
      log.error('Error loading settings:', error.message);
      return this.defaultSettings;
    }
  }

  async saveSettings(settings) {
    try {
      await this.ensureSettingsDirectory();
      
      // Validate required fields
      const validatedSettings = this.validateSettings(settings);
      
      await fs.writeFile(
        this.settingsFile,
        JSON.stringify(validatedSettings, null, 2),
        'utf8'
      );
      
      return true;
    } catch (error) {
      log.error('Error saving settings:', error.message);
      throw new Error(`Failed to save settings: ${error.message}`);
    }
  }

  validateSettings(settings) {
    const validated = { ...this.defaultSettings };
    
    // Validate transcription language
    if (settings.transcriptionLanguage && typeof settings.transcriptionLanguage === 'string') {
      validated.transcriptionLanguage = settings.transcriptionLanguage.trim();
    }
    
    // Validate theme
    if (settings.defaultTheme && ['light', 'dark', 'auto'].includes(settings.defaultTheme)) {
      validated.defaultTheme = settings.defaultTheme;
    }
    
    // Validate bucket names (allow empty strings)
    if (typeof settings.bucketName === 'string') {
      validated.bucketName = settings.bucketName.trim();
    }
    
    if (typeof settings.outputBucketName === 'string') {
      validated.outputBucketName = settings.outputBucketName.trim();
    }
    
    // Validate region
    if (settings.region && typeof settings.region === 'string') {
      validated.region = settings.region.trim();
    }

    // Validate memoryId
    if (typeof settings.memoryId === 'string') {
      validated.memoryId = settings.memoryId.trim();
    }
    if (typeof settings.memoryEnabled === 'boolean') {
      validated.memoryEnabled = settings.memoryEnabled;
    }
    if (typeof settings.userId === 'string') {
      validated.userId = settings.userId;
    }

    // Validate SageMaker image generation
    if (typeof settings.sagemakerImageEndpoint === 'string') {
      validated.sagemakerImageEndpoint = settings.sagemakerImageEndpoint.trim();
    }
    if (typeof settings.sagemakerImageComponent === 'string') {
      validated.sagemakerImageComponent = settings.sagemakerImageComponent.trim();
    }

    // Validate web search Gateway execution role ARN
    if (typeof settings.webSearchGatewayRoleArn === 'string') {
      validated.webSearchGatewayRoleArn = settings.webSearchGatewayRoleArn.trim();
    }

    // Validate Mantle API key
    if (typeof settings.mantleApiKey === 'string') {
      validated.mantleApiKey = settings.mantleApiKey.trim();
    }

    // Preserve bedrockModels array
    if (Array.isArray(settings.bedrockModels)) {
      validated.bedrockModels = settings.bedrockModels;
    }
    
    return validated;
  }

  async deleteSettings() {
    try {
      const hasSettings = await this.hasSettings();
      if (hasSettings) {
        await fs.unlink(this.settingsFile);
      }
      return true;
    } catch (error) {
      log.error('Error deleting settings:', error.message);
      throw new Error(`Failed to delete settings: ${error.message}`);
    }
  }

  getDefaultSettings() {
    return { ...this.defaultSettings };
  }
}

module.exports = SettingsManager;