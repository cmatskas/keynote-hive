/**
 * SwarmOrchestrator — runs multi-agent pipelines using Strands Graph pattern.
 * Handles checkpoint persistence, quality gate loops, autonomy modes, and IPC streaming.
 */
const { Agent, BedrockModel, tool } = require('@strands-agents/sdk');
const { z } = require('zod');
const { createSwarmTools } = require('./swarmTools');
const { evaluate, decide, buildRubricPrompt, parseJudgeResponse } = require('./rubricEvaluator');
const { BedrockRuntimeClient, ConverseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');
const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const log = require('electron-log/main');

class SwarmOrchestrator {
  constructor({ awsConfig, skillsManager, codeInterpreterManager, webSearchManager, settings, onEvent }) {
    this.awsConfig = awsConfig;
    this.skills = skillsManager;
    this.codeInterpreter = codeInterpreterManager;
    this.webSearchManager = webSearchManager;
    this.settings = settings;
    this.onEvent = onEvent || (() => {});
    this.runs = new Map();
    this.runsDir = path.join(app.getPath('userData'), 'swarm-runs');
    this._pendingInput = new Map();
  }

  async runPipeline(swarmId, template, brief, autonomyMode, files) {
    log.info(`[swarm:${swarmId}] Starting pipeline "${template.name}" (${template.agents.length} agents, mode=${autonomyMode})`);
    const state = {
      swarmId, status: 'running', autonomyMode,
      templateId: template.id, templateName: template.name,
      startedAt: new Date().toISOString(),
      agents: template.agents.map(a => ({ id: a.id, label: a.label, status: 'pending', output: null })),
      currentIndex: 0, brief, retries: {},
    };
    this.runs.set(swarmId, { aborted: false, state });

    try {
      await this._ensureDir(path.join(this.runsDir, swarmId));

      // Resume from persisted state if available
      try {
        const persisted = JSON.parse(await fs.readFile(path.join(this.runsDir, swarmId, 'state.json'), 'utf8'));
        state.retries = persisted.retries || {};
      } catch { /* fresh run */ }

      // Adaptive learning: gather historical feedback + adapt rubric to brief
      const historicalFeedback = await this._getHistoricalFeedback(template.id);
      const adaptedRubric = template.rubric ? await this._adaptRubric(template.rubric, brief) : null;

      // Upload attached files to sandbox
      let fileContext = '';
      if (files && files.length > 0) {
        await this._uploadFilesToSandbox(files, swarmId);
        fileContext = `\n\nAttached files available in the sandbox at /tmp/:\n${files.map(f => `- /tmp/${f.name}${f.isDir ? ' (workspace directory)' : ''}`).join('\n')}`;
      }

      let previousOutput = brief + fileContext;

      for (let i = 0; i < template.agents.length; i++) {
        if (this.runs.get(swarmId)?.aborted) { state.status = 'cancelled'; break; }

        const agentConfig = template.agents[i];
        state.currentIndex = i;
        state.agents[i].status = 'running';
        this.onEvent('swarm-agent-started', { swarmId, agentIndex: i, role: agentConfig.id, label: agentConfig.label });
        log.info(`[swarm:${swarmId}] Agent ${i}/${template.agents.length - 1} started: ${agentConfig.id} (${agentConfig.label})`);

        // Check for checkpoint resume
        const checkpointFile = path.join(this.runsDir, swarmId, `agent-${i}-output.md`);
        try {
          const saved = await fs.readFile(checkpointFile, 'utf8');
          state.agents[i].status = 'done';
          state.agents[i].output = saved;
          previousOutput = saved;
          this.onEvent('swarm-agent-done', { swarmId, agentIndex: i, output: saved });
          continue;
        } catch { /* no checkpoint, run agent */ }

        try {
          // Route video-capable agents through the multimodal path
          const videoFiles = (files || []).filter(f => /\.(mp4|mov|mkv|webm|avi|flv|mpeg|mpg|wmv|3gp)$/i.test(f.name || f.path));
          const useVideoPath = agentConfig.supportsVideo && videoFiles.length > 0;

          let output = useVideoPath
            ? await this._runVideoAnalysisAgent(swarmId, agentConfig, previousOutput, brief, i, videoFiles)
            : await this._runAgent(swarmId, agentConfig, previousOutput, brief, i, adaptedRubric || template.rubric, historicalFeedback);

          // Extract keyframes after video analysis
          if (useVideoPath && output) {
            const frameManifest = await this._extractVideoFrames(swarmId, i, videoFiles);
            if (frameManifest) output += '\n\n' + frameManifest;
          }

          // Quality gate loop
          if (agentConfig.isQualityGate) {
            const rubric = template.rubric;
            const retryKey = agentConfig.id;
            const maxRetries = agentConfig.maxRetries || 2;
            const attempts = (state.retries[retryKey] || 0);

            if (rubric) {
              // ── Rubric-based evaluation ──
              // The quality gate agent was given a rubric prompt; parse its JSON scores
              const scores = parseJudgeResponse(output);
              if (scores) {
                const result = evaluate(rubric.criteria, scores, rubric);
                const decision = decide(result.score, { threshold: rubric.threshold, minPass: rubric.minPass, attempt: attempts, maxRetries });

                // Persist rubric scores in state for observability
                if (!state.rubric_scores) state.rubric_scores = {};
                if (!state.rubric_scores[retryKey]) state.rubric_scores[retryKey] = [];
                state.rubric_scores[retryKey].push({ attempt: attempts, score: result.score, axis_scores: result.axis_scores, decision });

                if (decision === 'REVISE' && i >= 2) {
                  log.info(`[swarm:${swarmId}] Quality gate REVISE (score=${result.score.toFixed(2)}, attempt=${attempts + 1}/${maxRetries})`);
                  state.retries[retryKey] = attempts + 1;
                  const feedback = result.failing.map(f =>
                    `${f.isPenalty ? 'PENALTY' : 'FAILED'}: "${f.text}" — ${f.reason}`
                  ).join('\n');
                  const prevAgent = template.agents[i - 1];
                  state.agents[i].status = 'pending';
                  state.agents[i - 1].status = 'running';
                  this.onEvent('swarm-agent-started', { swarmId, agentIndex: i - 1, role: prevAgent.id, label: `${prevAgent.label} (revision ${attempts + 1})` });
                  const revised = await this._runAgent(swarmId, prevAgent, previousOutput + '\n\nREVISION FEEDBACK (score: ' + result.score.toFixed(2) + '):\n' + feedback, brief, i - 1);
                  state.agents[i - 1].output = revised;
                  await this._saveCheckpoint(swarmId, i - 1, revised);
                  this.onEvent('swarm-agent-done', { swarmId, agentIndex: i - 1, output: revised });
                  previousOutput = revised;
                  i--;
                  continue;
                } else if (decision === 'FAIL') {
                  log.error(`[swarm:${swarmId}] Quality gate FAIL (score=${result.score.toFixed(2)}, threshold=${rubric.minPass})`);
                  state.agents[i].status = 'error';
                  state.status = 'error';
                  this.onEvent('swarm-error', { swarmId, error: `Quality gate failed (score: ${result.score.toFixed(2)}, threshold: ${rubric.minPass})`, agentIndex: i });
                  await this._saveState(swarmId, state);
                  return;
                }
                // PASS or PASS_WITH_RESERVATIONS — continue
              }
              // If JSON parsing failed, fall through to legacy string parsing
              else {
                const trimmed = output.trimStart();
                if (trimmed.startsWith('REVISE:') || trimmed.startsWith('REVISE\n')) {
                  previousOutput = trimmed.replace(/^REVISE:?\s*/, '').trim() || previousOutput;
                } else {
                  previousOutput = trimmed.replace(/^PASS\s*/, '').trim() || previousOutput;
                }
              }
            } else {
              // ── Legacy string-based evaluation (no rubric defined) ──
              const trimmed = output.trimStart();
              if (trimmed.startsWith('REVISE:') || trimmed.startsWith('REVISE\n')) {
                state.retries[retryKey] = attempts + 1;
                if (attempts + 1 < maxRetries && i >= 2) {
                  const feedback = trimmed.replace(/^REVISE:?\s*/, '').trim();
                  const prevAgent = template.agents[i - 1];
                  state.agents[i].status = 'pending';
                  state.agents[i - 1].status = 'running';
                  this.onEvent('swarm-agent-started', { swarmId, agentIndex: i - 1, role: prevAgent.id, label: `${prevAgent.label} (revision ${attempts + 1})` });
                  const revised = await this._runAgent(swarmId, prevAgent, previousOutput + '\n\nREVISION FEEDBACK:\n' + feedback, brief, i - 1);
                  state.agents[i - 1].output = revised;
                  await this._saveCheckpoint(swarmId, i - 1, revised);
                  this.onEvent('swarm-agent-done', { swarmId, agentIndex: i - 1, output: revised });
                  previousOutput = revised;
                  i--;
                  continue;
                }
                previousOutput = trimmed.replace(/^REVISE:?\s*/, '').trim() || previousOutput;
              } else {
                previousOutput = trimmed.replace(/^PASS\s*/, '').trim() || previousOutput;
              }
            }
          } else {
            if (output) previousOutput = output;
          }

          // Verify formatter agents actually saved a file locally — retry on failure, fail pipeline if exhausted
          if (agentConfig.id === 'formatter' && output) {
            const maxFormatterRetries = agentConfig.maxRetries || 2;
            let saved = await this._verifyLocalSave(swarmId, i, output);
            let formatterAttempts = 0;

            while (!saved && formatterAttempts < maxFormatterRetries) {
              formatterAttempts++;
              log.warn(`[swarm:${swarmId}] Formatter did not save a file (attempt ${formatterAttempts}/${maxFormatterRetries}), retrying`);
              this.onEvent('swarm-agent-chunk', { swarmId, agentIndex: i, chunk: `\n🔁 Retrying formatter (attempt ${formatterAttempts}/${maxFormatterRetries})...\n` });
              const retryInput = previousOutput + '\n\nIMPORTANT: Your previous attempt did NOT save a file. You MUST call execute_code to build the file, then call save_file_locally with the exact sandbox_path and local_path. Do not describe the steps — execute them now.';
              output = await this._runAgent(swarmId, agentConfig, retryInput, brief, i, adaptedRubric || template.rubric, historicalFeedback);
              saved = await this._verifyLocalSave(swarmId, i, output);
            }

            if (!saved) {
              log.error(`[swarm:${swarmId}] Formatter agent ${i} (${agentConfig.id}) failed to save a file after ${maxFormatterRetries} retries`);
              state.agents[i].status = 'error';
              state.status = 'error';
              this.onEvent('swarm-error', { swarmId, error: `Formatter did not produce a file after ${maxFormatterRetries} retries. No output asset was generated.`, agentIndex: i });
              await this._saveState(swarmId, state);
              return;
            }
            previousOutput = output + `\n\n✅ File verified at: ${saved}`;
          }

          state.agents[i].status = 'done';
          state.agents[i].output = previousOutput;
          await this._saveCheckpoint(swarmId, i, previousOutput);
          this.onEvent('swarm-agent-done', { swarmId, agentIndex: i, output: previousOutput });

          // Review point pause
          if (agentConfig.reviewPoint && autonomyMode !== 'autonomous') {
            state.status = 'paused';
            await this._saveState(swarmId, state);
            this.onEvent('swarm-review-pause', { swarmId, agentIndex: i, output: previousOutput });
            const edited = await this._waitForContinue(swarmId);
            if (edited !== null) previousOutput = edited;
            state.status = 'running';
          }
        } catch (err) {
          log.error(`[swarm:${swarmId}] Agent ${i} (${agentConfig.id}) failed: ${err.message}`);
          state.agents[i].status = 'error';
          state.status = 'error';
          this.onEvent('swarm-error', { swarmId, error: err.message, agentIndex: i });
          await this._saveState(swarmId, state);
          return;
        }

        await this._saveState(swarmId, state);
      }

      if (state.status !== 'cancelled') state.status = 'completed';
      state.completedAt = new Date().toISOString();
      log.info(`[swarm:${swarmId}] Pipeline ${state.status} (${template.agents.length} agents, retries=${JSON.stringify(state.retries)})`);
      await this._saveState(swarmId, state);
      // Clean up checkpoint files — state.json has all we need for analytics
      this._cleanupOutputFiles(swarmId).catch(() => {});
      this._pruneOldRuns().catch(() => {});
      this.onEvent('swarm-pipeline-done', { swarmId, finalOutput: previousOutput });
    } catch (err) {
      state.status = 'error';
      this.onEvent('swarm-error', { swarmId, error: err.message, agentIndex: state.currentIndex });
    }
  }

  async _runAgent(swarmId, agentConfig, input, brief, agentIndex, rubric, historicalFeedback) {
    // Load skill bodies for this agent
    const skillBodies = [];
    for (const skillName of (agentConfig.skills || [])) {
      const body = await this.skills.getSkillBody(skillName);
      if (body) skillBodies.push({ name: skillName, body });
    }

    const skillBlock = skillBodies.length > 0
      ? `\n\n<active_skills>\n${skillBodies.map(s => `<skill name="${s.name}">\n${s.body}\n</skill>`).join('\n')}\n</active_skills>`
      : '';

    // Inject historical feedback for writer/editor agents (not quality gates, not researcher/planner/formatter)
    const feedbackBlock = (historicalFeedback && ['writer', 'editor'].includes(agentConfig.id))
      ? `\n\n${historicalFeedback}`
      : '';

    // For rubric-based quality gates, use the structured rubric prompt
    const basePrompt = (agentConfig.isQualityGate && rubric)
      ? buildRubricPrompt(rubric.criteria, brief)
      : agentConfig.prompt;

    const systemPrompt = `${basePrompt}\n\n<user_brief>\n${brief}\n</user_brief>${skillBlock}${feedbackBlock}`;

    // User message is just the previous agent's output — brief is in system prompt
    const handoff = input === brief
      ? 'Begin your task based on the user brief in your system prompt.'
      : `<previous_agent_output>\n${input}\n</previous_agent_output>\n\nBuild on the above output. The original user brief is in your system prompt.`;

    // Build tools — platform tools from template config + request_input for non-quality-gate agents
    const tools = createSwarmTools(
      { codeInterpreterManager: this.codeInterpreter, webSearchManager: this.webSearchManager, settings: this.settings, onStatus: (msg) => this.onEvent('swarm-agent-chunk', { swarmId, agentIndex, chunk: `\n🔧 ${msg}\n` }) },
      agentConfig.tools || []
    );

    if (!agentConfig.isQualityGate) {
      const self = this;
      const sid = swarmId;
      const idx = agentIndex;
      const mode = this.runs.get(swarmId)?.state?.autonomyMode || 'guided';

      tools.push(tool({
        name: 'request_input',
        description: 'Ask the user a question when you encounter ambiguity that significantly changes the output. Include a default choice for autonomous mode.',
        inputSchema: z.object({
          question: z.string(),
          options: z.array(z.string()).optional(),
          default_choice: z.string(),
          risk_if_wrong: z.enum(['low', 'medium', 'high']),
        }),
        callback: async (inp) => {
          if (mode === 'autonomous' || (mode === 'guided' && inp.risk_if_wrong !== 'high')) {
            self.onEvent('swarm-agent-chunk', { swarmId: sid, agentIndex: idx, chunk: `\n⚡ Auto-resolved: "${inp.question}" → ${inp.default_choice}\n` });
            return inp.default_choice;
          }
          self.onEvent('swarm-input-request', { swarmId: sid, agentIndex: idx, ...inp });
          return await self._waitForInput(sid);
        },
      }));
    }

    const model = new BedrockModel({
      modelId: agentConfig.model,
      clientConfig: {
        region: this.awsConfig.region,
        credentials: this.awsConfig.credentials,
      },
    });

    const agent = new Agent({ model, systemPrompt, tools, id: agentConfig.id });

    let fullText = '';
    for await (const event of agent.stream(handoff)) {
      if (this.runs.get(swarmId)?.aborted) throw new Error('Pipeline cancelled');
      if (event.type === 'modelStreamUpdateEvent') {
        const inner = event.event;
        if (inner.type === 'modelContentBlockDeltaEvent' && inner.delta?.type === 'textDelta') {
          fullText += inner.delta.text;
          this.onEvent('swarm-agent-chunk', { swarmId, agentIndex, chunk: inner.delta.text });
        }
      }
    }
    return fullText;
  }

  // ── Pause/Resume ──────────────────────────────────────

  _waitForContinue(swarmId) {
    return new Promise(resolve => { this._pendingInput.set(swarmId, { resolve }); });
  }

  continueAfterReview(swarmId, editedOutput) {
    const pending = this._pendingInput.get(swarmId);
    if (pending) { pending.resolve(editedOutput); this._pendingInput.delete(swarmId); }
  }

  _waitForInput(swarmId) {
    return new Promise(resolve => { this._pendingInput.set(`${swarmId}-input`, { resolve }); });
  }

  answerInput(swarmId, answer) {
    const pending = this._pendingInput.get(`${swarmId}-input`);
    if (pending) { pending.resolve(answer); this._pendingInput.delete(`${swarmId}-input`); }
  }

  cancel(swarmId) {
    const run = this.runs.get(swarmId);
    if (run) run.aborted = true;
    // Resolve any pending waits for this specific swarm
    const keysToResolve = [swarmId, `${swarmId}-input`];
    for (const key of keysToResolve) {
      const pending = this._pendingInput.get(key);
      if (pending) { pending.resolve(null); this._pendingInput.delete(key); }
    }
  }

  // ── Persistence ───────────────────────────────────────

  async _saveCheckpoint(swarmId, agentIndex, output) {
    const dir = path.join(this.runsDir, swarmId);
    await this._ensureDir(dir);
    await fs.writeFile(path.join(dir, `agent-${agentIndex}-output.md`), output, 'utf8');
  }

  async _saveState(swarmId, state) {
    const dir = path.join(this.runsDir, swarmId);
    await this._ensureDir(dir);
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
  }

  async _ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
  }

  async _cleanupOutputFiles(swarmId) {
    const dir = path.join(this.runsDir, swarmId);
    const files = await fs.readdir(dir);
    for (const f of files) {
      if (f.endsWith('-output.md')) await fs.unlink(path.join(dir, f)).catch(() => {});
    }
  }

  async _pruneOldRuns(maxRuns = 50) {
    try {
      const dirs = await fs.readdir(this.runsDir);
      if (dirs.length <= maxRuns) return;
      const sorted = dirs.sort();
      const toDelete = sorted.slice(0, sorted.length - maxRuns);
      for (const dir of toDelete) {
        const full = path.join(this.runsDir, dir);
        await fs.rm(full, { recursive: true, force: true }).catch(() => {});
      }
      log.info(`[swarm] Pruned ${toDelete.length} old run(s)`);
    } catch { /* runsDir may not exist */ }
  }

  // ── Adaptive Learning ─────────────────────────────────

  async _runVideoAnalysisAgent(swarmId, agentConfig, input, brief, agentIndex, videoFiles) {
    const fsLocal = require('fs').promises;
    const MODELS = require('./pipelineTemplates').MODELS;
    const modelId = MODELS[agentConfig.model] || agentConfig.model;

    // Load skills
    const skillBodies = [];
    for (const skillName of (agentConfig.skills || [])) {
      const body = await this.skills.getSkillBody(skillName);
      if (body) skillBodies.push({ name: skillName, body });
    }
    const skillBlock = skillBodies.length > 0
      ? `\n\n<active_skills>\n${skillBodies.map(s => `<skill name="${s.name}">\n${s.body}\n</skill>`).join('\n')}\n</active_skills>`
      : '';

    const systemPrompt = `${agentConfig.prompt}\n\n<user_brief>\n${brief}\n</user_brief>${skillBlock}`;

    // Build content blocks: video(s) + text
    const content = [];
    for (const vf of videoFiles) {
      try {
        const stat = await fsLocal.stat(vf.path);
        const ext = vf.path.split('.').pop().toLowerCase();
        const formatMap = { mp4: 'mp4', mov: 'mov', mkv: 'mkv', webm: 'webm', avi: 'avi', flv: 'flv', mpeg: 'mpeg', mpg: 'mpg', wmv: 'wmv', '3gp': 'three_gp' };
        const format = formatMap[ext] || 'mp4';

        if (stat.size <= 25 * 1024 * 1024) {
          // Direct upload (≤25MB)
          const bytes = await fsLocal.readFile(vf.path);
          content.push({ video: { format, source: { bytes } } });
          this.onEvent('swarm-agent-chunk', { swarmId, agentIndex, chunk: `\n🎬 Analyzing video: ${vf.name} (${(stat.size / 1024 / 1024).toFixed(1)}MB direct)\n` });
        } else {
          // S3 upload for large videos
          const s3Uri = await this._uploadVideoToS3(vf.path, swarmId);
          if (s3Uri) {
            content.push({ video: { format, source: { s3Location: { uri: s3Uri } } } });
            this.onEvent('swarm-agent-chunk', { swarmId, agentIndex, chunk: `\n🎬 Analyzing video: ${vf.name} (${(stat.size / 1024 / 1024).toFixed(1)}MB via S3)\n` });
          }
        }
      } catch (err) {
        this.onEvent('swarm-agent-chunk', { swarmId, agentIndex, chunk: `\n⚠️ Failed to load video ${vf.name}: ${err.message}\n` });
      }
    }

    content.push({ text: input === brief
      ? 'Analyze the attached video and produce a structured analysis brief based on your system prompt.'
      : `<previous_agent_output>\n${input}\n</previous_agent_output>\n\nAnalyze the attached video in context of the above.`
    });

    // Call Bedrock Converse API directly (Strands doesn't support video content blocks)
    const client = new BedrockRuntimeClient({
      region: this.awsConfig.region,
      credentials: this.awsConfig.credentials,
    });

    let fullText = '';
    try {
      const response = await client.send(new ConverseStreamCommand({
        modelId,
        system: [{ text: systemPrompt }],
        messages: [{ role: 'user', content }],
        inferenceConfig: { maxTokens: 4096 },
      }));

      for await (const event of response.stream) {
        if (this.runs.get(swarmId)?.aborted) throw new Error('Pipeline cancelled');
        if (event.contentBlockDelta?.delta?.text) {
          fullText += event.contentBlockDelta.delta.text;
          this.onEvent('swarm-agent-chunk', { swarmId, agentIndex, chunk: event.contentBlockDelta.delta.text });
        }
      }
    } catch (err) {
      this.onEvent('swarm-agent-chunk', { swarmId, agentIndex, chunk: `\n⚠️ Video analysis error: ${err.message}\n` });
    }

    return fullText;
  }

  async _uploadVideoToS3(filePath, swarmId) {
    try {
      const fsLocal = require('fs').promises;
      const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
      const s3 = new S3Client({ region: this.awsConfig.region, credentials: this.awsConfig.credentials });
      const bucket = this.settings?.bucketName;
      if (!bucket) {
        this.onEvent('swarm-agent-chunk', { swarmId, agentIndex: 0, chunk: '\n⚠️ No S3 bucket configured for large video upload. Configure in Settings → Configuration.\n' });
        return null;
      }
      const key = `swarm-temp/${swarmId}/${require('path').basename(filePath)}`;
      const body = await fsLocal.readFile(filePath);
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
      return `s3://${bucket}/${key}`;
    } catch (err) {
      this.onEvent('swarm-agent-chunk', { swarmId, agentIndex: 0, chunk: `\n⚠️ S3 upload failed: ${err.message}\n` });
      return null;
    }
  }

  async _verifyLocalSave(swarmId, agentIndex, output) {
    try {
      const fsLocal = require('fs').promises;
      const os = require('os');
      const home = os.homedir();
      // Look for ~/Documents/Hive/*.docx or *.pptx in the output
      const pathMatch = output.match(/~\/Documents\/Hive\/[^\s"'`]+\.(docx|pptx|xlsx)/i)
        || output.match(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/Documents/Hive/[^\\s"\'`]+\\.(docx|pptx|xlsx)', 'i'));
      if (!pathMatch) {
        this.onEvent('swarm-agent-chunk', { swarmId, agentIndex, chunk: '\n⚠️ Formatter did not report a local file path.\n' });
        return null;
      }
      const filePath = pathMatch[0].replace('~', home);
      const stat = await fsLocal.stat(filePath);
      this.onEvent('swarm-agent-chunk', { swarmId, agentIndex, chunk: `\n✅ Verified: ${filePath} (${(stat.size / 1024).toFixed(1)} KB)\n` });
      return filePath;
    } catch {
      this.onEvent('swarm-agent-chunk', { swarmId, agentIndex, chunk: '\n❌ File was NOT saved to local machine. The formatter agent may have failed silently.\n' });
      return null;
    }
  }

  async _extractVideoFrames(swarmId, agentIndex, videoFiles) {
    try {
      if (!this.codeInterpreter.sessionId) {
        await this.codeInterpreter.startSession(7200);
      }
      this.onEvent('swarm-agent-chunk', { swarmId, agentIndex, chunk: '\n🎞️ Extracting keyframes from video...\n' });

      const videoName = videoFiles[0].name;
      const code = `
import subprocess, os, json

os.makedirs('/tmp/frames', exist_ok=True)

# Install opencv if needed
try:
    import cv2
except ImportError:
    subprocess.check_call(['pip', 'install', '-q', 'opencv-python-headless'])
    import cv2

video_path = '/tmp/${videoName}'
cap = cv2.VideoCapture(video_path)
fps = cap.get(cv2.CAP_PROP_FPS) or 30
total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
duration = total_frames / fps if fps > 0 else 0

# Extract 1 frame every 2 seconds (balance between coverage and count)
interval = max(int(fps * 2), 1)
frames = []
frame_idx = 0
saved = 0

while cap.isOpened() and saved < 60:  # cap at 60 frames
    ret, frame = cap.read()
    if not ret:
        break
    if frame_idx % interval == 0:
        timestamp = frame_idx / fps
        ts_str = f"{int(timestamp//60):02d}:{int(timestamp%60):02d}"
        filename = f"/tmp/frames/frame_{saved:04d}_{ts_str.replace(':','')}.jpg"
        cv2.imwrite(filename, frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        frames.append({"path": filename, "timestamp": ts_str, "index": saved})
        saved += 1
    frame_idx += 1

cap.release()
print(json.dumps({"duration": f"{int(duration//60)}:{int(duration%60):02d}", "fps": round(fps,1), "total_frames": saved, "frames": frames}))
`;

      const result = await this.codeInterpreter.executeCode(code);
      if (!result.success) {
        this.onEvent('swarm-agent-chunk', { swarmId, agentIndex, chunk: `\n⚠️ Frame extraction failed: ${(result.errors || []).join(', ')}\n` });
        return null;
      }

      // Parse the JSON output
      try {
        const data = JSON.parse(result.text.trim());
        const manifest = [
          `## Extracted Video Frames`,
          `Duration: ${data.duration} | FPS: ${data.fps} | Frames extracted: ${data.total_frames}`,
          ``,
          `Available frames in sandbox (use these paths in scene cards):`,
          ...data.frames.map(f => `- \`${f.path}\` — timestamp ${f.timestamp}`),
          ``,
          `**Scene Writer**: Reference these frame paths in your scene cards under "Visual:".`,
          `**Formatter**: Embed these images in the PPTX slides using python-pptx add_picture().`,
        ];
        this.onEvent('swarm-agent-chunk', { swarmId, agentIndex, chunk: `\n🎞️ Extracted ${data.total_frames} keyframes\n` });
        return manifest.join('\n');
      } catch {
        return null;
      }
    } catch (err) {
      this.onEvent('swarm-agent-chunk', { swarmId, agentIndex, chunk: `\n⚠️ Frame extraction error: ${err.message}\n` });
      return null;
    }
  }

  async _uploadFilesToSandbox(files, swarmId) {
    if (!this.codeInterpreter.sessionId) {
      this.onEvent('swarm-agent-chunk', { swarmId, agentIndex: 0, chunk: '\n🔧 Starting sandbox for file uploads...\n' });
      await this.codeInterpreter.startSession(7200);
    }
    const fsLocal = require('fs').promises;
    const pathMod = require('path');

    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.cache', 'target', '__pycache__', '.next', '.venv', 'env', '.env', '.tox', 'coverage', '.nyc_output']);
    const ALLOWED_EXT = new Set([
      '.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.pdf', '.docx', '.pptx', '.xlsx', '.rtf',
      '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.rb', '.php', '.c', '.cpp', '.h', '.cs', '.swift', '.kt', '.sh', '.bash', '.sql', '.r',
      '.toml', '.ini', '.cfg', '.env', '.properties', '.tf', '.hcl',
      '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico',
      '.mp4', '.mov', '.avi', '.webm', '.mkv', '.mp3', '.wav', '.m4a',
    ]);
    const MAX_FILES = 50;

    /** Upload buffer to sandbox via base64+executeCode */
    const uploadViaSandbox = async (sandboxPath, buffer) => {
      const b64 = buffer.toString('base64');
      const chunkSize = 500000;
      if (b64.length <= chunkSize) {
        const code = `import base64\ndata = base64.b64decode("${b64}")\nimport os; os.makedirs(os.path.dirname("${sandboxPath}") or ".", exist_ok=True)\nwith open("${sandboxPath}", "wb") as f:\n    f.write(data)\nprint(f"Wrote {len(data)} bytes to ${sandboxPath}")`;
        return this.codeInterpreter.executeCode(code);
      }
      const chunks = [];
      for (let i = 0; i < b64.length; i += chunkSize) chunks.push(b64.slice(i, i + chunkSize));
      const code = `import base64, os
chunks = ${JSON.stringify(chunks)}
data = base64.b64decode("".join(chunks))
os.makedirs(os.path.dirname("${sandboxPath}") or ".", exist_ok=True)
with open("${sandboxPath}", "wb") as f:
    f.write(data)
print(f"Wrote {len(data)} bytes to ${sandboxPath}")`;
      return this.codeInterpreter.executeCode(code);
    };

    let uploaded = 0;
    for (const f of files) {
      try {
        if (f.isDir) {
          const collected = [];
          const scan = async (dir) => {
            if (collected.length >= MAX_FILES) return;
            const entries = await fsLocal.readdir(dir, { withFileTypes: true });
            for (const e of entries) {
              if (collected.length >= MAX_FILES) break;
              if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
                await scan(pathMod.join(dir, e.name));
              } else if (e.isFile() && ALLOWED_EXT.has(pathMod.extname(e.name).toLowerCase())) {
                collected.push(pathMod.join(dir, e.name));
              }
            }
          };
          await scan(f.path);
          for (const filePath of collected) {
            const relPath = pathMod.relative(f.path, filePath);
            const content = await fsLocal.readFile(filePath);
            await uploadViaSandbox(`/tmp/${relPath}`, content);
            uploaded++;
          }
          this.onEvent('swarm-agent-chunk', { swarmId, agentIndex: 0, chunk: `\n📁 Uploaded ${collected.length} files from workspace\n` });
        } else {
          const content = await fsLocal.readFile(f.path);
          await uploadViaSandbox(`/tmp/${f.name}`, content);
          uploaded++;
          this.onEvent('swarm-agent-chunk', { swarmId, agentIndex: 0, chunk: `\n📎 Uploaded ${f.name}\n` });
        }
      } catch (err) {
        this.onEvent('swarm-agent-chunk', { swarmId, agentIndex: 0, chunk: `\n⚠️ Failed to upload ${f.name}: ${err.message}\n` });
      }
    }
  }

  async _getHistoricalFeedback(templateId) {
    try {
      const dirs = await fs.readdir(this.runsDir);
      const failures = {};

      for (const dir of dirs.slice(-20)) { // last 20 runs max
        try {
          const raw = await fs.readFile(path.join(this.runsDir, dir, 'state.json'), 'utf8');
          const state = JSON.parse(raw);
          if (state.templateId !== templateId || !state.rubric_scores) continue;

          for (const attempts of Object.values(state.rubric_scores)) {
            for (const attempt of attempts) {
              if (attempt.decision === 'REVISE' || attempt.decision === 'FAIL') {
                // Track axis-level failures
                for (const [axis, score] of Object.entries(attempt.axis_scores || {})) {
                  if (score < 0.75) {
                    if (!failures[axis]) failures[axis] = 0;
                    failures[axis]++;
                  }
                }
              }
            }
          }
        } catch { /* skip */ }
      }

      const sorted = Object.entries(failures).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (!sorted.length) return null;

      return `<historical_feedback>\nIn previous ${templateId} runs, the quality gate frequently flagged these issues:\n${sorted.map(([axis, count]) => `- "${axis}" failed ${count} time${count > 1 ? 's' : ''}`).join('\n')}\nAvoid these patterns proactively.\n</historical_feedback>`;
    } catch { return null; }
  }

  async _adaptRubric(rubric, brief) {
    try {
      const model = new BedrockModel({
        modelId: require('./pipelineTemplates').DEFAULT_MODELS.formatter,
        clientConfig: { region: this.awsConfig.region, credentials: this.awsConfig.credentials },
      });

      const criteriaList = rubric.criteria.map((c, i) =>
        `${i}: [weight ${c.weight}] "${c.text}"${c.canBeNA ? ' (can be N/A)' : ''}`
      ).join('\n');

      const agent = new Agent({
        model,
        systemPrompt: `You specialize in making evaluation criteria specific and concrete. Given generic rubric criteria and a user brief, rewrite each criterion to reference the specific content of the brief. Keep the same number of criteria, same weights, same meaning — just make the text specific. Output ONLY a JSON array of objects: [{"index": 0, "text": "specific criterion text"}, ...]`,
        tools: [],
        id: 'rubric-adapter',
      });

      let result = '';
      for await (const event of agent.stream(`Brief: ${brief}\n\nCriteria:\n${criteriaList}`)) {
        if (event.type === 'modelStreamUpdateEvent') {
          const inner = event.event;
          if (inner.type === 'modelContentBlockDeltaEvent' && inner.delta?.type === 'textDelta') {
            result += inner.delta.text;
          }
        }
      }

      // Parse the adapted criteria
      const start = result.indexOf('[');
      const end = result.lastIndexOf(']');
      if (start === -1 || end === -1) return null;

      const adapted = JSON.parse(result.slice(start, end + 1));
      const newCriteria = rubric.criteria.map((c, i) => {
        const match = adapted.find(a => a.index === i);
        return match ? { ...c, text: match.text } : c;
      });

      return { ...rubric, criteria: newCriteria };
    } catch (err) {
      // If adaptation fails, fall back to original rubric silently
      return null;
    }
  }
}

module.exports = SwarmOrchestrator;
