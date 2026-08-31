/**
 * @jest-environment jsdom
 */

/**
 * Tests for the StoryBrand tab renderer and its HTML export.
 *
 * The fixture is the *real* markup, sliced out of src/pages/index.html rather than
 * hand-written here. A hand-written fixture drifts: an id renamed in the page keeps
 * passing against a stale copy, and the failure only shows up in the running app.
 *
 * The behaviour under test is mostly one rule — the rendered text comes from the
 * stored units and the analysis only decides colour. Everything the model returned
 * beyond a map of index to element key is inert.
 */

const fs = require('fs');
const path = require('path');

const mockElectronAPI = {
  invoke: jest.fn(),
  showToast: jest.fn(),
  receive: jest.fn(),
};
Object.defineProperty(window, 'electronAPI', { value: mockElectronAPI, writable: true });

const { ELEMENTS } = require('../../src/main/models/storybrandElements');

/** The storyboard page markup, taken from the app's own HTML. */
function storyboardMarkup() {
  const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'pages', 'index.html'),
    'utf8',
  );
  const start = html.indexOf('<div id="storyboard-page"');
  expect(start).toBeGreaterThan(-1);
  // Walk to the matching close so the fixture is exactly the tab's subtree.
  let depth = 0;
  let i = start;
  while (i < html.length) {
    if (html.startsWith('<div', i)) depth++;
    else if (html.startsWith('</div>', i)) {
      depth--;
      if (depth === 0) return html.slice(start, i + 6);
    }
    i++;
  }
  throw new Error('Unbalanced storyboard-page markup');
}

const UNITS = [
  { index: 1, text: 'From Models to Agents at Scale', children: [], kind: 'heading', level: 1 },
  { index: 2, text: 'AI agents are not making it to production at scale.', children: [], kind: 'paragraph' },
  { index: 3, text: 'We have a unique vantage point on this.', children: [], kind: 'paragraph' },
  { index: 4, text: 'Here is your prescription.', children: ['One: momentum', 'Two: infrastructure'], kind: 'bullet' },
];

const ANALYSIS = {
  id: 'sb-test-000001',
  displayName: 'Reinvent keynote',
  units: UNITS,
  classifications: { 1: 'problem', 2: 'character', 3: 'guide', 4: 'plan' },
  wordCount: 3281,
  unitCount: 4,
  modelId: 'opus-id',
  createdAt: 1735689600000,
  audit: {
    overall: 'Strong problem framing, thin on Success.',
    elements: {
      problem: { status: 'strong', found: 'unit 2', issue: '', fix: '' },
      success: { status: 'missing', found: '', issue: 'No transformation shown', fix: 'Add a closing vision' },
    },
    whatsWorking: ['Clear stakes'],
    quickWins: ['Name the villain'],
  },
};

async function loadTab({ list = [], elements = ELEMENTS } = {}) {
  document.body.innerHTML = storyboardMarkup();

  mockElectronAPI.invoke.mockImplementation((channel) => {
    switch (channel) {
      case 'storyboard-get-elements': return Promise.resolve(elements);
      case 'get-bedrock-models': return Promise.resolve([
        { id: 'Opus', inferenceProfileId: 'opus-id', role: 'creator' },
        { id: 'Haiku', inferenceProfileId: 'haiku-id', role: 'formatter' },
      ]);
      case 'storyboard-list': return Promise.resolve(list);
      case 'storyboard-search': return Promise.resolve(list);
      case 'storyboard-get': return Promise.resolve(ANALYSIS);
      case 'storyboard-rename': return Promise.resolve({ ...ANALYSIS });
      case 'storyboard-delete': return Promise.resolve(true);
      default: return Promise.resolve(undefined);
    }
  });

  jest.resetModules();
  delete window.StoryboardTab;
  require('../../src/renderer/storyboardExport.js');
  require('../../src/renderer/storyboardTab.js');
  await window.StoryboardTab.init();
  return window.StoryboardTab;
}

