const { tool, AfterToolCallEvent, BeforeToolCallEvent } = require('@strands-agents/sdk');
const { z } = require('zod');
const { createSwarmTools } = require('./swarmTools');
const { createAgent, isAnthropicModel } = require('./strandsAgentFactory');
const fs = require('fs').promises;
const path = require('path');
const log = require('electron-log/main');

/**
 * Builds a short, human-readable status line for a tool call about to start,
 * derived from the tool name and its input. Falls back to a generic label
 * for tools/inputs this doesn't specifically recognize — the activity log
 * still shows *something* for every tool call rather than nothing.
 */
function describeToolStart(name, input = {}) {
  switch (name) {
    case 'activate_skill':
      return `Loading skill: ${input.name || ''}`.trim();
    case 'execute_code':
      return 'Running code...';
    case 'save_file_locally':
      return input.sandbox_path ? `Saving ${path.basename(input.sandbox_path)}...` : 'Saving file...';
    case 'read_local_file':
      return input.sandbox_path ? `Reading ${path.basename(input.sandbox_path)}...` : 'Reading file...';
    case 'generate_image':
      return 'Generating image...';
    case 'web':
      return input.query ? `Searching: ${input.query}` : (input.url ? `Browsing ${input.url}` : 'Browsing the web...');
    case 'list_directory':
      return input.path ? `Listing ${input.path}` : 'Listing files...';
    default:
      return 'Working...';
  }
}

const NARRATION_SUMMARY_MAX_CHARS = 100;

/**
 * Compresses a model's raw pre-tool-call narration ("I'll check the file
 * first, then generate the report and save it...") down to a short,
 * activity-log-friendly summary. Models front-load the actual intent in the
 * first clause/sentence, so this takes just that — the alternative of
 * showing the full narration verbatim is what made the activity log
 * unreadable for multi-step tasks (paragraphs of raw model reasoning
 * stacking up in the timeline). Deliberately a cheap string heuristic rather
 * than a second LLM call — this is a lightweight progress indicator, not
 * something worth extra latency/cost for.
 */
function summarizeNarration(text) {
  if (!text) return '';
  const trimmed = text.trim().replace(/\s+/g, ' ');
  // First sentence/clause: split on sentence-ending punctuation or newline,
  // take the first non-empty segment.
  const firstSegment = trimmed.split(/(?<=[.!?])\s+|\n+/)[0] || trimmed;
  if (firstSegment.length <= NARRATION_SUMMARY_MAX_CHARS) return firstSegment;
  return `${firstSegment.slice(0, NARRATION_SUMMARY_MAX_CHARS).trimEnd()}...`;
}

/**
 * AgentToolExecutor — runs the Work tab's agent loop on a real Strands Agent.
 *
 * Previously this hand-rolled the Bedrock Converse streaming loop and tool
 * dispatch directly. It now builds a Strands Agent (via strandsAgentFactory,
 * shared with Swarm) and drives it with agent.stream() — so model-call
 * retries, tool-call retries, and introspective logging come from the
 * framework instead of bespoke code, and both Work and Swarm agents behave
 * identically for free.
 */
class AgentToolExecutor {
  constructor({ bedrockClient, awsConfig, skillsManager, codeInterpreterManager, memoryManager, webSearchManager, sessionId, settings, signal, onStatus, onChunk }) {
    this.bedrock = bedrockClient;
    this.awsConfig = awsConfig || {};
    this.skills = skillsManager;
    this.codeInterpreter = codeInterpreterManager;
    this.memory = memoryManager;
    this.webSearchManager = webSearchManager;
    this.sessionId = sessionId;
    this.settings = settings || {};
    this.signal = signal || null;
    this.onStatus = onStatus || (() => {});
    this.onChunk = onChunk || (() => {});
    this._sandboxFiles = new Set();  // track files written to sandbox
    this._savedLocally = new Set();  // track files saved to local filesystem
  }

