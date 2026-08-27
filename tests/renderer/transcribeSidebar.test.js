/**
 * @jest-environment jsdom
 */

/**
 * Tests for the Transcribe tab's history sidebar.
 *
 * The point of this list is that a transcription you've already paid for stays
 * reachable. It's backed by the local registry, so it renders offline; and
 * selecting an entry only changes what the pane shows — it must never disturb a
 * job in flight, which is only safe because the main process owns jobs and the
 * renderer observes them.
 */

const mockElectronAPI = {
  invoke: jest.fn(),
  receive: jest.fn(),
  showToast: jest.fn(),
};
Object.defineProperty(window, 'electronAPI', { value: mockElectronAPI, writable: true });
Object.defineProperty(window, 'marked', { value: { parse: (md) => md }, writable: true });

global.ModalManager = jest.fn().mockImplementation(() => ({
  show: jest.fn(), hide: jest.fn(), showError: jest.fn(),
}));

const mockModalShow = jest.fn();
const mockModalHide = jest.fn();
global.bootstrap = {
  Modal: jest.fn().mockImplementation(() => ({ show: mockModalShow, hide: mockModalHide })),
};
global.bootstrap.Modal.getInstance = jest.fn(() => ({ show: mockModalShow, hide: mockModalHide }));

global.URL.createObjectURL = jest.fn(() => 'mock-url');
Object.defineProperty(navigator, 'clipboard', { value: { writeText: jest.fn() }, writable: true });

const RECORDS = [
  {
    jobId: 'job-1', jobName: 'transcription-1717000000000',
    displayName: 'Keynote Draft 3', sourceFile: 'keynote-v4.mp4',
    status: 'COMPLETED', createdAt: '2026-06-02T10:00:00.000Z',
    durationSeconds: 2520, segmentCount: 400, language: 'en-US',
  },
  {
    jobId: 'job-2', jobName: 'transcription-1716000000000',
    displayName: 'Customer interview', sourceFile: 'interview.m4a',
    status: 'COMPLETED', createdAt: '2026-05-28T09:00:00.000Z',
    durationSeconds: 1080, segmentCount: 200, language: 'en-US',
  },
  {
    // Predates naming: shown rather than hidden, with an invitation to name it.
    jobId: 'job-3', jobName: 'transcription-1715000000000',
    displayName: 'transcription-1715000000000', sourceFile: 'old.mp4',
    status: 'COMPLETED', createdAt: '2026-05-14T09:00:00.000Z',
    durationSeconds: 600,
  },
  {
    // Paused past its budget: still on AWS, still collectable.
    jobId: 'job-4', jobName: 'transcription-1714000000000',
    displayName: 'Board review', sourceFile: 'board.mp4',
    status: 'ABANDONED', createdAt: '2026-05-01T09:00:00.000Z',
  },
];

function buildDom() {
  document.body.innerHTML = `
    <div id="work-page"></div><div id="swarm-page"></div>
    <div id="analyze-page"></div><div id="settings-page"></div><div id="showflow-page"></div>
    <div id="nav-work"></div><div id="nav-swarm"></div><div id="nav-analyze"></div>
    <div id="nav-settings"></div><div id="nav-showflow"></div>
    <div id="nav-transcribe"><span id="navTranscribeSpinner" class="d-none"></span></div>
    <div id="transcribe-page">
      <div class="transcribe-layout">
        <div class="conv-sidebar transcribe-sidebar" id="transcribeSidebar">
          <button id="newTranscriptionBtn"></button>
          <input type="text" id="transcriptionSearch" />
          <button id="transcriptionSearchClear" class="d-none"></button>
          <div id="transcriptionList"></div>
        </div>
        <div class="transcribe-main">
          <button id="transcribeSidebarToggle"></button>
          <div id="transcribeViewHeader" class="d-none">
            <h5 id="transcribeViewTitle"></h5>
            <button id="transcribeRenameBtn"></button>
            <button id="transcribeDeleteBtn"></button>
            <div id="transcribeViewMeta"></div>
          </div>
          <div id="transcribePlayerPane">
            <div class="upload-zone" id="uploadZone"><input type="file" id="fileInput" /></div>
            <div id="videoContainer" class="d-none"><video id="videoPlayer"></video></div>
          </div>
          <div id="transcribeTranscriptPane">
            <div id="transcribeTranscriptTitle"></div>
            <button id="clearTranscriptionBtn" class="d-none"></button>
            <div id="transcriptionContent"><div id="transcriptionText"></div></div>
            <input type="checkbox" id="includeSpeakerTimestamps" />
            <button id="downloadTranscript" class="d-none"></button>
            <button id="copyTranscript" class="d-none"></button>
          </div>
        </div>
      </div>
    </div>
    <div id="deleteTranscriptionModal">
      <strong id="deleteTranscriptionName"></strong>
      <input type="checkbox" id="deleteTranscriptionFromAws" />
      <button id="deleteTranscriptionConfirmBtn"></button>
    </div>
    <div id="clearTranscriptionModal"></div>
    <button id="saveTranscriptBeforeClear"></button>
    <button id="copyTranscriptBeforeClear"></button>
    <button id="clearWithoutSaving"></button>
    <select id="promptTemplateSelect"><option value=""></option></select>
    <input type="checkbox" id="useExistingTranscript" />
    <select id="modelSelect"><option value="m">m</option></select>
    <textarea id="promptEditor"></textarea>
    <div id="analysisText"></div>
    <button id="invokeBedrockBtn"></button>
    <button id="downloadAnalysis" class="d-none"></button>
    <button id="copyAnalysis" class="d-none"></button>
    <button id="attachFileBtn"></button>
    <div id="analyzeAttachMenu"></div>
    <div id="analyzeAttachFiles"></div>
    <input type="file" id="fileUpload" />
    <button id="managePromptsBtn"></button>
    <button id="addPromptBtn"></button>
    <button id="savePromptBtn"></button>
    <button id="cancelPromptBtn"></button>
    <div id="managePromptsModal"></div>
    <select id="workModelSelect"></select>
    <div id="conversationList"></div>
    <input type="text" id="conversationSearch" />
    <button id="conversationSearchClear"></button>
    <button id="newConversationBtn"></button>
    <div id="credentialWarningBanner"></div>
    <span id="credentialWarningText"></span>
    <button id="credentialWarningUpdateBtn"></button>
    <button id="credentialWarningDismiss"></button>
  `;
}

