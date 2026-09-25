/**
 * modelCatalog.js / modelCatalogMeta.js — the Settings → Models picker's data.
 *
 * Pure functions over already-fetched catalog data, so these tests hand in
 * fixtures shaped like the real ListFoundationModels / ListInferenceProfiles
 * responses and check the merge: which models are offered, which inference
 * profile ID Hive would add, how configured state and Swarm roles are
 * reflected, and how the offline fallback behaves.
 */
jest.mock('electron-log/main', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { buildCatalog, buildFallbackCatalog, isTextGenerationModel, normalizeId } =
  require('../../src/main/models/modelCatalog');
const { describeModel, formatCost, baseModelId } = require('../../src/main/models/modelCatalogMeta');

const text = (modelId, extra = {}) => ({
  modelId,
  modelName: extra.modelName || modelId,
  providerName: extra.providerName || 'Test',
  inputModalities: ['TEXT'],
  outputModalities: ['TEXT'],
  inferenceTypesSupported: extra.inferenceTypesSupported || ['ON_DEMAND'],
  ...extra,
});
const profile = (inferenceProfileId) => ({ inferenceProfileId, status: 'ACTIVE' });

const flat = (catalog) => catalog.groups.flatMap((g) => g.models);
const rowFor = (catalog, base) => flat(catalog).find((m) => m.modelId === base);

describe('modelCatalogMeta', () => {
  test('baseModelId strips region/global prefixes but never a provider segment', () => {
    expect(baseModelId('global.anthropic.claude-sonnet-5')).toBe('anthropic.claude-sonnet-5');
    expect(baseModelId('us.openai.gpt-6-sol')).toBe('openai.gpt-6-sol');
    expect(baseModelId('google.gemma-3-27b-it')).toBe('google.gemma-3-27b-it');
    expect(baseModelId('amazon.nova-2-lite-v1:0')).toBe('amazon.nova-2-lite-v1:0');
  });

  test('formatCost renders the pill text like the reference UX', () => {
    expect(formatCost(1)).toBe('~1×');
    expect(formatCost(2)).toBe('~2×');
    expect(formatCost(8.3)).toBe('~8.3×');
    expect(formatCost(0.1)).toBe('~0.1×');
    expect(formatCost(0.03)).toBe('~0.03×');
    expect(formatCost(12)).toBe('~12×');
    expect(formatCost(null)).toBeNull();
  });

  test('describeModel: a curated model gets its description and cost regardless of prefix', () => {
    const viaGlobal = describeModel('global.anthropic.claude-sonnet-5');
    const viaUs = describeModel('us.anthropic.claude-sonnet-5', { modelName: 'ignored' });
    expect(viaGlobal.name).toBe('Claude Sonnet 5');
    expect(viaGlobal.description).toMatch(/everyday/i);
    expect(viaGlobal.costLabel).toBe('~1×');
    expect(viaGlobal.known).toBe(true);
    expect(viaUs).toEqual(viaGlobal);
  });

  test('describeModel: an unknown model gets the catalog name, no description, no cost', () => {
    const d = describeModel('mistral.mistral-large-3', { modelName: 'Mistral Large 3' });
    expect(d).toMatchObject({ name: 'Mistral Large 3', description: null, costLabel: null, known: false, providerLabel: 'Mistral' });
  });

  test('describeModel carries the tool capability decision', () => {
    expect(describeModel('google.gemma-3-27b-it').supportsTools).toBe(false);
    expect(describeModel('global.moonshotai.kimi-k3').supportsTools).toBe(true);
  });

  test('one vendor under two ID prefixes lands in one group (live catalog: moonshot. and moonshotai.)', () => {
    const cat = buildCatalog({
      foundationModels: [text('moonshot.kimi-k2-thinking'), text('moonshotai.kimi-k3')],
      inferenceProfiles: [],
      configuredModels: [],
    });
    expect(cat.groups).toHaveLength(1);
    expect(cat.groups[0]).toMatchObject({ provider: 'moonshotai', label: 'Moonshot' });
    expect(cat.groups[0].models).toHaveLength(2);
  });
});

describe('isTextGenerationModel', () => {
  test('keeps text-in/text-out on-demand models', () => {
    expect(isTextGenerationModel(text('anthropic.claude-sonnet-5'))).toBe(true);
  });

  test.each([
    ['image output', { modelId: 'amazon.nova-canvas-v1', outputModalities: ['IMAGE'] }],
    ['embeddings by ID', { modelId: 'amazon.nova-2-multimodal-embeddings-v1:0' }],
    ['speech by ID', { modelId: 'amazon.nova-2-sonic-v1:0' }],
    ['safety model by ID', { modelId: 'openai.gpt-oss-safeguard-120b' }],
    ['context-window variant', { modelId: 'anthropic.claude-sonnet-4-20250514-v1:0:200k' }],
    ['provisioned-only', { modelId: 'x.y', inferenceTypesSupported: ['PROVISIONED'] }],
  ])('drops %s', (_label, overrides) => {
    expect(isTextGenerationModel(text(overrides.modelId, overrides))).toBe(false);
  });
});

describe('buildCatalog', () => {
  const foundationModels = [
    text('anthropic.claude-sonnet-5', { providerName: 'Anthropic', modelName: 'Claude Sonnet 5' }),
    text('anthropic.claude-opus-5-5', { providerName: 'Anthropic' }),
    text('openai.gpt-6-sol', { providerName: 'OpenAI' }),
    text('google.gemma-3-27b-it', { providerName: 'Google' }),
    text('mistral.mistral-large-3', { providerName: 'Mistral AI', modelName: 'Mistral Large 3' }),
    text('amazon.nova-canvas-v1', { outputModalities: ['IMAGE'] }),
    // Duplicate entries for one model: bare and versioned.
    text('anthropic.claude-sonnet-4-20250514-v1', { providerName: 'Anthropic' }),
    text('anthropic.claude-sonnet-4-20250514-v1:0', { providerName: 'Anthropic' }),
  ];
  const inferenceProfiles = [
    profile('us.anthropic.claude-sonnet-5'),
    profile('global.anthropic.claude-sonnet-5'),
    profile('global.anthropic.claude-opus-5-5'),
    profile('us.openai.gpt-6-sol'),
    profile('us.anthropic.claude-sonnet-4-20250514-v1:0'),
  ];

  test('groups by provider in picker order with display labels', () => {
    const cat = buildCatalog({ foundationModels, inferenceProfiles, configuredModels: [] });
    expect(cat.source).toBe('live');
    expect(cat.groups.map((g) => g.label)).toEqual(['Claude', 'OpenAI', 'Google', 'Mistral']);
  });

  test('prefers the global inference profile, then us, then the bare ID', () => {
    const cat = buildCatalog({ foundationModels, inferenceProfiles, configuredModels: [] });
    expect(rowFor(cat, 'anthropic.claude-sonnet-5').inferenceProfileId).toBe('global.anthropic.claude-sonnet-5');
    expect(rowFor(cat, 'openai.gpt-6-sol').inferenceProfileId).toBe('us.openai.gpt-6-sol');
    // Gemma has no profile: invoked by bare model ID, as the defaults do.
    expect(rowFor(cat, 'google.gemma-3-27b-it').inferenceProfileId).toBe('google.gemma-3-27b-it');
  });

  test('collapses bare/versioned duplicates to the form a profile targets', () => {
    const cat = buildCatalog({ foundationModels, inferenceProfiles, configuredModels: [] });
    const sonnet4 = flat(cat).filter((m) => /claude-sonnet-4-20250514/.test(m.modelId));
    expect(sonnet4).toHaveLength(1);
    expect(sonnet4[0].modelId).toBe('anthropic.claude-sonnet-4-20250514-v1:0');
    expect(sonnet4[0].inferenceProfileId).toBe('us.anthropic.claude-sonnet-4-20250514-v1:0');
  });

  test('excludes non-text models', () => {
    const cat = buildCatalog({ foundationModels, inferenceProfiles, configuredModels: [] });
    expect(rowFor(cat, 'amazon.nova-canvas-v1')).toBeUndefined();
  });

  test('marks configured models — matching across prefix differences — and carries their role', () => {
    const configuredModels = [
      // Configured under `us.`, catalog row prefers `global.`: still the same model.
      { id: 'Sonnet', inferenceProfileId: 'us.anthropic.claude-sonnet-5', role: 'worker' },
      { id: 'Gemma', inferenceProfileId: 'google.gemma-3-27b-it', role: '' },
    ];
    const cat = buildCatalog({ foundationModels, inferenceProfiles, configuredModels });

    const sonnet = rowFor(cat, 'anthropic.claude-sonnet-5');
    expect(sonnet).toMatchObject({ configured: true, configuredRole: 'worker', configuredId: 'us.anthropic.claude-sonnet-5' });
    expect(rowFor(cat, 'google.gemma-3-27b-it')).toMatchObject({ configured: true, configuredRole: '' });
    expect(rowFor(cat, 'anthropic.claude-opus-5-5')).toMatchObject({ configured: false, configuredId: null });
  });

  test('a configured model the catalog no longer lists still gets a row, so it can be removed', () => {
    const configuredModels = [{ id: 'Old thing', inferenceProfileId: 'us.legacy.model-v1', role: '' }];
    const cat = buildCatalog({ foundationModels, inferenceProfiles, configuredModels });
    const row = rowFor(cat, 'legacy.model-v1');
    expect(row).toMatchObject({ configured: true, name: 'Old thing', inferenceProfileId: 'us.legacy.model-v1', known: false });
  });

  test('curated metadata and tool capability ride along on each row', () => {
    const cat = buildCatalog({ foundationModels, inferenceProfiles, configuredModels: [] });
    expect(rowFor(cat, 'anthropic.claude-sonnet-5')).toMatchObject({ known: true, costLabel: '~1×', supportsTools: true });
    expect(rowFor(cat, 'google.gemma-3-27b-it')).toMatchObject({ known: true, supportsTools: false });
    expect(rowFor(cat, 'mistral.mistral-large-3')).toMatchObject({ known: false, description: null, costLabel: null, name: 'Mistral Large 3' });
  });

  test('curated models sort first within a group, then unknowns by name', () => {
    const fms = [
      text('anthropic.zeta-unknown', { providerName: 'Anthropic', modelName: 'Zeta' }),
      text('anthropic.alpha-unknown', { providerName: 'Anthropic', modelName: 'Alpha' }),
      text('anthropic.claude-opus-5-5', { providerName: 'Anthropic' }),
      text('anthropic.claude-sonnet-5', { providerName: 'Anthropic' }),
    ];
    const cat = buildCatalog({ foundationModels: fms, inferenceProfiles: [], configuredModels: [] });
    expect(cat.groups[0].models.map((m) => m.name)).toEqual(['Claude Sonnet 5', 'Claude Opus 5.5', 'Alpha', 'Zeta']);
  });

  test('normalizeId treats bare, versioned, and prefixed forms as one model', () => {
    expect(normalizeId('global.amazon.nova-2-lite-v1:0')).toBe(normalizeId('amazon.nova-2-lite-v1'));
    expect(normalizeId('us.x.y-v1:0')).toBe('x.y-v1');
  });
});

describe('buildFallbackCatalog', () => {
  test('offers the curated list with conventional invoke IDs and says why', () => {
    const cat = buildFallbackCatalog({ configuredModels: [], reason: 'Hive is offline' });
    expect(cat.source).toBe('fallback');
    expect(cat.reason).toBe('Hive is offline');
    expect(rowFor(cat, 'anthropic.claude-sonnet-5').inferenceProfileId).toBe('global.anthropic.claude-sonnet-5');
    expect(rowFor(cat, 'google.gemma-3-27b-it').inferenceProfileId).toBe('google.gemma-3-27b-it');
    expect(flat(cat).every((m) => m.known || m.configured)).toBe(true);
  });

  test('a configured model keeps its own ID and appears even if uncurated', () => {
    const configuredModels = [
      { id: 'Sol', inferenceProfileId: 'us.openai.gpt-6-sol', role: 'formatter' },
      { id: 'Custom', inferenceProfileId: 'arn:aws:bedrock:us-east-1:123:application-inference-profile/abc', role: '' },
    ];
    const cat = buildFallbackCatalog({ configuredModels });
    expect(rowFor(cat, 'openai.gpt-6-sol')).toMatchObject({ configured: true, configuredRole: 'formatter', inferenceProfileId: 'us.openai.gpt-6-sol' });
    expect(flat(cat).find((m) => m.name === 'Custom')).toMatchObject({ configured: true, known: false });
  });
});
