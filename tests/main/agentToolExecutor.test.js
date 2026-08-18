/**
 * Tests for agentToolExecutor.js's agent-loop status/narration behavior:
 *
 *  - Text preceding a tool call (stopReason === 'toolUse') is routed to
 *    onStatus as a 'thinking' activity entry, not onChunk/the final answer.
 *  - Text ending a turn (stopReason !== 'toolUse') is treated as the real
 *    answer and flushed via onChunk into accumulatedText.
 *  - reasoningContentDelta events stream live to onStatus as 'thinking'
 *    entries with append:true, regardless of provider (Bedrock vs Mantle
 *    normalize to the same delta shape upstream).
 *  - BeforeToolCallEvent/AfterToolCallEvent emit {tool,detail,state} status
 *    for every tool call.
 *  - enableThinking is threaded through to createAgent().
 */

// Minimal hookable-agent stand-in: addHook records callbacks by event class
// so the test can invoke them manually, matching the real SDK's behavior
// closely enough without depending on it. stream() is swapped per-test.
function createMockAgent() {
  const hooks = new Map(); // EventClass -> [callback, ...]
  return {
    addHook: jest.fn((EventClass, callback) => {
      if (!hooks.has(EventClass)) hooks.set(EventClass, []);
      hooks.get(EventClass).push(callback);
      return jest.fn(); // cleanup fn
    }),
    _fireHook(EventClass, eventData) {
      (hooks.get(EventClass) || []).forEach((cb) => cb(eventData));
    },
    stream: jest.fn(),
  };
}

jest.mock('@strands-agents/sdk', () => {
  class FakeBeforeToolCallEvent {}
  class FakeAfterToolCallEvent {}
  return {
    tool: jest.fn((def) => def),
    AfterToolCallEvent: FakeAfterToolCallEvent,
    BeforeToolCallEvent: FakeBeforeToolCallEvent,
  };
});

jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../src/main/models/swarmTools', () => ({
  createSwarmTools: jest.fn(() => []),
}));

const mockCreateAgent = jest.fn();
jest.mock('../../src/main/models/strandsAgentFactory', () => ({
  createAgent: (...args) => mockCreateAgent(...args),
}));

jest.mock('../../src/main/utils', () => ({
  buildFileContentBlocks: jest.fn(async () => []),
}));

const AgentToolExecutor = require('../../src/main/models/agentToolExecutor');
const { BeforeToolCallEvent: FakeBeforeToolCallEvent, AfterToolCallEvent: FakeAfterToolCallEvent } = require('@strands-agents/sdk');

function buildExecutor({ onStatus = jest.fn(), onChunk = jest.fn(), memory = null, signal = null } = {}) {
  const skillsManager = {
    getCatalog: jest.fn(() => []),
    getAutoActivateSkills: jest.fn(async () => []),
  };
  const codeInterpreterManager = { sessionId: null };
  const executor = new AgentToolExecutor({
    bedrockClient: {},
    awsConfig: { region: 'us-east-1', credentials: {} },
    skillsManager,
    codeInterpreterManager,
    memoryManager: memory,
    webSearchManager: {},
    sessionId: 'sess-1',
    settings: {},
    signal,
    onStatus,
    onChunk,
  });
  return executor;
}

