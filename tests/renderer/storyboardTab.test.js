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
  // Same order as index.html's script tags. storyboardFlow must come first: the
  // tab calls window.StoryboardFlow while rendering, and that dependency is
  // deliberately not defended against — a forgotten script tag should break
  // loudly here rather than silently render a script with no ribbon.
  require('../../src/renderer/storyboardFlow.js');
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
    tab._renderAudit(ANALYSIS);

    const cards = $('sbAuditBody').querySelectorAll('.sb-audit-element');
    expect(cards).toHaveLength(7);
    expect($('sbAuditBody').textContent).toContain('Strong');
    expect($('sbAuditBody').textContent).toContain('Missing');
  });

  test('shows the issue and fix for a weak element', async () => {
    const tab = await loadTab();
    tab._renderAudit(ANALYSIS);

    const body = $('sbAuditBody').textContent;
    expect(body).toContain('No transformation shown');
    expect(body).toContain('Add a closing vision');
  });

  test('shows the overall verdict and both lists', async () => {
    const tab = await loadTab();
    tab._renderAudit(ANALYSIS);

    const body = $('sbAuditBody').textContent;
    expect(body).toContain('Strong problem framing');
    expect(body).toContain('Clear stakes');
    expect(body).toContain('Name the villain');
  });

  test('says so when there is no audit rather than rendering blank', async () => {
    const tab = await loadTab();
    tab._renderAudit({ audit: null });
    expect($('sbAuditBody').textContent).toMatch(/No audit/i);
  });

  test('marks elements the model did not rate as unrated', async () => {
    const tab = await loadTab();
    tab._renderAudit({ audit: { elements: {}, whatsWorking: [], quickWins: [] } });
    expect($('sbAuditBody').textContent).toContain('Unrated');
  });

  test('escapes audit text', async () => {
    const tab = await loadTab();
    tab._renderAudit({ audit: { overall: '<img src=x onerror="alert(1)">', elements: {} } });
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


describe('the page loads the flow module before the tab that needs it', () => {
  test('storyboardFlow.js is loaded, and before storyboardTab.js', () => {
    // The tab calls window.StoryboardFlow during render, so the order is load
    // bearing and invisible from the tab's own code.
    const html = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'pages', 'index.html'),
      'utf8',
    );
    const flowAt = html.indexOf('storyboardFlow.js');
    const tabAt = html.indexOf('storyboardTab.js');

    expect(flowAt).toBeGreaterThan(-1);
    expect(tabAt).toBeGreaterThan(-1);
    expect(flowAt).toBeLessThan(tabAt);
  });
});

/**
 * The flow ribbon's behaviour in the tab.
 *
 * buildFlow's grouping is covered in storyboardFlow.test.js; this covers the
 * parts that only exist once it is on screen — that a segment points at the right
 * paragraph, that widths carry the run's share, and that a script with no
 * structure does not get a bar implying it has some.
 */
