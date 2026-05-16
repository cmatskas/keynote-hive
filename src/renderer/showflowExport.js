/**
 * showflowExport.js — Word/Excel export + PowerPoint import
 * Ported from officeExport.ts (ShowFlow original project)
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMins(secs) {
  if (!secs) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function runItems(show) {
  return show.items.filter(i => !i.inParkingLot).sort((a, b) => a.position - b.position);
}

function parkedItems(show) {
  return show.items.filter(i => i.inParkingLot).sort((a, b) => a.position - b.position);
}

// ── Excel export ──────────────────────────────────────────────────────────────

function toHHMM(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = s > 0 ? ':' + String(s).padStart(2, '0') : '';
  return h > 0 ? h + ':' + mm + ss : mm + ':' + String(Math.floor(totalSeconds % 60)).padStart(2, '0');
}

function toMinLabel(secs) {
  if (!secs) return '—';
  const m = secs / 60;
  return m % 1 === 0 ? m + ' min' : m.toFixed(1) + ' min';
}

async function exportToExcel(show) {
  const XLSX_LIB = window.XLSX;
  const items = show.items.filter(i => !i.inParkingLot).sort((a, b) => a.position - b.position);
  const totalSecs = items.filter(i => !i.isChapterMark).reduce((s, i) => s + (i.durationSeconds || 0), 0);
  const estSecs = show.estimatedDurationSeconds ||
    items.filter(i => i.isChapterMark && i.estimatedDurationSeconds).reduce((s, i) => s + (i.estimatedDurationSeconds || 0), 0);

  // Build section groups
  const sections = [];
  let currentSection = null;
  for (const item of items) {
    if (item.isChapterMark) {
      currentSection = { chapter: item, items: [] };
      sections.push(currentSection);
    } else if (currentSection) {
      currentSection.items.push(item);
    } else {
      // Items before any chapter mark
      sections.push({ chapter: null, items: [item] });
    }
  }

  const rows = [];

  // Title row
  rows.push([show.name, '', '', '', '', '']);
  // Summary row
  const speakerNames = [...new Set(items.filter(i => i.performer).map(i => i.performer))].join(', ');
  rows.push([
    (speakerNames ? 'Speaker: ' + speakerNames + '  |  ' : '') +
    'Target: ' + toMinLabel(estSecs) + '  |  Script rate: 140 wpm',
    '', '', '', '', ''
  ]);
  rows.push(['', '', '', '', '', '', '', '']);
  // Header row
  rows.push(['Section', 'Content', 'Speaker', 'Start', 'End', 'Duration']);

  let cursor = 0; // running seconds
  let sectionNum = 0;

  for (const sec of sections) {
    const chapter = sec.chapter;
    const secItems = sec.items;

    // Presentation items — collapsed into chapter row
    const presentationItems = secItems.filter(i => {
      const et = show.elementTypes.find(t => t.id === i.elementTypeId);
      return !et || et.name === 'Presentation' || et.isDefault;
    });
    const nonPresentationItems = secItems.filter(i => {
      const et = show.elementTypes.find(t => t.id === i.elementTypeId);
      return et && et.name !== 'Presentation' && !et.isSystem;
    });

    if (chapter) {
      sectionNum++;
      const sectionDuration = secItems.reduce((s, i) => s + (i.durationSeconds || 0), 0);
      const start = toHHMM(cursor);
      cursor += sectionDuration;
      const end = toHHMM(cursor);

      // Determine type label from non-presentation items
      const typeLabels = [...new Set(nonPresentationItems.map(i => {
        const et = show.elementTypes.find(t => t.id === i.elementTypeId);
        return et?.name || '';
      }).filter(Boolean))];
      const typeLabel = typeLabels.length > 0 ? 'Script + ' + typeLabels.join(' + ') : 'Script';

      // Speakers: chapter performer or first item performer
      const speakers = chapter.performer ||
        [...new Set(secItems.filter(i => i.performer).map(i => i.performer))].join(' + ') || '';

      // Notes: non-presentation item titles
      const notes = nonPresentationItems.map(i => {
        const et = show.elementTypes.find(t => t.id === i.elementTypeId);
        return (et?.name || '') + (i.title !== chapter.title ? ': ' + i.title : '');
      }).join(', ');

      rows.push([
        'Section ' + sectionNum,
        chapter.title,
        speakers,
        start,
        end,
        toMinLabel(sectionDuration),
      ]);
    } else {
      // Items with no chapter — one row each
      for (const item of secItems) {
        const et = show.elementTypes.find(t => t.id === item.elementTypeId);
        const start = toHHMM(cursor);
        cursor += item.durationSeconds || 0;
        rows.push(['', item.title, item.performer || '', start, toHHMM(cursor), toMinLabel(item.durationSeconds)]);
      }
    }
  }

  // Total row
  rows.push(['', 'TOTAL RUNTIME', '', toHHMM(0), toHHMM(totalSecs), toMinLabel(totalSecs)]);

  // Target / buffer row
  if (estSecs > 0) {
    const diff = estSecs - totalSecs;
    const sign = diff >= 0 ? '+' : '-';
    const status = diff >= 0 ? '✅ ' + toMinLabel(Math.abs(diff)) + ' buffer' : '⚠️ ' + toMinLabel(Math.abs(diff)) + ' over';
    rows.push(['', 'TARGET: ' + toMinLabel(estSecs) + '  |  ' + status, '', '', '', sign + toMinLabel(Math.abs(diff))]);
  }

  const wb = XLSX_LIB.utils.book_new();
  const ws = XLSX_LIB.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 12 }, { wch: 40 }, { wch: 28 }, { wch: 8 }, { wch: 8 }, { wch: 10 }];
  XLSX_LIB.utils.book_append_sheet(wb, ws, 'Run of Show');

  const filename = show.name.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '_run_of_show.xlsx';
  const wbout = XLSX_LIB.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Word export ─────────────────────────────────────────────────────────────

async function exportToWord(show) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    HeadingLevel, WidthType, BorderStyle } = window.docx;

  const items  = runItems(show);
  const parked = parkedItems(show);
  const totalSecs = items.filter(i => !i.isChapterMark).reduce((s, i) => s + (i.durationSeconds || 0), 0);
  const estSecs = show.estimatedDurationSeconds ||
    items.filter(i => i.isChapterMark && i.estimatedDurationSeconds).reduce((s, i) => s + (i.estimatedDurationSeconds || 0), 0);

  const border = { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' };
  const borders = { top: border, bottom: border, left: border, right: border };

  const cell = (text, bold = false, widthPct = 20) =>
    new TableCell({
      width: { size: widthPct, type: WidthType.PERCENTAGE },
      borders,
      children: [new Paragraph({
        children: [new TextRun({ text: String(text || ''), bold, size: 20, font: 'Calibri' })],
        spacing: { before: 40, after: 40 },
      })],
    });

  // Build section map: item id -> section name
  const sectionMap = {};
  let currentSection = '';
  for (const item of items) {
    if (item.isChapterMark) { currentSection = item.title; }
    else { sectionMap[item.id] = currentSection; }
  }

  const headerRow = new TableRow({ tableHeader: true, children: [
    cell('#', true, 5), cell('Section', true, 18), cell('Type', true, 12),
    cell('Title', true, 28), cell(show.performerLabel, true, 17),
    cell('Duration', true, 10), cell('Notes', true, 10),
  ]});

  let seq = 0;
  const dataRows = items
    .filter(i => !i.isChapterMark)
    .map(item => {
      seq++;
      const et = show.elementTypes.find(t => t.id === item.elementTypeId);
      return new TableRow({ children: [
        cell(seq, false, 5),
        cell(sectionMap[item.id] || '', false, 18),
        cell(et?.name || '', false, 12),
        cell(item.title, false, 28),
        cell(item.performer || '', false, 17),
        cell(formatMins(item.durationSeconds), false, 10),
        cell(item.notes || '', false, 10),
      ]});
    });

  const docChildren = [
    new Paragraph({ text: show.name, heading: HeadingLevel.HEADING_1, spacing: { after: 120 } }),
    new Paragraph({ spacing: { after: 300 }, children: [
      new TextRun({ text: 'Total: ' + formatMins(totalSecs), size: 20, font: 'Calibri' }),
      estSecs ? new TextRun({ text: '   Target: ' + formatMins(estSecs), size: 20, font: 'Calibri' }) : new TextRun(''),
      new TextRun({ text: '   Items: ' + dataRows.length, size: 20, font: 'Calibri' }),
    ]}),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...dataRows] }),
  ];

  if (parked.length > 0) {
    docChildren.push(new Paragraph({ text: 'Parking Lot', heading: HeadingLevel.HEADING_2, spacing: { before: 400, after: 120 } }));
    const parkRows = [
      new TableRow({ tableHeader: true, children: [
        cell('Type', true, 20), cell('Title', true, 40),
        cell(show.performerLabel, true, 20), cell('Duration', true, 10), cell('Notes', true, 10),
      ]}),
      ...parked.map(item => {
        const et = show.elementTypes.find(t => t.id === item.elementTypeId);
        return new TableRow({ children: [
          cell(et?.name || '', false, 20), cell(item.title, false, 40),
          cell(item.performer || '', false, 20), cell(formatMins(item.durationSeconds), false, 10),
          cell(item.notes || '', false, 10),
        ]});
      }),
    ];
    docChildren.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: parkRows }));
  }

  const doc = new Document({
    sections: [{ children: docChildren }],
    styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },
  });

  const buffer = await Packer.toBlob(doc);
  const url = URL.createObjectURL(buffer);
  const a = document.createElement('a');
  a.href = url;
  a.download = show.name.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.showflow.docx';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── PowerPoint import ─────────────────────────────────────────────────────────

const WPM = 140;
const P14_NS = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
const PML_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DML_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

async function importFromPptx(file) {
  const JSZip = window.JSZip;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const parser = new DOMParser();

  // Parse presentation.xml for slide order and sections
  const presXml = await zip.files['ppt/presentation.xml'].async('string');
  const presDoc = parser.parseFromString(presXml, 'application/xml');

  // Build ordered slide ID list
  const slideIdEls = presDoc.getElementsByTagNameNS(PML_NS, 'sldId');
  const slideIdOrder = Array.from(slideIdEls).map(el => el.getAttribute('id'));

  // Count words per slide (by index, not by ID — slide files are slide1.xml, slide2.xml...)
  const slideWordCounts = {};
  for (let i = 0; i < slideIdOrder.length; i++) {
    const slidePath = 'ppt/slides/slide' + (i + 1) + '.xml';
    if (!zip.files[slidePath]) continue;
    const xml = await zip.files[slidePath].async('string');
    const doc = parser.parseFromString(xml, 'application/xml');
    const textNodes = doc.getElementsByTagNameNS(DML_NS, 't');
    const words = Array.from(textNodes).map(t => t.textContent).join(' ').split(/s+/).filter(Boolean).length;
    slideWordCounts[slideIdOrder[i]] = words;
  }

  const durationForId = (id) => Math.max(60, Math.ceil((slideWordCounts[id] || 30) / WPM) * 60);

  const { DEFAULT_ELEMENT_TYPES, CHAPTER_MARK_TYPE, PERFORMER_LABELS, CHAPTER_LABELS } = window.ShowflowStore;
  const defaults = DEFAULT_ELEMENT_TYPES.keynote;
  const presentationEt = defaults.find(t => t.name === 'Presentation') || defaults[0];
  const elementTypes = [
    { ...CHAPTER_MARK_TYPE, customFieldDefs: [] },
    ...defaults.map(t => ({ ...t, customFieldDefs: [] })),
  ];

  const showName = file.name.replace(/.pptx$/i, '').replace(/[-_]/g, ' ');
  const items = [];
  let position = 0;

  const sectionEls = presDoc.getElementsByTagNameNS(P14_NS, 'section');

  if (sectionEls.length > 0) {
    Array.from(sectionEls).forEach(sec => {
      const sectionName = sec.getAttribute('name') || 'Section';
      const sldIds = Array.from(sec.getElementsByTagNameNS(P14_NS, 'sldId')).map(el => el.getAttribute('id'));
      const sectionDuration = sldIds.reduce((sum, id) => sum + durationForId(id), 0);

      // Chapter mark for the section
      items.push({
        id: crypto.randomUUID(), elementTypeId: CHAPTER_MARK_TYPE.id,
        title: sectionName, durationSeconds: 0,
        estimatedDurationSeconds: sectionDuration,
        performer: '', notes: sldIds.length + ' slide' + (sldIds.length !== 1 ? 's' : ''),
        customFields: [], position: position++, inParkingLot: false, isChapterMark: true,
      });

      // One Presentation item representing the section content
      if (sectionDuration > 0) {
        items.push({
          id: crypto.randomUUID(), elementTypeId: presentationEt.id,
          title: sectionName, durationSeconds: sectionDuration,
          performer: '', notes: '',
          customFields: [], position: position++, inParkingLot: false, isChapterMark: false,
        });
      }
    });
  } else {
    // No sections — single item with total duration
    const totalDuration = slideIdOrder.reduce((sum, id) => sum + durationForId(id), 0);
    items.push({
      id: crypto.randomUUID(), elementTypeId: presentationEt.id,
      title: showName, durationSeconds: totalDuration,
      performer: '', notes: slideIdOrder.length + ' slides',
      customFields: [], position: 0, inParkingLot: false, isChapterMark: false,
    });
  }

  const totalEst = items.filter(i => !i.isChapterMark).reduce((s, i) => s + i.durationSeconds, 0);
  return {
    id: crypto.randomUUID(), name: showName, showType: 'keynote',
    performerLabel: PERFORMER_LABELS.keynote, chapterLabel: CHAPTER_LABELS.keynote,
    estimatedDurationSeconds: totalEst, elementTypes, items,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

window.ShowflowExport = { exportToExcel, exportToWord, importFromPptx };
