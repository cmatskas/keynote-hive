/**
 * IPC handlers for the StoryBrand tab.
 *
 * Extraction is local and free, so it runs regardless of connectivity — a saved
 * analysis opens offline, and a file can be read and prepared offline too. Only
 * `storyboard-analyze` touches AWS, and it is the only handler gated on being
 * online with working credentials.
 *
 * Credentials and settings are read from ctx, never accepted from the renderer,
 * consistent with every other IPC module here.
 */

const StoryboardRegistry = require('../models/storyboardRegistry');
const extractor = require('../models/storyboardExtractor');
const analyzer = require('../models/storyboardAnalyzer');
const { ELEMENTS } = require('../models/storybrandElements');
const log = require('electron-log/main');

/**
 * The model to analyse with: whatever the renderer picked, else the model
 * assigned the Creator role, else the first configured model.
 *
 * Creator is the right default — classification quality across a whole keynote is
 * exactly the "best model" case, and it matches how Swarm treats the role.
 */
function resolveModel(settings, requested) {
  const models = settings?.bedrockModels || [];
  if (requested) return requested;
  const creator = models.find(m => m.role === 'creator');
  return (creator || models[0])?.inferenceProfileId || '';
}

function register(ipcMain, ctx) {
  const registry = new StoryboardRegistry();

  /** Element definitions for the legend and explanation rail. */
  ipcMain.handle('storyboard-get-elements', async () => ELEMENTS);

  /**
   * Read an uploaded file into classifiable units. No model, no network.
   * Returns the units so the renderer can show a preview and a word count before
   * the user spends a model call.
   */
  ipcMain.handle('storyboard-extract', async (_event, { name, content } = {}) => {
    if (!name) throw new Error('No file provided');
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || []);
    return extractor.extractFromFile({ name, content: buffer });
  });

  /** Same, for text pasted straight into the tab. */
  ipcMain.handle('storyboard-extract-text', async (_event, { text, sourceName } = {}) =>
    extractor.extractFromText(text, sourceName || 'Pasted text'));

  /**
   * The only AWS call in this tab. Classifies every unit and produces the audit in
   * one request, then persists the result so the colours never shift between
   * viewings.
   */
  ipcMain.handle('storyboard-analyze', async (_event, payload = {}) => {
    ctx.assertOnline('Analysing a script');

    const settings = ctx.currentSettings || await ctx.settingsManager.loadSettings();
    const { units, sourceName, format, wordCount, displayName, revisionOf } = payload;

    const modelId = resolveModel(settings, payload.modelId);
    const result = await analyzer.analyze({
      units,
      modelId,
      region: settings.region,
      mantleApiKey: settings.mantleApiKey,
      wordCount,
    });

    // Chain a re-upload onto the analysis it supersedes. The tab is read-only, so
    // revising means editing the script elsewhere and uploading again — without
    // this, the history the sidebar shows would be a flat list of unrelated rows
    // and "did my rewrite fix the Guide section?" would be unanswerable.
    let supersedes = revisionOf || null;
    if (!supersedes) {
      const previous = await registry.findPredecessor({ sourceName, format });
      supersedes = previous ? previous.id : null;
    }

    return registry.save({
      units,
      classifications: result.classifications,
      audit: result.audit,
      modelId: result.modelId,
      sourceName,
      format,
      wordCount,
      displayName,
      revisionOf: supersedes,
    });
  });

  /**
   * Re-run the model over an already-saved snapshot.
   *
   * The tab is read-only, so this is what "Re-analyse" means: same text, fresh
   * classification. Useful when switching model or when a classification looks
   * wrong. It replaces the result in place rather than creating a revision —
   * a revision means the *script* changed, which requires a new upload.
   */
  ipcMain.handle('storyboard-reanalyze', async (_event, { id, modelId } = {}) => {
    ctx.assertOnline('Re-analysing a script');

    const existing = await registry.get(id);
    if (!existing) throw new Error('That analysis no longer exists.');

    const settings = ctx.currentSettings || await ctx.settingsManager.loadSettings();
    const result = await analyzer.analyze({
      units: existing.units,
      modelId: resolveModel(settings, modelId),
      region: settings.region,
      mantleApiKey: settings.mantleApiKey,
      wordCount: existing.wordCount,
    });

    return registry.save({
      ...existing,
      classifications: result.classifications,
      audit: result.audit,
      modelId: result.modelId,
    });
  });

  // ── Local history: all available offline ─────────────────────────────────

  ipcMain.handle('storyboard-list', async () => registry.list());
  ipcMain.handle('storyboard-get', async (_event, id) => registry.get(id));
  ipcMain.handle('storyboard-search', async (_event, query) => registry.search(query));
  ipcMain.handle('storyboard-revisions', async (_event, id) => registry.revisionChain(id));

  ipcMain.handle('storyboard-rename', async (_event, { id, displayName } = {}) =>
    registry.rename(id, displayName));

  ipcMain.handle('storyboard-delete', async (_event, id) => {
    const removed = await registry.remove(id);
    if (removed) log.info(`[storyboard] deleted analysis ${id}`);
    return removed;
  });
}

module.exports = { register, resolveModel };
