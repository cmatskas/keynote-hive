/**
 * Shared DOM fixture for suites that load src/renderer/index.js.
 *
 * index.js wires listeners to these elements at require time, so every suite
 * that loads it needs the full skeleton up front — an incomplete fixture fails
 * on an unrelated addEventListener rather than on the behaviour under test.
 * One copy here instead of one per suite, so a new element index.js starts
 * touching is added once, not tracked down in every file that pasted the
 * skeleton (which is how the copies had already started to drift).
 *
 * Not matched by Jest's testMatch (no .test.js suffix), so it is never
 * collected as a suite of its own.
 */

/**
 * @param {object} [opts]
 * @param {string} [opts.modelSelectOptions] - option markup for the Chat model
 *   select, for suites that need a pre-selected model without going through
 *   loadBedrockModels().
 * @returns {string} innerHTML for document.body
 */
function buildIndexPageDom({ modelSelectOptions = '' } = {}) {
  return `
            <div id="uploadZone"></div>
            <input type="file" id="fileInput" />
            <div id="videoContainer" class="d-none"></div>
            <video id="videoPlayer"></video>
            <div id="transcriptionContent"></div>
            <div id="loadingSpinner"></div>
            <div id="transcriptionText"></div>
            <select id="promptTemplateSelect">
                <option value="">Select Template</option>
                <option value="Test prompt template">Test Template</option>
            </select>
            <input type="checkbox" id="useExistingTranscript" />
            <select id="modelSelect">${modelSelectOptions}</select>
            <select id="workModelSelect"></select>
            <textarea id="promptEditor"></textarea>
            <div id="analysisText"></div>
            <button id="invokeBedrockBtn"></button>
            <button id="downloadAnalysis" class="d-none"></button>
            <button id="copyAnalysis" class="d-none"></button>
            <button id="downloadTranscript" class="d-none"></button>
            <button id="copyTranscript" class="d-none"></button>
            <button id="clearTranscriptionBtn" class="d-none"></button>
            <button id="saveTranscriptBeforeClear"></button>
            <button id="copyTranscriptBeforeClear"></button>
            <button id="clearWithoutSaving"></button>
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
            <input type="text" id="transcribeViewTitleInput" class="d-none" />
                            <button id="transcribeRenameBtn"></button>
                            <button id="transcribeDeleteBtn"></button>
                            <div id="transcribeViewMeta"></div>
                        </div>
                        <div id="transcribePlayerPane"></div>
                        <div id="transcribeTranscriptPane"></div>
                        <div id="transcribeTranscriptTitle"></div>
                    </div>
                </div>
            </div>
            <div id="deleteTranscriptionModal">
                <strong id="deleteTranscriptionName"></strong>
                <input type="checkbox" id="deleteTranscriptionFromAws" />
                <button id="deleteTranscriptionConfirmBtn"></button>
            </div>
            <div id="analyze-page"></div>
            <div id="nav-transcribe"><span id="navTranscribeSpinner" class="d-none"></span></div>
            <div id="nav-analyze"></div>
            <div id="nav-app-settings"></div>
            <div id="nav-credentials"></div>
            <div id="nav-connection-status"></div>
            <div id="bedrockProcessingModal"></div>
            <div id="clearTranscriptionModal"></div>
            <input type="radio" name="viewMode" value="full" checked />
        `;
}

module.exports = { buildIndexPageDom };
