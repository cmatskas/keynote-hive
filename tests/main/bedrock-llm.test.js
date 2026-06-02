/**
 * Integration tests for Bedrock LLM models
 * Tests all configured models against all default prompts using actual AWS credentials
 * 
 * IMPORTANT: App credentials are encrypted and cannot be used in tests.
 * Configure credentials using environment variables or AWS CLI:
 *   export AWS_ACCESS_KEY_ID=your_key
 *   export AWS_SECRET_ACCESS_KEY=your_secret
 *   export AWS_REGION=us-east-1
 * OR:
 *   aws configure
 */

const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { BedrockAgentRuntimeClient, RetrieveAndGenerateCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const { bedrockModels, region } = require('../../config.js');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;

// Mock Electron app for CustomPromptsManager
jest.mock('electron', () => ({
  app: {
    getPath: () => '/tmp'
  }
}));

const CustomPromptsManager = require('../../src/main/models/customPromptsManager');

// Helper to load credentials from environment or AWS CLI
const loadCredentialsFromAWS = async () => {
  // Try AWS environment variables
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    console.log('✓ Loaded credentials from environment variables');
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION || region,
      sessionToken: process.env.AWS_SESSION_TOKEN
    };
  }
  
  // Try AWS CLI credentials file
  try {
    const credentialsPath = path.join(os.homedir(), '.aws', 'credentials');
    const configPath = path.join(os.homedir(), '.aws', 'config');
    
    const credData = await fs.readFile(credentialsPath, 'utf8');
    const accessKeyMatch = credData.match(/aws_access_key_id\s*=\s*(.+)/);
    const secretKeyMatch = credData.match(/aws_secret_access_key\s*=\s*(.+)/);
    const sessionTokenMatch = credData.match(/aws_session_token\s*=\s*(.+)/);
    
    if (accessKeyMatch && secretKeyMatch) {
      let awsRegion = region;
      try {
        const configData = await fs.readFile(configPath, 'utf8');
        const regionMatch = configData.match(/region\s*=\s*(.+)/);
        if (regionMatch) awsRegion = regionMatch[1].trim();
      } catch (e) {}
      
      console.log('✓ Loaded credentials from AWS CLI');
      return {
        accessKeyId: accessKeyMatch[1].trim(),
        secretAccessKey: secretKeyMatch[1].trim(),
        sessionToken: sessionTokenMatch ? sessionTokenMatch[1].trim() : undefined,
        region: awsRegion
      };
    }
  } catch (error) {}
  
  return null;
};

// Test sample text for prompts
const SAMPLE_TEXT = `
The quarterly earnings report shows significant growth in the technology sector. 
Revenue increased by 23% compared to last year, driven primarily by cloud services 
and AI product offerings. Customer satisfaction scores improved to 4.7 out of 5, 
indicating strong product-market fit. However, operational costs rose by 15%, 
mainly due to increased R&D investments. The company plans to expand into three 
new markets next quarter and hire 50 additional engineers. Key action items include 
optimizing infrastructure costs, launching the new mobile app, and conducting 
customer feedback sessions.
`;

