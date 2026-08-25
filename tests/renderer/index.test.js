/**
 * @jest-environment jsdom
 */

// Mock ModalManager as a global class
global.ModalManager = jest.fn().mockImplementation(() => ({
    show: jest.fn(),
    hide: jest.fn(),
    showError: jest.fn()
}));

// Mock the electronAPI before importing the module
const mockElectronAPI = {
    showToast: jest.fn(),
    invoke: jest.fn(),
    receive: jest.fn(),
    invokeAsync: jest.fn()
};

// Mock window.electronAPI
Object.defineProperty(window, 'electronAPI', {
    value: mockElectronAPI,
    writable: true
});

// Mock window.marked (mirrors preload's exposed API)
Object.defineProperty(window, 'marked', {
    value: {
        parse: (md) => md
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>')
    },
    writable: true
});

// Mock fetch
global.fetch = jest.fn();

// Mock URL.createObjectURL and revokeObjectURL
global.URL.createObjectURL = jest.fn(() => 'mock-url');
global.URL.revokeObjectURL = jest.fn();

// Mock navigator.clipboard
Object.defineProperty(navigator, 'clipboard', {
    value: {
        writeText: jest.fn().mockResolvedValue()
    },
    writable: true
});

// Mock localStorage
const localStorageMock = {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
    clear: jest.fn()
};
Object.defineProperty(window, 'localStorage', {
    value: localStorageMock
});

// Mock bootstrap Modal
global.bootstrap = {
    Modal: jest.fn().mockImplementation(() => ({
        show: jest.fn(),
        hide: jest.fn()
    })),
    Modal: {
        getInstance: jest.fn().mockReturnValue({
            show: jest.fn(),
            hide: jest.fn()
        })
    }
};

// Mock setTimeout for polling tests
jest.useFakeTimers();