  async buildSystemPrompt(memoryContext = '') {
    const catalog = this.skills.getCatalog();
    const autoSkills = await this.skills.getAutoActivateSkills();
    const autoBlock = autoSkills.length > 0
      ? `\n\n<active_skills>\n${autoSkills.map(s => `<skill name="${s.name}">\n${s.body}\n</skill>`).join('\n')}\n</active_skills>\n\nThe skills above are always active — follow their instructions automatically without needing to call activate_skill for them.`
      : '';

    const base = catalog.length === 0
      ? `You are a powerful work agent that completes complex, multi-step tasks. You can execute Python code via execute_code, read local files via read_local_file, and save files to the user's filesystem via save_file_locally. After generating any file, you MUST call save_file_locally to deliver it to the user and tell them the full local path where it was saved. Never leave generated files only in the sandbox. For anything involving the internet — searching or reading a web page — you MUST use the web tool exclusively. Never write HTTP requests, scraping code, or search-API calls yourself in execute_code; if the web tool reports it's unavailable, tell the user rather than improvising a workaround in the sandbox.${autoBlock}`
      : `You are a powerful work agent that completes complex, multi-step tasks using tools.

<available_skills>
${catalog.map(s => `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`).join('\n')}
</available_skills>

<instructions>
- When a task matches a skill's description, call activate_skill to load its full instructions before proceeding.
- For document creation tasks (Word, PowerPoint, Excel, PDF), you MUST call activate_skill for the matching skill (docx, pptx, xlsx, pdf) FIRST, then follow its instructions exactly.
- You can execute arbitrary Python code via execute_code for any task — not just skills. Write code to solve problems even when no skill covers the task.
- When the user mentions a local file path in their prompt, use read_local_file to load it into the sandbox before processing.
- When the user provides a working directory, use list_directory to discover files, then read_local_file to load the ones you need.
- After generating files in the sandbox (always save to /tmp/), you MUST call save_file_locally to deliver them to the user's local filesystem. Never leave generated files only in the sandbox.
- After saving a file locally, you MUST tell the user the full local path where the file was saved. Example: "I've saved the document to /Users/name/Documents/report.docx"
- Break complex tasks into steps. Execute code, inspect results, and iterate until the task is complete.
- Do NOT proactively scan or list local directories unless the user explicitly asks you to or provides a working directory. Wait for instructions before exploring the filesystem.
- For ANYTHING involving the internet — searching or reading a web page — you MUST use the web tool exclusively. Pass a URL to read a page, or a query to search the web. For research: search first, then browse specific result URLs for deeper content. Do NOT write HTTP requests, scraping code, or call search APIs yourself in execute_code — that is never an acceptable substitute for the web tool. If the web tool errors because search is unavailable, tell the user and do not try to work around it via the sandbox.
- If a library is missing in the sandbox, install it with pip via execute_code before using it.
- If execute_code returns an error, fix the code and retry. Do NOT give up or describe what you would have done.
- Write ALL document generation code in a SINGLE execute_code call. Do not split across multiple calls unless debugging an error.
</instructions>

<completion_checklist>
Before giving your FINAL response, verify ALL of the following — if any is NO, do it now:
1. Did you generate any file in the sandbox (/tmp/)? If yes, have you called save_file_locally for EACH one?
2. Have you told the user the exact local path of every saved file?
3. If the task was to create a document/report, does it now exist on the user's local filesystem?
4. If execute_code returned an error, did you fix and retry? Never end with a failed code execution.
</completion_checklist>${autoBlock}`;

    return memoryContext
      ? `${base}\n\nYou have persistent memory of past conversations with this user. Use the context below to personalise your responses and recall previous interactions when relevant.\n\n${memoryContext}`
      : base;
  }