describe('Bedrock LLM Integration Tests', () => {
  let bedrockClient;
  let credentials;
  
  // Load credentials before all tests
  beforeAll(async () => {
    credentials = await loadCredentialsFromAWS();
    
    if (!credentials) {
      throw new Error(
        'AWS credentials not found.\n\n' +
        'Please configure credentials using one of these methods:\n' +
        '1. Set environment variables: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION\n' +
        '2. Configure AWS CLI: aws configure\n\n' +
        'These tests require valid AWS credentials with Bedrock access.'
      );
    }
    
    bedrockClient = new BedrockRuntimeClient({
      region: credentials.region || region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        ...(credentials.sessionToken && { sessionToken: credentials.sessionToken })
      }
    });
    
    // Verify credentials are valid by making a test call
    try {
      const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
      const stsClient = new STSClient({
        region: credentials.region || region,
        credentials: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          ...(credentials.sessionToken && { sessionToken: credentials.sessionToken })
        }
      });
      await stsClient.send(new GetCallerIdentityCommand({}));
      console.log(`✓ Credentials verified`);
    } catch (error) {
      if (error.name === 'ExpiredTokenException' || error.message.includes('security token')) {
        throw new Error(
          'AWS credentials have expired.\n\n' +
          'Please refresh your credentials:\n' +
          '  aws sso login\n' +
          'OR update your credentials:\n' +
          '  aws configure'
        );
      }
      throw error;
    }
    
    console.log(`✓ Using region: ${credentials.region || region}`);
  });

  // Test each model with each prompt
  const defaultPrompts = [
    {
      id: 'Summarize Text',
      name: 'Summarize Text',
      prompt: 'Please provide a concise summary of the following text, highlighting the main points and key takeaways:'
    },
    {
      id: 'Analyze Sentiment',
      name: 'Analyze Sentiment',
      prompt: 'Analyze the sentiment and emotional tone of the following text. Identify whether it is positive, negative, or neutral, and explain why:'
    },
    {
      id: 'Extract Key Points',
      name: 'Extract Key Points',
      prompt: 'Extract and list the key points, main ideas, and important details from the following text:'
    },
    {
      id: 'Generate Action Items',
      name: 'Generate Action Items',
      prompt: 'Based on the following text, generate a list of actionable items, tasks, or next steps:'
    }
  ];
  
  describe.each(bedrockModels)('Model: $id', (model) => {
    describe.each(defaultPrompts)('Prompt: $id', (promptConfig) => {
      
      it(`should successfully invoke ${model.id} with "${promptConfig.id}" prompt`, async () => {
        // Construct the full prompt with sample text
        const fullPrompt = `${promptConfig.prompt}\n\nText:\n${SAMPLE_TEXT}`;
        
        // Create the request
        const request = {
          modelId: model.inferenceProfileId,
          messages: [
            {
              role: "user",
              content: [
                {
                  text: fullPrompt
                }
              ]
            }
          ],
          inferenceConfig: {
            maxTokens: 4096
          }
        };
        
        const command = new ConverseCommand(request);
        
        // Invoke the model
        const response = await bedrockClient.send(command);
        
        // Assertions
        expect(response).toBeDefined();
        expect(response.output).toBeDefined();
        expect(response.output.message).toBeDefined();
        expect(response.output.message.content).toBeDefined();
        expect(response.output.message.content.length).toBeGreaterThan(0);
        
        const responseText = response.output.message.content[0].text;
        expect(responseText).toBeDefined();
        expect(typeof responseText).toBe('string');
        expect(responseText.length).toBeGreaterThan(0);
        
        // Log response for debugging
        console.log(`\n${model.id} - ${promptConfig.id}:`);
        console.log(`Response length: ${responseText.length} characters`);
        console.log(`First 100 chars: ${responseText.substring(0, 100)}...`);
        
        // Verify response quality based on prompt type
        switch (promptConfig.id) {
          case 'Summarize Text':
            expect(responseText.toLowerCase()).toMatch(/revenue|growth|earnings|quarter/);
            break;
          case 'Analyze Sentiment':
            expect(responseText.toLowerCase()).toMatch(/positive|sentiment|tone|attitude/);
            break;
          case 'Extract Key Points':
            expect(responseText.toLowerCase()).toMatch(/revenue|growth|cost|expansion|hiring/);
            break;
          case 'Generate Action Items':
            expect(responseText.toLowerCase()).toMatch(/action|task|item|step/);
            break;
        }
      }, 60000); // 60 second timeout for API calls
      
    });
  });

  // Test error handling
  describe('Error Handling', () => {
    it('should handle invalid model ID gracefully', async () => {
      const request = {
        modelId: 'invalid-model-id',
        messages: [
          {
            role: "user",
            content: [{ text: "Test prompt" }]
          }
        ],
        inferenceConfig: {
          maxTokens: 100
        }
      };
      
      const command = new ConverseCommand(request);
      
      await expect(bedrockClient.send(command)).rejects.toThrow();
    });

    it('should handle empty prompt', async () => {
      const request = {
        modelId: bedrockModels[0].inferenceProfileId,
        messages: [
          {
            role: "user",
            content: [{ text: "" }]
          }
        ],
        inferenceConfig: {
          maxTokens: 100
        }
      };
      
      const command = new ConverseCommand(request);
      
      // Should either succeed with empty response or throw validation error
      try {
        const response = await bedrockClient.send(command);
        expect(response).toBeDefined();
      } catch (error) {
        expect(error).toBeDefined();
      }
    }, 30000);
  });

  // Test model comparison
  describe('Model Comparison', () => {
    const testPrompt = `${defaultPrompts[0].prompt}\n\nText:\n${SAMPLE_TEXT}`;
    
    it('should get responses from all models for the same prompt', async () => {
      const responses = [];
      
      for (const model of bedrockModels) {
        const request = {
          modelId: model.inferenceProfileId,
          messages: [
            {
              role: "user",
              content: [{ text: testPrompt }]
            }
          ],
          inferenceConfig: {
            maxTokens: 4096
          }
        };
        
        const command = new ConverseCommand(request);
        const response = await bedrockClient.send(command);
        const responseText = response.output.message.content[0].text;
        
        responses.push({
          model: model.id,
          response: responseText,
          length: responseText.length
        });
      }
      
      // Verify all models responded
      expect(responses.length).toBe(bedrockModels.length);
      
      // Log comparison
      console.log('\n=== Model Response Comparison ===');
      responses.forEach(r => {
        console.log(`\n${r.model}:`);
        console.log(`  Length: ${r.length} characters`);
        console.log(`  Preview: ${r.response.substring(0, 150)}...`);
      });
      
      // All responses should be unique (different models give different responses)
      const uniqueResponses = new Set(responses.map(r => r.response));
      expect(uniqueResponses.size).toBeGreaterThan(1);
    }, 180000); // 3 minute timeout for multiple API calls
  });

  // Test inference configuration variations
  describe('Inference Configuration', () => {
    const model = bedrockModels[0]; // Test with first model
    const prompt = `${defaultPrompts[0].prompt}\n\nText:\n${SAMPLE_TEXT}`;
    
    it('should handle different maxTokens settings', async () => {
      const tokenLimits = [100, 500, 2000];
      
      for (const maxTokens of tokenLimits) {
        const request = {
          modelId: model.inferenceProfileId,
          messages: [
            {
              role: "user",
              content: [{ text: prompt }]
            }
          ],
          inferenceConfig: {
            maxTokens: maxTokens,
            temperature: 0.7
          }
        };
        
        const command = new ConverseCommand(request);
        const response = await bedrockClient.send(command);
        const responseText = response.output.message.content[0].text;
        
        expect(responseText).toBeDefined();
        expect(responseText.length).toBeGreaterThan(0);
        
        console.log(`\nMax Tokens ${maxTokens}: ${responseText.length} characters`);
      }
    }, 90000);
  });
});
