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
   * Build an xlsx file from rows and return a downloadable Blob.
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