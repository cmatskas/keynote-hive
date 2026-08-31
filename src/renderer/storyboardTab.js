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
    $('sbAuditPanel').style.display = 'none';
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
    renderAudit(analysis.audit);
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
      const panel = $('sbAuditPanel');
      panel.style.display = panel.style.display === 'none' ? '' : 'none';
    });
    $('sbAuditClose')?.addEventListener('click', () => { $('sbAuditPanel').style.display = 'none'; });

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
  function updateActiveElement() {
    const scroll = $('sbScroll');
    const surface = $('sbSurface');
    if (!scroll || !surface) return;

    const anchor = scroll.getBoundingClientRect().top + scroll.clientHeight * 0.33;
    let key = null;

    for (const block of surface.querySelectorAll('[data-element]')) {
      if (!block.dataset.element) continue;
      if (block.getBoundingClientRect().top <= anchor) key = block.dataset.element;
      else break;
    }
    if (!key) {
      const first = surface.querySelector('[data-element]:not([data-element=""])');
      key = first?.dataset.element || null;
    }
    renderRail(key);
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

  function renderAudit(audit) {
    const body = $('sbAuditBody');
    if (!body) return;
    if (!audit) {
      body.innerHTML = '<div class="sb-audit-line">No audit was returned for this analysis.</div>';
      return;
    }

    const statusLabel = { strong: 'Strong', weak: 'Weak', missing: 'Missing', unknown: 'Unrated' };

    const elementCards = elements.map(def => {
      const entry = audit.elements?.[def.key] || { status: 'unknown' };
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
            <span class="sb-audit-status is-${esc(entry.status)}">${esc(statusLabel[entry.status] || entry.status)}</span>
          </div>
          ${lines}
        </div>`;
    }).join('');

    const list = (title, items) => (items?.length
      ? `<div class="sb-audit-section-title">${title}</div><ul class="sb-audit-list">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`
      : '');

    body.innerHTML = [
      audit.overall ? `<div class="sb-audit-overall">${esc(audit.overall)}</div>` : '',
      elementCards,
      list('What&rsquo;s working', audit.whatsWorking),
      list('Quick wins', audit.quickWins),
    ].join('');
  }

  // ── Sidebar ──────────────────────────────────────────────────────────────

  function bindSidebar() {
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
          <div class="conv-item-actions">
            <button class="conv-action" data-action="rename" title="Rename"><i class="bi bi-pencil"></i></button>
            <button class="conv-action" data-action="delete" title="Delete"><i class="bi bi-trash"></i></button>
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.conv-item').forEach(item => {
      const id = item.dataset.id;
      item.addEventListener('click', async (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'rename') { e.stopPropagation(); return renameEntry(id); }
        if (action === 'delete') { e.stopPropagation(); return deleteEntry(id); }
        const analysis = await window.electronAPI.invoke('storyboard-get', id);
        if (analysis) showAnalysis(analysis);
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