  /** activate_skill is Work-tab specific (skills catalog isn't a Swarm concept) — the other 6 tools are shared via createSwarmTools(). */
  _buildActivateSkillTool() {
    return tool({
      name: 'activate_skill',
      description: 'Load full instructions for a skill. Call this before using a skill.',
      inputSchema: z.object({
        name: z.string().describe('The skill name to activate'),
      }),
      callback: async (input) => this._handleActivateSkill(input.name),
    });
  }

  /** Build the full tool list: 6 shared tools (execute_code, save_file_locally, read_local_file, web, generate_image, list_directory) + activate_skill. */
  _buildTools() {
    // swarmTools.js's tool callbacks now always pass a structured
    // {tool, detail, state} object tagged with their own tool name (fixed
    // from a prior bug where this wrapper hardcoded every status/error as
    // tool:'sandbox' — a web search failure, save error, etc. all showed up
    // mislabeled as sandbox activity in the activity log). The string
    // fallback below only guards against a future call site regressing to
    // a bare string; it should never actually be hit in normal operation.
    const onStatus = (msg) => this.onStatus(typeof msg === 'string' ? { tool: 'sandbox', detail: msg, state: 'running' } : msg);
    const tools = createSwarmTools(
      { codeInterpreterManager: this.codeInterpreter, webSearchManager: this.webSearchManager, settings: this.settings, onStatus },
      ['execute_code', 'save_file_locally', 'read_local_file', 'web', 'generate_image', 'list_directory']
    );
    if (this.skills.getCatalog().length > 0) {
      tools.push(this._buildActivateSkillTool());
    }
    return tools;
  }

