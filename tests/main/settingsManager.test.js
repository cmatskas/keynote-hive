/**
 * Tests for settingsManager.js — in particular validateSettings(), which is
 * an allowlist-based sanitizer: saveSettings() only persists fields it has
 * an explicit validation branch for, silently dropping anything else back
 * to its defaultSettings value. This previously caused a real bug —
 * webSearchGatewayRoleArn was added to defaultSettings but no matching
 * validation branch was added, so saveSettings() silently discarded it on
 * every save regardless of what the caller passed, and the field appeared
 * to "not persist" with no error anywhere.
 */
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/mock/userData') },
}));

jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('fs', () => ({
  promises: {
    access: jest.fn(),
    mkdir: jest.fn(),
    readFile: jest.fn(),
    writeFile: jest.fn(),
    unlink: jest.fn(),
  },
}));

const fs = require('fs').promises;
const SettingsManager = require('../../src/main/models/settingsManager');

describe('SettingsManager', () => {
  let manager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new SettingsManager();
  });

  describe('validateSettings — every defaultSettings key must round-trip', () => {
    // Regression guard for the exact bug class described above: for every
    // string-typed key in defaultSettings, saveSettings() must actually
    // preserve a caller-supplied non-default value rather than silently
    // resetting it. This will fail loudly the next time a new setting is
    // added to defaultSettings without a matching validateSettings() branch.
    // Excludes fields validated against a fixed enum (e.g. defaultTheme),
    // which correctly reject an arbitrary probe string by design — that's
    // not the failure mode this guard targets.
    const ENUM_CONSTRAINED_FIELDS = new Set(['defaultTheme']);

    test('preserves a distinct non-default value for every free-text default setting', () => {
      const defaults = manager.getDefaultSettings();
      const stringKeys = Object.keys(defaults)
        .filter((k) => typeof defaults[k] === 'string')
        .filter((k) => !ENUM_CONSTRAINED_FIELDS.has(k));
      expect(stringKeys.length).toBeGreaterThan(0);

      const probeValues = {};
      stringKeys.forEach((key) => { probeValues[key] = `__probe_${key}__`; });

      const validated = manager.validateSettings(probeValues);

      for (const key of stringKeys) {
        expect(validated[key]).toBe(probeValues[key]);
      }
    });

    test('specifically preserves webSearchGatewayRoleArn (regression case)', () => {
      const arn = 'arn:aws:iam::123456789012:role/hive-web-search-gateway-role';
      const validated = manager.validateSettings({ webSearchGatewayRoleArn: arn });
      expect(validated.webSearchGatewayRoleArn).toBe(arn);
    });

    test('trims whitespace from webSearchGatewayRoleArn', () => {
      const validated = manager.validateSettings({ webSearchGatewayRoleArn: '  arn:aws:iam::123456789012:role/x  ' });
      expect(validated.webSearchGatewayRoleArn).toBe('arn:aws:iam::123456789012:role/x');
    });

    test('falls back to the default (empty string) when the field is absent', () => {
      const validated = manager.validateSettings({});
      expect(validated.webSearchGatewayRoleArn).toBe('');
    });

    test('ignores a non-string value for webSearchGatewayRoleArn rather than throwing', () => {
      const validated = manager.validateSettings({ webSearchGatewayRoleArn: 12345 });
      expect(validated.webSearchGatewayRoleArn).toBe('');
    });
  });

  describe('saveSettings / loadSettings round-trip', () => {
    test('a saved webSearchGatewayRoleArn is what loadSettings subsequently returns', async () => {
      const arn = 'arn:aws:iam::123456789012:role/hive-web-search-gateway-role';
      fs.access.mockResolvedValue(); // settingsDir exists
      fs.writeFile.mockResolvedValue();

      await manager.saveSettings({ webSearchGatewayRoleArn: arn });

      // Verify the exact JSON written to disk contains the ARN, unmodified.
      const [, writtenJson] = fs.writeFile.mock.calls[0];
      const written = JSON.parse(writtenJson);
      expect(written.webSearchGatewayRoleArn).toBe(arn);

      // Simulate loadSettings() reading that same file back.
      fs.access.mockResolvedValue(); // hasSettings() -> true
      fs.readFile.mockResolvedValue(writtenJson);
      const loaded = await manager.loadSettings();
      expect(loaded.webSearchGatewayRoleArn).toBe(arn);
    });
  });
});
