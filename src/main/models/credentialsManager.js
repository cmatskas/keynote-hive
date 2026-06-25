const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs').promises;

class CredentialsManager {
  constructor() {
    this.credentialsPath = path.join(app.getPath('userData'), 'aws-credentials.json');
  }

  async saveCredentials(credentials) {
    try {
      // Validate required fields
      if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.region) {
        throw new Error('Missing required AWS credentials');
      }

      // Encrypt sensitive data
      const encryptedData = {
        accessKeyId: safeStorage.encryptString(credentials.accessKeyId),
        secretAccessKey: safeStorage.encryptString(credentials.secretAccessKey),
        region: credentials.region, // Region is not sensitive
        sessionToken: credentials.sessionToken ? safeStorage.encryptString(credentials.sessionToken) : null,
        profileName: credentials.profileName || 'default'
      };

      await fs.writeFile(this.credentialsPath, JSON.stringify(encryptedData, null, 2));
      return true;
    } catch (error) {
      throw new Error(`Failed to save credentials: ${error.message}`);
    }
  }

  async loadCredentials() {
    try {
      const data = await fs.readFile(this.credentialsPath, 'utf8');
      const encryptedData = JSON.parse(data);

      // Helper function to reconstruct Buffer from JSON serialized data
      const reconstructBuffer = (bufferData) => {
        if (Buffer.isBuffer(bufferData)) {
          return bufferData;
        }
        if (bufferData && bufferData.type === 'Buffer' && bufferData.data) {
          return Buffer.from(bufferData.data);
        }
        return bufferData;
      };

      // Decrypt sensitive data
      return {
        accessKeyId: safeStorage.decryptString(reconstructBuffer(encryptedData.accessKeyId)),
        secretAccessKey: safeStorage.decryptString(reconstructBuffer(encryptedData.secretAccessKey)),
        region: encryptedData.region,
        sessionToken: encryptedData.sessionToken ? safeStorage.decryptString(reconstructBuffer(encryptedData.sessionToken)) : null,
        profileName: encryptedData.profileName || 'default'
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null; // No credentials file exists
      }
      throw new Error(`Failed to load credentials: ${error.message}`);
    }
  }

  async hasCredentials() {
    try {
      await fs.access(this.credentialsPath);
      return true;
    } catch {
      return false;
    }
  }

  async deleteCredentials() {
    try {
      await fs.unlink(this.credentialsPath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return true; // File doesn't exist, consider it deleted
      }
      throw new Error(`Failed to delete credentials: ${error.message}`);
    }
  }

}

module.exports = CredentialsManager;