const flush = () => new Promise(r => setTimeout(r, 0));
const $ = id => document.getElementById(id);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the fixture is the real markup', () => {
  test('every id the controller touches exists in the page', async () => {
    // Guards against the controller and the page drifting apart.
    await loadTab();
    const required = [
      'sbList', 'sbSearch', 'sbSearchClear', 'sbNewBtn', 'sbTitle', 'sbTitleInput',
      'sbReanalyzeBtn', 'sbExportBtn', 'sbInputView', 'sbReadingView', 'sbDropzone',
      'sbFileInput', 'sbPasteInput', 'sbInputMeta', 'sbModelSelect', 'sbAnalyzeBtn',
      'sbInputError', 'sbGlassbar', 'sbLegend', 'sbSegColour', 'sbSegPlain', 'sbSegThumb',
      'sbAuditToggle', 'sbScroll', 'sbSurface', 'sbRail', 'sbInfoCard', 'sbInfoEyebrow',
      'sbInfoTitle', 'sbInfoTagline', 'sbInfoList', 'sbAuditPanel', 'sbAuditBody', 'sbAuditClose',
    ];
    for (const id of required) expect($(id)).not.toBeNull();
  });
});

describe('rendering the script', () => {
  test('draws the stored text, not anything from the model', async () => {
    const tab = await loadTab();

    tab._showAnalysis(ANALYSIS);

    const surface = $('sbSurface');
    expect(surface.textContent).toContain('AI agents are not making it to production at scale.');
    expect(surface.textContent).toContain('We have a unique vantage point on this.');
  });

  test('applies one colour class per unit from the classification', async () => {
    const tab = await loadTab();

    tab._showAnalysis(ANALYSIS);

    const blocks = $('sbSurface').querySelectorAll('[data-index]');
    expect(blocks[0].className).toContain('sb-c-red');     // problem
    expect(blocks[1].className).toContain('sb-c-blue');    // character
    expect(blocks[2].className).toContain('sb-c-green');   // guide
    expect(blocks[3].className).toContain('sb-c-gold');    // plan
  });

  test('renders headings at their level', async () => {
    const tab = await loadTab();
    tab._showAnalysis(ANALYSIS);

    const first = $('sbSurface').querySelector('[data-index="1"]');
    expect(first.className).toContain('sb-h1');
  });

  test('renders grouped outline children in the same colour as their parent', async () => {
    const tab = await loadTab();
    tab._showAnalysis(ANALYSIS);

    const children = $('sbSurface').querySelector('.sb-children');
    expect(children.className).toContain('sb-c-gold');
    expect(children.querySelectorAll('li')).toHaveLength(2);
    expect(children.textContent).toContain('One: momentum');
  });

  test('escapes the script rather than injecting it as HTML', async () => {
    // The script is user content and arrives from a file.
    const tab = await loadTab();
    tab._showAnalysis({
      ...ANALYSIS,
      units: [{ index: 1, text: '<img src=x onerror="alert(1)">', children: ['<script>bad()</script>'], kind: 'paragraph' }],
      classifications: { 1: 'problem' },
    });

    const surface = $('sbSurface');
    expect(surface.querySelector('img')).toBeNull();
    expect(surface.querySelector('script')).toBeNull();
    expect(surface.textContent).toContain('<img src=x');
  });

  test('a unit with no classification renders without a colour rather than a wrong one', async () => {
    // Unreachable in practice — the analyzer refuses partial results — but it must
    // not silently pick a default colour if it ever happens.
    const tab = await loadTab();
    tab._showAnalysis({ ...ANALYSIS, classifications: { 1: 'problem' } });

    const second = $('sbSurface').querySelector('[data-index="2"]');
    expect(second.className).not.toMatch(/sb-c-/);
  });
});

