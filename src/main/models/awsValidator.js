const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const { BedrockClient, ListFoundationModelsCommand } = require('@aws-sdk/client-bedrock');
const { TranscribeClient, ListTranscriptionJobsCommand } = require('@aws-sdk/client-transcribe');
const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3');

class AWSValidator {
  constructor(credentials) {
    this.credentials = credentials;
  }

  /**
   * Quick validation — single STS call to check credentials are fresh.
   * ~100ms. Use before first service call.
   */
  async quickValidate() {
    try {
      const stsClient = new STSClient({
        region: this.credentials.region,
        credentials: {
          accessKeyId: this.credentials.accessKeyId,
          secretAccessKey: this.credentials.secretAccessKey,
          sessionToken: this.credentials.sessionToken
        }
      });
      const identity = await stsClient.send(new GetCallerIdentityCommand({}));
      return {
        valid: true,
        identity: { userId: identity.UserId, account: identity.Account, arn: identity.Arn },
        errors: []
      };
    } catch (error) {
      return { valid: false, identity: null, errors: [`Invalid AWS credentials: ${error.message}`] };
    }
  }

  /**
   * Full validation — STS + Bedrock + Transcribe + S3 permission checks.
   * ~900ms. Use only from Connection Status tab.
   */
  async validateCredentials() {
    const results = {
      valid: false,
      identity: null,
      permissions: {
        bedrock: false,
        transcribe: false,
        s3: false
      },
      errors: []
    };

    try {
      // Test basic AWS credentials with STS
      const stsClient = new STSClient({
        region: this.credentials.region,
        credentials: {
          accessKeyId: this.credentials.accessKeyId,
          secretAccessKey: this.credentials.secretAccessKey,
          sessionToken: this.credentials.sessionToken
        }
      });

      const identityCommand = new GetCallerIdentityCommand({});
      const identity = await stsClient.send(identityCommand);
      
      results.identity = {
        userId: identity.UserId,
        account: identity.Account,
        arn: identity.Arn
      };
      results.valid = true;

      // Test Bedrock permissions
      try {
        const bedrockClient = new BedrockClient({
          region: this.credentials.region,
          credentials: {
            accessKeyId: this.credentials.accessKeyId,
            secretAccessKey: this.credentials.secretAccessKey,
            sessionToken: this.credentials.sessionToken
          }
        });

        const bedrockCommand = new ListFoundationModelsCommand({});
        await bedrockClient.send(bedrockCommand);
        results.permissions.bedrock = true;
      } catch (error) {
        results.errors.push(`Bedrock access denied: ${error.message}`);
      }

      // Test Transcribe permissions
      try {
        const transcribeClient = new TranscribeClient({
          region: this.credentials.region,
          credentials: {
            accessKeyId: this.credentials.accessKeyId,
            secretAccessKey: this.credentials.secretAccessKey,
            sessionToken: this.credentials.sessionToken
          }
        });

        const transcribeCommand = new ListTranscriptionJobsCommand({ MaxResults: 1 });
        await transcribeClient.send(transcribeCommand);
        results.permissions.transcribe = true;
      } catch (error) {
        results.errors.push(`Transcribe access denied: ${error.message}`);
      }

      // Test S3 permissions
      try {
        const s3Client = new S3Client({
          region: this.credentials.region,
          credentials: {
            accessKeyId: this.credentials.accessKeyId,
            secretAccessKey: this.credentials.secretAccessKey,
            sessionToken: this.credentials.sessionToken
          }
        });

        const s3Command = new ListBucketsCommand({});
        await s3Client.send(s3Command);
        results.permissions.s3 = true;
      } catch (error) {
        results.errors.push(`S3 access denied: ${error.message}`);
      }

    } catch (error) {
      results.errors.push(`Invalid AWS credentials: ${error.message}`);
    }

    return results;
  }

  /**
   * Parse expiry timestamp from an AWS session token.
   * AWS STS tokens are opaque — expiry is not reliably extractable client-side.
   * This is a best-effort attempt; returns null if not parseable.
   */
  static parseTokenExpiry(sessionToken) {
    if (!sessionToken) return null;
    try {
      // Try decoding as raw base64 JSON
      const padded = sessionToken.replace(/-/g, '+').replace(/_/g, '/')
        .padEnd(sessionToken.length + (4 - sessionToken.length % 4) % 4, '=');
      const decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
      if (decoded.exp && typeof decoded.exp === 'number') return new Date(decoded.exp * 1000);
      if (decoded.Expiration) return new Date(decoded.Expiration);
    } catch {}
    return null;
  }

  static getRequiredPermissions() {
    return {
      bedrock: [
        'bedrock:ListFoundationModels',
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream'
      ],
      transcribe: [
        'transcribe:StartTranscriptionJob',
        'transcribe:GetTranscriptionJob',
        'transcribe:ListTranscriptionJobs'
      ],
      s3: [
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject'
      ]
    };
  }
}

module.exports = AWSValidator;