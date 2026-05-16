/**
 * showflowTab.js — Showflow tab controller
 * Lazy-initialised on first tab visit. Depends on ShowflowStore, ShowflowExport, Sortable.
 */
(() => {
'use strict';

const $ = id => document.getElementById(id);
const esc = s => { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; };

// SortableJS instances — created once, never recreated
let sortRun = null, sortParking = null, sortPalette = null;

// Track last-rendered show id and element types to detect changes
let _lastShowId = null;
let _lastEtypes = '';

// ── Init (called once by index.js on first tab click) ─────────────────────────

function init() {
  bindHeaderButtons();
  // Wire import file input
  $('sf-import-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const show = JSON.parse(await file.text());
      ShowflowStore.setShow(show);
    } catch (err) { alert('Import failed: ' + err.message); }
    finally { e.target.value = ''; }
  });

  // Wire PPTX import
  $('sf-import-pptx-btn')?.addEventListener('click', () => {
    $('sf-overflow-menu').style.display = 'none';
    $('sf-import-pptx-input').click();
  });
  $('sf-import-pptx-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      window.electronAPI.showToast('Parsing PowerPoint…', 'info');
      const show = await window.ShowflowExport.importFromPptx(file);
      ShowflowStore.setShow(show);
      window.electronAPI.showToast(`Imported ${show.items.length} slides from ${file.name}`, 'success');
    } catch (err) { alert('PowerPoint import failed: ' + err.message); }
    finally { e.target.value = ''; }
  });

  // Subscribe: only re-render what changed
  ShowflowStore.subscribe((state, structural, changeType) => {
    const show = state.show;
    const switched = show?.id !== _lastShowId;
    const needsSortable = !sortRun || switched;
    _lastShowId = show?.id ?? null;

    updateVisibility(show);
    if (!show) return;

    renderHeader(show);

    if (!structural) {
      if (changeType === 'expand') {
        // Expand/collapse: re-render run list, preserve scroll
        const runEl = $('sf-run');
        const scrollTop = runEl ? runEl.scrollTop : 0;
        renderRunOfShow(show);
        if (runEl) requestAnimationFrame(() => { runEl.scrollTop = scrollTop; });
      } else if (changeType === 'duration') {
        // Duration changed: update chapter mark badges in-place
        updateChapterBadges(show);
      }
      // Field edits (title/notes/performer): skip re-render to preserve focus
      return;
    }

    const etKey = JSON.stringify(show.elementTypes.map(t => t.id));
    const etChanged = etKey !== _lastEtypes;
    _lastEtypes = etKey;

    // Preserve scroll position for in-place changes (delete, park, reorder)
    // but not when switching shows or first load
    const runEl = $('sf-run');
    const scrollTop = (!switched && !needsSortable && runEl) ? runEl.scrollTop : 0;

    if (needsSortable) {
      renderElementsPanel(show);
      renderRunOfShow(show);
      renderParkingLot(show);
      initSortable();
      const orphans = ShowflowStore.getOrphanCount();
      if (orphans > 0) {
        window.electronAPI.showToast(
          `${orphans} item${orphans > 1 ? 's have' : ' has'} an unknown element type and will appear with a fallback style.`,
          'warning'
        );
      }
    } else {
      if (etChanged) renderElementsPanel(show);
      renderRunOfShow(show);
      renderParkingLot(show);
    }

    if (scrollTop > 0 && runEl) requestAnimationFrame(() => { runEl.scrollTop = scrollTop; });
  });

  // Initial render
  const show = ShowflowStore.getShow();
  _lastShowId = show?.id ?? null;
  updateVisibility(show);
  if (show) {
    renderHeader(show);
    renderElementsPanel(show);
    renderRunOfShow(show);
    renderParkingLot(show);
    initSortable();
  }
}

// ── Visibility ────────────────────────────────────────────────────────────────

function updateVisibility(show) {
  const has = !!show;
  $('sf-welcome').style.display = has ? 'none' : 'flex';
  $('sf-body').style.display    = has ? 'flex' : 'none';
  ['sf-duration-pill','sf-overflow-wrap','sf-save-btn'].forEach(id => {
    const el = $(id); if (el) el.style.display = has ? '' : 'none';
  });
  if (!has) $('sf-show-name').style.display = 'none';
}

// ── Header ────────────────────────────────────────────────────────────────────

function renderHeader(show) {
  const nameEl = $('sf-show-name');
  nameEl.textContent = show.name;
  nameEl.style.display = '';

  const total = ShowflowStore.getTotalDuration();
  const est   = ShowflowStore.getTotalEstimatedDuration();
  const over  = est > 0 && total > est;
  const under = est > 0 && total < est;
  const pill     = $('sf-duration-pill');
  const actualEl = $('sf-duration-actual');
  const targetEl = $('sf-duration-target');

  actualEl.textContent = ShowflowStore.formatDuration(total);
  pill.classList.toggle('over', over);
  pill.classList.toggle('under', under);
  actualEl.classList.toggle('over', over);
  actualEl.classList.toggle('under', under);

  if (est > 0) {
    targetEl.textContent = ShowflowStore.formatDuration(est);
    targetEl.classList.remove('unset');
  } else {
    targetEl.textContent = '+ target';
    targetEl.classList.add('unset');
  }
}