  /**
   * Run the full agent loop. Returns the final assistant text.
   */
  async run(model, prompt, conversationHistory = [], files = [], enableThinking = false) {
    // Fire immediately so there's no dead air between hitting send and the
    // first sign of activity — memory loading (below) can take a moment on
    // its own, and previously nothing appeared until it resolved. Tagged
    // 'agent', NOT 'sandbox' — no AgentCore Code Interpreter session is
    // actually started here (that only happens lazily, the first time the
    // model calls execute_code — see swarmTools.js). Mislabeling this as
    // 'sandbox' made it look like a real, billable sandbox session spins up
    // on every single message even when the model never touches execute_code.
    this.onStatus({ tool: 'agent', detail: 'Starting up...', state: 'running' });

    // Load memory context if available
    let memoryContext = '';
    if (this.memory && this.sessionId) {
      try {
        this.onStatus({ tool: 'memory', detail: 'Loading context...', state: 'running' });
        memoryContext = await this.memory.buildContext(this.sessionId, prompt);
        this.onStatus({ tool: 'memory', detail: 'Context loaded', state: 'done' });
      } catch (err) {
        log.warn('[work] Memory load failed:', err.message);
      }
    }

    const systemPrompt = await this.buildSystemPrompt(memoryContext);
    const tools = this._buildTools();

    const introspectionLog = (entry) => {
      const label = entry.source === 'model' ? 'model call' : `tool "${entry.name}"`;
      log.info(`[work:${this.sessionId}] ${label} attempt ${entry.attempt} failed: ${entry.error} (retried=${entry.retried})`);
      if (entry.retried) {
        this.onStatus({ tool: entry.source === 'model' ? 'model' : entry.name, detail: `Recovering from transient error (attempt ${entry.attempt})...`, state: 'running' });
      }
    };

    const { agent, dispose } = createAgent({
      modelId: model,
      region: this.awsConfig.region,
      mantleApiKey: this.settings?.mantleApiKey,
      systemPrompt,
      tools,
      id: `work-${this.sessionId}`,
      onLog: introspectionLog,
      enableThinking,
    });

    // Track sandbox-written / locally-saved files for the auto-save-to-Downloads
    // safety net. AfterToolCallEvent reliably exposes the tool name + exact input
    // args (unlike the raw stream events), so this hook is the source of truth.
    const cleanupFileTracking = agent.addHook(AfterToolCallEvent, (event) => {
      if (event.error) return;
      const { name, input } = event.toolUse;
      if (name === 'execute_code') {
        const outputText = event.result?.content?.map(c => c.text || '').join('\n') || '';
        const tmpMatches = `${input.code || ''}\n${outputText}`.match(/\/tmp\/[\w.\-]+/g) || [];
        tmpMatches.forEach(f => this._sandboxFiles.add(f));
      }
      if (name === 'save_file_locally' && typeof input.sandbox_path === 'string') {
        this._savedLocally.add(input.sandbox_path);
      }
      if (name === 'read_local_file' && typeof input.sandbox_path === 'string') {
        // Input files already exist locally (user provided them) — skip auto-save to Downloads
        this._savedLocally.add(input.sandbox_path);
      }
    });

    // Surface every tool call in the activity log as it starts (BeforeToolCallEvent
    // fires before execution) and mark it done when AfterToolCallEvent fires. Without
    // this, the only visible activity between "Context loaded" and the final answer
    // was whatever swarmTools' own onStatus happened to emit (sandbox cold-start only) —
    // multi-step turns (skill activation -> code execution -> file save) looked silent.
    const cleanupToolStatus = agent.addHook(BeforeToolCallEvent, (event) => {
      const { name, input } = event.toolUse;
      this.onStatus({ tool: name, detail: describeToolStart(name, input), state: 'running' });
    });
    const cleanupToolStatusDone = agent.addHook(AfterToolCallEvent, (event) => {
      this.onStatus({ tool: event.toolUse.name, state: 'done' });
    });

    // Build the new turn's content (text + any file attachments — oversized
    // documents are uploaded into the sandbox and the model is pointed at
    // them rather than sent as native document blocks; see buildFileContentBlocks()).
    const { buildFileContentBlocks } = require('../utils');
    let newTurnBlocks = [{ text: prompt }];
    if (files.length > 0) {
      const fileBlocks = await buildFileContentBlocks(files, {
        codeInterpreter: this.codeInterpreter,
        isAnthropicModel: isAnthropicModel(model),
        // This is the PERSISTENT per-conversation sandbox — if file prep is
        // what starts it, it must get the same 2h lifetime the tools use
        // (swarmTools.js startSession(7200)), not the 5-minute default that
        // Chat's throwaway session uses. Previously this was left at 300s,
        // so a conversation whose first message had an attachment got a
        // sandbox that died 5 minutes in — every later execute_code failed
        // with "ValidationException: ... session is not active".
        sessionTimeout: 7200,
      });
      newTurnBlocks = [...newTurnBlocks, ...fileBlocks];
    }

    // Each invocation constructs a fresh Agent (createAgent() above), so it
    // has no memory of prior turns on its own — conversationHistory (the
    // renderer's own message list for this session) is what supplies that.
    // Capped to a sliding window since it's otherwise unbounded (this is the
    // within-session equivalent of AgentCore's own default truncation
    // strategy for managed conversations). Long-term facts/preferences come
    // from AgentCore Memory instead (see buildContext() above), which stays
    // bounded via topK regardless of session length.
    const MAX_HISTORY_MESSAGES = 20;
    const trimmedHistory = conversationHistory.slice(-MAX_HISTORY_MESSAGES);

    // agent.stream()'s MessageData[] variant runs each message through
    // Message.fromMessageData(), which itself converts plain content block
    // data (e.g. {text}, {document: {...}}) into real ContentBlock instances
    // via contentBlockFromData() — so newTurnBlocks must stay as plain data
    // here (matching buildFileContentBlocks()'s raw output and the history
    // messages' own shape), NOT be pre-converted, or DocumentBlock instances
    // get passed back through that conversion a second time and misclassified.
    const userInput = [
      ...trimmedHistory,
      { role: 'user', content: newTurnBlocks },
    ];

    const maxIterations = 30;
    let accumulatedText = '';
    // Text deltas are buffered per model-turn rather than flushed to onChunk
    // immediately, because whether this turn's text is the real answer or
    // just narration ("I'll check the file, then...") before a tool call is
    // only known once the turn ends (modelMessageEvent.stopReason). Turns
    // ending in 'toolUse' get routed to the activity log as a 'thinking'
    // entry (summarized, not verbatim) instead of the chat bubble.
    let turnText = '';
    let turnReasoning = '';
    // Tracks whether the static "Reasoning..." status has already been sent
    // for the reasoning block currently in progress, so repeated deltas
    // don't spam the activity log with one entry/append per token — raw
    // chain-of-thought is not meant for end-user display anyway.
    let reasoningStatusSent = false;
    let iterationCount = 0;
    let aborted = false;

    try {
      // cancelSignal gives the SDK real cancellation: it aborts the in-flight
      // model HTTP request and stops at built-in checkpoints (between loop
      // cycles, during model streaming, and between tool calls), ending the
      // stream gracefully with stopReason 'cancelled'. The in-loop aborted
      // check below is kept only as a cheap fallback for the window between
      // an event arriving and the SDK noticing the signal.
      for await (const event of agent.stream(userInput, { cancelSignal: this.signal ?? undefined })) {
        if (this.signal?.aborted) { aborted = true; break; }

        if (event.type === 'modelStreamUpdateEvent') {
          const inner = event.event;
          if (inner.type === 'modelContentBlockDeltaEvent') {
            if (inner.delta?.type === 'textDelta') {
              turnText += inner.delta.text;
            } else if (inner.delta?.type === 'reasoningContentDelta' && inner.delta.text) {
              // Extended thinking/reasoning tokens — normalized to the same
              // shape by the SDK for both Bedrock (Anthropic) and OpenAI
              // (Mantle Responses API) providers. The raw reasoning text is
              // NOT streamed to the UI (that's what made the activity log
              // unreadable) — only a single static "Reasoning..." status is
              // emitted the first time this block starts producing text.
              // Still buffered internally in case it's useful for debug logs.
              turnReasoning += inner.delta.text;
              if (!reasoningStatusSent) {
                reasoningStatusSent = true;
                this.onStatus({ tool: 'thinking', detail: 'Reasoning...', state: 'running' });
              }
            }
          }
        } else if (event.type === 'modelMessageEvent') {
          if (event.stopReason === 'toolUse') {
            // This turn's text was the model narrating its next step, not
            // the final answer — surface a short summary as a distinct
            // activity-log entry rather than the full text, and rather than
            // merging it into the chat bubble.
            const summary = summarizeNarration(turnText);
            if (summary) {
              this.onStatus({ tool: 'thinking', detail: summary, state: 'done' });
            } else if (reasoningStatusSent) {
              // No narration text, but reasoning did occur this turn — close
              // out the "Reasoning..." entry so it doesn't stay stuck running.
              this.onStatus({ tool: 'thinking', state: 'done' });
            }
          } else if (turnText) {
            // Real answer content (endTurn, or any other terminal reason) —
            // this is what actually reaches the chat bubble.
            accumulatedText += turnText;
            this.onChunk(turnText);
          } else if (reasoningStatusSent) {
            this.onStatus({ tool: 'thinking', state: 'done' });
          }
          turnText = '';
          turnReasoning = '';
          reasoningStatusSent = false;
        } else if (event.type === 'toolResultEvent') {
          iterationCount++;
          if (iterationCount === maxIterations - 2) {
            log.warn(`[work:${this.sessionId}] Approaching iteration soft-limit — model should wrap up soon.`);
          }
        }
      }
    } catch (err) {
      // With cancelSignal the stream normally ends gracefully (stopReason
      // 'cancelled'), but some abort paths — e.g. an AWS SDK call inside a
      // tool aborted via abortSignal — surface as a thrown AbortError
      // instead. If the user requested the stop, treat it as a graceful
      // stop rather than bubbling an error to the renderer.
      if (!this.signal?.aborted) throw err;
      log.info(`[work:${this.sessionId}] Run cancelled by user (${err.name || err.message})`);
    } finally {
      // The stream can also end on its own when cancelled (no event after
      // the signal fires), so derive the final aborted state from the
      // signal itself rather than only the in-loop break.
      if (this.signal?.aborted) aborted = true;
      dispose();
      cleanupFileTracking();
      cleanupToolStatus();
      cleanupToolStatusDone();

      // Save conversation to memory — but never a cancelled turn.
      //
      // AgentCore Memory is durable and cross-conversation, so writing an
      // interrupted run recorded a truncated reply as though it were a complete
      // one: buildContext() would then feed the abandoned attempt back into
      // every later turn, and nothing local could unwrite it. A turn the user
      // stopped is not something the agent should remember happening.
      if (this.memory && this.sessionId && accumulatedText && !aborted) {
        try {
          await this.memory.saveEvent(this.sessionId, [
            { role: 'user', content: prompt },
            { role: 'assistant', content: accumulatedText },
          ]);
        } catch (err) {
          log.warn('[work] Memory save failed:', err.message);
        }
      }

      // Auto-save any sandbox files the agent forgot to save locally
      const unsaved = [...this._sandboxFiles].filter(f => !this._savedLocally.has(f));
      if (unsaved.length > 0 && this.codeInterpreter.sessionId) {
        const downloadsDir = require('os').homedir() + '/Downloads';
        const autoSaved = [];
        for (const sandboxPath of unsaved) {
          try {
            const filename = path.basename(sandboxPath);
            const localPath = path.join(downloadsDir, filename);
            const base64 = await this.codeInterpreter.readFileBase64(sandboxPath);
            const buffer = Buffer.from(base64, 'base64');
            await fs.mkdir(downloadsDir, { recursive: true });
            await fs.writeFile(localPath, buffer);
            autoSaved.push(localPath);
          } catch { /* file may not exist, skip */ }
        }
        if (autoSaved.length > 0) {
          const notice = `\n\n⚠️ The following files were auto-saved to your Downloads folder:\n${autoSaved.map(p => `- ${p}`).join('\n')}`;
          this.onChunk(notice);
          accumulatedText += notice;
        }
      }
    }

    if (aborted) return accumulatedText;

    if (iterationCount >= maxIterations) {
      const exhaustionMsg = '\n\n⚠️ I ran out of steps before finishing. Please send a follow-up message and I\'ll continue where I left off.';
      this.onChunk(exhaustionMsg);
      accumulatedText += exhaustionMsg;
    }

    return accumulatedText;
  }

  async _handleActivateSkill(name) {
    if (this.skills.isActivated(name)) {
      return `Skill "${name}" is already activated in this session.`;
    }

    const body = await this.skills.getSkillBody(name);
    if (!body) return JSON.stringify({ error: `Skill not found: ${name}` });

    this.skills.markActivated(name);
    const resources = await this.skills.listResources(name);
    const dir = this.skills.getSkillDir(name);

    let wrapped = `<skill_content name="${name}">\n${body}\n\nSkill directory: ${dir}`;
    if (resources.length > 0) {
      wrapped += `\n\n<skill_resources>\n${resources.map(r => `  <file>${r}</file>`).join('\n')}\n</skill_resources>`;
    }
    wrapped += '\n</skill_content>';
    return wrapped;
  }
}

module.exports = AgentToolExecutor;
// Exposed for unit testing the pure helper functions in isolation — the
// primary export remains the class itself so existing `require(...)` call
// sites (e.g. ipc/agent.js) are unaffected.
module.exports.summarizeNarration = summarizeNarration;
module.exports.describeToolStart = describeToolStart;