/** Loads index.js with the transcription registry responding as configured. */
function loadRenderer({ records = RECORDS, getEntry = null, state = { active: false } } = {}) {
  mockElectronAPI.invoke.mockImplementation((channel, payload) => {
    switch (channel) {
      case 'transcription-list': return Promise.resolve(records);
      case 'transcription-get': {
        if (getEntry) return Promise.resolve(getEntry(payload));
        const record = records.find(r => r.jobId === payload);
        return Promise.resolve(record
          ? { ...record, transcript: [{ startTime: 0, endTime: 4, speaker: '1', text: 'Good morning.' }] }
          : null);
      }
      case 'get-transcription-state': return Promise.resolve(state);
      case 'get-connectivity-status': return Promise.resolve({ online: true });
      // Unrelated startup channels. They need shapes their callers can handle,
      // or an unhandled rejection from elsewhere in DOMContentLoaded fails the
      // test regardless of the sidebar.
      case 'list-conversations': return Promise.resolve([]);
      case 'get-prompt-templates': return Promise.resolve([]);
      case 'get-bedrock-models': return Promise.resolve([]);
      case 'get-custom-prompts': return Promise.resolve([]);
      case 'has-credentials': return Promise.resolve(false);
      default: return Promise.resolve(undefined);
    }
  });

  jest.resetModules();
  require('../../src/renderer/index.js');
}

/** Runs the DOMContentLoaded work that wires the sidebar. */
async function initSidebar() {
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await flush();
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
};

const rows = () => Array.from(document.querySelectorAll('#transcriptionList .conv-item'));
const rowTitles = () => rows().map(r => r.querySelector('.conv-item-title').textContent.trim());

beforeEach(() => {
  jest.clearAllMocks();
  buildDom();
});

describe('rendering the list', () => {
  test('lists recorded transcriptions with date and duration', async () => {
    loadRenderer();
    await initSidebar();

    expect(rowTitles()).toEqual([
      'Keynote Draft 3', 'Customer interview', 'transcription-1715000000000', 'Board review',
    ]);
    const meta = rows()[0].querySelector('.transcription-item-meta').textContent;
    expect(meta).toContain('42 min');
    expect(meta).toMatch(/Jun/);
  });

  test('shows a legacy unnamed job rather than hiding it, and invites naming', async () => {
    loadRenderer();
    await initSidebar();

    const legacy = rows()[2];
    expect(legacy.querySelector('.transcription-item-unnamed')).not.toBeNull();
    expect(legacy.querySelector('.transcription-item-meta').textContent).toContain('name this');
  });

  test('marks an abandoned job as still being on AWS', async () => {
    loadRenderer();
    await initSidebar();

    const abandoned = rows()[3];
    expect(abandoned.querySelector('.transcription-item-status.is-abandoned')).not.toBeNull();
    expect(abandoned.querySelector('.transcription-item-meta').textContent).toContain('still on AWS');
  });

  test('shows an empty state when nothing has been transcribed', async () => {
    loadRenderer({ records: [] });
    await initSidebar();

    expect(rows()).toHaveLength(0);
    expect(document.getElementById('transcriptionList').textContent).toContain('No transcriptions yet');
  });

  test('survives a failed list load', async () => {
    mockElectronAPI.invoke.mockImplementation((channel) => {
      if (channel === 'transcription-list') return Promise.reject(new Error('disk gone'));
      if (channel === 'get-transcription-state') return Promise.resolve({ active: false });
      if (channel === 'get-connectivity-status') return Promise.resolve({ online: true });
      return Promise.resolve([]);
    });
    jest.resetModules();
    require('../../src/renderer/index.js');

    await initSidebar();

    expect(document.getElementById('transcriptionList').textContent).toContain('No transcriptions yet');
  });
});

