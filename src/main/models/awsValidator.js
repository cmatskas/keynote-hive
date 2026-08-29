const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const { BedrockClient, ListFoundationModelsCommand } = require('@aws-sdk/client-bedrock');
const { TranscribeClient, ListTranscriptionJobsCommand } = require('@aws-sdk/client-transcribe');
const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3');
const { isNetworkError, describeAwsError } = require('../awsErrors');

// The shared admin AWS account that owns Hive's organization-wide
// resources (the Managed Knowledge Base and its AgentCore Gateway). This
// gates visibility of the Admin tab in Settings — see adminSetup.js's doc
// comment for why this is a UX convenience, not the real security
// boundary (AWS IAM itself is what actually rejects unauthorized calls).
// Deliberately a hardcoded constant, not a setting — a regular user should
// never be able to change which account is treated as the admin account
// from the UI.
const AWS_KEYNOTE_ACCOUNT_ID = '448778737104';

class AWSValidator {
  constructor(credentials) {
    this.credentials = credentials;
  }

  /**
   * Quick validation — single STS call to check credentials are fresh.
   * ~100ms. Use before first service call.
   *
   * Returns one of three states, not two. `{ valid: false }` alone was
   * ambiguous: it conflated "AWS rejected these credentials" with "we never
   * reached AWS", and callers acted on the former when it was really the
   * latter — routing to the credentials page at startup, escalating a poll to
   * "expired" and tearing down the renderer, and telling users their working
   * credentials were invalid. When the failure is transport-level the result
   * now carries `offline: true`, and callers must treat that as "unknown,
   * try again later" rather than "invalid".
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
        offline: false,
        identity: { userId: identity.UserId, account: identity.Account, arn: identity.Arn },
        isAdminAccount: identity.Account === AWS_KEYNOTE_ACCOUNT_ID,
        errors: []
      };
    } catch (error) {
      if (isNetworkError(error)) {
        return {
          valid: false,
          offline: true,
          identity: null,
          errors: [describeAwsError(error)]
        };
      }
      return {
        valid: false,
        offline: false,
        identity: null,
        errors: [`Invalid AWS credentials: ${error.message}`]
      };
    }
  }

  /**
   * Full validation — STS + Bedrock + Transcribe + S3 permission checks.
   * ~900ms. Use only from Connection Status tab.
   */
  async validateCredentials() {
    const results = {
      valid: false,
      offline: false,
      identity: null,
      isAdminAccount: false,
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
      results.isAdminAccount = identity.Account === AWS_KEYNOTE_ACCOUNT_ID;
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
      // Same three-state distinction as quickValidate: a transport failure
      // must not be reported to the Connection Status tab as bad credentials.
      if (isNetworkError(error)) {
        results.offline = true;
        results.errors.push(describeAwsError(error));
      } else {
        results.errors.push(`Invalid AWS credentials: ${error.message}`);
      }
    }

    return results;
  }

  /**
   * Parse expiry timestamp from an AWS session token.
   * AWS STS tokens are opaque — expiry is not reliably extractable client-side.
   * This is a best-effort attempt; returns null if not parseable.
   */
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
module.exports.AWS_KEYNOTE_ACCOUNT_ID = AWS_KEYNOTE_ACCOUNT_ID;