function bindHeaderButtons() {
  // Overflow menu toggle
  $('sf-overflow-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    const m = $('sf-overflow-menu');
    m.style.display = m.style.display === 'none' ? '' : 'none';
  });
  document.addEventListener('click', () => {
    const m = $('sf-overflow-menu');
    if (m) m.style.display = 'none';
  });

  // Overflow menu items
  $('sf-shows-btn')?.addEventListener('click', () => { $('sf-overflow-menu').style.display = 'none'; openShowManager(); });
  $('sf-import-btn')?.addEventListener('click', () => { $('sf-overflow-menu').style.display = 'none'; $('sf-import-input').click(); });
  $('sf-export-word')?.addEventListener('click', async () => {
    $('sf-overflow-menu').style.display = 'none';
    const show = ShowflowStore.getShow(); if (show) await window.ShowflowExport.exportToWord(show);
  });
  $('sf-export-excel')?.addEventListener('click', async () => {
    $('sf-overflow-menu').style.display = 'none';
    const show = ShowflowStore.getShow(); if (show) await window.ShowflowExport.exportToExcel(show);
  });
  $('sf-close-btn')?.addEventListener('click', () => {
    $('sf-overflow-menu').style.display = 'none';
    ShowflowStore.setShow(null);
    ShowflowStore.setCurrentFilePath(null);
  });

  // Duration target inline edit
  $('sf-duration-target').addEventListener('click', () => {
    const show = ShowflowStore.getShow(); if (!show) return;
    const targetEl = $('sf-duration-target');
    const input    = $('sf-duration-target-input');
    const label    = $('sf-duration-target-label');
    const cur = Math.round((show.estimatedDurationSeconds || 0) / 60);
    input.value = cur || '';
    targetEl.style.display = 'none';
    input.style.display = '';
    label.style.display = '';
    input.focus(); input.select();
  });
  const commitTarget = () => {
    const input  = $('sf-duration-target-input');
    const label  = $('sf-duration-target-label');
    const target = $('sf-duration-target');
    ShowflowStore.updateShowEstimate((parseInt(input.value) || 0) * 60);
    input.style.display = 'none';
    label.style.display = 'none';
    target.style.display = '';
  };
  $('sf-duration-target-input').addEventListener('blur', commitTarget);
  $('sf-duration-target-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') e.target.blur();
    if (e.key === 'Escape') {
      $('sf-duration-target-input').style.display = 'none';
      $('sf-duration-target-label').style.display = 'none';
      $('sf-duration-target').style.display = '';
    }
  });

  // Primary buttons
  $('sf-new-btn').addEventListener('click', openNewShowModal);
  $('sf-save-btn')?.addEventListener('click', saveShowAs);
  $('sf-create-btn')?.addEventListener('click', openNewShowModal);
  $('sf-open-btn')?.addEventListener('click', openShowFile);
}

// ── SortableJS — init once, re-apply after full list rebuilds ─────────────────

function initSortable() {
  const elList  = $('sf-elements-list');
  const runList = $('sf-run-list');
  const parkList= $('sf-parking-list');
  const runEl   = $('sf-run');
  const parkEl  = $('sf-parking');
  if (!elList || !runList || !parkList) return;

  if (sortRun)     { sortRun.destroy();     sortRun = null; }
  if (sortParking) { sortParking.destroy(); sortParking = null; }

  // ── Palette: native drag + click — wired in wirePaletteEvents() after renderElementsPanel ──

  // ── Run list: drop target ─────────────────────────────────────────────────
  runEl.addEventListener('dragover', e => { e.preventDefault(); runEl.classList.add('drag-over'); });
  runEl.addEventListener('dragleave', e => { if (!runEl.contains(e.relatedTarget)) runEl.classList.remove('drag-over'); });
  runEl.addEventListener('drop', e => {
    e.preventDefault(); runEl.classList.remove('drag-over');
    const type = e.dataTransfer.getData('sf-type');
    if (type === 'palette') {
      const etId = e.dataTransfer.getData('sf-et-id');
      // Find which card the pointer is over to insert at that position
      const afterPosition = getDropPosition(e.clientY);
      ShowflowStore.addItem(etId, afterPosition);
    } else if (type === 'parked-item') {
      ShowflowStore.moveFromParking(e.dataTransfer.getData('sf-item-id'));
    }
  });

  // ── Parking lot: drop target ──────────────────────────────────────────────
  parkEl.addEventListener('dragover', e => { e.preventDefault(); parkEl.classList.add('drag-over'); });
  parkEl.addEventListener('dragleave', e => { if (!parkEl.contains(e.relatedTarget)) parkEl.classList.remove('drag-over'); });
  parkEl.addEventListener('drop', e => {
    e.preventDefault(); parkEl.classList.remove('drag-over');
    const type = e.dataTransfer.getData('sf-type');
    if (type === 'palette') {
      ShowflowStore.addItem(e.dataTransfer.getData('sf-et-id'));
      const run = ShowflowStore.getRunItems();
      const last = run[run.length - 1];
      if (last) ShowflowStore.moveToParking(last.id);
    } else if (type === 'run-item') {
      ShowflowStore.moveToParking(e.dataTransfer.getData('sf-item-id'));
    }
  });

  // ── Run list: SortableJS for same-list reorder only ───────────────────────
  sortRun = Sortable.create(runList, {
    animation: 150, ghostClass: 'sortable-ghost',
    handle: '.sf-drag-handle',
    filter: 'input, textarea, button',
    preventOnFilter: false,
    onEnd(evt) {
      const { item, oldIndex, newIndex } = evt;
      if (oldIndex === newIndex) return;
      const run = ShowflowStore.getRunItems();
      const overId = run[newIndex]?.id;
      if (overId) { item.remove(); ShowflowStore.reorderItems(item.dataset.id, overId, newIndex > oldIndex); }
    },
  });
}

