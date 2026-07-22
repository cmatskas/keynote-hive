const { contextBridge, ipcRenderer } = require('electron');
const Toastify = require('toastify-js');
const { marked } = require('marked');

// Configure marked: enable GFM + line breaks, escape any raw HTML in source
marked.setOptions({ breaks: true, gfm: true });
const renderer = new marked.Renderer();
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
renderer.html = function (token) { return escapeHtml(token.raw || token.text || ''); };
marked.use({ renderer });

contextBridge.exposeInMainWorld('marked', { parse: (md) => marked.parse(md) });

// Expose ExcelJS workbook generation to renderer
const ExcelJS = require('exceljs');
contextBridge.exposeInMainWorld('ExcelExport', {
  /**
   * Build a showflow-style run-of-show xlsx workbook with live formulas,
   * real Excel durations/times, merged header cells, and styling —
   * matching the reference "Keynote" run-of-show format.
   *
   * @param {object} opts
   * @param {string} opts.sheetName - worksheet tab name
   * @param {string} opts.showName - title shown in the merged header banner
   * @param {string} opts.lastUpdatedLabel - e.g. "Last Updated Jun 29"
   * @param {string[]} opts.legendLines - short key/legend lines under the title (e.g. speaker roles)
   * @param {string|null} opts.startClockTime - "HH:MM" 24h anchor for the clock-time column, or null
   * @param {Array<{section:string, subsection:string, speaker:string, durationSeconds:number, notes?:string, bold?:boolean}>} opts.rows
   * @returns {Promise<Uint8Array>}
   */
  generateShowflow: async ({ sheetName, showName, lastUpdatedLabel, legendLines, startClockTime, rows }) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(sheetName || 'Keynote');

    const HEADERS = ['Section', 'Subsection', 'Speaker', ' Length', 'Cumulative', 'Clock Time \n(Start)', 'Notes'];
    const COL_WIDTHS = [31.66, 64.16, 24.16, 13.33, 12.83, 19.0, 45.66];
    sheet.columns = COL_WIDTHS.map(w => ({ width: w }));

    const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E75B6' } };
    const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };
    const BOLD = { bold: true };
    const DURATION_FMT = '[h]:mm:ss;@';
    const CLOCK_FMT = '[$-409]h:mm AM/PM;@';

    // ── Header block (rows 1-N): key/legend, merged A1:A{N} ──
    const legend = legendLines && legendLines.length ? legendLines : ['Launch', 'Demo', 'Video'];
    let r = 1;
    if (legend.length > 1) {
      sheet.mergeCells(`A1:A${legend.length}`);
    }
    sheet.getCell('A1').value = 'KEY';
    sheet.getCell('A1').font = BOLD;
    sheet.getCell('A1').alignment = { vertical: 'top' };
    legend.forEach((line, idx) => {
      sheet.getCell(`B${idx + 1}`).value = line;
    });
    if (lastUpdatedLabel) sheet.getCell(`C1`).value = lastUpdatedLabel;
    r = legend.length + 1;

    // ── Confidential banner (merged full width) ──
    const bannerRow = r;
    sheet.mergeCells(`A${bannerRow}:G${bannerRow}`);
    const bannerCell = sheet.getCell(`A${bannerRow}`);
    bannerCell.value = 'AMAZON CONFIDENTIAL - DO NOT COPY, DO NOT DISTRIBUTE, DO NOT FORWARD';
    bannerCell.font = { bold: true, color: { argb: 'FFFF0000' } };
    bannerCell.alignment = { horizontal: 'center' };
    r++;

    // ── Title (merged full width) ──
    const titleRow = r;
    sheet.mergeCells(`A${titleRow}:G${titleRow}`);
    const titleCell = sheet.getCell(`A${titleRow}`);
    titleCell.value = showName || 'Run of Show';
    titleCell.font = { bold: true, size: 13 };
    titleCell.alignment = { horizontal: 'center' };
    r++;

    // ── Column headers ──
    const headerRow = r;
    HEADERS.forEach((h, i) => {
      const cell = sheet.getCell(headerRow, i + 1);
      cell.value = h;
      cell.font = HEADER_FONT;
      cell.fill = HEADER_FILL;
      cell.alignment = { horizontal: 'center', vertical: 'center', wrapText: true };
    });
    r++;

    // ── Data rows ──
    const firstDataRow = r;
    const lengthCol = 4, cumulativeCol = 5, clockCol = 6;

    if (startClockTime) {
      const [hh, mm] = startClockTime.split(':').map(Number);
      sheet.getCell(`F${firstDataRow}`).value = (hh * 3600 + mm * 60) / 86400; // fraction of a day
      sheet.getCell(`F${firstDataRow}`).numFmt = CLOCK_FMT;
    }

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const excelRow = firstDataRow + idx;

      const sectionCell = sheet.getCell(excelRow, 1);
      sectionCell.value = row.section || null;
      if (row.bold) sectionCell.font = BOLD;

      const subCell = sheet.getCell(excelRow, 2);
      subCell.value = row.subsection || null;

      const speakerCell = sheet.getCell(excelRow, 3);
      speakerCell.value = row.speaker || null;

      const lengthCell = sheet.getCell(excelRow, lengthCol);
      const secs = row.durationSeconds || 0;
      lengthCell.value = secs / 86400; // Excel stores time-of-day/duration as a fraction of a day
      lengthCell.numFmt = DURATION_FMT;

      // Cumulative — running SUM formula anchored to the first data row
      const cumCell = sheet.getCell(excelRow, cumulativeCol);
      cumCell.value = { formula: `SUM($D$${firstDataRow}:D${excelRow})` };
      cumCell.numFmt = DURATION_FMT;

      // Clock time — anchor + previous cumulative (skip on the very first row, already seeded)
      if (idx > 0 && startClockTime) {
        const clockCell = sheet.getCell(excelRow, clockCol);
        clockCell.value = { formula: `$F$${firstDataRow}+E${excelRow - 1}` };
        clockCell.numFmt = CLOCK_FMT;
      }

      const notesCell = sheet.getCell(excelRow, 7);
      notesCell.value = row.notes || null;

      if (row.bold) {
        [subCell, speakerCell, lengthCell, cumCell, notesCell].forEach(c => { c.font = BOLD; });
      }
    }

    // ── Total row ──
    const totalRow = firstDataRow + rows.length;
    sheet.getCell(totalRow, lengthCol).value = 'Keynote Total:';
    sheet.getCell(totalRow, lengthCol).font = BOLD;
    const totalCumCell = sheet.getCell(totalRow, cumulativeCol);
    totalCumCell.value = { formula: `SUM($D$${firstDataRow}:D${totalRow})` };
    totalCumCell.numFmt = DURATION_FMT;
    totalCumCell.font = BOLD;
    if (startClockTime && rows.length > 0) {
      const totalClockCell = sheet.getCell(totalRow, clockCol);
      totalClockCell.value = { formula: `$F$${firstDataRow}+E${totalRow - 1}` };
      totalClockCell.numFmt = CLOCK_FMT;
      totalClockCell.font = BOLD;
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return new Uint8Array(buffer);
  },

  /**
   * Legacy generic exporter — build an xlsx file from plain string rows.
   * @param {object} opts - { sheetName, rows: string[][], colWidths: number[] }
   * @returns {Promise<Uint8Array>}
   */
  generate: async ({ sheetName, rows, colWidths }) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(sheetName || 'Sheet1');
    if (colWidths) {
      sheet.columns = colWidths.map(w => ({ width: w }));
    }
    for (const row of rows) {
      sheet.addRow(row);
    }
    const buffer = await workbook.xlsx.writeBuffer();
    return new Uint8Array(buffer);
  },
});