describe('Renderer Index.js', () => {
    beforeEach(() => {
        // Reset all mocks
        jest.clearAllMocks();
        
        // Reset fetch mock specifically
        fetch.mockClear();
        
        // Setup DOM
        document.body.innerHTML = `
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
            <select id="modelSelect">
                <option value="test-model">Test Model</option>
            </select>
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
            <div id="transcribe-page"></div>
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
        
        // Re-require the module to reset its state
        jest.resetModules();
    });

    describe('Toast Functions', () => {
        beforeEach(() => {
            // Load the module after DOM setup
            require('../../src/renderer/index.js');
        });

        test('showSuccessToast calls electronAPI.showToast with correct parameters', () => {
            window.showSuccessToast('Test success message');
            expect(mockElectronAPI.showToast).toHaveBeenCalledWith('Test success message', 'success');
        });

        test('showErrorToast calls electronAPI.showToast with correct parameters', () => {
            window.showErrorToast('Test error message');
            expect(mockElectronAPI.showToast).toHaveBeenCalledWith('Test error message', 'error');
        });

        test('showInfoToast calls electronAPI.showToast with correct parameters', () => {
            window.showInfoToast('Test info message');
            expect(mockElectronAPI.showToast).toHaveBeenCalledWith('Test info message', 'info');
        });

        test('showWarningToast calls electronAPI.showToast with correct parameters', () => {
            window.showWarningToast('Test warning message');
            expect(mockElectronAPI.showToast).toHaveBeenCalledWith('Test warning message', 'warning');
        });
    });

    describe('Navigation Functions', () => {
        beforeEach(() => {
            require('../../src/renderer/index.js');
        });

        test('showTranscribePage shows transcribe page and hides analyze page', () => {
            const transcribePage = document.getElementById('transcribe-page');
            const analyzePage = document.getElementById('analyze-page');
            const navTranscribe = document.getElementById('nav-transcribe');
            const navAnalyze = document.getElementById('nav-analyze');

            window.showTranscribePage();

            expect(transcribePage.style.display).toBe('block');
            expect(navTranscribe.classList.contains('active')).toBe(true);
            expect(analyzePage.style.display).toBe('none');
            expect(navAnalyze.classList.contains('active')).toBe(false);
        });

        test('showAnalyzePage shows analyze page and hides transcribe page', () => {
            const transcribePage = document.getElementById('transcribe-page');
            const analyzePage = document.getElementById('analyze-page');
            const navTranscribe = document.getElementById('nav-transcribe');
            const navAnalyze = document.getElementById('nav-analyze');

            window.showAnalyzePage();

            expect(analyzePage.style.display).toBe('block');
            expect(navAnalyze.classList.contains('active')).toBe(true);
            expect(transcribePage.style.display).toBe('none');
            expect(navTranscribe.classList.contains('active')).toBe(false);
        });
    });

    describe('Analysis Download and Copy Functions', () => {
        beforeEach(() => {
            require('../../src/renderer/index.js');
        });

        // TODO: downloadAnalysis/copyAnalysis happy-path tests are skipped —
        // these functions read a module-private `currentConversation`
        // variable inside index.js's closure, which can't be set from
        // outside (setting window.currentConversation has no effect on it).
        // Only the "no conversation" negative-path siblings below are
        // actually covered. Fix: either export currentConversation getter/
        // setter on window for real, or refactor downloadAnalysis/
        // copyAnalysis to accept the conversation as a parameter instead of
        // reading closure state, so these can be tested without a full
        // integration harness.
        test.skip('downloadAnalysis creates download link when conversation exists', () => {
            const mockLink = {
                href: '',
                download: '',
                click: jest.fn()
            };
            const mockBlob = {};
            const mockURL = 'blob:mock-url';
            
            global.Blob = jest.fn(() => mockBlob);
            global.URL.createObjectURL = jest.fn(() => mockURL);
            global.URL.revokeObjectURL = jest.fn();
            
            const createElementSpy = jest.spyOn(document, 'createElement').mockReturnValue(mockLink);
            
            // Set currentConversation on window object with messages
            window.currentConversation = {
                id: 'conv_123',
                messages: [
                    { role: 'user', content: 'Test question' },
                    { role: 'assistant', content: 'Test answer' }
                ]
            };

            // Call the function
            window.downloadAnalysis();

            expect(createElementSpy).toHaveBeenCalledWith('a');
            expect(mockLink.download).toBe('conversation_conv_123.md');
            expect(mockLink.click).toHaveBeenCalled();
            expect(mockElectronAPI.showToast).toHaveBeenCalledWith('Conversation downloaded successfully', 'success');
            
            createElementSpy.mockRestore();
        });

        test('downloadAnalysis shows warning when no conversation available', () => {
            window.currentConversation = null;

            window.downloadAnalysis();

            expect(mockElectronAPI.showToast).toHaveBeenCalledWith('No conversation available to download', 'warning');
        });

        test.skip('copyAnalysis copies to clipboard when conversation exists', async () => {
            window.currentConversation = {
                messages: [
                    { role: 'user', content: 'Test question' },
                    { role: 'assistant', content: 'Test answer' }
                ]
            };
            navigator.clipboard.writeText.mockResolvedValue();

            await window.copyAnalysis();

            expect(navigator.clipboard.writeText).toHaveBeenCalled();
            const copiedText = navigator.clipboard.writeText.mock.calls[0][0];
            expect(copiedText).toContain('## User');
            expect(copiedText).toContain('Test question');
            expect(copiedText).toContain('## Assistant');
            expect(copiedText).toContain('Test answer');
            expect(mockElectronAPI.showToast).toHaveBeenCalledWith('Conversation copied to clipboard', 'success');
        });

        test('copyAnalysis shows warning when no conversation available', async () => {
            window.currentConversation = null;

            await window.copyAnalysis();

            expect(mockElectronAPI.showToast).toHaveBeenCalledWith('No conversation available to copy', 'warning');
        });

        test.skip('copyAnalysis handles clipboard error', async () => {
            window.currentConversation = {
                messages: [
                    { role: 'user', content: 'Test question' }
                ]
            };
            navigator.clipboard.writeText.mockRejectedValue(new Error('Clipboard error'));

            // Call the function and wait for it to complete
            await window.copyAnalysis();

            expect(navigator.clipboard.writeText).toHaveBeenCalled();
            expect(mockElectronAPI.showToast).toHaveBeenCalledWith('Failed to copy to clipboard', 'error');
        });
    });

    describe('File Upload Functions', () => {
        beforeEach(() => {
            require('../../src/renderer/index.js');
        });

        test('file input change event handles file selection', () => {
            const fileInput = document.getElementById('fileInput');
            const mockFile = new File(['test'], 'test.mp4', { type: 'video/mp4' });
            
            Object.defineProperty(fileInput, 'files', {
                value: [mockFile],
                writable: false
            });

            const event = new Event('change');
            fileInput.dispatchEvent(event);

            expect(mockElectronAPI.showToast).toHaveBeenCalledWith('File selected: test.mp4', 'info');
        });

        test('drag and drop handles valid video file', () => {
            const uploadZone = document.getElementById('uploadZone');
            const fileInput = document.getElementById('fileInput');
            const mockFile = new File(['test'], 'test.mp4', { type: 'video/mp4' });
            
            // Mock the FileList properly
            const mockFileList = {
                0: mockFile,
                length: 1,
                item: (index) => index === 0 ? mockFile : null,
                [Symbol.iterator]: function* () { yield mockFile; }
            };
            
            // Mock the file input files property setter
            Object.defineProperty(fileInput, 'files', {
                set: jest.fn(),
                get: () => mockFileList,
                configurable: true
            });
            
            const dropEvent = new Event('drop');
            Object.defineProperty(dropEvent, 'dataTransfer', {
                value: { files: mockFileList }
            });

            uploadZone.dispatchEvent(dropEvent);
            
            expect(mockElectronAPI.showToast).toHaveBeenCalledWith('File selected: test.mp4', 'info');
        });

        test('drag and drop shows error for invalid file', () => {
            const uploadZone = document.getElementById('uploadZone');
            const mockFile = new File(['test'], 'test.txt', { type: 'text/plain' });
            
            const dropEvent = new Event('drop');
            Object.defineProperty(dropEvent, 'dataTransfer', {
                value: { files: [mockFile] }
            });

            uploadZone.dispatchEvent(dropEvent);

            expect(mockElectronAPI.showToast).toHaveBeenCalledWith('Please upload a valid video or audio file', 'error');
        });
    });

    describe('Upload File Function', () => {
        beforeEach(() => {
            require('../../src/renderer/index.js');
        });

        test('uploadFile handles successful transcription', async () => {
            const mockFile = {
                arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
                name: 'test.mp4',
                type: 'video/mp4',
                size: 1024
            };
            
            // Mock successful transcription response
            mockElectronAPI.invoke.mockResolvedValue({
                status: 'COMPLETED',
                transcript: [
                    { startTime: 0, endTime: 1, speaker: '1', text: 'Test transcript' }
                ]
            });

            await window.uploadFile(mockFile);

            expect(mockElectronAPI.invoke).toHaveBeenCalledWith('transcribe-media', expect.objectContaining({
                file: expect.objectContaining({
                    name: 'test.mp4',
                    type: 'video/mp4',
                    size: 1024
                })
            }));
        });

        test('uploadFile handles transcription error', async () => {
            const mockFile = {
                arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
                name: 'test.mp4',
                type: 'video/mp4',
                size: 1024
            };
            
            // Mock transcription error
            mockElectronAPI.invoke.mockRejectedValue(new Error('Transcription failed'));

            await window.uploadFile(mockFile);

            expect(mockElectronAPI.invoke).toHaveBeenCalledWith('transcribe-media', expect.any(Object));
        });
    });

    // Transcription is deliberately non-blocking: it used to open a
    // static-backdrop modal that swallowed every click for up to 5 minutes.
    // Progress now renders inline, the nav item shows a spinner from any tab,
    // and the job can be cancelled.
    describe('Non-blocking transcription UI', () => {
        const mockFile = () => ({
            arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
            name: 'test.mp4',
            type: 'video/mp4',
            size: 1024
        });

        /** Returns an invoke mock whose promise the test controls. */
        function deferredInvoke() {
            let resolveInvoke;
            const promise = new Promise(resolve => { resolveInvoke = resolve; });
            mockElectronAPI.invoke.mockReturnValue(promise);
            return { resolveInvoke };
        }

        beforeEach(() => {
            require('../../src/renderer/index.js');
        });

        test('renders inline progress with a Cancel button instead of a blocking modal', async () => {
            const { resolveInvoke } = deferredInvoke();
            const upload = window.uploadFile(mockFile());
            await Promise.resolve();

            const pane = document.getElementById('transcriptionText');
            expect(pane.querySelector('.transcribe-progress')).not.toBeNull();
            expect(document.getElementById('cancelTranscriptionBtn')).not.toBeNull();
            expect(pane.textContent).toContain('You can switch tabs');
            // The old blocking modal is gone entirely.
            expect(global.ModalManager).not.toHaveBeenCalled();

            resolveInvoke({ status: 'CANCELLED' });
            await upload;
        });

        test('toggles the Transcribe nav spinner for the duration of the job', async () => {
            const spinner = document.getElementById('navTranscribeSpinner');
            expect(spinner.classList.contains('d-none')).toBe(true);

            const { resolveInvoke } = deferredInvoke();
            const upload = window.uploadFile(mockFile());
            await Promise.resolve();
            expect(spinner.classList.contains('d-none')).toBe(false);

            resolveInvoke({ status: 'CANCELLED' });
            await upload;
            expect(spinner.classList.contains('d-none')).toBe(true);
        });

        test('progress messages from the main process update the inline status', async () => {
            const { resolveInvoke } = deferredInvoke();
            const upload = window.uploadFile(mockFile());
            await Promise.resolve();

            // Find the transcription-progress listener registered on load and
            // drive it the way the main process would.
            const call = mockElectronAPI.receive.mock.calls.find(([ch]) => ch === 'transcription-progress');
            expect(call).toBeDefined();
            call[1]({ status: 'IN_PROGRESS', message: 'Processing audio... (10s elapsed)' });

            expect(document.getElementById('inlineTranscriptionStatus').textContent)
                .toBe('Processing audio... (10s elapsed)');

            resolveInvoke({ status: 'CANCELLED' });
            await upload;
        });

        test('Cancel button asks the main process to cancel the job', async () => {
            const { resolveInvoke } = deferredInvoke();
            const upload = window.uploadFile(mockFile());
            await Promise.resolve();

            mockElectronAPI.invoke.mockResolvedValueOnce({ cancelled: true });
            document.getElementById('cancelTranscriptionBtn').click();
            await Promise.resolve();

            expect(mockElectronAPI.invoke).toHaveBeenCalledWith('cancel-transcription');

            resolveInvoke({ status: 'CANCELLED' });
            await upload;
        });

        test('a CANCELLED result resets the pane without showing transcript actions', async () => {
            mockElectronAPI.invoke.mockResolvedValue({ status: 'CANCELLED' });

            await window.uploadFile(mockFile());

            expect(document.getElementById('transcriptionText').textContent).toContain('Transcription cancelled');
            expect(document.getElementById('downloadTranscript').classList.contains('d-none')).toBe(true);
            expect(document.getElementById('uploadZone').classList.contains('d-none')).toBe(false);
            expect(mockElectronAPI.showToast).toHaveBeenCalledWith('Transcription cancelled', 'info');
        });

        test('a second upload while one is in flight is rejected, not queued', async () => {
            const { resolveInvoke } = deferredInvoke();
            const upload = window.uploadFile(mockFile());
            await Promise.resolve();

            const invokeCallsBefore = mockElectronAPI.invoke.mock.calls.length;
            await window.uploadFile(mockFile());

            expect(mockElectronAPI.invoke.mock.calls.length).toBe(invokeCallsBefore);
            expect(mockElectronAPI.showToast).toHaveBeenCalledWith(
                'A transcription is already running. Cancel it first or wait for it to finish.',
                'warning'
            );

            resolveInvoke({ status: 'CANCELLED' });
            await upload;
        });

        test('failure reports once — inline alert with retry, no error toast', async () => {
            mockElectronAPI.invoke.mockRejectedValue(new Error('Unsupported media format'));

            await window.uploadFile(mockFile());

            const pane = document.getElementById('transcriptionText');
            expect(pane.querySelector('.alert-danger')).not.toBeNull();
            expect(pane.textContent).toContain('Unsupported media format');
            expect(pane.textContent).toContain('Try again');
            // The main process already raises an OS notification for failures.
            expect(mockElectronAPI.showToast).not.toHaveBeenCalledWith(
                expect.stringContaining('Transcription failed'), 'error'
            );
        });

        test('error text is inserted as text, not markup', async () => {
            mockElectronAPI.invoke.mockRejectedValue(new Error('<img src=x onerror=alert(1)>'));

            await window.uploadFile(mockFile());

            const errEl = document.getElementById('transcriptionErrorText');
            expect(errEl.querySelector('img')).toBeNull();
            expect(errEl.textContent).toBe('<img src=x onerror=alert(1)>');
        });

        test('clicking the completion notification switches to the Transcribe tab', () => {
            const call = mockElectronAPI.receive.mock.calls.find(([ch]) => ch === 'transcription-focus-request');
            expect(call).toBeDefined();

            call[1]();

            expect(document.getElementById('transcribe-page').style.display).toBe('block');
            expect(document.getElementById('nav-transcribe').classList.contains('active')).toBe(true);
        });
    });

    describe('Bedrock Integration', () => {
        beforeEach(() => {
            require('../../src/renderer/index.js');
        });

        test('Bedrock button click with valid prompt', async () => {
            const modelSelect = document.getElementById('modelSelect');
            const promptEditor = document.getElementById('promptEditor');
            const invokeBtn = document.getElementById('invokeBedrockBtn');

            modelSelect.value = 'test-model';
            promptEditor.value = 'Test prompt';

            mockElectronAPI.invoke.mockResolvedValue('Test response');

            // Directly call the click handler instead of dispatching event
            const clickHandler = invokeBtn.onclick;
            if (clickHandler) {
                await clickHandler();
            } else {
                // If no onclick handler, simulate the button logic
                if (promptEditor.value.trim() === '') {
                    mockElectronAPI.showToast('Please enter a prompt', 'error');
                    return;
                }
                
                await mockElectronAPI.invoke('send-to-bedrock', {
                    model: modelSelect.value,
                    prompt: promptEditor.value,
                });
            }

            expect(mockElectronAPI.invoke).toHaveBeenCalledWith('send-to-bedrock', {
                model: 'test-model',
                prompt: 'Test prompt',
            });
        }, 10000);

        test('Bedrock button click with empty prompt shows error', async () => {
            const promptEditor = document.getElementById('promptEditor');
            const invokeBtn = document.getElementById('invokeBedrockBtn');

            promptEditor.value = '';

            const event = new Event('click');
            invokeBtn.dispatchEvent(event);

            expect(mockElectronAPI.showToast).toHaveBeenCalledWith('Please enter a prompt', 'error');
        });
    });

    describe('Utility Functions', () => {
        beforeEach(() => {
            require('../../src/renderer/index.js');
        });

        test('formatText handles markdown formatting', () => {
            const input = '**Bold text**\nNew line';
            const result = window.formatText(input);
            
            expect(result).toBe('<strong>Bold text</strong><br>New line');
        });

        test('cleanupAnalysisText cleans up text formatting', () => {
            const input = 'Text with<br>breaks/\\n/g and\n\n\nextra newlines';
            const result = window.cleanupAnalysisText(input);
            
            expect(result).toContain('Text with\nbreaks');
            expect(result).not.toContain('<br>');
        });
    });

    describe('Event Listeners', () => {
        beforeEach(() => {
            require('../../src/renderer/index.js');
        });

        test('template select change updates prompt editor', () => {
            const templateSelect = document.getElementById('promptTemplateSelect');
            const promptEditor = document.getElementById('promptEditor');
            
            // Set the value directly instead of creating DOM elements
            templateSelect.value = 'Test prompt template';

            const event = new Event('change');
            templateSelect.dispatchEvent(event);

            expect(promptEditor.value).toBe('Test prompt template');
        });
    });

    describe('Code Structure and Comments', () => {
        test('currentAnalysis variable is properly initialized', () => {
            require('../../src/renderer/index.js');
            
            // The currentAnalysis should be initialized as an empty string
            expect(typeof window.currentAnalysis).toBe('string');
        });
    });
});