// ── Elements panel ────────────────────────────────────────────────────────────

function renderElementsPanel(show) {
  const system  = show.elementTypes.filter(t => t.isSystem);
  const regular = show.elementTypes.filter(t => !t.isSystem);
  $('sf-elements-list').innerHTML = [...system, ...regular].map(et => `
    <div class="sf-element-card" data-id="${et.id}" data-element-type-id="${et.id}">
      <div class="sf-element-icon" style="background:${et.color}22;border-left:3px solid ${et.color}">${et.icon}</div>
      <span class="sf-element-name">${esc(et.name)}</span>
      <div class="sf-et-actions">
        <button class="sf-et-btn sf-et-edit" data-id="${et.id}" title="Edit">✏️</button>
        ${et.isSystem || et.isDefault || ShowflowStore.isDefaultElementType(et.id) ? '' : `<button class="sf-et-btn sf-et-delete" data-id="${et.id}" title="Delete">✕</button>`}
      </div>
    </div>`).join('');

  $('sf-add-type-btn').onclick = () => openAddTypeModal();

  // Wire edit/delete buttons
  $('sf-elements-list').querySelectorAll('.sf-et-edit').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const et = show.elementTypes.find(t => t.id === btn.dataset.id);
      if (et) openAddTypeModal(et);
    });
  });
  $('sf-elements-list').querySelectorAll('.sf-et-delete').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openDeleteTypeModal(btn.dataset.id, show);
    });
  });

  wirePaletteEvents();
}

function wirePaletteEvents() {
  $('sf-elements-list').querySelectorAll('.sf-element-card').forEach(card => {
    let dragging = false;
    card.setAttribute('draggable', 'true');
    card.addEventListener('dragstart', e => {
      dragging = true;
      e.dataTransfer.setData('sf-type', 'palette');
      e.dataTransfer.setData('sf-et-id', card.dataset.elementTypeId);
      e.dataTransfer.effectAllowed = 'copy';
    });
    card.addEventListener('dragend', () => { setTimeout(() => { dragging = false; }, 0); });
    card.addEventListener('click', () => { if (dragging) return; ShowflowStore.addItem(card.dataset.elementTypeId); });
  });
}

// ── Drop position helper ──────────────────────────────────────────────────────

function getDropPosition(clientY) {
  // Find the card the pointer is over and return the position to insert after
  const runList = $('sf-run-list');
  if (!runList) return undefined;
  const cards = Array.from(runList.querySelectorAll('[data-id]')).filter(el =>
    el.classList.contains('sf-item-card') || el.classList.contains('sf-chapter-card')
  );
  if (cards.length === 0) return undefined;

  // Find the card whose midpoint is just above the drop Y
  let afterCard = null;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (clientY > rect.top + rect.height / 2) afterCard = card;
    else break;
  }

  if (!afterCard) return undefined; // drop above all cards — insert at start (position 0 - 0.5)

  const run = ShowflowStore.getRunItems();
  const afterItem = run.find(i => i.id === afterCard.dataset.id);
  return afterItem?.position;
}

// ── Targeted chapter badge update (on duration change, no full re-render) ─────

