const { app, Notification } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const SwarmOrchestrator = require('../models/swarmOrchestrator');
const CodeInterpreterManager = require('../models/codeInterpreterManager');
const { getTemplate, getAllTemplates, resolveModels } = require('../models/pipelineTemplates');

function swarmNotify(ctx, title, body) {
  if (Notification.isSupported()) {
    const n = new Notification({ title: `Hive — ${title}`, body, silent: false });
    n.on('click', () => { if (ctx.mainWindow) { ctx.mainWindow.show(); ctx.mainWindow.focus(); } });
    n.show();
  }
}

function createSwarmOrchestrator(ctx) {
  ctx.swarmOrchestrator = new SwarmOrchestrator({
    awsConfig: ctx.awsClients.agentCoreConfig,
    skillsManager: ctx.skillsManager,
    codeInterpreterManager: new CodeInterpreterManager(ctx.awsClients.agentCoreConfig),
    webSearchManager: ctx.webSearchManager,
    settings: { ...(ctx.currentSettings || {}) },
    onEvent: (channel, data) => {
      if (ctx.mainWindow) ctx.mainWindow.webContents.send(channel, data);
      if (channel === 'swarm-review-pause') {
        swarmNotify(ctx, 'Review Required', `${data.agentIndex !== undefined ? 'Agent' : 'Pipeline'} output ready for your review.`);
      } else if (channel === 'swarm-input-request') {
        swarmNotify(ctx, 'Input Needed', data.question ? data.question.slice(0, 100) : 'An agent needs your input.');
      } else if (channel === 'swarm-pipeline-done') {
        swarmNotify(ctx, 'Pipeline Complete', 'All agents finished successfully.');
      } else if (channel === 'swarm-error') {
        swarmNotify(ctx, 'Pipeline Error', data.error ? data.error.slice(0, 100) : 'An error occurred.');
      }
    },
  });
  return ctx.swarmOrchestrator;
}

function register(ipcMain, ctx) {
  ipcMain.handle('swarm-get-templates', async () => getAllTemplates());

  ipcMain.handle('swarm-get-analytics', async () => {
    const runsDir = path.join(app.getPath('userData'), 'swarm-runs');
    const runs = [];
    try {
      const dirs = await fs.readdir(runsDir);
      for (const dir of dirs) {
        try {
          const raw = await fs.readFile(path.join(runsDir, dir, 'state.json'), 'utf8');
          runs.push(JSON.parse(raw));
        } catch { /* skip invalid */ }
      }
    } catch { /* no runs dir */ }

    if (!runs.length) return { summary: null, templates: {}, insights: [] };

    const completed = runs.filter(r => r.status === 'completed');
    const errored = runs.filter(r => r.status === 'error');
    const templates = {};

    for (const run of runs) {
      const tid = run.templateId || 'unknown';
      if (!templates[tid]) templates[tid] = { name: run.templateName || tid, runs: 0, completed: 0, errors: 0, scores: [], criteriaStats: {} };
      const t = templates[tid];
      t.runs++;
      if (run.status === 'completed') t.completed++;
      if (run.status === 'error') t.errors++;

      for (const [gateId, attempts] of Object.entries(run.rubric_scores || {})) {
        for (const attempt of attempts) {
          t.scores.push(attempt.score);
          for (const [axis, score] of Object.entries(attempt.axis_scores || {})) {
            if (!t.criteriaStats[axis]) t.criteriaStats[axis] = { pass: 0, fail: 0 };
            if (score >= 0.75) t.criteriaStats[axis].pass++;
            else t.criteriaStats[axis].fail++;
          }
        }
      }
    }

    const allScores = Object.values(templates).flatMap(t => t.scores);
    const avgScore = allScores.length ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;
    const summary = {
      totalRuns: runs.length,
      completed: completed.length,
      errors: errored.length,
      passRate: runs.length ? Math.round((completed.length / runs.length) * 100) : 0,
      avgScore: Math.round(avgScore * 100),
    };

    const insights = [];
    for (const [tid, t] of Object.entries(templates)) {
      if (t.errors > 0 && t.errors / t.runs > 0.5) {
        insights.push({ severity: 'error', message: `${t.name}: ${t.errors}/${t.runs} runs failed — check tool configuration` });
      }
      for (const [axis, stats] of Object.entries(t.criteriaStats)) {
        const total = stats.pass + stats.fail;
        if (total >= 3 && stats.fail / total > 0.5) {
          insights.push({ severity: 'warn', message: `${t.name} → "${axis}" fails ${Math.round(stats.fail / total * 100)}% of the time — consider adjusting the writer prompt or rubric weight` });
        }
        if (total >= 5 && stats.pass === total) {
          insights.push({ severity: 'info', message: `${t.name} → "${axis}" passes 100% — consider removing to save evaluation tokens` });
        }
      }
    }

    return { summary, templates, insights };
  });

  ipcMain.handle('swarm-run-pipeline', async (event, { templateId, brief, autonomyMode, files }) => {
    if (!ctx.awsClients.bedrock) throw new Error('AWS credentials not configured');
    const settings = ctx.currentSettings || await ctx.settingsManager.loadSettings();
    const models = (settings.bedrockModels || []);
    const overrides = {};
    for (const m of models) { if (m.role) overrides[m.role] = m.inferenceProfileId; }
    resolveModels(overrides);

    const orch = createSwarmOrchestrator(ctx);
    const template = getTemplate(templateId);
    if (!template) throw new Error(`Unknown template: ${templateId}`);
    const swarmId = `swarm-${Date.now()}`;
    orch.runPipeline(swarmId, template, brief, autonomyMode || 'guided', files || []);
    return { swarmId };
  });

  ipcMain.handle('swarm-continue', async (event, { swarmId, editedOutput }) => {
    if (ctx.swarmOrchestrator) ctx.swarmOrchestrator.continueAfterReview(swarmId, editedOutput);
  });

  ipcMain.handle('swarm-answer-input', async (event, { swarmId, answer }) => {
    if (ctx.swarmOrchestrator) ctx.swarmOrchestrator.answerInput(swarmId, answer);
  });

  ipcMain.handle('swarm-cancel', async (event, { swarmId }) => {
    if (ctx.swarmOrchestrator) ctx.swarmOrchestrator.cancel(swarmId);
  });
}

module.exports = { register };
