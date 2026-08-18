/**
 * @jest-environment jsdom
 */

/**
 * Tests for workTab.js's describeAgentError() — rewrites a raw AWS SDK
 * AccessDeniedException for AgentCore Code Interpreter/Browser session
 * actions into an actionable message pointing at the Setup Check
 * "Code Interpreter Permission" fix (grant-hive-permissions.sh), instead
 * of surfacing the raw SDK error string to the user. Any other error is
 * passed through unchanged.
 *
 * describeAgentError is exported on window.WorkTab purely for this test
 * (matching agentToolExecutor.js's own module.exports.summarizeNarration
 * pattern) — production code never calls it via that path.
 */

// workTab.js's IIFE reads window.ChatRenderer, window.FileManager, and
// localStorage at module load time — minimal stubs so require() doesn't
// throw, even though describeAgentError() itself never touches any of them.
// FileManager is the real module (not stubbed) since workTab.js calls
// FM.createFileManager(...) directly at load time and expects a real
// object back, not just a jest.fn().
global.ChatRenderer = {};
global.FileManager = require('../../src/renderer/fileManager.js');

const localStorageMock = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });

global.electronAPI = {
  receive: jest.fn(),
  invoke: jest.fn().mockResolvedValue({}),
  showToast: jest.fn(),
  removeAllListeners: jest.fn(),
};

require('../../src/renderer/workTab.js');

const { describeAgentError } = window.WorkTab;

describe('describeAgentError()', () => {
  test('rewrites AccessDeniedException for StartCodeInterpreterSession into an actionable message', () => {
    const error = new Error(
      'AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/MyRole/session is not authorized to perform: bedrock-agentcore:StartCodeInterpreterSession on resource: *'
    );
    const result = describeAgentError(error);
    expect(result).toContain('View instructions to fix this');
    expect(result).toContain('workAgentErrorViewInstructions');
    expect(result).not.toContain('AccessDeniedException'); // raw SDK text is not shown verbatim
  });

  test('rewrites AccessDeniedException for InvokeCodeInterpreter', () => {
    const error = new Error('AccessDeniedException: not authorized to perform: bedrock-agentcore:InvokeCodeInterpreter');
    const result = describeAgentError(error);
    expect(result).toContain('View instructions to fix this');
  });

  test('rewrites AccessDeniedException for StopCodeInterpreterSession', () => {
    const error = new Error('AccessDeniedException: not authorized to perform: bedrock-agentcore:StopCodeInterpreterSession');
    const result = describeAgentError(error);
    expect(result).toContain('View instructions to fix this');
  });

  test('rewrites AccessDeniedException for StartBrowserSession', () => {
    const error = new Error('AccessDeniedException: not authorized to perform: bedrock-agentcore:StartBrowserSession');
    const result = describeAgentError(error);
    expect(result).toContain('View instructions to fix this');
  });

  test('rewrites AccessDeniedException for StopBrowserSession', () => {
    const error = new Error('AccessDeniedException: not authorized to perform: bedrock-agentcore:StopBrowserSession');
    const result = describeAgentError(error);
    expect(result).toContain('View instructions to fix this');
  });

  test('passes through an AccessDeniedException for an unrelated action unchanged', () => {
    const error = new Error('AccessDeniedException: not authorized to perform: s3:GetObject');
    const result = describeAgentError(error);
    expect(result).toBe(error.message);
    expect(result).not.toContain('View instructions to fix this');
  });

  test('passes through a non-AccessDenied AgentCore error unchanged', () => {
    const error = new Error('ThrottlingException: Rate exceeded for bedrock-agentcore:StartCodeInterpreterSession');
    const result = describeAgentError(error);
    expect(result).toBe(error.message);
  });

  test('passes through an unrelated error unchanged', () => {
    const error = new Error('Mantle API key not configured — set it in Settings > Mantle API Key');
    const result = describeAgentError(error);
    expect(result).toBe(error.message);
  });

  test('handles an error-like object without a message gracefully (falls back to String())', () => {
    const result = describeAgentError({});
    expect(typeof result).toBe('string');
  });
});