describe('the legend and the rail', () => {
  test('the legend lists all seven elements', async () => {
    await loadTab();
    const items = $('sbLegend').querySelectorAll('.sb-legend-item');
    expect(items).toHaveLength(7);
    expect($('sbLegend').textContent).toContain('Success');
  });

  /**
   * jsdom reports every getBoundingClientRect as zeroes, which makes every block
   * count as "above the reading anchor" and hides whether the selection rule works
   * at all. Give the blocks real geometry so the rule is genuinely exercised.
   */
  function stubGeometry(tops, { containerTop = 0, height = 600 } = {}) {
    const scroll = $('sbScroll');
    scroll.getBoundingClientRect = () => ({ top: containerTop, bottom: containerTop + height, height });
    Object.defineProperty(scroll, 'clientHeight', { value: height, configurable: true });

    const blocks = $('sbSurface').querySelectorAll('[data-index]');
    blocks.forEach((block, i) => {
      const top = tops[i];
      block.getBoundingClientRect = () => ({ top, bottom: top + 40, height: 40 });
    });
    return scroll;
  }

  test('the rail shows the definition of the element being read', async () => {
    const tab = await loadTab();
    tab._showAnalysis(ANALYSIS);
    // Anchor sits at 0 + 600 * 0.33 = 198. Blocks at 0 and 100 are above it, so the
    // active element must be the *second* one — proving it takes the last block
    // above the anchor, not the first or the last overall.
    const scroll = stubGeometry([0, 100, 400, 700]);
    scroll.dispatchEvent(new Event('scroll'));
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 160));

    expect($('sbInfoEyebrow').textContent).toBe('Character');
    expect($('sbInfoTitle').textContent).toBe('The Hero');
    expect($('sbInfoList').querySelectorAll('li').length).toBeGreaterThan(0);
  });

  test('the rail bullet markers carry the element colour', async () => {
    // The list items set their own text colour for readability, so currentColor
    // resolves to ink and the markers came out grey — the design calls for
    // coloured dots.
    const tab = await loadTab();
    tab._showAnalysis(ANALYSIS);
    const scroll = stubGeometry([0, 100, 400, 700]);
    scroll.dispatchEvent(new Event('scroll'));
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 160));

    expect($('sbInfoCard').style.getPropertyValue('--sb-el')).toBe('var(--sb-blue)');
  });

  test('the rail follows the reader down the page', async () => {
    const tab = await loadTab();
    tab._showAnalysis(ANALYSIS);
    // Scrolled further: now blocks 1-3 are above the anchor, so Guide is active.
    const scroll = stubGeometry([-400, -300, 100, 700]);
    scroll.dispatchEvent(new Event('scroll'));
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 160));

    expect($('sbInfoEyebrow').textContent).toBe('Guide');
  });

  test('the glass bar gains a shadow once scrolled', async () => {
    const tab = await loadTab();
    tab._showAnalysis(ANALYSIS);
    const scroll = stubGeometry([0, 100, 400, 700]);

    Object.defineProperty(scroll, 'scrollTop', { value: 120, configurable: true });
    scroll.dispatchEvent(new Event('scroll'));
    await new Promise(r => requestAnimationFrame(r));

    expect($('sbGlassbar').classList.contains('is-scrolled')).toBe(true);
  });
});

describe('the Colour / Plain toggle', () => {
  test('starts in colour mode', async () => {
    const tab = await loadTab();
    tab._showAnalysis(ANALYSIS);

    expect($('sbReadingView').classList.contains('is-plain')).toBe(false);
    expect($('sbSegColour').classList.contains('is-active')).toBe(true);
  });

  test('plain mode flips the flag the CSS keys off', async () => {
    const tab = await loadTab();
    tab._showAnalysis(ANALYSIS);

    tab._setPlain(true);

    expect($('sbReadingView').classList.contains('is-plain')).toBe(true);
    expect($('sbSegPlain').classList.contains('is-active')).toBe(true);
    expect($('sbSegPlain').getAttribute('aria-pressed')).toBe('true');
    // Colour classes stay on the markup; only the CSS neutralises them, so
    // switching back is free and lossless.
    expect($('sbSurface').innerHTML).toContain('sb-c-red');
  });

  test('toggles back to colour', async () => {
    const tab = await loadTab();
    tab._showAnalysis(ANALYSIS);
    tab._setPlain(true);
    tab._setPlain(false);
    expect($('sbReadingView').classList.contains('is-plain')).toBe(false);
  });
});

describe('the audit panel', () => {
  test('renders one card per element with its status', async () => {
    const tab = await loadTab();
    tab._renderAudit(ANALYSIS.audit);

    const cards = $('sbAuditBody').querySelectorAll('.sb-audit-element');
    expect(cards).toHaveLength(7);
    expect($('sbAuditBody').textContent).toContain('Strong');
    expect($('sbAuditBody').textContent).toContain('Missing');
  });

  test('shows the issue and fix for a weak element', async () => {
    const tab = await loadTab();
    tab._renderAudit(ANALYSIS.audit);

    const body = $('sbAuditBody').textContent;
    expect(body).toContain('No transformation shown');
    expect(body).toContain('Add a closing vision');
  });

  test('shows the overall verdict and both lists', async () => {
    const tab = await loadTab();
    tab._renderAudit(ANALYSIS.audit);

    const body = $('sbAuditBody').textContent;
    expect(body).toContain('Strong problem framing');
    expect(body).toContain('Clear stakes');
    expect(body).toContain('Name the villain');
  });

  test('says so when there is no audit rather than rendering blank', async () => {
    const tab = await loadTab();
    tab._renderAudit(null);
    expect($('sbAuditBody').textContent).toMatch(/No audit/i);
  });

  test('marks elements the model did not rate as unrated', async () => {
    const tab = await loadTab();
    tab._renderAudit({ elements: {}, whatsWorking: [], quickWins: [] });
    expect($('sbAuditBody').textContent).toContain('Unrated');
  });

  test('escapes audit text', async () => {
    const tab = await loadTab();
    tab._renderAudit({ overall: '<img src=x onerror="alert(1)">', elements: {} });
    expect($('sbAuditBody').querySelector('img')).toBeNull();
  });
});

