/**
 * storyboardExport.js — write a colour-coded analysis out as one HTML file.
 *
 * Self-contained on purpose: no stylesheet link, no font request, no script from a
 * CDN. The exported file is something you email to a co-presenter or open in two
 * years, and either of those breaks the moment it depends on something external.
 * That also means it renders identically offline, which matches how the rest of
 * Hive behaves.
 *
 * The output deliberately follows the shape of the reference `keynote.html` — a
 * legend bar, the script, and a sticky explanation rail — because that artifact is
 * the known-good target. It uses the same system UI font stack as the app rather
 * than the reference's serif pairing, so an export looks like the tab it came from. It carries the same seven-colour palette and the same
 * Colour/Plain toggle, reimplemented standalone rather than by scraping the live
 * DOM, so a change to the tab's markup cannot silently corrupt an export.
 */
(() => {
  'use strict';

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Filesystem-safe stem for the download. */
  function safeFileName(name) {
    const stem = String(name || 'storybrand-analysis')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase();
    return `${stem || 'storybrand-analysis'}.html`;
  }

  function buildStyles(elements) {
    const vars = elements.map(e => `    --${e.slug}: ${e.hex};`).join('\n');
    const colours = elements.map(e => `  .c-${e.slug} { color: var(--${e.slug}); }`).join('\n');
    const cards = elements.map(e => `
  .info-card.${e.slug} { color: var(--${e.slug}); --el: var(--${e.slug}); }`).join('');

    return `  :root {
${vars}
    --canvas: #F6F7F9;
    --surface: #ffffff;
    --ink: #222;
    --ink-soft: #555;
    --hairline: rgba(0,0,0,.08);
    /* Bootstrap 5.3's default stack, so an export looks like the tab it came from.
       No webfont: this file has to render identically offline and in two years. */
    --sans: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans',
            'Liberation Sans', Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji';
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--canvas);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 17.5px;
    line-height: 1.65;
  }
  .bar {
    position: fixed; inset: 0 0 auto 0; z-index: 10;
    display: flex; align-items: center; gap: 14px;
    padding: 11px 18px;
    background: rgba(255,255,255,.82);
    backdrop-filter: saturate(180%) blur(12px);
    -webkit-backdrop-filter: saturate(180%) blur(12px);
    border-bottom: 1px solid var(--hairline);
  }
  .bar.scrolled { box-shadow: 0 4px 16px rgba(0,0,0,.08); }
  /* Flow ribbon. Outside the scrolling content so it stays put — it is a minimap
     as well as a picture of the talk. */
  .flow { padding: 10px 22px 8px; background: var(--surface); border-bottom: 1px solid var(--hairline);
          position: sticky; top: 52px; z-index: 9; }
  .flow-track { display: flex; gap: 2px; height: 14px; }
  /* flex-basis 0 so a segment's width is its share of the script and nothing
     else; with auto an empty button still claims content width. */
  .flow-seg { flex: 1 1 0; min-width: 3px; padding: 0; border: none; border-radius: 3px;
              background: var(--el); opacity: 0.78; cursor: pointer;
              transition: opacity 0.15s ease, transform 0.15s ease; }
  .flow-seg:hover, .flow-seg:focus-visible { opacity: 1; transform: scaleY(1.35);
              transform-origin: top; outline: none; }
  .flow-seg.current { opacity: 1; box-shadow: 0 0 0 2px var(--surface), 0 0 0 3px currentColor; }
  .flow-caption { margin-top: 7px; font-size: 11.5px; color: var(--ink-soft); min-height: 14px; }
  .flow-caption.detail { font-weight: 600; }
  /* Plain mode drops the ribbon's colour with the script's, so the toggle means
     the same thing in both places. */
  body.plain .flow-seg { background: var(--ink-soft) !important; color: var(--ink-soft) !important; }

  .legend { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 500; white-space: nowrap; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .segmented {
    position: relative; margin-left: auto; display: inline-flex; padding: 3px;
    border-radius: 999px; background: rgba(0,0,0,.06); border: 1px solid var(--hairline);
  }
  .seg { position: relative; z-index: 1; border: 0; background: transparent; color: var(--ink-soft);
         font: 600 12.5px var(--sans); padding: 4px 14px; border-radius: 999px; cursor: pointer; transition: color .25s ease; }
  .seg.active { color: var(--ink); }
  .thumb { position: absolute; top: 3px; left: 3px; height: calc(100% - 6px); border-radius: 999px;
           background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.16);
           transition: transform .28s cubic-bezier(.4,0,.2,1), width .28s ease; }
  .canvas {
    background:
      radial-gradient(55% 40% at 12% 0%, rgba(21,101,192,.05), transparent 70%),
      radial-gradient(45% 35% at 88% 6%, rgba(106,27,154,.04), transparent 70%);
    padding: 96px 24px 110px;
  }
  .grid { max-width: 1180px; margin: 0 auto; display: grid;
          grid-template-columns: minmax(0,720px) 340px; gap: 34px; justify-content: center; align-items: start; }
  .surface { min-width: 0; background: var(--surface); border: 1px solid var(--hairline);
             border-radius: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06);
             padding: 40px 44px 44px; }
  h1, h2, h3 { font-weight: 650; letter-spacing: -.01em; }
  h1 { font-size: 31px; line-height: 1.25; margin-bottom: 26px; }
  h2 { font-size: 23px; margin: 38px 0 14px; }
  h3 { font-size: 19px; margin: 26px 0 10px; }
  p { margin-bottom: 19px; }
  .children { margin: -8px 0 19px; padding-left: 20px; list-style: none; }
  .children li { position: relative; margin-bottom: 6px; font-size: 16px; }
  .children li::before { content: ''; position: absolute; left: -14px; top: .62em; width: 6px; height: 6px;
                         border-radius: 50%; background: currentColor; opacity: .55; }
${colours}
  body.plain [class*="c-"] { color: var(--ink); }
  body.plain .rail { display: none; }
  body.plain .grid { grid-template-columns: minmax(0,760px); }
  .rail { position: sticky; top: 90px; align-self: start; }
  .info-card { position: relative; background: var(--surface); border: 1px solid var(--hairline);
               border-radius: 14px; overflow: hidden;
               box-shadow: 0 1px 3px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06); }
  .accent { height: 4px; background: currentColor; transition: background-color .4s ease; }
  .info-body { padding: 18px 20px 20px; }
  .swatch { width: 26px; height: 26px; border-radius: 50%; background: currentColor;
            box-shadow: 0 0 0 5px rgba(0,0,0,.06); margin-bottom: 14px; }
  .eyebrow { font-size: 11.5px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; margin-bottom: 5px; }
  .info-title { font-size: 20px; font-weight: 600; line-height: 1.3; margin-bottom: 6px; }
  .tagline { font-size: 13.5px; font-style: italic; color: var(--ink-soft); line-height: 1.55; margin-bottom: 14px; }
  .points { list-style: none; }
  .points li { position: relative; padding-left: 15px; font-size: 13.5px; line-height: 1.55; color: var(--ink); margin-bottom: 9px; }
  /* --el rather than currentColor: .points li sets its own text colour for
     readability, which would otherwise make the marker grey. */
  .points li::before { content: ''; position: absolute; left: 0; top: .55em; width: 6px; height: 6px;
                       border-radius: 50%; background: var(--el, currentColor); }
${cards}
  .audit { max-width: 1094px; margin: 34px auto 0; background: var(--surface);
           border: 1px solid var(--hairline); border-radius: 14px; padding: 24px 28px; }
  .audit h2 { margin-top: 0; }
  .audit-el { border: 1px solid var(--hairline); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
  .audit-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .audit-name { font-weight: 600; font-size: 14px; }
  .status { margin-left: auto; font-size: 11px; font-weight: 700; letter-spacing: .06em;
            text-transform: uppercase; padding: 2px 8px; border-radius: 999px; background: rgba(0,0,0,.07); color: var(--ink-soft); }
  .audit-line { font-size: 13px; line-height: 1.55; color: var(--ink-soft); margin-top: 4px; }
  .audit-line strong { color: var(--ink); }
  .foot { max-width: 1094px; margin: 26px auto 0; font-size: 12px; color: var(--ink-soft); text-align: center; }
  @media (max-width: 1180px) {
    .grid { grid-template-columns: minmax(0,100%); }
    .rail { position: static; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }`;
  }

  function buildScript(elements) {
    // Definitions are inlined rather than fetched, so the file stands alone.
    const defs = JSON.stringify(elements.reduce((acc, e) => {
      acc[e.key] = { slug: e.slug, label: e.label, title: e.title, tagline: e.tagline, points: e.points };
      return acc;
    }, {}));

    return `(function () {
  var DEFS = ${defs};
  var bar = document.getElementById('bar');
  var segColour = document.getElementById('segColour');
  var segPlain = document.getElementById('segPlain');
  var thumb = document.getElementById('thumb');
  var card = document.getElementById('infoCard');

  function moveThumb() {
    var active = document.body.classList.contains('plain') ? segPlain : segColour;
    thumb.style.width = active.offsetWidth + 'px';
    thumb.style.transform = 'translateX(' + (active.offsetLeft - 3) + 'px)';
  }
  function setPlain(plain) {
    document.body.classList.toggle('plain', plain);
    segColour.classList.toggle('active', !plain);
    segPlain.classList.toggle('active', plain);
    moveThumb();
  }
  segColour.addEventListener('click', function () { setPlain(false); });
  segPlain.addEventListener('click', function () { setPlain(true); });
  window.addEventListener('resize', moveThumb);
  moveThumb();

  var blocks = [].slice.call(document.querySelectorAll('[data-element]'));
  var currentKey = null;
  function renderRail(key) {
    var def = DEFS[key];
    if (!def || key === currentKey) return;
    currentKey = key;
    card.className = 'info-card ' + def.slug;
    document.getElementById('eyebrow').textContent = def.label;
    document.getElementById('infoTitle').textContent = def.title;
    document.getElementById('tagline').textContent = def.tagline;
    var list = document.getElementById('points');
    list.innerHTML = '';
    (def.points || []).forEach(function (p) {
      var li = document.createElement('li');
      li.textContent = p;
      list.appendChild(li);
    });
  }
  function update() {
    bar.classList.toggle('scrolled', window.scrollY > 4);
    var anchor = window.innerHeight * 0.35;
    var key = blocks.length ? blocks[0].getAttribute('data-element') : null;
    var idx = blocks.length ? blocks[0].getAttribute('data-index') : null;
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].getBoundingClientRect().top <= anchor) {
        key = blocks[i].getAttribute('data-element');
        idx = blocks[i].getAttribute('data-index');
      } else break;
    }
    renderRail(key);
    markFlow(idx);
  }

  // ── Flow ribbon ──
  var segs = [].slice.call(document.querySelectorAll('.flow-seg'));
  var caption = document.getElementById('flowCaption');
  var summary = caption ? caption.textContent : '';
  var currentSeg = -1;

  function setCaption(text, detail, colour) {
    if (!caption) return;
    caption.textContent = text;
    caption.className = 'flow-caption' + (detail ? ' detail' : '');
    caption.style.color = colour || '';
  }

  /* Highlights the run containing the given paragraph index, so the ribbon reports position
     rather than just composition. Ranges come from the segments themselves — the
     document carries no copy of the run table. */
  function markFlow(idx) {
    if (!segs.length || idx === null) return;
    var n = parseInt(idx, 10);
    var found = -1;
    for (var i = 0; i < segs.length; i++) {
      var start = parseInt(segs[i].getAttribute('data-index'), 10);
      var next = i + 1 < segs.length ? parseInt(segs[i + 1].getAttribute('data-index'), 10) : Infinity;
      if (n >= start && n < next) { found = i; break; }
    }
    if (found === currentSeg) return;
    currentSeg = found;
    for (var j = 0; j < segs.length; j++) segs[j].classList.toggle('current', j === found);
    if (found >= 0) {
      setCaption(segs[found].getAttribute('data-caption'), true, segs[found].style.color);
    }
  }

  segs.forEach(function (seg) {
    seg.addEventListener('click', function () {
      var target = document.querySelector('[data-index="' + seg.getAttribute('data-index') + '"]');
      if (!target) return;
      var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var top = target.getBoundingClientRect().top + window.pageYOffset - window.innerHeight * 0.25;
      window.scrollTo({ top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' });
    });
    var show = function () { setCaption(seg.getAttribute('data-caption'), true, seg.style.color); };
    seg.addEventListener('mouseenter', show);
    seg.addEventListener('focus', show);
  });

  var track = document.getElementById('flowTrack');
  if (track) {
    track.addEventListener('mouseleave', function () {
      if (currentSeg >= 0) setCaption(segs[currentSeg].getAttribute('data-caption'), true, segs[currentSeg].style.color);
      else setCaption(summary, false, '');
    });
    track.addEventListener('keydown', function (e) {
      var dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      var at = segs.indexOf(document.activeElement);
      var next = segs[Math.min(segs.length - 1, Math.max(0, at + dir))];
      if (next) next.focus();
    });
  }

  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { update(); ticking = false; });
  }, { passive: true });
  update();
})();`;
  }

  function buildBody(analysis, elements) {
    const byKey = new Map(elements.map(e => [e.key, e]));

    const script = (analysis.units || []).map(unit => {
      const def = byKey.get(analysis.classifications?.[unit.index]);
      const cls = def ? ` class="c-${def.slug}"` : '';
      // data-index on every block, classified or not: the ribbon's click targets
      // resolve through it, and an unclassified paragraph still has a position.
      const attr = ` data-index="${unit.index}"` + (def ? ` data-element="${esc(def.key)}"` : '');
      const tag = unit.kind === 'heading'
        ? (unit.level === 1 ? 'h1' : unit.level === 2 ? 'h2' : 'h3')
        : 'p';
      const children = (unit.children || []).length
        ? `\n    <ul class="children${def ? ` c-${def.slug}` : ''}">${unit.children
            .map(c => `<li>${esc(c)}</li>`).join('')}</ul>`
        : '';
      return `    <${tag}${cls}${attr}>${esc(unit.text)}</${tag}>${children}`;
    }).join('\n');

    const legend = elements
      .map(e => `      <span class="legend-item"><span class="dot" style="background:${e.hex}"></span>${esc(e.label)}</span>`)
      .join('\n');

    return { script, legend, flow: buildFlow(analysis, elements) };
  }

  /**
   * The flow ribbon: one segment per run of consecutive paragraphs sharing an
   * element, sized by word count.
   *
   * Uses the same StoryboardFlow.buildFlow the tab does, so a shared file and the
   * tab it came from cannot disagree about the shape of the story. Colours are
   * inlined as hex rather than referencing custom properties, because an export
   * has to render standalone with no stylesheet of ours behind it.
   *
   * Returns '' for a script with one run or none — a single full-width bar implies
   * structure the script does not have.
   */
  function buildFlow(analysis, elements) {
    const flowApi = typeof window !== 'undefined' ? window.StoryboardFlow : null;
    if (!flowApi) return '';

    const runs = flowApi.buildFlow(analysis.units || [], analysis.classifications || {});
    if (runs.length <= 1) return '';

    const byKey = new Map(elements.map(e => [e.key, e]));
    const segs = runs.map((run, i) => {
      const def = byKey.get(run.key);
      const label = def ? def.label : 'Unclassified';
      const range = run.startIndex === run.endIndex
        ? `paragraph ${run.startIndex}`
        : `paragraphs ${run.startIndex}\u2013${run.endIndex}`;
      const pct = Math.round(run.share * 100);
      const colour = def ? def.hex : '#9aa0a6';
      return `    <button type="button" class="flow-seg" data-run="${i}" data-index="${run.startIndex}"
      style="flex-grow:${run.share * 1000}; --el:${colour}; color:${colour}"
      title="${esc(label)} \u00b7 ${range} \u00b7 ${run.words.toLocaleString()} words (${pct}%)"
      aria-label="Jump to ${esc(label)}, ${range}"
      data-caption="${esc(label)} \u00b7 ${range} \u00b7 ${run.words.toLocaleString()} words (${pct}%)"></button>`;
    }).join('\n');

    return `<div class="flow" role="navigation" aria-label="Story flow">
  <div class="flow-track" id="flowTrack">
${segs}
  </div>
  <div class="flow-caption" id="flowCaption">${runs.length} sections \u00b7 hover to inspect, click to jump</div>
</div>`;
  }

  function buildAudit(audit, elements) {
    if (!audit) return '';
    const labels = { strong: 'Strong', weak: 'Weak', missing: 'Missing', unknown: 'Unrated' };

    const cards = elements.map(def => {
      const entry = audit.elements?.[def.key] || { status: 'unknown' };
      const lines = [
        entry.found ? `<div class="audit-line"><em>${esc(entry.found)}</em></div>` : '',
        entry.issue ? `<div class="audit-line"><strong>Issue:</strong> ${esc(entry.issue)}</div>` : '',
        entry.fix ? `<div class="audit-line"><strong>Fix:</strong> ${esc(entry.fix)}</div>` : '',
      ].join('');
      return `    <div class="audit-el" style="color:${def.hex}">
      <div class="audit-head">
        <span class="dot" style="background:currentColor"></span>
        <span class="audit-name">${esc(def.label)}</span>
        <span class="status">${esc(labels[entry.status] || entry.status)}</span>
      </div>${lines}
    </div>`;
    }).join('\n');

    const list = (title, items) => (items?.length
      ? `    <h3>${title}</h3>\n    <ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`
      : '');

    return `  <section class="audit">
    <h2>Audit</h2>
${audit.overall ? `    <p>${esc(audit.overall)}</p>` : ''}
${cards}
${list('What&rsquo;s working', audit.whatsWorking)}
${list('Quick wins', audit.quickWins)}
  </section>`;
  }

  /** Build the complete HTML document. */
  function buildHtml(analysis, elements) {
    const { script, legend, flow } = buildBody(analysis, elements);
    const title = analysis.displayName || analysis.sourceName || 'StoryBrand analysis';
    const when = new Date(analysis.createdAt || Date.now()).toLocaleString();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} — StoryBrand analysis</title>
<style>
${buildStyles(elements)}
</style>
</head>
<body>

<div class="bar" id="bar">
  <div class="legend">
${legend}
  </div>
  <div class="segmented" role="group" aria-label="Colour coding">
    <button class="seg active" id="segColour">Colour</button>
    <button class="seg" id="segPlain">Plain</button>
    <span class="thumb" id="thumb"></span>
  </div>
</div>

${flow}

<div class="canvas">
  <div class="grid">
    <main class="surface">
${script}
    </main>
    <aside class="rail">
      <div class="info-card" id="infoCard">
        <div class="accent"></div>
        <div class="info-body">
          <div class="swatch"></div>
          <div class="eyebrow" id="eyebrow"></div>
          <div class="info-title" id="infoTitle"></div>
          <div class="tagline" id="tagline"></div>
          <ul class="points" id="points"></ul>
        </div>
      </div>
    </aside>
  </div>
${buildAudit(analysis.audit, elements)}
  <div class="foot">
    ${esc(title)} · ${analysis.unitCount || (analysis.units || []).length} paragraphs ·
    ${(analysis.wordCount || 0).toLocaleString()} words · analysed ${esc(when)}
    ${analysis.modelId ? `· ${esc(analysis.modelId)}` : ''}
  </div>
</div>

<script>
${buildScript(elements)}
</script>
</body>
</html>`;
  }

  /** Build and trigger a download. */
  function download(analysis, elements) {
    const html = buildHtml(analysis, elements);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = safeFileName(analysis.displayName || analysis.sourceName);
    link.click();
    URL.revokeObjectURL(link.href);
    return html;
  }

  window.StoryboardExport = { buildHtml, download, safeFileName, esc };
})();