describe('the flow ribbon', () => {
  /** An analysis with three distinct runs. */
  function threeRunAnalysis() {
    return {
      id: 'a1',
      displayName: 'Test',
      units: [
        { index: 1, text: 'one two three four five six seven eight nine ten', kind: 'paragraph' },
        { index: 2, text: 'eleven twelve', kind: 'paragraph' },
        { index: 3, text: 'thirteen', kind: 'paragraph' },
      ],
      classifications: { 1: 'character', 2: 'problem', 3: 'success' },
      audit: null,
      modelId: 'm',
      analysedAt: new Date().toISOString(),
    };
  }

  beforeEach(() => {
    document.getElementById('sbFlowTrack').innerHTML = '';
    document.getElementById('sbFlow').style.display = '';
  });

  test('draws one segment per run, in document order', () => {
    window.StoryboardTab._render(threeRunAnalysis());

    const segs = [...document.querySelectorAll('#sbFlowTrack .sb-flow-seg')];
    expect(segs).toHaveLength(3);
    expect(segs.map(s => s.dataset.index)).toEqual(['1', '2', '3']);
  });

  test('segment width carries the run\'s share of the words', () => {
    // Not paragraph count: the first run is ten words of a thirteen-word script
    // and must dominate, or the ribbon misrepresents the talk.
    window.StoryboardTab._render(threeRunAnalysis());

    const grows = [...document.querySelectorAll('#sbFlowTrack .sb-flow-seg')]
      .map(s => parseFloat(s.style.flexGrow));

    expect(grows[0]).toBeGreaterThan(grows[1]);
    expect(grows[1]).toBeGreaterThan(grows[2]);
    expect(grows[0]).toBeCloseTo(1000 * 10 / 13, 0);
  });

  test('each segment names its element, range and size for hover and screen readers', () => {
    window.StoryboardTab._render(threeRunAnalysis());

    const first = document.querySelector('#sbFlowTrack .sb-flow-seg');
    expect(first.getAttribute('title')).toMatch(/paragraph 1/);
    expect(first.getAttribute('title')).toMatch(/10 words/);
    expect(first.getAttribute('aria-label')).toMatch(/^Jump to /);
  });

  test('carries the element colour class so the ribbon matches the script', () => {
    window.StoryboardTab._render(threeRunAnalysis());

    const segs = [...document.querySelectorAll('#sbFlowTrack .sb-flow-seg')];
    // Whatever the palette says, not a hardcoded list here — the definitions are
    // the single source of truth for colour.
    const slugFor = key => ELEMENTS.find(e => e.key === key).slug;
    expect(segs[0].className).toContain(`sb-fc-${slugFor('character')}`);
    expect(segs[1].className).toContain(`sb-fc-${slugFor('problem')}`);
    expect(segs[2].className).toContain(`sb-fc-${slugFor('success')}`);
  });

  test('is hidden for a script with only one run', () => {
    // A single full-width bar implies structure the script does not have.
    window.StoryboardTab._render({
      ...threeRunAnalysis(),
      classifications: { 1: 'character', 2: 'character', 3: 'character' },
    });

    expect(document.getElementById('sbFlow').style.display).toBe('none');
    expect(document.querySelectorAll('#sbFlowTrack .sb-flow-seg')).toHaveLength(0);
  });

  test('clicking a segment scrolls that run\'s first paragraph into view', () => {
    window.StoryboardTab._render(threeRunAnalysis());
    const scroll = document.getElementById('sbScroll');
    const scrollTo = jest.fn();
    scroll.scrollTo = scrollTo;
    // jsdom reports zero geometry, so give the target an offset to aim at.
    const target = document.querySelector('#sbSurface [data-index="3"]');
    Object.defineProperty(target, 'offsetTop', { value: 900, configurable: true });
    Object.defineProperty(scroll, 'clientHeight', { value: 400, configurable: true });

    document.querySelector('#sbFlowTrack .sb-flow-seg[data-index="3"]').click();

    expect(scrollTo).toHaveBeenCalledTimes(1);
    // Offset back by a quarter viewport so the paragraph lands where the rail's
    // anchor is rather than flush under the glass bar.
    expect(scrollTo.mock.calls[0][0].top).toBe(900 - 100);
  });

  test('never scrolls to a negative offset for an early paragraph', () => {
    window.StoryboardTab._render(threeRunAnalysis());
    const scroll = document.getElementById('sbScroll');
    scroll.scrollTo = jest.fn();
    Object.defineProperty(scroll, 'clientHeight', { value: 400, configurable: true });
    const target = document.querySelector('#sbSurface [data-index="1"]');
    Object.defineProperty(target, 'offsetTop', { value: 10, configurable: true });

    document.querySelector('#sbFlowTrack .sb-flow-seg[data-index="1"]').click();

    expect(scroll.scrollTo.mock.calls[0][0].top).toBe(0);
  });

  test('the caption reports the run currently being read', () => {
    // A live readout of position is more use than a static summary, and it is
    // what makes the ribbon a minimap rather than a legend. Which run that is
    // here depends on geometry jsdom does not have, so this asserts the shape of
    // the readout rather than a specific run.
    window.StoryboardTab._render(threeRunAnalysis());

    const caption = document.getElementById('sbFlowCaption');
    expect(caption.textContent).toMatch(/paragraph \d/);
    expect(caption.textContent).toMatch(/words/);
    expect(caption.classList.contains('is-detail')).toBe(true);
  });

  test('the caption falls back to an affordance hint when no run is current', () => {
    // The state before any position is known — it has to say what the ribbon is
    // for, since an unlabelled strip of colour explains nothing.
    window.StoryboardTab._render(threeRunAnalysis());

    window.StoryboardTab._flowCaption(-1);

    const caption = document.getElementById('sbFlowCaption');
    expect(caption.textContent).toMatch(/3 sections/);
    expect(caption.textContent).toMatch(/click to jump/);
    expect(caption.classList.contains('is-detail')).toBe(false);
  });

  test('hovering a segment reports its element, range and share', () => {
    window.StoryboardTab._render(threeRunAnalysis());

    document.querySelector('#sbFlowTrack .sb-flow-seg[data-index="2"]')
      .dispatchEvent(new MouseEvent('mouseenter'));

    const caption = document.getElementById('sbFlowCaption').textContent;
    expect(caption).toMatch(/paragraph 2/);
    expect(caption).toMatch(/2 words/);
  });
});