/** Wraps an array of stream events into an async generator, as agent.stream() returns. */
function streamOf(events) {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

describe('agentToolExecutor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('narration vs answer routing (stopReason-based)', () => {
    test('routes text ending in stopReason "toolUse" to onStatus as a thinking entry, not onChunk', async () => {
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([
        { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: "I'll check the file first." } } },
        { type: 'modelMessageEvent', stopReason: 'toolUse' },
      ]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const onStatus = jest.fn();
      const onChunk = jest.fn();
      const executor = buildExecutor({ onStatus, onChunk });

      const result = await executor.run('test-model', 'do something', [], []);

      expect(onChunk).not.toHaveBeenCalledWith("I'll check the file first.");
      expect(onStatus).toHaveBeenCalledWith({ tool: 'thinking', detail: "I'll check the file first.", state: 'done' });
      expect(result).toBe('');
    });

    test('routes text ending in stopReason "endTurn" to onChunk as the real answer', async () => {
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([
        { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Here is your answer.' } } },
        { type: 'modelMessageEvent', stopReason: 'endTurn' },
      ]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const onStatus = jest.fn();
      const onChunk = jest.fn();
      const executor = buildExecutor({ onStatus, onChunk });

      const result = await executor.run('test-model', 'do something', [], []);

      expect(onChunk).toHaveBeenCalledWith('Here is your answer.');
      expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ tool: 'thinking' }));
      expect(result).toBe('Here is your answer.');
    });

    test('handles a multi-turn sequence: narration -> tool call -> final answer', async () => {
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([
        { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Let me look this up.' } } },
        { type: 'modelMessageEvent', stopReason: 'toolUse' },
        { type: 'toolResultEvent' },
        { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'The answer is 42.' } } },
        { type: 'modelMessageEvent', stopReason: 'endTurn' },
      ]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const onStatus = jest.fn();
      const onChunk = jest.fn();
      const executor = buildExecutor({ onStatus, onChunk });

      const result = await executor.run('test-model', 'what is the answer', [], []);

      expect(onStatus).toHaveBeenCalledWith({ tool: 'thinking', detail: 'Let me look this up.', state: 'done' });
      expect(onChunk).toHaveBeenCalledWith('The answer is 42.');
      expect(onChunk).not.toHaveBeenCalledWith('Let me look this up.');
      expect(result).toBe('The answer is 42.');
    });

    test('does not emit a thinking entry for a toolUse turn with only whitespace/no text', async () => {
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([
        { type: 'modelMessageEvent', stopReason: 'toolUse' },
      ]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const onStatus = jest.fn();
      const executor = buildExecutor({ onStatus });

      await executor.run('test-model', 'do something', [], []);

      expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ tool: 'thinking' }));
    });

    test('summarizes long, multi-sentence narration down to a short entry instead of dumping it verbatim', async () => {
      const longNarration = "I'll start by reading the input file to understand its structure. Then I'll process each row, apply the required transformations, and finally write the output to a new spreadsheet with formatted headers and totals.";
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([
        { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: longNarration } } },
        { type: 'modelMessageEvent', stopReason: 'toolUse' },
      ]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const onStatus = jest.fn();
      const executor = buildExecutor({ onStatus });
      await executor.run('test-model', 'process this data', [], []);

      const thinkingCall = onStatus.mock.calls.find(([arg]) => arg.tool === 'thinking' && arg.state === 'done');
      expect(thinkingCall).toBeDefined();
      const [{ detail }] = thinkingCall;
      expect(detail.length).toBeLessThan(longNarration.length);
      expect(detail).toBe("I'll start by reading the input file to understand its structure.");
    });
  });

  describe('reasoningContentDelta (extended thinking) — summarized, not streamed raw', () => {
    test('emits a single static "Reasoning..." status, not the raw reasoning text', async () => {
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([
        { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: 'Considering ' } } },
        { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: 'options and tradeoffs in significant detail...' } } },
        { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Final answer.' } } },
        { type: 'modelMessageEvent', stopReason: 'endTurn' },
      ]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const onStatus = jest.fn();
      const onChunk = jest.fn();
      const executor = buildExecutor({ onStatus, onChunk });

      await executor.run('test-model', 'think about it', [], [], true);

      // Only one 'running' status for the reasoning block, regardless of how
      // many deltas arrived — no raw reasoning text anywhere in onStatus calls.
      const runningThinkingCalls = onStatus.mock.calls
        .map(([arg]) => arg)
        .filter((arg) => arg.tool === 'thinking' && arg.state === 'running');
      expect(runningThinkingCalls).toEqual([{ tool: 'thinking', detail: 'Reasoning...', state: 'running' }]);

      const rawTextLeaked = onStatus.mock.calls.some(
        ([arg]) => typeof arg.detail === 'string' && arg.detail.includes('Considering')
      );
      expect(rawTextLeaked).toBe(false);
      expect(onChunk).toHaveBeenCalledWith('Final answer.');
    });

    test('closes out the "thinking" entry with a done status once the turn ends', async () => {
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([
        { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: 'Thinking...' } } },
        { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Answer.' } } },
        { type: 'modelMessageEvent', stopReason: 'endTurn' },
      ]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const onStatus = jest.fn();
      const executor = buildExecutor({ onStatus });
      await executor.run('test-model', 'think about it', [], [], true);

      expect(onStatus).toHaveBeenCalledWith({ tool: 'thinking', detail: 'Reasoning...', state: 'running' });
    });

    test('ignores reasoningContentDelta events with no text', async () => {
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([
        { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', signature: 'sig-only' } } },
        { type: 'modelMessageEvent', stopReason: 'endTurn' },
      ]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const onStatus = jest.fn();
      const executor = buildExecutor({ onStatus });

      await executor.run('test-model', 'think about it', [], [], true);

      expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ tool: 'thinking' }));
    });

    test('resets the reasoning status flag between turns (fires again on a second reasoning turn)', async () => {
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([
        { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: 'First thought.' } } },
        { type: 'modelMessageEvent', stopReason: 'toolUse' },
        { type: 'toolResultEvent' },
        { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: 'Second thought.' } } },
        { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Done.' } } },
        { type: 'modelMessageEvent', stopReason: 'endTurn' },
      ]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const onStatus = jest.fn();
      const executor = buildExecutor({ onStatus });
      await executor.run('test-model', 'think about it', [], [], true);

      const runningReasoningCalls = onStatus.mock.calls.filter(
        ([arg]) => arg.tool === 'thinking' && arg.state === 'running' && arg.detail === 'Reasoning...'
      );
      expect(runningReasoningCalls.length).toBe(2);
    });
  });

  describe('summarizeNarration', () => {
    const { summarizeNarration } = AgentToolExecutor;

    test('returns short single-sentence text unchanged', () => {
      expect(summarizeNarration("I'll check the file first.")).toBe("I'll check the file first.");
    });

    test('takes only the first sentence when multiple are present', () => {
      expect(summarizeNarration("I'll check the file first. Then I'll generate the report and save it locally."))
        .toBe("I'll check the file first.");
    });

    test('hard-truncates a long single sentence with an ellipsis', () => {
      const longText = 'This is a very long piece of narration text that goes on and on without any sentence-ending punctuation to break it up at all';
      const result = summarizeNarration(longText);
      expect(result.length).toBeLessThanOrEqual(103); // 100 chars + '...'
      expect(result.endsWith('...')).toBe(true);
    });

    test('collapses internal whitespace/newlines before summarizing', () => {
      expect(summarizeNarration('I will   check\n\nthe file.')).toBe('I will check the file.');
    });

    test('returns empty string for falsy input', () => {
      expect(summarizeNarration('')).toBe('');
      expect(summarizeNarration(undefined)).toBe('');
    });
  });

  describe('enableThinking threading', () => {
    test('passes enableThinking through to createAgent()', async () => {
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([{ type: 'modelMessageEvent', stopReason: 'endTurn' }]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const executor = buildExecutor();
      await executor.run('test-model', 'prompt', [], [], true);

      expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({ enableThinking: true }));
    });

    test('defaults enableThinking to false when omitted', async () => {
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([{ type: 'modelMessageEvent', stopReason: 'endTurn' }]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const executor = buildExecutor();
      await executor.run('test-model', 'prompt', [], []);

      expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({ enableThinking: false }));
    });
  });

  describe('tool-call status emission (BeforeToolCallEvent / AfterToolCallEvent)', () => {
    test('emits a running status on BeforeToolCallEvent and a done status on AfterToolCallEvent', async () => {
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([{ type: 'modelMessageEvent', stopReason: 'endTurn' }]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const onStatus = jest.fn();
      const executor = buildExecutor({ onStatus });

      // Kick off run() but fire hooks synchronously mid-flight by capturing
      // the agent before the stream resolves — addHook is called before
      // agent.stream() is iterated, so hooks are already registered here.
      const runPromise = executor.run('test-model', 'prompt', [], []);
      // Let the microtask queue advance past the memory-load await and the
      // createAgent()/addHook() calls before firing hooks synchronously.
      await Promise.resolve();
      await Promise.resolve();

      mockAgent._fireHook(FakeBeforeToolCallEvent, { toolUse: { name: 'execute_code', input: {} } });
      expect(onStatus).toHaveBeenCalledWith({ tool: 'execute_code', detail: 'Running code...', state: 'running' });

      mockAgent._fireHook(FakeAfterToolCallEvent, { toolUse: { name: 'execute_code', input: {} }, error: undefined });
      expect(onStatus).toHaveBeenCalledWith({ tool: 'execute_code', state: 'done' });

      await runPromise;
    });

    test('describeToolStart produces readable details for known tools', async () => {
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([{ type: 'modelMessageEvent', stopReason: 'endTurn' }]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const onStatus = jest.fn();
      const executor = buildExecutor({ onStatus });
      const runPromise = executor.run('test-model', 'prompt', [], []);
      await Promise.resolve();
      await Promise.resolve();

      mockAgent._fireHook(FakeBeforeToolCallEvent, { toolUse: { name: 'web', input: { query: 'AWS pricing' } } });
      expect(onStatus).toHaveBeenCalledWith({ tool: 'web', detail: 'Searching: AWS pricing', state: 'running' });

      mockAgent._fireHook(FakeBeforeToolCallEvent, { toolUse: { name: 'activate_skill', input: { name: 'docx' } } });
      expect(onStatus).toHaveBeenCalledWith({ tool: 'activate_skill', detail: 'Loading skill: docx', state: 'running' });

      await runPromise;
    });
  });

  describe('initial status emission', () => {
    test('emits a "Starting up..." status tagged "agent" (not "sandbox" — no real sandbox session starts here)', async () => {
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([{ type: 'modelMessageEvent', stopReason: 'endTurn' }]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const onStatus = jest.fn();
      const executor = buildExecutor({ onStatus });
      await executor.run('test-model', 'prompt', [], []);

      expect(onStatus.mock.calls[0][0]).toEqual({ tool: 'agent', detail: 'Starting up...', state: 'running' });
    });

    test('emits memory loading/loaded statuses when a memory manager is present', async () => {
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([{ type: 'modelMessageEvent', stopReason: 'endTurn' }]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const memory = {
        buildContext: jest.fn(async () => 'some context'),
        saveEvent: jest.fn(async () => {}),
      };
      const onStatus = jest.fn();
      const executor = buildExecutor({ onStatus, memory });
      await executor.run('test-model', 'prompt', [], []);

      expect(onStatus).toHaveBeenCalledWith({ tool: 'memory', detail: 'Loading context...', state: 'running' });
      expect(onStatus).toHaveBeenCalledWith({ tool: 'memory', detail: 'Context loaded', state: 'done' });
    });
  });

  describe('cancellation (cancelSignal)', () => {
    test('passes the abort signal to agent.stream() as cancelSignal', async () => {
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([{ type: 'modelMessageEvent', stopReason: 'endTurn' }]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const controller = new AbortController();
      const executor = buildExecutor({ signal: controller.signal });
      await executor.run('test-model', 'prompt', [], []);

      expect(mockAgent.stream).toHaveBeenCalledWith(expect.anything(), { cancelSignal: controller.signal });
    });

    test('passes cancelSignal: undefined when no signal is configured', async () => {
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue(streamOf([{ type: 'modelMessageEvent', stopReason: 'endTurn' }]));
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const executor = buildExecutor();
      await executor.run('test-model', 'prompt', [], []);

      expect(mockAgent.stream).toHaveBeenCalledWith(expect.anything(), { cancelSignal: undefined });
    });

    test('returns partial text gracefully when the signal aborts mid-stream', async () => {
      const controller = new AbortController();
      const mockAgent = createMockAgent();
      // First turn completes and flushes text, then the user hits Stop; the
      // executor must break out on the next event and return what it has.
      mockAgent.stream.mockReturnValue((async function* () {
        yield { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Partial answer.' } } };
        yield { type: 'modelMessageEvent', stopReason: 'endTurn' };
        controller.abort();
        yield { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'never seen' } } };
      })());
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const onChunk = jest.fn();
      const executor = buildExecutor({ onChunk, signal: controller.signal });
      const result = await executor.run('test-model', 'prompt', [], []);

      expect(result).toBe('Partial answer.');
      expect(onChunk).not.toHaveBeenCalledWith('never seen');
    });

    test('treats a stream that ends on its own after cancellation as a graceful stop', async () => {
      // With cancelSignal the SDK ends the stream itself (stopReason
      // 'cancelled') — no further events, no throw. The executor must not
      // hang or error, and must return the accumulated text.
      const controller = new AbortController();
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue((async function* () {
        yield { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Some text.' } } };
        yield { type: 'modelMessageEvent', stopReason: 'endTurn' };
        controller.abort();
        // Stream ends here, simulating the SDK noticing the signal.
      })());
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const executor = buildExecutor({ signal: controller.signal });
      const result = await executor.run('test-model', 'prompt', [], []);

      expect(result).toBe('Some text.');
    });

    test('swallows an abort-shaped thrown error when the signal is aborted', async () => {
      const controller = new AbortController();
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue((async function* () {
        yield { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Before abort.' } } };
        yield { type: 'modelMessageEvent', stopReason: 'endTurn' };
        controller.abort();
        const err = new Error('Request aborted');
        err.name = 'AbortError';
        throw err;
      })());
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const executor = buildExecutor({ signal: controller.signal });
      const result = await executor.run('test-model', 'prompt', [], []);

      expect(result).toBe('Before abort.');
    });

    test('still rethrows stream errors when the signal is NOT aborted', async () => {
      const controller = new AbortController();
      const mockAgent = createMockAgent();
      mockAgent.stream.mockReturnValue((async function* () {
        yield { type: 'modelMessageEvent', stopReason: 'endTurn' };
        throw new Error('real model failure');
      })());
      mockCreateAgent.mockReturnValue({ agent: mockAgent, dispose: jest.fn() });

      const executor = buildExecutor({ signal: controller.signal });
      await expect(executor.run('test-model', 'prompt', [], [])).rejects.toThrow('real model failure');
    });
  });
});