describe('search', () => {
  test('filters by name', async () => {
    loadRenderer();
    await initSidebar();

    const search = document.getElementById('transcriptionSearch');
    search.value = 'keynote';
    search.dispatchEvent(new Event('input'));

    expect(rowTitles()).toEqual(['Keynote Draft 3']);
  });

  test('also matches the source file name', async () => {
    loadRenderer();
    await initSidebar();

    const search = document.getElementById('transcriptionSearch');
    search.value = 'interview.m4a';
    search.dispatchEvent(new Event('input'));

    expect(rowTitles()).toEqual(['Customer interview']);
  });

  test('reports no matches distinctly from an empty library', async () => {
    loadRenderer();
    await initSidebar();

    const search = document.getElementById('transcriptionSearch');
    search.value = 'nothing like this';
    search.dispatchEvent(new Event('input'));

    expect(document.getElementById('transcriptionList').textContent).toContain('No transcriptions found');
  });

  test('the clear button restores the full list', async () => {
    loadRenderer();
    await initSidebar();

    const search = document.getElementById('transcriptionSearch');
    search.value = 'keynote';
    search.dispatchEvent(new Event('input'));
    expect(rows()).toHaveLength(1);

    document.getElementById('transcriptionSearchClear').click();

    expect(rows()).toHaveLength(4);
    expect(search.value).toBe('');
  });
});

describe('opening a saved transcript', () => {
  test('shows the transcript with a header, and hides the player', async () => {
    // The local media file is long gone by now, so a player would be a dead
    // control.
    loadRenderer();
    await initSidebar();

    rows()[0].click();
    await flush();

    expect(document.querySelector('.transcribe-layout').classList.contains('viewing-saved')).toBe(true);
    expect(document.getElementById('transcribeViewHeader').classList.contains('d-none')).toBe(false);
    expect(document.getElementById('transcribeViewTitle').textContent).toBe('Keynote Draft 3');
    expect(document.getElementById('transcriptionText').textContent).toContain('Good morning.');
  });

  test('the header names the source file, date, duration and language', async () => {
    loadRenderer();
    await initSidebar();

    rows()[0].click();
    await flush();

    const meta = document.getElementById('transcribeViewMeta').textContent;
    expect(meta).toContain('keynote-v4.mp4');
    expect(meta).toContain('42 min');
    expect(meta).toContain('en-US');
  });

  test('reveals download and copy for a stored transcript', async () => {
    loadRenderer();
    await initSidebar();

    rows()[0].click();
    await flush();

    expect(document.getElementById('downloadTranscript').classList.contains('d-none')).toBe(false);
    expect(document.getElementById('copyTranscript').classList.contains('d-none')).toBe(false);
  });

  test('an abandoned entry explains the job may still be on AWS', async () => {
    loadRenderer({
      getEntry: (jobId) => ({
        ...RECORDS.find(r => r.jobId === jobId),
        transcript: null,
      }),
    });
    await initSidebar();

    rows()[3].click();
    await flush();

    const pane = document.getElementById('transcriptionText');
    expect(pane.textContent).toContain('still be available on AWS');
    // Nothing to download.
    expect(document.getElementById('downloadTranscript').classList.contains('d-none')).toBe(true);
  });

  test('marks the open entry as active', async () => {
    loadRenderer();
    await initSidebar();

    rows()[1].click();
    await flush();

    expect(rows()[1].classList.contains('active')).toBe(true);
    expect(rows()[0].classList.contains('active')).toBe(false);
  });

  test('a vanished entry warns and refreshes rather than showing a blank pane', async () => {
    loadRenderer({ getEntry: () => null });
    await initSidebar();

    rows()[0].click();
    await flush();

    expect(mockElectronAPI.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/could not be found/i), 'warning'
    );
  });
});

