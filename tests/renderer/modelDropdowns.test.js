/**
 * @jest-environment jsdom
 *
 * loadBedrockModels() fills both the Chat (modelSelect) and Work
 * (workModelSelect) dropdowns from get-bedrock-models. The Work tab is an
 * agent loop, so models flagged supportsTools: false (Gemma 3 on Converse
 * answers tool requests with plain text) must be left out of it — the
 * agent's tools would otherwise silently never run.
 */

global.ModalManager = jest.fn().mockImplementation(() => ({ show: jest.fn(), hide: jest.fn(), showError: jest.fn() }));
global.fetch = jest.fn();
global.bootstrap = { Modal: { getInstance: jest.fn().mockReturnValue({ show: jest.fn(), hide: jest.fn() }) } };
Object.defineProperty(window, 'localStorage', { value: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn(), clear: jest.fn() } });
Object.defineProperty(window, 'marked', { value: { parse: (md) => md }, writable: true });

const MODELS = [
  { id: 'Claude Opus 5.5', inferenceProfileId: 'global.anthropic.claude-opus-5-5', role: 'creator' },
  { id: 'Grok 4.6', inferenceProfileId: 'us.xai.grok-4.6', role: '' },
  { id: 'Gemma 3 27B', inferenceProfileId: 'google.gemma-3-27b-it', role: '', supportsTools: false },
];

const mockElectronAPI = {
  showToast: jest.fn(),
  invoke: jest.fn(async (channel) => {
    if (channel === 'get-bedrock-models') return MODELS;
    if (channel === 'get-prompt-templates') return [];
    return undefined;
  }),
  receive: jest.fn(),
  invokeAsync: jest.fn(),
  getPathForFile: jest.fn(() => ''),
};
Object.defineProperty(window, 'electronAPI', { value: mockElectronAPI, writable: true });

const optionValues = (id) => [...document.getElementById(id).options].map(o => o.value);

const { buildIndexPageDom } = require('./helpers/indexPageDom');

describe('model dropdowns', () => {
  beforeAll(async () => {
    // Same page skeleton index.test.js uses (shared helper): index.js wires
    // listeners to these elements at load time, so each must exist before the
    // require.
    document.body.innerHTML = buildIndexPageDom();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    require('../../src/renderer/index.js');
    await window.loadBedrockModels();
  });

  test('Chat dropdown lists every model, including tool-less ones', () => {
    expect(optionValues('modelSelect')).toEqual([
      'global.anthropic.claude-opus-5-5',
      'us.xai.grok-4.6',
      'google.gemma-3-27b-it',
    ]);
  });

  test('Work dropdown skips models flagged supportsTools: false', () => {
    expect(optionValues('workModelSelect')).toEqual([
      'global.anthropic.claude-opus-5-5',
      'us.xai.grok-4.6',
    ]);
  });

  test('models without the flag are treated as tool-capable', () => {
    expect(optionValues('workModelSelect')).toContain('us.xai.grok-4.6');
  });
});