/**
 * The flow ribbon in the standalone export.
 *
 * The export has to carry the same overview as the tab, and must stay
 * self-contained — no stylesheet, no font and no script of ours behind it, so the
 * ribbon's colours are inlined and its behaviour ships in the document.
 */
describe('the exported flow ribbon', () => {
  function analysisWithRuns() {
    return {
      id: 'e1',
      displayName: 'Export test',
      sourceName: 'keynote.docx',
      units: [
        { index: 1, text: 'alpha beta gamma delta', kind: 'paragraph' },
        { index: 2, text: 'epsilon zeta', kind: 'paragraph' },
        { index: 3, text: 'eta', kind: 'paragraph' },
      ],
      classifications: { 1: 'character', 2: 'problem', 3: 'guide' },
      audit: null,
      modelId: 'model-x',
      analysedAt: new Date().toISOString(),
    };
  }

  const exportHtml = (analysis) =>
    window.StoryboardExport.buildHtml(analysis, ELEMENTS);

  test('includes a segment per run, with inlined colours', () => {
    const html = exportHtml(analysisWithRuns());

    const segs = html.match(/class="flow-seg"/g) || [];
    expect(segs).toHaveLength(3);
    // Hex, not a custom property from our stylesheet — nothing of ours is present.
    expect(html).toContain(ELEMENTS.find(e => e.key === 'character').hex);
  });

  test('every script block carries data-index so click-to-jump can resolve a target', () => {
    // The ribbon's segments point at paragraphs by index; without these the
    // clicks would silently do nothing in an exported file.
    //
    // Parsed rather than string-matched. A toContain('data-index="1"') check
    // passes on the *segments*, which carry the same attribute — it looked like
    // coverage and verified nothing.
    const html = exportHtml(analysisWithRuns());
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const blocks = [...doc.querySelectorAll('.surface [data-index]')];
    expect(blocks.map(b => b.getAttribute('data-index'))).toEqual(['1', '2', '3']);

    // And every segment's target actually exists in the document.
    for (const seg of doc.querySelectorAll('.flow-seg')) {
      const target = seg.getAttribute('data-index');
      expect(doc.querySelector(`.surface [data-index="${target}"]`)).not.toBeNull();
    }
  });

  test('segment widths carry each run\'s share of the words', () => {
    const html = exportHtml(analysisWithRuns());

    const grows = [...html.matchAll(/flex-grow:([\d.]+)/g)].map(m => parseFloat(m[1]));
    expect(grows).toHaveLength(3);
    expect(grows[0]).toBeGreaterThan(grows[1]);
    expect(grows[1]).toBeGreaterThan(grows[2]);
  });

  test('is omitted for a script with a single run', () => {
    const html = exportHtml({
      ...analysisWithRuns(),
      classifications: { 1: 'character', 2: 'character', 3: 'character' },
    });

    expect(html).not.toContain('class="flow-seg"');
    expect(html).not.toContain('id="flowTrack"');
  });

  test('stays entirely self-contained', () => {
    // The guarantee the whole export rests on: it must render identically on
    // someone else's machine, offline, in two years.
    const html = exportHtml(analysisWithRuns());

    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  test('the ribbon script ships in the document', () => {
    const html = exportHtml(analysisWithRuns());

    expect(html).toContain('flow-seg');
    expect(html).toContain('markFlow');
    expect(html).toContain('prefers-reduced-motion');
  });
});

/**
 * The StoryBrand 2.0 audit sections.
 *
 * Three sections were added: the 4 Rules, the P.E.A.C.E. soundbites, and AWS brand
 * alignment. The behaviour that matters most is what happens when they are
 * *absent* — an analysis saved before they existed, or a model call that failed
 * this run. An empty section reads as "nothing to report", which is the opposite
 * of "not assessed", so absence has to be explicit or silent, never blank.
 */
describe('the 2.0 audit sections', () => {
  const fullAudit = () => ({
    overall: 'Solid arc.',
    elements: Object.fromEntries(ELEMENTS.map(e => [e.key, { status: 'strong', score: 9, found: '', issue: '', fix: '' }])),
    rules: {
      'zero-cognitive-load': { verdict: 'pass', evidence: 'plain words', note: '' },
      survival: { verdict: 'fail', evidence: '22% faster', note: 'lead with the benefit' },
      memorable: { verdict: 'pass', evidence: '', note: '' },
      'customer-hero': { verdict: 'pass', evidence: '', note: '' },
    },
    soundbites: {
      problem: { status: 'strong', found: 'the barking', suggestion: '' },
      empathy: { status: 'weak', found: '', suggestion: 'say you understand' },
      answer: { status: 'strong', found: '', suggestion: '' },
      change: { status: 'missing', found: '', suggestion: 'name who they become' },
      endResult: { status: 'strong', found: '', suggestion: '' },
    },
    whatsWorking: ['clear problem'],
    quickWins: ['add empathy'],
  });

  const fullBrand = () => ({
    score: 74,
    verdict: 'Close, but the opening centres AWS.',
    dimensions: {
      persona: { status: 'weak', score: 6, found: 'we built', issue: 'AWS as hero', fix: 'lead with you' },
      positioning: { status: 'strong', score: 9, found: '', issue: '', fix: '' },
      traits: { status: 'strong', score: 8, found: '', issue: '', fix: '' },
      voice: { status: 'weak', score: 7, found: '', issue: '', fix: '' },
      craft: { status: 'strong', score: 8, found: '', issue: '', fix: '' },
    },
    naturalAlignment: 'Guide and champion agree.',
    tensions: ['The tightest line loses the double-take.'],
    outOfScope: ['Slide colour is visual.'],
  });

  const body = () => document.getElementById('sbAuditBody');

  let tab;
  beforeEach(async () => { tab = await loadTab(); });

  test('renders the 4 Rules with pass and fail verdicts', () => {
    tab._renderAudit({ audit: fullAudit() });

    const text = body().textContent;
    expect(text).toContain('The 4 Rules of Messaging');
    expect(text).toContain('Linked to survival');
    expect(body().querySelectorAll('.sb-rule-verdict.is-fail')).toHaveLength(1);
    expect(body().querySelectorAll('.sb-rule-verdict.is-pass')).toHaveLength(3);
  });

  test('renders the five soundbites in P.E.A.C.E. order', () => {
    // The order is part of the framework; a scorecard that reorders them stops
    // matching what the skill teaches.
    tab._renderAudit({ audit: fullAudit() });

    const names = [...body().querySelectorAll('.sb-soundbite-name')].map(n => n.textContent);
    expect(names).toEqual(['Problem', 'Empathy', 'Answer', 'Change', 'End result']);
  });

  test('leads the brand section with its score and bands it', () => {
    tab._renderAudit({ audit: fullAudit(), brandAlignment: fullBrand() });

    const score = body().querySelector('.sb-brand-score');
    expect(score).not.toBeNull();
    expect(score.textContent).toContain('74');
    expect(score.textContent).toContain('/100');
    // 74 is mixed, not good — a bare number with no band is unreadable.
    expect(score.classList.contains('is-mixed')).toBe(true);
  });

  test('bands the score by range', () => {
    const band = (score) => {
      tab._renderAudit({ audit: fullAudit(), brandAlignment: { ...fullBrand(), score } });
      const el = body().querySelector('.sb-brand-score');
      return ['is-good', 'is-mixed', 'is-poor'].find(c => el.classList.contains(c));
    };

    expect(band(92)).toBe('is-good');
    expect(band(64)).toBe('is-mixed');
    expect(band(31)).toBe('is-poor');
  });

  test('calls out where the two frameworks agree', () => {
    // Worth surfacing rather than burying: it is the one place StoryBrand and the
    // AWS brand reinforce each other.
    tab._renderAudit({ audit: fullAudit(), brandAlignment: fullBrand() });

    expect(body().querySelector('.sb-brand-agrees').textContent).toContain('Guide and champion agree');
  });

  test('omits the new sections entirely for an analysis that predates them', () => {
    // The key degradation case. Four "Unrated" rules and five "Unrated" soundbites
    // would read as findings about the script rather than as an absence of data.
    tab._renderAudit({
      audit: {
        overall: 'old analysis',
        elements: Object.fromEntries(ELEMENTS.map(e => [e.key, { status: 'strong', score: null }])),
        rules: Object.fromEntries(['zero-cognitive-load', 'survival', 'memorable', 'customer-hero']
          .map(k => [k, { verdict: 'unknown', evidence: '', note: '' }])),
        soundbites: Object.fromEntries(['problem', 'empathy', 'answer', 'change', 'endResult']
          .map(k => [k, { status: 'unknown', found: '', suggestion: '' }])),
        whatsWorking: [],
        quickWins: [],
      },
    });

    const text = body().textContent;
    expect(text).toContain('old analysis');
    expect(text).not.toContain('The 4 Rules of Messaging');
    expect(text).not.toContain('The 5 Soundbites');
    expect(text).not.toContain('AWS brand alignment');
  });

  test('omits element scores that were never assessed', () => {
    tab._renderAudit({
      audit: { overall: '', elements: { character: { status: 'strong', score: null } } },
    });

    expect(body().querySelectorAll('.sb-audit-score')).toHaveLength(0);
  });

  test('says so when the brand call failed this run', () => {
    // Distinguishes a transient failure from a permanent gap — otherwise the user
    // has no idea Re-analyse would help.
    tab._renderAudit({ audit: fullAudit(), brandAlignment: null, incomplete: ['brand alignment'] });

    const text = body().textContent;
    expect(text).toContain('AWS brand alignment');
    expect(text).toMatch(/could not be produced/i);
    expect(text).toMatch(/Re-analyse/i);
  });

  test('says so when the audit call failed but the brand check succeeded', () => {
    tab._renderAudit({ audit: null, brandAlignment: fullBrand(), incomplete: ['audit'] });

    const text = body().textContent;
    expect(text).toMatch(/StoryBrand audit could not be produced/i);
    // The brand check still renders — that is the point of splitting the calls.
    expect(body().querySelector('.sb-brand-score')).not.toBeNull();
  });

  test('reports both failures rather than looking empty', () => {
    tab._renderAudit({ audit: null, brandAlignment: null, incomplete: ['audit', 'brand alignment'] });

    expect(body().textContent).toMatch(/audit and brand alignment could not be produced/i);
  });

  test('still says nothing was returned for an analysis with no audit at all', () => {
    tab._renderAudit({ audit: null });

    expect(body().textContent).toMatch(/No audit was returned/i);
  });

  test('escapes model text in the new sections', () => {
    tab._renderAudit({
      audit: { ...fullAudit(), rules: { survival: { verdict: 'fail', evidence: '<img src=x onerror="alert(1)">', note: '' } } },
      brandAlignment: { ...fullBrand(), verdict: '<script>alert(1)</script>' },
    });

    expect(body().querySelector('img')).toBeNull();
    expect(body().querySelector('script')).toBeNull();
  });
});

describe('the export carries the 2.0 audit sections', () => {
  const withEverything = () => ({
    id: 'x', displayName: 'Keynote', sourceName: 'k.docx',
    units: [{ index: 1, text: 'one two three', kind: 'paragraph' }, { index: 2, text: 'four', kind: 'paragraph' }],
    classifications: { 1: 'character', 2: 'problem' },
    audit: {
      overall: 'Reads well.',
      elements: Object.fromEntries(ELEMENTS.map(e => [e.key, { status: 'strong', score: 9, found: '', issue: '', fix: '' }])),
      rules: {
        'zero-cognitive-load': { verdict: 'pass', evidence: 'plain', note: '' },
        survival: { verdict: 'fail', evidence: 'specs first', note: 'lead with the benefit' },
        memorable: { verdict: 'pass', evidence: '', note: '' },
        'customer-hero': { verdict: 'pass', evidence: '', note: '' },
      },
      soundbites: {
        problem: { status: 'strong', found: 'the stall', suggestion: '' },
        empathy: { status: 'weak', found: '', suggestion: 'show you understand' },
        answer: { status: 'strong', found: '', suggestion: '' },
        change: { status: 'missing', found: '', suggestion: 'name who they become' },
        endResult: { status: 'strong', found: '', suggestion: '' },
      },
      whatsWorking: ['clear problem'], quickWins: ['add empathy'],
    },
    brandAlignment: {
      score: 74, verdict: 'Close.',
      dimensions: {
        persona: { status: 'weak', score: 6, found: 'we built', issue: 'AWS as hero', fix: 'lead with you' },
        positioning: { status: 'strong', score: 9, found: '', issue: '', fix: '' },
        traits: { status: 'strong', score: 8, found: '', issue: '', fix: '' },
        voice: { status: 'weak', score: 7, found: '', issue: '', fix: '' },
        craft: { status: 'strong', score: 8, found: '', issue: '', fix: '' },
      },
      naturalAlignment: 'Guide and champion agree.',
      tensions: ['clarity versus spark'], outOfScope: ['slide colour'],
    },
    incomplete: [],
    modelId: 'm', analysedAt: Date.now(),
  });

  const html = (a) => window.StoryboardExport.buildHtml(a, ELEMENTS);

  test('includes all three new sections', () => {
    const out = html(withEverything());

    expect(out).toContain('The 4 Rules of Messaging');
    expect(out).toContain('The 5 Soundbites');
    expect(out).toContain('AWS brand alignment');
    expect(out).toContain('74');
  });

  test('bands the brand score, so the number has a scale', () => {
    expect(html({ ...withEverything(), brandAlignment: { ...withEverything().brandAlignment, score: 91 } }))
      .toMatch(/brand-score good/);
    expect(html(withEverything())).toMatch(/brand-score mixed/);
    expect(html({ ...withEverything(), brandAlignment: { ...withEverything().brandAlignment, score: 22 } }))
      .toMatch(/brand-score poor/);
  });

  test('omits the new sections for an analysis that predates them', () => {
    // The realistic shape: _readAudit fills every rule and soundbite key with
    // 'unknown' for a stored analysis that has none, so the keys are *present* and
    // empty rather than absent. A fixture that deletes them entirely tests a state
    // the app never produces — and lets a check on presence pass where a check on
    // content is what is needed.
    const old = withEverything();
    old.audit = {
      overall: 'old analysis',
      elements: Object.fromEntries(ELEMENTS.map(e => [e.key, { status: 'strong', score: null }])),
      rules: Object.fromEntries(['zero-cognitive-load', 'survival', 'memorable', 'customer-hero']
        .map(k => [k, { verdict: 'unknown', evidence: '', note: '' }])),
      soundbites: Object.fromEntries(['problem', 'empathy', 'answer', 'change', 'endResult']
        .map(k => [k, { status: 'unknown', found: '', suggestion: '' }])),
      whatsWorking: [], quickWins: [],
    };
    old.brandAlignment = null;
    old.incomplete = [];

    const out = html(old);

    expect(out).toContain('old analysis');
    expect(out).not.toContain('The 4 Rules of Messaging');
    expect(out).not.toContain('The 5 Soundbites');
    expect(out).not.toContain('AWS brand alignment');
  });

  test('says so when a call was unavailable at analysis time', () => {
    const a = withEverything();
    a.brandAlignment = null;
    a.incomplete = ['brand alignment'];

    const out = html(a);

    expect(out).toContain('AWS brand alignment');
    expect(out).toMatch(/not available when the analysis ran/);
  });

  test('stays self-contained with the new sections present', () => {
    // The guarantee the whole export rests on.
    const out = html(withEverything());

    expect(out).not.toMatch(/<link[^>]+stylesheet/i);
    expect(out).not.toMatch(/<script[^>]+src=/i);
    expect(out).not.toMatch(/https?:\/\//);
  });

  test('escapes model text in the new sections', () => {
    const a = withEverything();
    a.audit.rules.survival.note = '<img src=x onerror="alert(1)">';
    a.brandAlignment.verdict = '<script>alert(1)</script>';

    const out = html(a);
    const doc = new DOMParser().parseFromString(out, 'text/html');

    expect(doc.querySelector('.audit img')).toBeNull();
    expect(doc.querySelector('.audit script')).toBeNull();
  });
});