describe('New Transcription', () => {
  test('returns to the drop zone and clears the saved-transcript view', async () => {
    loadRenderer();
    await initSidebar();
    rows()[0].click();
    await flush();
    expect(document.querySelector('.transcribe-layout').classList.contains('viewing-saved')).toBe(true);

    document.getElementById('newTranscriptionBtn').click();
    await flush();

    expect(document.querySelector('.transcribe-layout').classList.contains('viewing-saved')).toBe(false);
    expect(document.getElementById('transcribeViewHeader').classList.contains('d-none')).toBe(true);
    expect(document.getElementById('uploadZone').classList.contains('d-none')).toBe(false);
  });

  test('refuses while a job is running rather than abandoning it', async () => {
    loadRenderer({ state: { active: true, jobId: 'job-live', status: 'IN_PROGRESS', message: 'Processing…' } });
    await initSidebar();

    document.getElementById('newTranscriptionBtn').click();

    expect(mockElectronAPI.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/already running/i), 'warning'
    );
  });
});

describe('sidebar toggle', () => {
  test('collapses and restores', async () => {
    loadRenderer();
    await initSidebar();
    const layout = document.querySelector('.transcribe-layout');

    document.getElementById('transcribeSidebarToggle').click();
    expect(layout.classList.contains('sidebar-collapsed')).toBe(true);

    document.getElementById('transcribeSidebarToggle').click();
    expect(layout.classList.contains('sidebar-collapsed')).toBe(false);
  });
});

describe('a job in flight', () => {
  test('appears at the top of the list while running', async () => {
    loadRenderer({ state: { active: true, jobId: 'job-live', displayName: 'keynote v4', status: 'IN_PROGRESS', message: 'Processing…' } });
    await initSidebar();

    const first = rows()[0];
    expect(first.querySelector('.transcription-item-status.is-running')).not.toBeNull();
    expect(first.querySelector('.transcription-item-meta').textContent).toContain('in progress');
  });

  test('opening a saved transcript does not cancel it', async () => {
    // Only safe because the main process owns the job — this is purely a change
    // of view.
    loadRenderer({ state: { active: true, jobId: 'job-live', status: 'IN_PROGRESS', message: 'Processing…' } });
    await initSidebar();

    rows()[1].click();   // first row is the running job
    await flush();

    expect(mockElectronAPI.invoke).not.toHaveBeenCalledWith('cancel-transcription', expect.anything());
    expect(mockElectronAPI.invoke).not.toHaveBeenCalledWith('cancel-transcription');
  });
});

describe('deleting', () => {
  test('asks first, with the AWS option unchecked', async () => {
    // The AWS copy is the durable tier; deleting it is irreversible, so it must
    // never be pre-armed.
    loadRenderer();
    await initSidebar();
    rows()[0].click();
    await flush();

    document.getElementById('transcribeDeleteBtn').click();

    expect(document.getElementById('deleteTranscriptionName').textContent).toBe('Keynote Draft 3');
    expect(document.getElementById('deleteTranscriptionFromAws').checked).toBe(false);
    expect(mockModalShow).toHaveBeenCalled();
  });

  test('deletes locally when the AWS box is left unchecked', async () => {
    loadRenderer();
    await initSidebar();
    rows()[0].click();
    await flush();
    document.getElementById('transcribeDeleteBtn').click();

    document.getElementById('deleteTranscriptionConfirmBtn').click();
    await flush();

    expect(mockElectronAPI.invoke).toHaveBeenCalledWith('transcription-delete', {
      jobId: 'job-1', deleteFromAws: false,
    });
  });

  test('passes the AWS option through when checked', async () => {
    loadRenderer();
    await initSidebar();
    rows()[0].click();
    await flush();
    document.getElementById('transcribeDeleteBtn').click();
    document.getElementById('deleteTranscriptionFromAws').checked = true;

    document.getElementById('deleteTranscriptionConfirmBtn').click();
    await flush();

    expect(mockElectronAPI.invoke).toHaveBeenCalledWith('transcription-delete', {
      jobId: 'job-1', deleteFromAws: true,
    });
  });

  test('returns to the drop zone afterwards', async () => {
    loadRenderer();
    await initSidebar();
    rows()[0].click();
    await flush();
    document.getElementById('transcribeDeleteBtn').click();

    document.getElementById('deleteTranscriptionConfirmBtn').click();
    await flush();

    expect(document.querySelector('.transcribe-layout').classList.contains('viewing-saved')).toBe(false);
  });

  test('does nothing when no transcript is selected', async () => {
    loadRenderer();
    await initSidebar();

    document.getElementById('transcribeDeleteBtn').click();

    expect(mockModalShow).not.toHaveBeenCalled();
  });
});
