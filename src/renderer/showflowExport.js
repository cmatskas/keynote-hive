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

// ── Shared data builder ───────────────────────────────────────────────────────

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

function buildShowData(show) {
  const items = runItems(show);
  const parked = parkedItems(show);
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
      sections.push({ chapter: null, items: [item] });
    }
  }

  // Build timed rows — section-grouped with non-presentation items as separate rows
  const rows = [];
  let cursor = 0;
  let sectionNum = 0;

  for (const sec of sections) {
    const chapter = sec.chapter;
    const secItems = sec.items;

    if (chapter) {
      sectionNum++;

      const presentationItems = secItems.filter(i => {
        const et = show.elementTypes.find(t => t.id === i.elementTypeId);
        return !et || et.name === 'Presentation' || (!et.isSystem && et.id === 'et-presentation');
      });
      const nonPresentationItems = secItems.filter(i => {
        const et = show.elementTypes.find(t => t.id === i.elementTypeId);
        return et && et.name !== 'Presentation' && et.id !== 'et-presentation';
      });

      const presDuration = presentationItems.reduce((s, i) => s + (i.durationSeconds || 0), 0);
      const start = toHHMM(cursor);
      cursor += presDuration;

      const speakers = chapter.performer ||
        [...new Set(presentationItems.filter(i => i.performer).map(i => i.performer))].join(' + ') || '';

      rows.push({
        section: 'Section ' + sectionNum,
        content: chapter.title,
        speaker: speakers,
        start,
        end: toHHMM(cursor),
        duration: presDuration,
      });

      for (const item of nonPresentationItems) {
        const et = show.elementTypes.find(t => t.id === item.elementTypeId);
        const itemStart = toHHMM(cursor);
        cursor += item.durationSeconds || 0;
        rows.push({
          section: '',
          content: (et?.name ? et.name + ': ' : '') + item.title,
          speaker: item.performer || '',
          start: itemStart,
          end: toHHMM(cursor),
          duration: item.durationSeconds || 0,
        });
      }
    } else {
      for (const item of secItems) {
        const start = toHHMM(cursor);
        cursor += item.durationSeconds || 0;
        rows.push({
          section: '',
          content: item.title,
          speaker: item.performer || '',
          start,
          end: toHHMM(cursor),
          duration: item.durationSeconds || 0,
        });
      }
    }
  }

  // Buffer/target info
  let bufferInfo = null;
  if (estSecs > 0) {
    const diff = estSecs - totalSecs;
    bufferInfo = {
      diff,
      sign: diff >= 0 ? '+' : '-',
      status: diff >= 0 ? '✅ ' + toMinLabel(Math.abs(diff)) + ' buffer' : '⚠️ ' + toMinLabel(Math.abs(diff)) + ' over',
    };
  }

  // Speaker summary
  const speakerNames = [...new Set(items.filter(i => i.performer).map(i => i.performer))].join(', ');

  return { items, parked, totalSecs, estSecs, rows, bufferInfo, speakerNames };
}

// ── Excel export ──────────────────────────────────────────────────────────────

async function exportToExcel(show) {
  const { totalSecs, estSecs, rows, bufferInfo, speakerNames } = buildShowData(show);

  const xlRows = [];

  // Title row
  xlRows.push([show.name, '', '', '', '', '']);
  // Summary row
  xlRows.push([
    (speakerNames ? 'Speaker: ' + speakerNames + '  |  ' : '') +
    'Target: ' + toMinLabel(estSecs) + '  |  Script rate: 140 wpm',
    '', '', '', '', ''
  ]);
  xlRows.push(['', '', '', '', '', '', '', '']);
  // Header row
  xlRows.push(['Section', 'Content', 'Speaker', 'Start', 'End', 'Duration']);

  // Data rows
  for (const r of rows) {
    xlRows.push([r.section, r.content, r.speaker, r.start, r.end, toMinLabel(r.duration)]);
  }

  // Total row
  xlRows.push(['', 'TOTAL RUNTIME', '', toHHMM(0), toHHMM(totalSecs), toMinLabel(totalSecs)]);

  // Target / buffer row
  if (bufferInfo) {
    xlRows.push(['', 'TARGET: ' + toMinLabel(estSecs) + '  |  ' + bufferInfo.status, '', '', '', bufferInfo.sign + toMinLabel(Math.abs(bufferInfo.diff))]);
  }

  const buffer = await window.ExcelExport.generate({
    sheetName: 'Run of Show',
    rows: xlRows,
    colWidths: [12, 40, 28, 8, 8, 10],
  });

  const filename = show.name.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.xlsx';
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
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

  const { totalSecs, estSecs, rows, bufferInfo, speakerNames } = buildShowData(show);

  const border = { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' };
  const borders = { top: border, bottom: border, left: border, right: border };

  const cell = (text, bold = false, widthPct = 16) =>
    new TableCell({
      width: { size: widthPct, type: WidthType.PERCENTAGE },
      borders,
      children: [new Paragraph({
        children: [new TextRun({ text: String(text || ''), bold, size: 20, font: 'Calibri' })],
        spacing: { before: 40, after: 40 },
      })],
    });

  // Header row
  const headerRow = new TableRow({ tableHeader: true, children: [
    cell('Section', true, 14), cell('Content', true, 34), cell('Speaker', true, 22),
    cell('Start', true, 8), cell('End', true, 8), cell('Duration', true, 14),
  ]});

  // Data rows from shared builder
  const dataRows = rows.map(r => new TableRow({ children: [
    cell(r.section, false, 14),
    cell(r.content, false, 34),
    cell(r.speaker, false, 22),
    cell(r.start, false, 8),
    cell(r.end, false, 8),
    cell(toMinLabel(r.duration), false, 14),
  ]}));

  // Total row
  const totalRow = new TableRow({ children: [
    cell('', false, 14), cell('TOTAL RUNTIME', true, 34), cell('', false, 22),
    cell(toHHMM(0), false, 8), cell(toHHMM(totalSecs), false, 8),
    cell(toMinLabel(totalSecs), true, 14),
  ]});

  const tableRows = [headerRow, ...dataRows, totalRow];

  if (bufferInfo) {
    const targetRow = new TableRow({ children: [
      cell('', false, 14),
      cell('TARGET: ' + toMinLabel(estSecs) + '  |  ' + bufferInfo.status, true, 34),
      cell('', false, 22), cell('', false, 8), cell('', false, 8),
      cell(bufferInfo.sign + toMinLabel(Math.abs(bufferInfo.diff)), false, 14),
    ]});
    tableRows.push(targetRow);
  }

  const docChildren = [
    new Paragraph({ text: show.name, heading: HeadingLevel.HEADING_1, spacing: { after: 120 } }),
    new Paragraph({ spacing: { after: 300 }, children: [
      new TextRun({ text: (speakerNames ? 'Speaker: ' + speakerNames + '  |  ' : '') +
        'Target: ' + toMinLabel(estSecs) + '  |  Script rate: 140 wpm', size: 20, font: 'Calibri' }),
    ]}),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: tableRows }),
  ];

  const doc = new Document({
    sections: [{ children: docChildren }],
    styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },
  });

  const buffer = await Packer.toBlob(doc);
  const url = URL.createObjectURL(buffer);
  const a = document.createElement('a');
  a.href = url;
  a.download = show.name.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.docx';
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