const ALLOWED_INVOKE_CHANNELS = new Set([
    'add-custom-prompt', 'cancel-agent', 'cancel-bedrock', 'compress-conversation', 'create-conversation', 'delete-conversation',
    'install-update',
    'delete-credentials', 'delete-custom-prompt', 'delete-settings', 'get-app-version',
    'get-bedrock-models', 'get-custom-prompts', 'get-default-settings', 'get-knowledge-bases',
    'get-prompt-templates', 'get-skills', 'get-skill-content', 'has-credentials', 'invoke-agent', 'list-conversations',
    'load-conversation', 'load-credentials', 'load-settings', 'memory-connect', 'memory-delete', 'memory-disable',
    'memory-enable', 'memory-extract', 'memory-list', 'memory-status', 'navigate-to-main', 'open-skills-folder',
    'quick-validate-credentials', 'refresh-skills', 'save-conversation', 'save-credentials',
    'save-credentials',
    'save-settings', 'save-skill-content', 'select-directory', 'send-to-bedrock', 'splash-ready', 'toggle-skill',
    'show:save', 'show:saveAs', 'show:open', 'show:openPath', 'show:listRecent', 'show:clearRecent',
    'create-skill', 'delete-skill', 'transcribe-media',
    'update-custom-prompt', 'validate-credentials', 'work-history-delete', 'work-history-list',
    'work-history-load', 'work-history-rename', 'work-history-save', 'work-history-star', 'work-cleanup-session',
    'swarm-run-pipeline', 'swarm-continue', 'swarm-cancel', 'swarm-answer-input', 'swarm-get-templates', 'swarm-get-analytics', 'select-files',
]);

const ALLOWED_RECEIVE_CHANNELS = new Set([
    'agent-status', 'agent-stream-chunk', 'bedrock-stream-chunk', 'bedrock-stream-complete',
    'credential-expiry-warning',
    'transcription-progress', 'app-before-quit', 'show-settings', 'update-available', 'update-downloaded',
    'swarm-agent-started', 'swarm-agent-chunk', 'swarm-agent-done',
    'swarm-review-pause', 'swarm-input-request', 'swarm-pipeline-done', 'swarm-error',
]);

contextBridge.exposeInMainWorld('electronAPI', {
    showToast: (message, type) => {

        const types = {
            success: 'toast-success',
            error: 'toast-error',
            info: 'toast-info',
            warning: 'toast-warning'
        };
        
        Toastify({
            text: message,
            duration: 5000,
            close: true,
            gravity: "top",
            position: "center",
            className: types[type] || '',
            stopOnFocus: true,
            offset: { y: 80 },
            style: {
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: "500",
                padding: "12px 20px"
            },
            onClick: function(){}
        }).showToast();
    }, 
    send: (channel, data) => {
        if (ALLOWED_INVOKE_CHANNELS.has(channel)) ipcRenderer.send(channel, data);
    },
    receive: (channel, func) => {
        if (ALLOWED_RECEIVE_CHANNELS.has(channel)) {
            ipcRenderer.on(channel, (event, ...args) => func(...args));
        }
    },
    removeAllListeners: (channel) => {
        if (ALLOWED_RECEIVE_CHANNELS.has(channel)) ipcRenderer.removeAllListeners(channel);
    },
    invoke: (channel, data) => {
        if (!ALLOWED_INVOKE_CHANNELS.has(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
        return ipcRenderer.invoke(channel, data);
    },
    invokeAsync: async (channel, data) => {
        if (!ALLOWED_INVOKE_CHANNELS.has(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
        return await ipcRenderer.invoke(channel, data);
    }
});