function updateChapterBadges(show) {
  const runList = $('sf-run-list');
  if (!runList) return;
  runList.querySelectorAll('.sf-chapter-card').forEach(card => {
    const id = card.dataset.id;
    const chapterDuration = ShowflowStore.getChapterDuration(id);
    const item = show.items.find(i => i.id === id);
    if (!item) return;
    const est  = item.estimatedDurationSeconds || 0;
    const over = est > 0 && chapterDuration > est;
    let badge = card.querySelector('.sf-chapter-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'badge sf-chapter-badge';
      const targetInput = card.querySelector('.sf-est-input');
      if (targetInput) targetInput.parentNode.insertBefore(badge, targetInput);
    }
    if (chapterDuration > 0) {
      badge.textContent = ShowflowStore.formatDuration(chapterDuration);
      badge.className = `badge sf-chapter-badge ${over ? 'bg-danger' : 'bg-success'}`;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  });
}

// ── Run of show ───────────────────────────────────────────────────────────────

function renderRunOfShow(show) {
  const list       = $('sf-run-list');
  const empty      = $('sf-run-empty');
  const runItems   = ShowflowStore.getRunItems();
  const expandedId = ShowflowStore.getExpandedItemId();

  let curChapter = null;
  const chapterMap = {};
  for (const item of runItems) {
    if (item.isChapterMark) { curChapter = item.id; chapterMap[item.id] = null; }
    else chapterMap[item.id] = curChapter;
  }

  // Remove all children except the empty state placeholder
  Array.from(list.children).forEach(c => { if (c.id !== 'sf-run-empty') c.remove(); });

  // Insert cards before the empty state
  const html = runItems.map(item => {
    const et = show.elementTypes.find(t => t.id === item.elementTypeId);
    return item.isChapterMark
      ? chapterCardHTML(item, expandedId === item.id, ShowflowStore.getChapterDuration(item.id))
      : itemCardHTML(item, et, expandedId === item.id, !!chapterMap[item.id], show.performerLabel);
  }).join('');
  empty.insertAdjacentHTML('beforebegin', html);

  empty.classList.toggle('visible', runItems.length === 0);
  wireListEvents(list);
}

// ── Card HTML helpers ─────────────────────────────────────────────────────────

function secsSelect(id, totalSeconds, cls) {
  const secs = totalSeconds % 60;
  // Round to nearest 15
  const snapped = [0, 15, 30, 45].reduce((prev, cur) => Math.abs(cur - secs) < Math.abs(prev - secs) ? cur : prev, 0);
  return `<select class="${cls}" data-id="${id}" style="font-size:12px;border:1px solid var(--border-secondary);border-radius:5px;padding:1px 2px;background:var(--bg-primary);color:var(--text-primary)">
    <option value="0"${snapped===0?' selected':''}>:00</option>
    <option value="15"${snapped===15?' selected':''}>:15</option>
    <option value="30"${snapped===30?' selected':''}>:30</option>
    <option value="45"${snapped===45?' selected':''}>:45</option>
  </select>`;
}

function itemCardHTML(item, et, expanded, inChapter, perfLabel) {
  const color = et?.color || '#8e8e93';
  const icon  = et?.icon  || '📋';
  const typeName = et?.name || '⚠ Unknown Type';
  const mins  = Math.floor(item.durationSeconds / 60);
  const listId = `perf-${item.id}`;
  const suggestions = ShowflowStore.getPerformerSuggestions().map(s => `<option value="${esc(s)}">`).join('');
  return `
  <div class="sf-item-card${inChapter ? ' in-chapter' : ''}" data-id="${item.id}" style="border-left:3px solid ${color}">
    <div class="sf-drag-handle" style="background:${color}18">⠿</div>
    <div class="sf-card-body">
      <div class="sf-card-title-row">
        <span style="font-size:15px;flex-shrink:0">${icon}</span>
        <input class="sf-title-input" data-id="${item.id}" value="${esc(item.title)}" placeholder="Untitled" />
        <input class="sf-duration-input" type="number" min="0" data-id="${item.id}" value="${mins}" />
        ${secsSelect(item.id, item.durationSeconds, 'sf-secs-select')}
        <span class="sf-duration-label">min</span>
        <button class="sf-action-btn" data-action="expand" data-id="${item.id}" title="${expanded ? 'Collapse' : 'Expand'}">${expanded ? '▲' : '▼'}</button>
        <button class="sf-action-btn" data-action="park"   data-id="${item.id}" title="Move to parking lot"><i class="bi bi-archive"></i></button>
        <button class="sf-action-btn danger" data-action="delete" data-id="${item.id}" title="Delete">✕</button>
      </div>
      ${item.performer ? `<div class="small text-muted ps-4 mt-1">${esc(perfLabel)}: ${esc(item.performer)}</div>` : ''}
      ${expanded ? `<div class="sf-expanded-fields">
        <div><div class="sf-field-label">${esc(perfLabel)}</div>
          <datalist id="${listId}">${suggestions}</datalist>
          <input class="form-control form-control-sm" list="${listId}" data-id="${item.id}" data-performer="1"
                 value="${esc(item.performer)}" placeholder="Add ${esc(perfLabel.toLowerCase())}…" />
        </div>
        <div><div class="sf-field-label">Notes</div>
          <textarea class="form-control form-control-sm" rows="2" data-id="${item.id}">${esc(item.notes)}</textarea>
        </div>
      </div>` : ''}
    </div>
  </div>`;
}

function chapterCardHTML(item, expanded, chapterDuration) {
  const est  = item.estimatedDurationSeconds || 0;
  const over = est > 0 && chapterDuration > est;
  const estMins = Math.floor(est / 60);
  return `
  <div class="sf-chapter-card" data-id="${item.id}">
    <div class="sf-drag-handle" style="background:#fff3e0;color:#f97316">⠿</div>
    <div class="sf-card-body">
      <div class="sf-card-title-row">
        <span>📍</span>
        <input class="sf-title-input" data-id="${item.id}" value="${esc(item.title)}" placeholder="Chapter name"
               style="font-weight:700;color:#c2410c" />
        <div class="d-flex align-items-center gap-1 flex-shrink-0">
          ${chapterDuration > 0 ? `<span class="badge sf-chapter-badge ${over ? 'bg-danger' : 'bg-success'}">${ShowflowStore.formatDuration(chapterDuration)}</span>` : ''}
          <input class="sf-est-input" type="number" min="0" data-id="${item.id}" value="${estMins}" placeholder="0"
                 style="width:44px;text-align:center;font-size:12px;border:1px solid #fed7aa;border-radius:5px;padding:1px 3px;background:#fff3e0;color:#c2410c" />
          ${secsSelect(item.id, est, 'sf-est-secs-select').replace('var(--bg-primary)', '#fff3e0').replace('var(--text-primary)', '#c2410c').replace('var(--border-secondary)', '#fed7aa')}
          <span style="font-size:11px;color:#9a3412">target</span>
          <button class="sf-action-btn" data-action="expand" data-id="${item.id}">${expanded ? '▲' : '▼'}</button>
          <button class="sf-action-btn danger" data-action="delete" data-id="${item.id}">✕</button>
        </div>
      </div>
      ${expanded ? `<div class="sf-expanded-fields">
        <div><div class="sf-field-label" style="color:#9a3412">Notes</div>
          <textarea class="form-control form-control-sm" rows="2" data-id="${item.id}">${esc(item.notes)}</textarea>
        </div>
      </div>` : ''}
    </div>
  </div>`;
}

// ── Parking lot ───────────────────────────────────────────────────────────────

function renderParkingLot(show) {
  const list   = $('sf-parking-list');
  const empty  = $('sf-parking-empty');
  const parked = ShowflowStore.getParkingLotItems();

  list.innerHTML = parked.map(item => {
    const et    = show.elementTypes.find(t => t.id === item.elementTypeId);
    const color = et?.color || '#8e8e93';
    const mins  = Math.round(item.durationSeconds / 60);
    return `
    <div class="sf-parked-card" data-id="${item.id}" style="border-left:3px solid ${color}">
      <div class="d-flex align-items-stretch">
        <div class="sf-drag-handle" style="background:${color}14;color:${color}88">⠿</div>
        <div class="sf-card-body">
          <div class="sf-card-title-row">
            <span style="font-size:13px">${et?.icon || '📋'}</span>
            <input class="sf-title-input" data-id="${item.id}" value="${esc(item.title)}" style="font-size:13px" />
          </div>
          <div class="d-flex align-items-center gap-1 mt-1 ps-4">
            <input class="sf-duration-input" type="number" min="0" data-id="${item.id}" value="${mins}" style="width:36px;font-size:11px" />
            <span class="sf-duration-label">min</span>
            ${item.performer ? `<span class="text-muted small ms-1">· ${esc(item.performer)}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="sf-parked-actions">
        <button class="sf-return-btn" data-action="return" data-id="${item.id}">↩ Return</button>
        <button class="sf-delete-btn" data-action="delete" data-id="${item.id}">✕</button>
      </div>
    </div>`;
  }).join('');

  empty.classList.toggle('visible', parked.length === 0);
  wireListEvents(list);
}

// ── Shared event wiring (called after each list rebuild) ──────────────────────

function wireListEvents(list) {
  list.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', e => {
      const btn = e.currentTarget;
      const id  = btn.dataset.id;
      switch (btn.dataset.action) {
        case 'expand': ShowflowStore.setExpandedItem(id); break;
        case 'park':   ShowflowStore.moveToParking(id);   break;
        case 'return': ShowflowStore.moveFromParking(id); break;
        case 'delete': ShowflowStore.deleteItem(id);      break;
      }
    });
  });
  list.querySelectorAll('.sf-title-input').forEach(el =>
    el.addEventListener('input', e => ShowflowStore.updateItem(e.target.dataset.id, { title: e.target.value })));
  list.querySelectorAll('.sf-duration-input').forEach(el => {
    el.addEventListener('change', e => {
      const id   = e.target.dataset.id;
      const mins = parseInt(e.target.value) || 0;
      const secs = parseInt(e.target.closest('.sf-card-body, .sf-card-title-row')?.querySelector('.sf-secs-select')?.value || 0);
      ShowflowStore.updateItem(id, { durationSeconds: mins * 60 + secs });
    });
  });
  list.querySelectorAll('.sf-secs-select').forEach(el => {
    el.addEventListener('change', e => {
      const id   = e.target.dataset.id;
      const secs = parseInt(e.target.value) || 0;
      const mins = parseInt(e.target.closest('.sf-card-body, .sf-card-title-row')?.querySelector('.sf-duration-input')?.value || 0);
      ShowflowStore.updateItem(id, { durationSeconds: mins * 60 + secs });
    });
  });
  list.querySelectorAll('.sf-est-input').forEach(el => {
    el.addEventListener('change', e => {
      const id   = e.target.dataset.id;
      const mins = parseInt(e.target.value) || 0;
      const secs = parseInt(e.target.closest('.sf-card-body, .sf-card-title-row')?.querySelector('.sf-est-secs-select')?.value || 0);
      ShowflowStore.updateItem(id, { estimatedDurationSeconds: mins * 60 + secs });
    });
  });
  list.querySelectorAll('.sf-est-secs-select').forEach(el => {
    el.addEventListener('change', e => {
      const id   = e.target.dataset.id;
      const secs = parseInt(e.target.value) || 0;
      const mins = parseInt(e.target.closest('.sf-card-body, .sf-card-title-row')?.querySelector('.sf-est-input')?.value || 0);
      ShowflowStore.updateItem(id, { estimatedDurationSeconds: mins * 60 + secs });
    });
  });
  list.querySelectorAll('textarea[data-id]').forEach(el =>
    el.addEventListener('input', e => ShowflowStore.updateItem(e.target.dataset.id, { notes: e.target.value })));
  list.querySelectorAll('input[data-performer]').forEach(el =>
    el.addEventListener('input', e => ShowflowStore.updateItem(e.target.dataset.id, { performer: e.target.value })));
}

// ── File operations ───────────────────────────────────────────────────────────

async function openShowFile() {
  const result = await window.electronAPI.invoke('show:open');
  if (!result.ok) return;
  ShowflowStore.setShow(result.show);
  ShowflowStore.setCurrentFilePath(result.filePath);
}

async function saveShowAs() {
  const show = ShowflowStore.getShow(); if (!show) return;
  const result = await window.electronAPI.invoke('show:saveAs', { show });
  if (result.ok) ShowflowStore.setCurrentFilePath(result.filePath);
}

// ── Import / Export ───────────────────────────────────────────────────────────

function bindImportExport() {
  $('sf-export-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    const m = $('sf-export-menu');
    m.style.display = m.style.display === 'none' ? '' : 'none';
  });
  document.addEventListener('click', () => { const m = $('sf-export-menu'); if (m) m.style.display = 'none'; });

  $('sf-export-word')?.addEventListener('click', async () => {
    const show = ShowflowStore.getShow(); if (show) await window.ShowflowExport.exportToWord(show);
  });
  $('sf-export-excel')?.addEventListener('click', async () => {
    const show = ShowflowStore.getShow(); if (show) await window.ShowflowExport.exportToExcel(show);
  });

  $('sf-import-btn')?.addEventListener('click', () => $('sf-import-input').click());
  $('sf-import-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const show = JSON.parse(await file.text());
      ShowflowStore.setShow(show);
    } catch (err) { alert('Import failed: ' + err.message); }
    finally { e.target.value = ''; }
  });
}

// ── New Show modal ────────────────────────────────────────────────────────────

const SHOW_TYPES = [
  { value: 'keynote',       label: 'Keynote',        emoji: '🎤', desc: 'Speaker + Presenter field' },
  { value: 'dance_recital', label: 'Dance Recital',  emoji: '💃', desc: 'Dancer field, Act chapters' },
  { value: 'play',          label: 'Play / Musical', emoji: '🎭', desc: 'Actor field, Act chapters' },
  { value: 'concert',       label: 'Concert',        emoji: '🎸', desc: 'Performer field, Set chapters' },
  { value: 'custom',        label: 'Custom',         emoji: '✨', desc: 'You name everything' },
];

function openNewShowModal() {
  document.getElementById('sf-new-modal')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'sf-new-modal';
  wrap.innerHTML = `
  <div class="modal fade" id="sfNewModalInner" tabindex="-1">
    <div class="modal-dialog modal-dialog-centered">
      <div class="modal-content">
        <div class="modal-header border-0 pb-0">
          <h5 class="modal-title fw-bold">New Show</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">
          <label class="form-label fw-semibold small text-uppercase text-muted">Show Name</label>
          <input id="sf-new-name" class="form-control mb-2" placeholder="e.g. AWS re:Invent 2026 Keynote" />
          <label class="form-label fw-semibold small text-uppercase text-muted">Target Duration (minutes)</label>
          <input id="sf-new-duration" type="number" min="0" class="form-control mb-3" placeholder="e.g. 90 for 1h 30m" />
          <label class="form-label fw-semibold small text-uppercase text-muted">Show Type</label>
          <div class="d-flex flex-column gap-2">
            ${SHOW_TYPES.map((t, i) => `
            <label class="d-flex align-items-center gap-3 p-2 rounded border sf-type-option${i===0?' border-primary bg-primary bg-opacity-10':''}" style="cursor:pointer">
              <input type="radio" name="sf-show-type" value="${t.value}" ${i===0?'checked':''} class="d-none" />
              <span style="font-size:22px">${t.emoji}</span>
              <div><div class="fw-semibold">${t.label}</div><div class="text-muted small">${t.desc}</div></div>
            </label>`).join('')}
          </div>
        </div>
        <div class="modal-footer border-0 pt-0">
          <button class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
          <button class="btn btn-primary" id="sf-new-confirm">Create Show</button>
        </div>
      </div>
    </div>
  </div>`;
  document.body.appendChild(wrap);

  wrap.querySelectorAll('.sf-type-option').forEach(lbl => lbl.addEventListener('click', () => {
    wrap.querySelectorAll('.sf-type-option').forEach(l => l.classList.remove('border-primary','bg-primary','bg-opacity-10'));
    lbl.classList.add('border-primary','bg-primary','bg-opacity-10');
  }));

  const bsModal = new bootstrap.Modal(wrap.querySelector('#sfNewModalInner'));
  bsModal.show();
  setTimeout(() => wrap.querySelector('#sf-new-name')?.focus(), 300);

  wrap.querySelector('#sf-new-confirm').addEventListener('click', async () => {
    const name = wrap.querySelector('#sf-new-name').value.trim(); if (!name) return;
    const showType = wrap.querySelector('input[name="sf-show-type"]:checked').value;
    bsModal.hide();
    wrap.querySelector('#sfNewModalInner').addEventListener('hidden.bs.modal', () => {
      wrap.remove();
      const name = wrap.querySelector('#sf-new-name').value.trim(); if (!name) return;
      const showType = wrap.querySelector('input[name="sf-show-type"]:checked').value;
      const durationMins = parseInt(wrap.querySelector('#sf-new-duration').value) || 0;
      ShowflowStore.createShow(name, showType);
      if (durationMins > 0) ShowflowStore.updateShowEstimate(durationMins * 60);
    }, { once: true });
  });
  // Cancel just removes the modal
  wrap.querySelector('#sfNewModalInner').addEventListener('hidden.bs.modal', () => wrap.remove());
}

// ── Show Manager modal ────────────────────────────────────────────────────────

async function openShowManager() {
  document.getElementById('sf-manager-modal')?.remove();
  const recents = await window.electronAPI.invoke('show:listRecent');
  const curName = ShowflowStore.getShow()?.name;

  const wrap = document.createElement('div');
  wrap.id = 'sf-manager-modal';
  wrap.innerHTML = `
  <div class="modal fade" id="sfManagerInner" tabindex="-1">
    <div class="modal-dialog modal-dialog-centered modal-lg">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title fw-bold">🎬 My Shows</h5>
          <div class="d-flex gap-2 ms-auto me-3">
            <button class="btn btn-outline-secondary btn-sm" id="sf-mgr-open">Open File…</button>
            <button class="btn btn-primary btn-sm" id="sf-mgr-new">+ New Show</button>
          </div>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body" style="max-height:60vh;overflow-y:auto">
          ${recents.length === 0
            ? `<div class="text-center py-5 text-muted"><div style="font-size:48px">📂</div>
               <div class="fw-semibold mt-2">No recent files</div>
               <div class="small">Create a new show or open an existing .showflow file.</div></div>`
            : recents.map(r => `
              <div class="d-flex align-items-center gap-3 p-3 rounded mb-1 sf-recent-item${r.name===curName?' border border-primary bg-primary bg-opacity-10':''}"
                   style="cursor:pointer" data-path="${esc(r.filePath)}">
                <div class="rounded-3 d-flex align-items-center justify-content-center"
                     style="width:44px;height:44px;background:var(--bg-secondary);font-size:22px;flex-shrink:0">🎬</div>
                <div class="flex-grow-1 overflow-hidden">
                  <div class="fw-semibold text-truncate">${esc(r.name)}
                    ${r.name===curName?'<span class="badge bg-primary ms-1" style="font-size:10px">OPEN</span>':''}
                  </div>
                  <div class="small text-muted text-truncate">${esc(r.filePath)}</div>
                </div>
              </div>`).join('')}
        </div>
        ${recents.length > 0 ? `<div class="modal-footer border-0 pt-0 justify-content-start">
          <button class="btn btn-sm btn-outline-secondary" id="sf-mgr-clear">Clear Recent Files</button>
        </div>` : ''}
      </div>
    </div>
  </div>`;
  document.body.appendChild(wrap);

  const bsModal = new bootstrap.Modal(wrap.querySelector('#sfManagerInner'));
  bsModal.show();

  wrap.querySelectorAll('.sf-recent-item').forEach(el => {
    el.addEventListener('click', async () => {
      const result = await window.electronAPI.invoke('show:openPath', el.dataset.path);
      if (result.ok) { ShowflowStore.setShow(result.show); ShowflowStore.setCurrentFilePath(result.filePath); bsModal.hide(); }
      else alert('Could not open file: ' + (result.error || 'File may have been moved.'));
    });
  });
  wrap.querySelector('#sf-mgr-open')?.addEventListener('click', async () => { bsModal.hide(); await openShowFile(); });
  wrap.querySelector('#sf-mgr-new')?.addEventListener('click', () => { bsModal.hide(); openNewShowModal(); });
  wrap.querySelector('#sf-mgr-clear')?.addEventListener('click', async () => {
    await window.electronAPI.invoke('show:clearRecent'); bsModal.hide();
  });
  wrap.querySelector('#sfManagerInner').addEventListener('hidden.bs.modal', () => wrap.remove());
}

// ── Add / Edit Element Type modal ─────────────────────────────────────────────

function openAddTypeModal(existing = null) {
  document.getElementById('sf-add-type-modal')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'sf-add-type-modal';
  wrap.innerHTML = `
  <div class="modal fade" id="sfAddTypeInner" tabindex="-1">
    <div class="modal-dialog modal-dialog-centered modal-sm">
      <div class="modal-content">
        <div class="modal-header border-0 pb-0">
          <h6 class="modal-title fw-bold">${existing ? 'Edit Element Type' : 'New Element Type'}</h6>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">
          <div class="mb-2">
            <label class="form-label small fw-semibold">Name</label>
            <input id="sf-at-name" class="form-control form-control-sm" value="${esc(existing?.name || '')}" placeholder="e.g. Q&A" />
          </div>
          <div class="mb-2">
            <label class="form-label small fw-semibold">Icon (emoji)</label>
            <input id="sf-at-icon" class="form-control form-control-sm" value="${esc(existing?.icon || '📋')}" maxlength="4" />
          </div>
          <div class="mb-2">
            <label class="form-label small fw-semibold">Colour</label>
            <input id="sf-at-color" type="color" class="form-control form-control-sm form-control-color" value="${existing?.color || '#90CAF9'}" />
          </div>
        </div>
        <div class="modal-footer border-0 pt-0">
          <button class="btn btn-sm btn-secondary" data-bs-dismiss="modal">Cancel</button>
          <button class="btn btn-sm btn-primary" id="sf-at-confirm">${existing ? 'Save' : 'Add'}</button>
        </div>
      </div>
    </div>
  </div>`;
  document.body.appendChild(wrap);

  const bsModal = new bootstrap.Modal(wrap.querySelector('#sfAddTypeInner'));
  bsModal.show();
  setTimeout(() => wrap.querySelector('#sf-at-name')?.focus(), 300);

  wrap.querySelector('#sf-at-confirm').addEventListener('click', () => {
    const name  = wrap.querySelector('#sf-at-name').value.trim(); if (!name) return;
    const icon  = wrap.querySelector('#sf-at-icon').value.trim() || '📋';
    const color = wrap.querySelector('#sf-at-color').value || '#90CAF9';
    bsModal.hide();
    if (existing) {
      // Update in place
      ShowflowStore.updateElementType(existing.id, { name, icon, color });
    } else {
      ShowflowStore.addElementType(name, icon, color);
    }
  });
  wrap.querySelector('#sfAddTypeInner').addEventListener('hidden.bs.modal', () => wrap.remove());
}

function openDeleteTypeModal(etId, show) {
  const et = show.elementTypes.find(t => t.id === etId);
  if (!et) return;
  document.getElementById('sf-del-type-modal')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'sf-del-type-modal';
  wrap.innerHTML = `
  <div class="modal fade" id="sfDelTypeInner" tabindex="-1">
    <div class="modal-dialog modal-dialog-centered modal-sm">
      <div class="modal-content">
        <div class="modal-header border-0 pb-0">
          <h6 class="modal-title fw-bold">Delete Element Type</h6>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">
          <p class="mb-0">Delete <strong>${esc(et.icon)} ${esc(et.name)}</strong>? Items using this type will lose their type association.</p>
        </div>
        <div class="modal-footer border-0 pt-0">
          <button class="btn btn-sm btn-secondary" data-bs-dismiss="modal">Cancel</button>
          <button class="btn btn-sm btn-danger" id="sf-del-confirm">Delete</button>
        </div>
      </div>
    </div>
  </div>`;
  document.body.appendChild(wrap);

  const bsModal = new bootstrap.Modal(wrap.querySelector('#sfDelTypeInner'));
  bsModal.show();

  wrap.querySelector('#sf-del-confirm').addEventListener('click', () => {
    bsModal.hide();
    ShowflowStore.deleteElementType(etId);
  });
  wrap.querySelector('#sfDelTypeInner').addEventListener('hidden.bs.modal', () => wrap.remove());
}

window.ShowflowTab = { init };
})();
