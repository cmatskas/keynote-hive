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

/**
 * Rewinding a stopped turn.
 *
 * When a run is stopped, the Work tab offers Edit prompt / Try again, and both
 * rewind past the stopped turn before sending again. The rewind has to be real:
 * conversationHistory for the next call is derived from session.messages, so a
 * turn left behind is a turn the model gets told about — it would receive the
 * attempt the user just discarded and read the edited prompt as a follow-up to
 * it, which is the opposite of what editing means.
 */
describe('rewindTo()', () => {
  const { rewindTo } = window.WorkTab;

  /** A session mid-conversation whose last turn was stopped. */
  function buildStoppedSession() {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const messages = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },        // index 2 — the stopped turn
      { role: 'assistant', content: 'partial second...' }, // discarded on rewind
    ];

    // One node per message, plus the notice, in render order.
    const nodes = messages.map((m, i) => {
      const el = document.createElement('div');
      el.className = `chat-message ${m.role}`;
      el.dataset.idx = String(i);
      container.appendChild(el);
      return el;
    });
    const notice = document.createElement('div');
    notice.className = 'chat-interrupted';
    container.appendChild(notice);

    const session = {
      container,
      messages,
      streamingEl: nodes[3],
      streamingText: 'partial second...',
      interruptedNotice: notice,
      lastUserTurn: { el: nodes[2], index: 2, text: 'second question' },
    };
    return { session, container, nodes, notice };
  }

  test('truncates history to just before the stopped turn', () => {
    const { session } = buildStoppedSession();

    rewindTo(session, session.lastUserTurn);

    expect(session.messages).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ]);
  });

  test('discards the partial reply as well as the prompt', () => {
    const { session } = buildStoppedSession();

    rewindTo(session, session.lastUserTurn);

    const contents = session.messages.map(m => m.content);
    expect(contents).not.toContain('second question');
    expect(contents).not.toContain('partial second...');
  });

  test('keeps every earlier turn intact', () => {
    // A rewind that took too much would silently erase conversation the user
    // never asked to lose.
    const { session } = buildStoppedSession();

    rewindTo(session, session.lastUserTurn);

    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].content).toBe('first question');
  });

  test('removes the stopped message, the partial reply and the notice from the DOM', () => {
    const { session, container, nodes, notice } = buildStoppedSession();

    rewindTo(session, session.lastUserTurn);

    expect(container.contains(nodes[0])).toBe(true);
    expect(container.contains(nodes[1])).toBe(true);
    expect(container.contains(nodes[2])).toBe(false);
    expect(container.contains(nodes[3])).toBe(false);
    // The notice is after the stopped turn, so it goes with it rather than being
    // left orphaned above the resent message.
    expect(container.contains(notice)).toBe(false);
    expect(container.querySelectorAll('.chat-message')).toHaveLength(2);
  });

  test('clears streaming state so the next run does not inherit discarded text', () => {
    const { session } = buildStoppedSession();

    rewindTo(session, session.lastUserTurn);

    expect(session.streamingEl).toBeNull();
    expect(session.streamingText).toBe('');
    expect(session.lastUserTurn).toBeNull();
    expect(session.interruptedNotice).toBeNull();
  });

  test('rewinding the very first turn empties the conversation', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const el = document.createElement('div');
    container.appendChild(el);

    const session = {
      container,
      messages: [{ role: 'user', content: 'only question' }],
      streamingEl: null,
      streamingText: '',
      lastUserTurn: { el, index: 0, text: 'only question' },
    };

    rewindTo(session, session.lastUserTurn);

    expect(session.messages).toEqual([]);
    expect(container.children).toHaveLength(0);
  });
});
