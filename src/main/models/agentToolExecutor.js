const { tool, AfterToolCallEvent } = require('@strands-agents/sdk');
const { z } = require('zod');
const { createSwarmTools } = require('./swarmTools');
const { createAgent } = require('./strandsAgentFactory');
const fs = require('fs').promises;
const path = require('path');
const log = require('electron-log/main');

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
      ? `You are a powerful work agent that completes complex, multi-step tasks. You can execute Python code via execute_code, read local files via read_local_file, and save files to the user's filesystem via save_file_locally. After generating any file, you MUST call save_file_locally to deliver it to the user and tell them the full local path where it was saved. Never leave generated files only in the sandbox.${autoBlock}`
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
- You can browse the web using the web tool. Pass a URL to read a page, or a query to search the web. For research: search first, then browse specific result URLs for deeper content.
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
  async run(model, prompt, conversationHistory = [], files = []) {
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
      credentials: this.awsConfig.credentials,
      systemPrompt,
      tools,
      id: `work-${this.sessionId}`,
      onLog: introspectionLog,
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

    // Build the new turn's content (text + any file attachments — oversized
    // documents are uploaded into the sandbox and the model is pointed at
    // them rather than sent as native document blocks; see buildFileContentBlocks()).
    const { buildFileContentBlocks } = require('../utils');
    let newTurnBlocks = [{ text: prompt }];
    if (files.length > 0) {
      const fileBlocks = await buildFileContentBlocks(files, {
        codeInterpreter: this.codeInterpreter,
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
    let iterationCount = 0;
    let aborted = false;

    try {
      for await (const event of agent.stream(userInput)) {
        if (this.signal?.aborted) { aborted = true; break; }

        if (event.type === 'modelStreamUpdateEvent') {
          const inner = event.event;
          if (inner.type === 'modelContentBlockDeltaEvent' && inner.delta?.type === 'textDelta') {
            accumulatedText += inner.delta.text;
            this.onChunk(inner.delta.text);
          }
        } else if (event.type === 'toolResultEvent') {
          iterationCount++;
          if (iterationCount === maxIterations - 2) {
            log.warn(`[work:${this.sessionId}] Approaching iteration soft-limit — model should wrap up soon.`);
          }
        }
      }
    } finally {
      dispose();
      cleanupFileTracking();

      // Save conversation to memory
      if (this.memory && this.sessionId && accumulatedText) {
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
