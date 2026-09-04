/**
 * storyboardTab.js — StoryBrand analysis tab controller.
 *
 * Lazy-initialised on first tab visit, like every other tab here.
 *
 * The rendering rule that matters: every word on screen comes from the units the
 * main process extracted from the user's file. The analysis contributes a map of
 * unit index to element key and nothing else. If that map is missing an index, the
 * paragraph is not drawn in a fallback colour — the analyzer refuses to return a
 * partial result at all, so this side never has to guess.
 *
 * The reference design is a standalone page and binds its scroll behaviour to
 * `window`. Inside a tab the scroll container is a div, so the IntersectionObserver
 * needs an explicit `root` and the scroll listener has to be on the container.
 * Getting that wrong is silent: the reveal animations and the scroll-aware rail
 * simply never fire.
 */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  /** Escape text for insertion as HTML. The script is user content. */
  function esc(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  // ── State ────────────────────────────────────────────────────────────────

  let elements = [];              // definitions from the main process
  let elementsByKey = new Map();
  let pending = null;             // { units, sourceName, format, wordCount }
  let current = null;             // the saved analysis being displayed
  let searchTimer = null;
  let revealObserver = null;
  let activeElementKey = null;
  let inited = false;

  // ── Init ─────────────────────────────────────────────────────────────────

  async function init() {
    if (inited) return;
    inited = true;

    try {
      elements = await window.electronAPI.invoke('storyboard-get-elements') || [];
    } catch {
      elements = [];
    }
    elementsByKey = new Map(elements.map(e => [e.key, e]));

    renderLegend();
    await populateModels();
    bindInput();
    bindReadingView();
    bindSidebar();
    await refreshList();

    // The Analyse button is AWS-dependent, so it must obey the same gating as
    // every other model call — offline *or* rejected credentials.
    window.OfflineGuard?.refresh();
  }

  // ── Model dropdown ───────────────────────────────────────────────────────

  async function populateModels() {
    const select = $('sbModelSelect');
    if (!select) return;
    try {
      const models = await window.electronAPI.invoke('get-bedrock-models') || [];
      select.innerHTML = models
        .map(m => `<option value="${esc(m.inferenceProfileId)}"${m.role === 'creator' ? ' selected' : ''}>${esc(m.id)}</option>`)
        .join('');
    } catch {
      select.innerHTML = '<option value="">No models configured</option>';
    }
  }

  // ── Input view ───────────────────────────────────────────────────────────

  function bindInput() {
    const dropzone = $('sbDropzone');
    const fileInput = $('sbFileInput');

    dropzone?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) await loadFile(file);
      e.target.value = '';
    });

    ['dragenter', 'dragover'].forEach(type => {
      dropzone?.addEventListener(type, (e) => {
        e.preventDefault();
        dropzone.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(type => {
      dropzone?.addEventListener(type, () => dropzone.classList.remove('is-dragover'));
    });
    dropzone?.addEventListener('drop', async (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file) await loadFile(file);
    });

    // Pasting is debounced through the same extraction path as a file, so the
    // preview and the analysis always agree on how the text was split.
    let pasteTimer = null;
    $('sbPasteInput')?.addEventListener('input', (e) => {
      clearTimeout(pasteTimer);
      const text = e.target.value;
      pasteTimer = setTimeout(() => loadText(text), 350);
    });

    $('sbAnalyzeBtn')?.addEventListener('click', runAnalysis);
    $('sbNewBtn')?.addEventListener('click', showInputView);
  }

  function showError(message) {
    const el = $('sbInputError');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('is-visible', !!message);
  }

  async function loadFile(file) {
    showError('');
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      pending = await window.electronAPI.invoke('storyboard-extract', {
        name: file.name,
        content: Array.from(buffer),
      });
      $('sbPasteInput').value = '';
      describePending();
    } catch (err) {
      pending = null;
      describePending();
      showError(err.message);
    }
  }

  async function loadText(text) {
    showError('');
    if (!String(text || '').trim()) { pending = null; describePending(); return; }
    try {
      pending = await window.electronAPI.invoke('storyboard-extract-text', { text });
      describePending();
    } catch (err) {
      pending = null;
      describePending();
      showError(err.message);
    }
  }

  function describePending() {
    const meta = $('sbInputMeta');
    const btn = $('sbAnalyzeBtn');
    if (pending) {
      const units = pending.units.length;
      meta.textContent = `${pending.sourceName} — ${units} paragraph${units === 1 ? '' : 's'}, ${pending.wordCount.toLocaleString()} words`;
    } else {
      meta.textContent = '';
    }
    // Never force-enable: OfflineGuard may be holding this disabled because AWS
    // is unreachable, and re-enabling here would undo that.
    if (btn && !btn.classList.contains('offline-disabled')) btn.disabled = !pending;
  }

  async function runAnalysis() {
    if (!pending) return;
    const btn = $('sbAnalyzeBtn');
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Analysing…';
    $('navStoryboardSpinner')?.classList.remove('d-none');
    showError('');

    try {
      const saved = await window.electronAPI.invoke('storyboard-analyze', {
        ...pending,
        modelId: $('sbModelSelect')?.value || undefined,
      });
      pending = null;
      $('sbPasteInput').value = '';
      await refreshList();
      showAnalysis(saved);
    } catch (err) {
      showError(err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
      $('navStoryboardSpinner')?.classList.add('d-none');
      describePending();
    }
  }

  // ── Reading view ─────────────────────────────────────────────────────────

  function renderLegend() {
    const legend = $('sbLegend');
    if (!legend) return;
    legend.innerHTML = elements.map(e => `
      <span class="sb-legend-item">
        <span class="sb-dot" style="background: var(--sb-${e.slug})"></span>${esc(e.label)}
      </span>`).join('');
  }

  function showInputView() {
    current = null;
    $('sbInputView').style.display = '';
    $('sbReadingView').style.display = 'none';
    // Through the helper so the toggle's state resets with it — returning to the
    // input view with aria-expanded left true would report a panel that is gone.
    setAuditOpen(false);
    $('sbReanalyzeBtn').classList.add('d-none');
    $('sbExportBtn').classList.add('d-none');
    $('sbTitle').textContent = 'StoryBrand';
    highlightActive(null);
  }

  function showAnalysis(analysis) {
    current = analysis;
    $('sbInputView').style.display = 'none';
    $('sbReadingView').style.display = '';
    $('sbReanalyzeBtn').classList.remove('d-none');
    $('sbExportBtn').classList.remove('d-none');
    $('sbTitle').textContent = analysis.displayName || 'Analysis';
    renderScript(analysis);
    renderAudit(analysis);
    highlightActive(analysis.id);
    $('sbScroll').scrollTop = 0;
    showRevisionBadge(analysis.id);
  }

  /**
   * Show where this analysis sits in its revision history.
   *
   * Without this the `revisionOf` links are stored and never surfaced, which is
   * the whole point of chaining them — seeing that this is the third pass at a
   * script is what makes comparing passes possible.
   */
  async function showRevisionBadge(id) {
    const badge = $('sbRevision');
    if (!badge) return;
    badge.classList.add('d-none');
    try {
      const chain = await window.electronAPI.invoke('storyboard-revisions', id);
      if (!Array.isArray(chain) || chain.length < 2) return;
      const position = chain.findIndex(c => c.id === id) + 1;
      badge.textContent = `Revision ${position} of ${chain.length}`;
      badge.title = chain
        .map((c, i) => `${i + 1}. ${c.displayName} — ${new Date(c.createdAt).toLocaleDateString()}`)
        .join('\n');
      badge.classList.remove('d-none');
    } catch { /* the badge is informational; never block the view on it */ }
  }

  /**
   * Draw the script.
   *
   * Text comes from `analysis.units`; the classification only decides which colour
   * class each unit carries. A unit with no classification would render uncoloured,
   * but the analyzer refuses partial results, so that state should be unreachable.
   */
  function renderScript(analysis) {
    const surface = $('sbSurface');
    if (!surface) return;

    const html = analysis.units.map(unit => {
      const key = analysis.classifications?.[unit.index];
      const def = elementsByKey.get(key);
      const colour = def ? ` sb-c-${def.slug}` : '';
      const tag = unit.kind === 'heading'
        ? (unit.level === 1 ? 'sb-h1' : unit.level === 2 ? 'sb-h2' : 'sb-h3')
        : 'sb-p';

      const children = (unit.children || []).length
        ? `<ul class="sb-children${colour}">${unit.children.map(c => `<li>${esc(c)}</li>`).join('')}</ul>`
        : '';

      return `<div class="${tag}${colour} sb-reveal" data-element="${esc(key || '')}" data-index="${unit.index}">${esc(unit.text)}</div>${children}`;
    }).join('\n');

    surface.innerHTML = html;
    renderFlow(analysis);
    observeReveals();
    updateActiveElement();
  }

  function bindReadingView() {
    // Segmented Colour/Plain toggle.
    $('sbSegColour')?.addEventListener('click', () => setPlain(false));
    $('sbSegPlain')?.addEventListener('click', () => setPlain(true));
    positionThumb();
    window.addEventListener('resize', positionThumb);

    const scroll = $('sbScroll');
    // Scroll must be observed on the container, not the window — the reference
    // design is a full page and this is a div.
    let ticking = false;
    scroll?.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        $('sbGlassbar')?.classList.toggle('is-scrolled', scroll.scrollTop > 4);
        updateActiveElement();
        ticking = false;
      });
    }, { passive: true });

    $('sbAuditToggle')?.addEventListener('click', () => {
      setAuditOpen($('sbAuditPanel').style.display === 'none');
    });
    $('sbAuditClose')?.addEventListener('click', () => setAuditOpen(false));

    // Escape closes it. Not a nicety: the panel is an overlay, and when its only
    // way out was one button it was possible to end up with no way back at all.
    // A second, layout-independent exit means a positioning mistake cannot trap
    // the user again.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const page = $('storyboard-page');
      // Only when this tab is actually showing, or Escape here would swallow the
      // key for whatever else is on screen.
      if (!page || page.classList.contains('d-none')) return;
      if ($('sbContextMenu')?.style.display === 'block') return hideEntryMenu();
      if ($('sbAuditPanel')?.style.display !== 'none') setAuditOpen(false);
    });

    $('sbTitle')?.addEventListener('click', () => { if (current) beginRename(); });
    $('sbTitleInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') endRename(true);
      if (e.key === 'Escape') endRename(false);
    });
    $('sbTitleInput')?.addEventListener('blur', () => endRename(true));

    $('sbReanalyzeBtn')?.addEventListener('click', reanalyze);
    $('sbExportBtn')?.addEventListener('click', exportHtml);
    $('sbSidebarToggle')?.addEventListener('click', () => {
      $('storyboardSidebar')?.classList.toggle('d-none');
    });
  }

  function setPlain(plain) {
    $('sbReadingView')?.classList.toggle('is-plain', plain);
    $('sbSegColour')?.classList.toggle('is-active', !plain);
    $('sbSegPlain')?.classList.toggle('is-active', plain);
    $('sbSegColour')?.setAttribute('aria-pressed', String(!plain));
    $('sbSegPlain')?.setAttribute('aria-pressed', String(plain));
    positionThumb();
  }

  /** Slide the pill thumb under the active segment. */
  function positionThumb() {
    const thumb = $('sbSegThumb');
    const active = $('sbReadingView')?.classList.contains('is-plain') ? $('sbSegPlain') : $('sbSegColour');
    if (!thumb || !active) return;
    thumb.style.width = `${active.offsetWidth}px`;
    thumb.style.transform = `translateX(${active.offsetLeft - 3}px)`;
  }

  function observeReveals() {
    revealObserver?.disconnect();
    const scroll = $('sbScroll');
    const items = $('sbSurface')?.querySelectorAll('.sb-reveal') || [];

    if (!('IntersectionObserver' in window) || !scroll) {
      items.forEach(el => el.classList.add('is-visible'));
      return;
    }
    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      });
    }, { root: scroll, threshold: 0.1, rootMargin: '0px 0px -6% 0px' });

    items.forEach(el => revealObserver.observe(el));
  }

  /**
   * Pick the last classified block whose top has passed the reading anchor, and
   * show that element in the rail.
   */
  // ── Flow ribbon ────────────────────────────────────────────
  //
  // A sequential picture of the talk: one segment per run of consecutive
  // paragraphs sharing an element, in document order, sized by word count.
  //
  // Deliberately not a histogram of element totals. Totals describe composition,
  // which the sidebar shape bar already shows, and composition throws away the
  // one thing a keynote is made of — order. A ribbon shows the arc, and makes a
  // missing element visible as an absent colour rather than as a fact you have to
  // go and check.

  let flowRuns = [];
  let flowActiveRun = -1;

  function renderFlow(analysis) {
    const track = $('sbFlowTrack');
    const wrap = $('sbFlow');
    if (!track || !wrap) return;

    flowRuns = window.StoryboardFlow.buildFlow(analysis.units || [], analysis.classifications || {});
    flowActiveRun = -1;

    if (flowRuns.length <= 1) {
      // One run is not a flow — it is a solid bar that says nothing. Hide rather
      // than draw something that implies structure the script does not have.
      wrap.style.display = 'none';
      track.innerHTML = '';
      return;
    }
    wrap.style.display = '';

    track.innerHTML = flowRuns.map((run, i) => {
      const def = elementsByKey.get(run.key);
      const label = def ? def.label : 'Unclassified';
      const pct = Math.round(run.share * 1000) / 10;
      const range = run.startIndex === run.endIndex
        ? `paragraph ${run.startIndex}`
        : `paragraphs ${run.startIndex}\u2013${run.endIndex}`;
      // flex-grow carries the proportion; flex-basis 0 keeps content from
      // influencing width, so a run's size is its share and nothing else.
      return `<button type="button" class="sb-flow-seg${def ? ` sb-fc-${def.slug}` : ' is-unclassified'}"
        style="flex-grow: ${run.share * 1000}"
        data-run="${i}" data-index="${run.startIndex}"
        title="${esc(label)} \u00b7 ${range} \u00b7 ${run.words.toLocaleString()} words (${pct}%)"
        aria-label="Jump to ${esc(label)}, ${range}"></button>`;
    }).join('');

    track.querySelectorAll('.sb-flow-seg').forEach(seg => {
      seg.addEventListener('click', () => jumpToUnit(Number(seg.dataset.index)));
      seg.addEventListener('mouseenter', () => showFlowCaption(Number(seg.dataset.run)));
      seg.addEventListener('focus', () => showFlowCaption(Number(seg.dataset.run)));
    });
    track.addEventListener('mouseleave', () => showFlowCaption(flowActiveRun));

    // Arrow keys walk the ribbon, so it is navigable without a mouse.
    track.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      const segs = [...track.querySelectorAll('.sb-flow-seg')];
      const at = segs.indexOf(document.activeElement);
      const next = segs[Math.min(segs.length - 1, Math.max(0, at + dir))];
      next?.focus();
    });

    showFlowCaption(-1);
  }

  /** The caption under the ribbon — hover detail without a custom tooltip. */
  function showFlowCaption(runIdx) {
    const caption = $('sbFlowCaption');
    if (!caption) return;
    const run = flowRuns[runIdx];
    if (!run) {
      caption.textContent = `${flowRuns.length} sections \u00b7 hover to inspect, click to jump`;
      caption.classList.remove('is-detail');
      return;
    }
    const def = elementsByKey.get(run.key);
    const range = run.startIndex === run.endIndex
      ? `paragraph ${run.startIndex}`
      : `paragraphs ${run.startIndex}\u2013${run.endIndex}`;
    caption.textContent = `${def ? def.label : 'Unclassified'} \u00b7 ${range} \u00b7 ${run.words.toLocaleString()} words (${Math.round(run.share * 100)}%)`;
    caption.classList.add('is-detail');
    if (def) caption.style.color = `var(--sb-${def.slug})`;
    else caption.style.removeProperty('color');
  }

  /** Scroll a paragraph into view inside the tab's own scroll container. */
  function jumpToUnit(index) {
    const scroll = $('sbScroll');
    const target = $('sbSurface')?.querySelector(`[data-index="${index}"]`);
    if (!scroll || !target) return;

    // Offset by a third of the viewport so the target lands where the rail's
    // anchor is, rather than flush against the top edge under the glass bar.
    const top = target.offsetTop - scroll.clientHeight * 0.25;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    scroll.scrollTo({ top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' });
  }

  /** Mark the run being read, making the ribbon a minimap rather than a legend. */
  function markFlowPosition(unitIndex) {
    if (!flowRuns.length) return;
    const idx = window.StoryboardFlow.runIndexForUnit(flowRuns, unitIndex);
    if (idx === flowActiveRun) return;
    flowActiveRun = idx;
    $('sbFlowTrack')?.querySelectorAll('.sb-flow-seg').forEach((seg, i) => {
      seg.classList.toggle('is-current', i === idx);
    });
    showFlowCaption(idx);
  }

  function updateActiveElement() {
    const scroll = $('sbScroll');
    const surface = $('sbSurface');
    if (!scroll || !surface) return;

    const anchor = scroll.getBoundingClientRect().top + scroll.clientHeight * 0.33;
    let key = null;

    let unitIndex = null;
    for (const block of surface.querySelectorAll('[data-element]')) {
      if (!block.dataset.element) continue;
      if (block.getBoundingClientRect().top <= anchor) {
        key = block.dataset.element;
        unitIndex = Number(block.dataset.index);
      } else break;
    }
    // Same anchor the rail uses, so the ribbon and the explanation card always
    // agree about where the reader is.
    if (unitIndex !== null) markFlowPosition(unitIndex);
    if (!key) {
      const first = surface.querySelector('[data-element]:not([data-element=""])');
      key = first?.dataset.element || null;
    }
    renderRail(key);
  }

  /**
   * Open or close the audit panel.
   *
   * One function rather than two handlers flipping the same style, so the
   * toggle's aria-expanded and pressed state cannot drift out of step with what
   * is actually on screen.
   */
  function setAuditOpen(open) {
    const panel = $('sbAuditPanel');
    const toggle = $('sbAuditToggle');
    if (!panel) return;
    panel.style.display = open ? '' : 'none';
    if (toggle) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.classList.toggle('active', open);
    }
    if (open) $('sbAuditClose')?.focus();
  }

  function renderRail(key) {
    if (!key || key === activeElementKey) return;
    const def = elementsByKey.get(key);
    if (!def) return;
    activeElementKey = key;

    const card = $('sbInfoCard');
    card.classList.add('is-swapping');

    // Colour is carried by `color` on the card so the accent bar, swatch and
    // bullet markers all pick it up through currentColor.
    setTimeout(() => {
      card.style.color = `var(--sb-${def.slug})`;
      // Also as a property: the bullet markers cannot use currentColor because the
      // list items set their own text colour for readability.
      card.style.setProperty('--sb-el', `var(--sb-${def.slug})`);
      $('sbInfoEyebrow').textContent = def.label;
      $('sbInfoTitle').textContent = def.title;
      $('sbInfoTagline').textContent = def.tagline;
      $('sbInfoList').innerHTML = (def.points || []).map(p => `<li>${esc(p)}</li>`).join('');
      card.classList.remove('is-swapping');
    }, 120);
  }

  // ── Audit ────────────────────────────────────────────────────────────────

  /** Labels for the fixed key lists the analyzer validates against. */
  const RULE_LABELS = {
    'zero-cognitive-load': 'Zero cognitive load',
    survival: 'Linked to survival',
    memorable: 'Memorable and repeatable',
    'customer-hero': 'Audience is the hero',
  };
  const SOUNDBITE_LABELS = {
    problem: 'Problem',
    empathy: 'Empathy',
    answer: 'Answer',
    change: 'Change',
    endResult: 'End result',
  };
  const BRAND_LABELS = {
    persona: 'Persona — champion, not hero',
    positioning: 'Positioning — builders turning ambition into action',
    traits: 'Personality traits',
    voice: 'Voice tenets',
    craft: 'Writing craft',
  };

  function renderAudit(analysis) {
    const body = $('sbAuditBody');
    if (!body) return;

    const audit = analysis?.audit || null;
    const brand = analysis?.brandAlignment || null;
    const incomplete = Array.isArray(analysis?.incomplete) ? analysis.incomplete : [];

    if (!audit && !brand) {
      // Distinguishes "this run could not produce it" from "this analysis predates
      // the feature" — otherwise a transient failure reads as a permanent gap.
      body.innerHTML = incomplete.length
        ? `<div class="sb-audit-line">The ${esc(incomplete.join(' and '))} could not be produced for this
             analysis. Re-analyse to try again.</div>`
        : '<div class="sb-audit-line">No audit was returned for this analysis.</div>';
      return;
    }

    const statusLabel = { strong: 'Strong', weak: 'Weak', missing: 'Missing', unknown: 'Unrated' };

    const elementCards = elements.map(def => {
      const entry = audit?.elements?.[def.key] || { status: 'unknown' };
      const lines = [
        entry.found ? `<div class="sb-audit-line sb-audit-quote">${esc(entry.found)}</div>` : '',
        entry.issue ? `<div class="sb-audit-line"><strong>Issue:</strong> ${esc(entry.issue)}</div>` : '',
        entry.fix ? `<div class="sb-audit-line"><strong>Fix:</strong> ${esc(entry.fix)}</div>` : '',
      ].join('');

      return `
        <div class="sb-audit-element" style="color: var(--sb-${def.slug})">
          <div class="sb-audit-element-head">
            <span class="sb-dot" style="background: currentColor"></span>
            <span class="sb-audit-element-name">${esc(def.label)}</span>
            ${entry.score !== null && entry.score !== undefined ? `<span class="sb-audit-score">${entry.score}/10</span>` : ''}
            <span class="sb-audit-status is-${esc(entry.status)}">${esc(statusLabel[entry.status] || entry.status)}</span>
          </div>
          ${lines}
        </div>`;
    }).join('');

    const list = (title, items) => (items?.length
      ? `<div class="sb-audit-section-title">${title}</div><ul class="sb-audit-list">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`
      : '');

    // ── The 4 Rules ──
    // Rendered only when at least one rule got a verdict. An analysis from before
    // this existed has four "unknown" rows, and a table of Unrated reads like a
    // finding rather than an absence.
    const ruleRows = Object.entries(RULE_LABELS)
      .map(([key, label]) => {
        const entry = audit?.rules?.[key];
        if (!entry) return '';
        const verdict = entry.verdict === 'pass' ? 'Pass' : entry.verdict === 'fail' ? 'Fail' : 'Unrated';
        return `
          <div class="sb-rule">
            <span class="sb-rule-verdict is-${esc(entry.verdict)}">${verdict}</span>
            <span class="sb-rule-name">${esc(label)}</span>
            ${entry.evidence ? `<div class="sb-audit-line sb-audit-quote">${esc(entry.evidence)}</div>` : ''}
            ${entry.note ? `<div class="sb-audit-line">${esc(entry.note)}</div>` : ''}
          </div>`;
      }).join('');
    const anyRule = audit?.rules && Object.values(audit.rules).some(r => r.verdict !== 'unknown');
    const rulesSection = anyRule
      ? `<div class="sb-audit-section-title">The 4 Rules of Messaging</div>${ruleRows}`
      : '';

    // ── P.E.A.C.E. soundbites ──
    const soundbiteRows = Object.entries(SOUNDBITE_LABELS)
      .map(([key, label]) => {
        const entry = audit?.soundbites?.[key];
        if (!entry) return '';
        return `
          <div class="sb-soundbite">
            <div class="sb-soundbite-head">
              <span class="sb-soundbite-name">${esc(label)}</span>
              <span class="sb-audit-status is-${esc(entry.status)}">${esc(statusLabel[entry.status] || entry.status)}</span>
            </div>
            ${entry.found ? `<div class="sb-audit-line sb-audit-quote">${esc(entry.found)}</div>` : ''}
            ${entry.suggestion ? `<div class="sb-audit-line"><strong>Try:</strong> ${esc(entry.suggestion)}</div>` : ''}
          </div>`;
      }).join('');
    const anySoundbite = audit?.soundbites && Object.values(audit.soundbites).some(sb => sb.status !== 'unknown');
    const soundbitesSection = anySoundbite
      ? `<div class="sb-audit-section-title">The 5 Soundbites</div>${soundbiteRows}`
      : '';

    // ── AWS brand alignment ──
    let brandSection = '';
    if (brand) {
      const dimRows = Object.entries(BRAND_LABELS).map(([key, label]) => {
        const entry = brand.dimensions?.[key];
        if (!entry) return '';
        return `
          <div class="sb-brand-dim">
            <div class="sb-brand-dim-head">
              <span class="sb-brand-dim-name">${esc(label)}</span>
              ${entry.score !== null && entry.score !== undefined ? `<span class="sb-brand-dim-score">${entry.score}/10</span>` : ''}
              <span class="sb-audit-status is-${esc(entry.status)}">${esc(statusLabel[entry.status] || entry.status)}</span>
            </div>
            ${entry.found ? `<div class="sb-audit-line sb-audit-quote">${esc(entry.found)}</div>` : ''}
            ${entry.issue ? `<div class="sb-audit-line"><strong>Issue:</strong> ${esc(entry.issue)}</div>` : ''}
            ${entry.fix ? `<div class="sb-audit-line"><strong>Fix:</strong> ${esc(entry.fix)}</div>` : ''}
          </div>`;
      }).join('');

      // Banded rather than numeric-only: "62" means nothing without a scale.
      const band = brand.score === null ? '' : brand.score >= 80 ? 'is-good' : brand.score >= 50 ? 'is-mixed' : 'is-poor';

      brandSection = `
        <div class="sb-audit-section-title">AWS brand alignment</div>
        ${brand.score !== null ? `
          <div class="sb-brand-score ${band}">
            <span class="sb-brand-score-value">${brand.score}<span class="sb-brand-score-max">/100</span></span>
            ${brand.verdict ? `<span class="sb-brand-verdict">${esc(brand.verdict)}</span>` : ''}
          </div>` : (brand.verdict ? `<div class="sb-audit-line">${esc(brand.verdict)}</div>` : '')}
        ${dimRows}
        ${brand.naturalAlignment ? `<div class="sb-audit-line sb-brand-agrees"><strong>Where both frameworks agree:</strong> ${esc(brand.naturalAlignment)}</div>` : ''}
        ${list('Tensions worth a decision', brand.tensions)}
        ${list('Out of scope (visual brand)', brand.outOfScope)}`;
    } else if (incomplete.includes('brand alignment')) {
      brandSection = `
        <div class="sb-audit-section-title">AWS brand alignment</div>
        <div class="sb-audit-line">This check could not be produced for this analysis. Re-analyse to try again.</div>`;
    }

    const auditUnavailable = !audit && incomplete.includes('audit')
      ? '<div class="sb-audit-line">The StoryBrand audit could not be produced for this analysis. Re-analyse to try again.</div>'
      : '';

    body.innerHTML = [
      auditUnavailable,
      audit?.overall ? `<div class="sb-audit-overall">${esc(audit.overall)}</div>` : '',
      audit ? elementCards : '',
      rulesSection,
      soundbitesSection,
      brandSection,
      list('What&rsquo;s working', audit?.whatsWorking),
      list('Quick wins', audit?.quickWins),
    ].join('');
  }

  // ── Sidebar ──────────────────────────────────────────────────────────────

  function bindSidebar() {
    bindEntryMenu();
    $('sbSearch')?.addEventListener('input', (e) => {
      const query = e.target.value;
      $('sbSearchClear')?.classList.toggle('d-none', !query);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => refreshList(query), 250);
    });
    $('sbSearchClear')?.addEventListener('click', () => {
      $('sbSearch').value = '';
      $('sbSearchClear').classList.add('d-none');
      refreshList();
    });
  }

  async function refreshList(query = '') {
    const list = $('sbList');
    if (!list) return;
    let entries = [];
    try {
      entries = String(query).trim()
        ? await window.electronAPI.invoke('storyboard-search', query)
        : await window.electronAPI.invoke('storyboard-list');
    } catch {
      entries = [];
    }

    if (!entries.length) {
      list.innerHTML = `<div class="conv-empty">${query ? 'No analyses match.' : 'No saved analyses yet.'}</div>`;
      return;
    }

    list.innerHTML = entries.map(entry => {
      const match = entry.matches?.[0];
      return `
        <div class="conv-item${entry.id === current?.id ? ' active' : ''}" data-id="${esc(entry.id)}">
          <div class="conv-item-title" title="${esc(entry.displayName)}">${esc(entry.displayName)}</div>
          <div class="sb-entry-shape">${shapeBar(entry.elementCounts)}</div>
          <div class="sb-entry-meta">${entry.unitCount} paragraphs · ${(entry.wordCount || 0).toLocaleString()} words</div>
          ${match ? `<div class="sb-entry-match">${esc(match.snippet)}</div>` : ''}
          <button class="sidebar-menu-btn" data-action="menu" title="More"><i class="bi bi-three-dots"></i></button>
        </div>`;
    }).join('');

    list.querySelectorAll('.conv-item').forEach(item => {
      const id = item.dataset.id;
      item.addEventListener('click', async (e) => {
        if (e.target.closest('[data-action="menu"]')) {
          e.stopPropagation();
          return showEntryMenu(e, id);
        }
        const analysis = await window.electronAPI.invoke('storyboard-get', id);
        if (analysis) showAnalysis(analysis);
      });
    });
  }

  // ── Row overflow menu ──────────────────────────────────────
  //
  // Two always-visible icon buttons per row was the wrong shape for this
  // sidebar: rows already carry a title, a colour shape bar, a paragraph/word
  // line and sometimes a search snippet, and a pencil and a trash competing with
  // all of that made the row read as a toolbar. This follows the Work tab
  // instead — a three-dots button that appears on hover, opening a menu — and
  // reuses its classes so the two are styled by the same rules rather than by
  // two descriptions of the same intent.

  let menuTargetId = null;

  function showEntryMenu(e, id) {
    const menu = $('sbContextMenu');
    if (!menu) return;
    menuTargetId = id;
    menu.style.display = 'block';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    // Clamped after layout, or a row near the window edge opens a menu that runs
    // off it. Same approach as the Work tab's.
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
      if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;
    });
  }

  function hideEntryMenu() {
    const menu = $('sbContextMenu');
    if (menu) menu.style.display = 'none';
    menuTargetId = null;
  }

  function bindEntryMenu() {
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#sbContextMenu') && !e.target.closest('[data-action="menu"]')) hideEntryMenu();
    });

    $('sbContextMenu')?.querySelectorAll('.ctx-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        const id = menuTargetId;
        hideEntryMenu();
        if (!id) return;
        if (action === 'rename') renameEntry(id);
        if (action === 'delete') deleteEntry(id);
      });
    });
  }

  /**
   * A one-line bar of the story's colour distribution — enough to recognise a
   * keynote in the list by its shape.
   */
  function shapeBar(counts) {
    if (!counts) return '';
    return elements
      .filter(e => counts[e.key])
      .map(e => `<span style="background: var(--sb-${e.slug}); flex-grow: ${counts[e.key]}"></span>`)
      .join('');
  }

  function highlightActive(id) {
    $('sbList')?.querySelectorAll('.conv-item').forEach(item => {
      item.classList.toggle('active', !!id && item.dataset.id === id);
    });
  }

  /**
   * Rename by editing the title in place.
   *
   * `window.prompt` is not implemented in Electron's renderer, and this matches how
   * the Transcribe tab renames a transcript — swap the title for an input rather
   * than opening a dialog.
   */
  async function renameEntry(id) {
    const analysis = await window.electronAPI.invoke('storyboard-get', id);
    if (!analysis) return;
    if (current?.id !== id) showAnalysis(analysis);
    beginRename();
  }

  function beginRename() {
    if (!current) return;
    const title = $('sbTitle');
    const input = $('sbTitleInput');
    if (!title || !input) return;
    input.value = current.displayName || '';
    input.dataset.id = current.id;
    input.classList.remove('d-none');
    title.classList.add('d-none');
    try { input.focus(); input.select(); } catch { /* not focusable under jsdom */ }
  }

  function endRename(commit) {
    const title = $('sbTitle');
    const input = $('sbTitleInput');
    if (!input || input.classList.contains('d-none')) return;
    const id = input.dataset.id;
    const name = input.value.trim();
    input.classList.add('d-none');
    title?.classList.remove('d-none');
    if (!commit || !id || !name || name === current?.displayName) return;

    window.electronAPI.invoke('storyboard-rename', { id, displayName: name })
      .then(async () => {
        if (current?.id === id) {
          current.displayName = name;
          if (title) title.textContent = name;
        }
        await refreshList($('sbSearch')?.value || '');
      })
      .catch(err => window.electronAPI.showToast(err.message, 'error'));
  }

  async function deleteEntry(id) {
    // confirm() works in Electron's renderer (settingsTab.js relies on it);
    // prompt() does not.
    if (!confirm('Delete this analysis? This cannot be undone.')) return;
    await window.electronAPI.invoke('storyboard-delete', id);
    if (current?.id === id) showInputView();
    await refreshList($('sbSearch')?.value || '');
  }

  async function reanalyze() {
    if (!current) return;
    const btn = $('sbReanalyzeBtn');
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Analysing…';
    try {
      const updated = await window.electronAPI.invoke('storyboard-reanalyze', {
        id: current.id,
        modelId: $('sbModelSelect')?.value || undefined,
      });
      showAnalysis(updated);
      await refreshList();
    } catch (err) {
      window.electronAPI.showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }

  function exportHtml() {
    if (!current || !window.StoryboardExport) return;
    window.StoryboardExport.download(current, elements);
  }

  window.StoryboardTab = {
    init,
    // Exposed for tests.
    _render: renderScript,
    _flowCaption: showFlowCaption,
    _renderAudit: renderAudit,
    _showAnalysis: showAnalysis,
    _setPlain: setPlain,
    _shapeBar: shapeBar,
    _showRevisionBadge: showRevisionBadge,
    _beginRename: beginRename,
    _endRename: endRename,
    _state: () => ({ pending, current, activeElementKey }),
  };
})();