describe('the sidebar', () => {
  const summary = {
    id: 'sb-test-000001',
    displayName: 'Reinvent keynote',
    unitCount: 71,
    wordCount: 3281,
    elementCounts: { problem: 20, guide: 15, plan: 30 },
  };

  test('shows saved analyses with their size', async () => {
    await loadTab({ list: [summary] });
    await flush();

    const items = $('sbList').querySelectorAll('.conv-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('Reinvent keynote');
    expect(items[0].textContent).toContain('71 paragraphs');
    expect(items[0].textContent).toContain('3,281 words');
  });

  test('draws a colour bar showing the shape of the story', async () => {
    const tab = await loadTab({ list: [summary] });
    await flush();

    const bar = $('sbList').querySelector('.sb-entry-shape');
    expect(bar.querySelectorAll('span')).toHaveLength(3);
    // Proportional to how many paragraphs landed on each element.
    expect(tab._shapeBar({ problem: 2, plan: 1 })).toContain('flex-grow: 2');
  });

  test('says so when nothing is saved', async () => {
    await loadTab({ list: [] });
    await flush();
    expect($('sbList').textContent).toMatch(/No saved analyses/i);
  });

  test('shows a search snippet when a match came from the script', async () => {
    await loadTab({
      list: [{ ...summary, matches: [{ index: 3, element: 'guide', snippet: '…unique vantage point…' }] }],
    });
    await flush();

    expect($('sbList').textContent).toContain('unique vantage point');
  });

  test('escapes analysis names', async () => {
    await loadTab({ list: [{ ...summary, displayName: '<img src=x onerror="alert(1)">' }] });
    await flush();
    expect($('sbList').querySelector('img')).toBeNull();
  });
});

describe('input view', () => {
  test('populates the model dropdown, defaulting to the Creator role', async () => {
    await loadTab();
    const select = $('sbModelSelect');
    expect(select.options).toHaveLength(2);
    expect(select.value).toBe('opus-id');
  });

  test('the Analyse button starts disabled with nothing loaded', async () => {
    await loadTab();
    expect($('sbAnalyzeBtn').disabled).toBe(true);
  });

  test('shows the reading view and its actions once an analysis is open', async () => {
    const tab = await loadTab();
    tab._showAnalysis(ANALYSIS);

    expect($('sbInputView').style.display).toBe('none');
    expect($('sbReadingView').style.display).toBe('');
    expect($('sbReanalyzeBtn').classList.contains('d-none')).toBe(false);
    expect($('sbExportBtn').classList.contains('d-none')).toBe(false);
    expect($('sbTitle').textContent).toBe('Reinvent keynote');
  });

  test('New Analysis returns to the input view', async () => {
    const tab = await loadTab();
    tab._showAnalysis(ANALYSIS);

    $('sbNewBtn').click();

    expect($('sbInputView').style.display).toBe('');
    expect($('sbReadingView').style.display).toBe('none');
    expect($('sbReanalyzeBtn').classList.contains('d-none')).toBe(true);
  });
});

describe('inline rename', () => {
  test('swaps the title for an input, since Electron has no window.prompt', async () => {
    const tab = await loadTab();
    tab._showAnalysis(ANALYSIS);

    tab._beginRename();

    expect($('sbTitleInput').classList.contains('d-none')).toBe(false);
    expect($('sbTitle').classList.contains('d-none')).toBe(true);
    expect($('sbTitleInput').value).toBe('Reinvent keynote');
  });

  test('committing sends the new name', async () => {
    const tab = await loadTab();
    tab._showAnalysis(ANALYSIS);
    tab._beginRename();
    $('sbTitleInput').value = 'Board version';

    tab._endRename(true);
    await flush();

    expect(mockElectronAPI.invoke).toHaveBeenCalledWith('storyboard-rename', {
      id: 'sb-test-000001', displayName: 'Board version',
    });
  });

  test('cancelling changes nothing', async () => {
    const tab = await loadTab();
    tab._showAnalysis(ANALYSIS);
    tab._beginRename();
    $('sbTitleInput').value = 'Discarded';

    tab._endRename(false);
    await flush();

    const renames = mockElectronAPI.invoke.mock.calls.filter(([c]) => c === 'storyboard-rename');
    expect(renames).toHaveLength(0);
    expect($('sbTitle').classList.contains('d-none')).toBe(false);
  });

  test('an empty name is not saved', async () => {
    const tab = await loadTab();
    tab._showAnalysis(ANALYSIS);
    tab._beginRename();
    $('sbTitleInput').value = '   ';

    tab._endRename(true);
    await flush();

    expect(mockElectronAPI.invoke.mock.calls.filter(([c]) => c === 'storyboard-rename')).toHaveLength(0);
  });
});

describe('revision badge', () => {
  test('is hidden for a standalone analysis', async () => {
    const tab = await loadTab();
    mockElectronAPI.invoke.mockImplementation((channel) => {
      if (channel === 'storyboard-revisions') return Promise.resolve([{ id: ANALYSIS.id }]);
      return Promise.resolve(undefined);
    });

    await tab._showRevisionBadge(ANALYSIS.id);

    expect($('sbRevision').classList.contains('d-none')).toBe(true);
  });

  test('shows the position in the chain when an analysis supersedes another', async () => {
    // Chaining is pointless if it is never surfaced.
    const tab = await loadTab();
    mockElectronAPI.invoke.mockImplementation((channel) => {
      if (channel === 'storyboard-revisions') {
        return Promise.resolve([
          { id: 'sb-older-00001', displayName: 'draft 1', createdAt: 1000 },
          { id: ANALYSIS.id, displayName: 'draft 2', createdAt: 2000 },
        ]);
      }
      return Promise.resolve(undefined);
    });

    await tab._showRevisionBadge(ANALYSIS.id);

    expect($('sbRevision').classList.contains('d-none')).toBe(false);
    expect($('sbRevision').textContent).toBe('Revision 2 of 2');
    expect($('sbRevision').title).toContain('draft 1');
  });

  test('a failed lookup does not break the view', async () => {
    const tab = await loadTab();
    mockElectronAPI.invoke.mockImplementation(() => Promise.reject(new Error('boom')));

    await expect(tab._showRevisionBadge(ANALYSIS.id)).resolves.toBeUndefined();
    expect($('sbRevision').classList.contains('d-none')).toBe(true);
  });
});

describe('HTML export', () => {
  const build = () => window.StoryboardExport.buildHtml(ANALYSIS, ELEMENTS);

  beforeEach(async () => { await loadTab(); });

  test('is a complete standalone document', () => {
    const html = build();
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('</html>');
  });

  test('references nothing external, so it works offline and in two years', () => {
    // No CDN script, no stylesheet link, no webfont request.
    const html = build();
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
  });

  test('carries every paragraph of the script', () => {
    const html = build();
    expect((html.match(/data-element=/g) || [])).toHaveLength(4);
    expect(html).toContain('AI agents are not making it to production at scale.');
  });

  test('carries all seven colours and the legend', () => {
    const html = build();
    for (const e of ELEMENTS) expect(html).toContain(e.hex);
    expect(html).toContain('Call to Action');
  });

  test('includes the audit', () => {
    const html = build();
    expect(html).toContain('Strong problem framing');
    expect(html).toContain('Add a closing vision');
  });

  test('escapes script text so an export cannot execute injected markup', () => {
    const html = window.StoryboardExport.buildHtml({
      ...ANALYSIS,
      units: [{ index: 1, text: '<script>alert(1)</script>', children: [], kind: 'paragraph' }],
      classifications: { 1: 'problem' },
      audit: null,
    }, ELEMENTS);

    // The only <script> in the document is the one we wrote ourselves.
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('records provenance in the footer', () => {
    const html = build();
    expect(html).toContain('3,281 words');
    expect(html).toContain('opus-id');
  });

  test('produces a filesystem-safe name', () => {
    const { safeFileName } = window.StoryboardExport;
    expect(safeFileName('From Models to Agents at Scale')).toBe('from-models-to-agents-at-scale.html');
    expect(safeFileName('keynote.docx')).toBe('keynote.html');
    expect(safeFileName('a/b\\c:d*?.md')).toBe('abcd.html');
    expect(safeFileName('')).toBe('storybrand-analysis.html');
  });

  test('survives an analysis with no audit', () => {
    const html = window.StoryboardExport.buildHtml({ ...ANALYSIS, audit: null }, ELEMENTS);
    expect(html).toContain('</html>');
    expect(html).not.toContain('class="audit"');
  });
});
