const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const videoContainer = document.getElementById('videoContainer');
const videoPlayer = document.getElementById('videoPlayer');
const transcriptionContent = document.getElementById('transcriptionContent');
const transcriptionText = document.getElementById('transcriptionText');
const templateSelect = document.getElementById('promptTemplateSelect');
let currentAnalysis = '';
let currentTranscript = [];
let currentConversation = null; // active conversation object
let selectedFiles = []; // attached documents for Bedrock
let credentialsVerified = false; // lazy credential check — once per session

function showSuccessToast(message) {
    window.electronAPI.showToast(message, 'success');
}

function showErrorToast(message) {
    window.electronAPI.showToast(message, 'error');
}

function showInfoToast(message) {
    window.electronAPI.showToast(message, 'info');
}

function showWarningToast(message) {
    window.electronAPI.showToast(message, 'warning');
}

// Initialize theme on page load
document.addEventListener('DOMContentLoaded', async function () {
    if (window.themeManager) {
        await window.themeManager.initializeFromSettings();
        setupThemeToggle();
    }
});

// Theme toggle functionality
function setupThemeToggle() {
    const themeToggle = document.getElementById('themeToggle');
    const themeIcon = document.getElementById('themeIcon');

    if (!themeToggle || !themeIcon) return;

    // Update icon based on current theme
    function updateThemeIcon() {
        const effectiveTheme = window.themeManager.getEffectiveTheme();
        const userPreference = window.themeManager.getUserPreference();

        if (userPreference === 'auto') {
            themeIcon.className = 'bi bi-circle-half';
            themeToggle.title = `Auto Theme (Currently ${effectiveTheme})`;
        } else if (effectiveTheme === 'dark') {
            themeIcon.className = 'bi bi-sun-fill';
            themeToggle.title = 'Switch to Light Theme';
        } else {
            themeIcon.className = 'bi bi-moon-fill';
            themeToggle.title = 'Switch to Dark Theme';
        }
    }

    // Cycle through themes: light -> dark -> auto -> light
    themeToggle.addEventListener('click', async () => {
        const currentPreference = window.themeManager.getUserPreference();
        let nextTheme;

        switch (currentPreference) {
            case 'light':
                nextTheme = 'dark';
                break;
            case 'dark':
                nextTheme = 'auto';
                break;
            case 'auto':
            default:
                nextTheme = 'light';
                break;
        }

        try {
            await window.themeManager.saveThemePreference(nextTheme);
            updateThemeIcon();
            showInfoToast(`Theme switched to ${nextTheme === 'auto' ? 'auto (system)' : nextTheme}`);
        } catch (error) {
            showErrorToast('Failed to save theme preference');
        }
    });

    // Listen for theme changes
    window.addEventListener('themeChanged', updateThemeIcon);

    // Initial icon update
    updateThemeIcon();
}

// Expose functions for testing
if (typeof window !== 'undefined') {
    window.showSuccessToast = showSuccessToast;
    window.showErrorToast = showErrorToast;
    window.showInfoToast = showInfoToast;
    window.showWarningToast = showWarningToast;
    window.showTranscribePage = showTranscribePage;
    window.showAnalyzePage = showAnalyzePage;
    window.showWorkPage = showWorkPage;
    window.showSettingsPage = showSettingsPage;
    window.downloadAnalysis = downloadAnalysis;
    window.copyAnalysis = copyAnalysis;
    window.uploadFile = uploadFile;
    window.loadKnowledgeBases = loadKnowledgeBases;
    window.simpleCitationParser = simpleCitationParser;
    window.formatText = formatText;
    window.cleanupAnalysisText = cleanupAnalysisText;
    window.downloadTranscript = downloadTranscript;
    window.copyTranscript = copyTranscript;
    window.clearTranscription = clearTranscription;
    window.resetTranscriptionUI = resetTranscriptionUI;

    // Expose currentAnalysis as a getter/setter to keep it synchronized
    Object.defineProperty(window, 'currentAnalysis', {
        get: () => currentAnalysis,
        set: (value) => { currentAnalysis = value; },
        configurable: true
    });
}

const ALL_PAGES = ['work', 'swarm', 'transcribe', 'analyze', 'settings', 'showflow'];

function showPage(name) {
    ALL_PAGES.forEach(p => {
        const page = document.getElementById(`${p}-page`);
        const nav = document.getElementById(`nav-${p}`);
        if (page) {
            const flexPages = ['showflow'];
            const display = p === name ? (p === 'work' ? '' : flexPages.includes(p) ? 'flex' : 'block') : 'none';
            page.style.display = display;
        }
        if (nav) nav.classList.toggle('active', p === name);
    });
}

function showTranscribePage() { showPage('transcribe'); }
function showAnalyzePage() { showPage('analyze'); }
function showWorkPage() { showPage('work'); }
function showSwarmPage() { showPage('swarm'); }
function showSettingsPage() { showPage('settings'); }

function downloadAnalysis() {
    if (!currentConversation || currentConversation.messages.length === 0) {
        showWarningToast('No conversation available to download');
        return;
    }

    const conversationMarkdown = currentConversation.messages
        .map(msg => `## ${msg.role === 'user' ? 'User' : 'Assistant'}\n\n${msg.content}`)
        .join('\n\n---\n\n');

    const blob = new Blob([conversationMarkdown], { type: 'text/markdown' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `conversation_${currentConversation.id}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
    showSuccessToast('Conversation downloaded successfully');
}

function copyAnalysis() {
    if (!currentConversation || currentConversation.messages.length === 0) {
        showWarningToast('No conversation available to copy');
        return Promise.resolve();
    }

    const conversationMarkdown = currentConversation.messages
        .map(msg => `## ${msg.role === 'user' ? 'User' : 'Assistant'}\n\n${msg.content}`)
        .join('\n\n---\n\n');

    return navigator.clipboard.writeText(conversationMarkdown)
        .then(() => {
            showSuccessToast('Conversation copied to clipboard');

            const copyBtn = document.getElementById('copyAnalysis');
            if (copyBtn) {
                const originalText = copyBtn.innerHTML;
                copyBtn.innerHTML = '<i class="fas fa-check me-2"></i>Copied!';
                setTimeout(() => {
                    copyBtn.innerHTML = originalText;
                }, 2000);
            }
        })
        .catch(err => {
            console.error('Failed to copy text:', err);
            showErrorToast('Failed to copy to clipboard');
        });
}

document.getElementById('nav-analyze')?.addEventListener('click', showAnalyzePage);
document.getElementById('nav-transcribe')?.addEventListener('click', showTranscribePage);
document.getElementById('nav-work')?.addEventListener('click', showWorkPage);
document.getElementById('nav-swarm')?.addEventListener('click', showSwarmPage);
document.getElementById('nav-settings')?.addEventListener('click', showSettingsPage);
document.getElementById('nav-showflow')?.addEventListener('click', () => {
    showPage('showflow');
    if (!window._showflowInited) {
        window._showflowInited = true;
        if (window.ShowflowTab && typeof window.ShowflowTab.init === 'function') {
            window.ShowflowTab.init();
        } else {
            alert('ShowflowTab not found! window.ShowflowTab = ' + JSON.stringify(window.ShowflowTab));
        }
    }
});

// ── Credential expiry warning banner ─────────────────────────────────────────

(function initCredentialWarning() {
  const banner  = document.getElementById('credentialWarningBanner');
  const text    = document.getElementById('credentialWarningText');
  const updateBtn = document.getElementById('credentialWarningUpdateBtn');
  const dismissBtn = document.getElementById('credentialWarningDismiss');
  if (!banner) return;

  window.electronAPI.receive('credential-expiry-warning', ({ level, minsLeft }) => {
    banner.className = 'alert mb-0 rounded-0 align-items-center py-2 px-3';
    if (level === 'expired') {
      banner.classList.add('alert-danger');
      text.textContent = 'Your AWS credentials have expired. Please update them to continue.';
      dismissBtn.style.display = 'none';
    } else if (level === 'critical') {
      banner.classList.add('alert-danger');
      text.textContent = `Your AWS credentials expire in ~${minsLeft} minute${minsLeft !== 1 ? 's' : ''}. Update now to avoid interruption.`;
      dismissBtn.style.display = '';
    } else {
      banner.classList.add('alert-warning');
      text.textContent = `Your AWS credentials expire in ~${minsLeft} minutes.`;
      dismissBtn.style.display = '';
    }
    banner.style.display = 'flex';
  });

  updateBtn.addEventListener('click', () => {
    showPage('settings');
    // Scroll to credentials section
    setTimeout(() => {
      document.querySelector('[data-bs-target="#credentials"]')?.click();
    }, 100);
    banner.style.display = 'none';
  });

  dismissBtn.addEventListener('click', () => {
    banner.style.display = 'none';
  });
})();

templateSelect.addEventListener('change', () => {
    const selectedOption = templateSelect.options[templateSelect.selectedIndex];
    const selectedPrompt = selectedOption.getAttribute('value');
    const promptInput = document.getElementById('promptEditor');
    promptInput.value = selectedPrompt;
});

// Add this to handle the checkbox toggle
document.getElementById('useKnowledgeBase').addEventListener('change', async () => {
    await loadKnowledgeBases();
});

// Handle the use existing transcript checkbox
document.getElementById('useExistingTranscript').addEventListener('change', () => {
    const isChecked = document.getElementById('useExistingTranscript').checked;
    const transcriptText = document.getElementById('transcriptionText').textContent || document.getElementById('transcriptionText').innerText;

    if (isChecked) {
        // Check if there's actually transcript content
        if (!transcriptText || transcriptText.trim() === '' || transcriptText.includes('Upload a file to see transcription')) {
            showWarningToast('No transcript available. Please transcribe a file first.');
            document.getElementById('useExistingTranscript').checked = false;
            return;
        }
        showInfoToast('Transcript will be included with your prompt');
    }
});

// Store the knowledge base selection
document.getElementById('knowledgeBaseSelect').addEventListener('change', function () {
    const selectedKnowledgeBaseId = this.value;
    localStorage.setItem('selectedKnowledgeBaseId', selectedKnowledgeBaseId);
    localStorage.setItem('useKnowledgeBase', 'true');
});

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        // Show info toast when file is selected
        showInfoToast(`File selected: ${file.name}`);

        const mediaUrl = URL.createObjectURL(file);
        videoPlayer.src = mediaUrl;
        uploadZone.classList.add('d-none');
        videoContainer.classList.remove('d-none');
        uploadFile(file);

        // Match transcription height to video
        const updateTranscriptionHeight = () => {
            transcriptionContent.style.height = `${videoContainer.offsetHeight}px`;
        };
        updateTranscriptionHeight();
        window.addEventListener('resize', updateTranscriptionHeight);
    }
});

// Handle click to upload
uploadZone.addEventListener('click', () => fileInput.click());

// Handle drag and drop
uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.style.borderColor = '#3b82f6';
});

uploadZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    uploadZone.style.borderColor = '#ccc';
});

uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && (file.type.startsWith('video/') || file.type.startsWith('audio/'))) {
        fileInput.files = e.dataTransfer.files;
        const event = new Event('change');
        fileInput.dispatchEvent(event);
    } else {
        showErrorToast('Please upload a valid video or audio file');
    }
});

// Handle prompt submission
let analyzeProcessing = false;

function setAnalyzeBtnState(processing) {
    const btn = document.getElementById('invokeBedrockBtn');
    if (!btn) return;
    const icon = btn.querySelector('i');
    analyzeProcessing = processing;
    if (processing) {
        icon.className = 'bi bi-stop-circle-fill';
        btn.classList.add('stop-mode');
        btn.title = 'Stop';
    } else {
        icon.className = 'bi bi-arrow-up';
        btn.classList.remove('stop-mode');
        btn.title = 'Send (Enter)';
    }
}

document.getElementById('invokeBedrockBtn').addEventListener('click', () => {
    if (analyzeProcessing) {
        window.electronAPI.invoke('cancel-bedrock').catch(() => {});
    } else {
        sendMessage();
    }
});

const promptEditor = document.getElementById('promptEditor');

// Auto-resize textarea as user types
promptEditor.addEventListener('input', () => {
    promptEditor.style.height = 'auto';
    promptEditor.style.height = Math.min(promptEditor.scrollHeight, 300) + 'px';
});

promptEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

async function sendMessage() {
    const model = document.getElementById('modelSelect').value;
    let prompt = document.getElementById('promptEditor').value.trim();
    const useKnowledgeBase = document.getElementById('useKnowledgeBase').checked;
    const useExistingTranscript = document.getElementById('useExistingTranscript').checked;

    if (!prompt) {
        showErrorToast('Please enter a prompt');
        return;
    }

    // Lazy credential check — once per session
    if (!credentialsVerified) {
        const check = await window.electronAPI.invoke('quick-validate-credentials');
        if (!check.valid) {
            showErrorToast('AWS credentials are invalid or expired. Please update in Settings → AWS Credentials.');
            return;
        }
        credentialsVerified = true;
    }

    // Validate file count
    if (selectedFiles.length > 5) {
        showErrorToast('Maximum 5 files allowed for Bedrock Converse API');
        return;
    }

    // Knowledge Base doesn't support file attachments
    if (useKnowledgeBase && selectedFiles.length > 0) {
        showWarningToast('File attachments are not supported with Knowledge Base. Files will be ignored.');
    }

    // Append transcript if requested
    if (useExistingTranscript) {
        const transcriptText = document.getElementById('transcriptionText').textContent || document.getElementById('transcriptionText').innerText;
        if (!transcriptText || transcriptText.trim() === '' || transcriptText.includes('Upload a file to see transcription')) {
            showWarningToast('No transcript available. Please transcribe a file first or uncheck "Transcript".');
            return;
        }
        prompt = `${prompt}\n\n--- TRANSCRIPT ---\n${transcriptText.trim()}\n--- END TRANSCRIPT ---`;
    }

    // Validate KB selection
    let knowledgeBaseId = null;
    if (useKnowledgeBase) {
        const kbSelect = document.getElementById('knowledgeBaseSelect');
        knowledgeBaseId = kbSelect.selectedIndex > 0 ? kbSelect.value : null;
        if (!knowledgeBaseId) {
            showErrorToast('Please select a knowledge base or uncheck "Knowledge Base"');
            return;
        }
    }

    // Create conversation if none active
    if (!currentConversation) {
        currentConversation = await window.electronAPI.invoke('create-conversation', prompt);
    }

    // Add user message to conversation
    const userMsg = { role: 'user', content: prompt, timestamp: new Date().toISOString() };
    currentConversation.messages.push(userMsg);
    appendChatMessage(userMsg);
    document.getElementById('promptEditor').value = '';
    document.getElementById('chatPlaceholder')?.remove();

    // Show thinking indicator
    const thinkingEl = appendThinking();
    setAnalyzeBtnState(true);

    // Build Bedrock history (exclude the message we just added — it's sent as prompt)
    const history = currentConversation.messages
        .slice(0, -1)
        .map(m => ({ role: m.role, content: [{ text: m.content }] }));

    try {
        // Pass files only if not using knowledge base
        const filesToSend = useKnowledgeBase ? [] : selectedFiles;

        // Create streaming message bubble
        let streamingText = '';
        const assistantMsg = { role: 'assistant', content: '', timestamp: new Date().toISOString() };
        const messageEl = appendChatMessage(assistantMsg);
        const bubbleEl = messageEl.querySelector('.chat-bubble');
        const copyBtn = messageEl.querySelector('.chat-copy-btn');
        
        // Set up stream listeners
        const streamChunkHandler = (chunk) => {
            streamingText += chunk;
            assistantMsg.content = streamingText;
            
            // Update bubble content while preserving copy button
            const copyBtnHTML = copyBtn ? copyBtn.outerHTML : '';
            bubbleEl.innerHTML = copyBtnHTML + formatText(streamingText);
            
            // Reattach copy button listener
            if (copyBtn) {
                const newCopyBtn = bubbleEl.querySelector('.chat-copy-btn');
                newCopyBtn.addEventListener('click', () => {
                    navigator.clipboard.writeText(assistantMsg.content)
                        .then(() => showSuccessToast('Response copied to clipboard'))
                        .catch(() => showErrorToast('Failed to copy to clipboard'));
                });
            }
        };
        
        const streamCompleteHandler = () => {
            thinkingEl.remove();
            currentConversation.messages.push(assistantMsg);
            currentAnalysis = streamingText;
            document.getElementById('downloadAnalysis').classList.remove('d-none');
            document.getElementById('copyAnalysis').classList.remove('d-none');
            
            // Clear files after successful send
            if (selectedFiles.length > 0 && !useKnowledgeBase) {
                selectedFiles = [];
                document.getElementById('fileUpload').value = '';
                updateFileList();
            }
        };
        
        window.electronAPI.removeAllListeners('bedrock-stream-chunk');
        window.electronAPI.removeAllListeners('bedrock-stream-complete');
        window.electronAPI.receive('bedrock-stream-chunk', streamChunkHandler);
        window.electronAPI.receive('bedrock-stream-complete', streamCompleteHandler);
        
        thinkingEl.remove();

        const response = await window.electronAPI.invoke('send-to-bedrock', {
            model,
            prompt,
            knowledgeBaseId,
            conversationHistory: history,
            files: filesToSend
        });

        // For KB responses (non-streaming)
        if (useKnowledgeBase) {
            const responseText = extractKBText(response);
            assistantMsg.content = responseText;
            const copyBtnHTML = copyBtn ? copyBtn.outerHTML : '';
            bubbleEl.innerHTML = copyBtnHTML + formatText(responseText);
            currentConversation.messages.push(assistantMsg);
            currentAnalysis = responseText;
            document.getElementById('downloadAnalysis').classList.remove('d-none');
            document.getElementById('copyAnalysis').classList.remove('d-none');
        }

        // Clear files after successful send
        if (selectedFiles.length > 0 && !useKnowledgeBase) {
            selectedFiles = [];
            document.getElementById('fileUpload').value = '';
            updateFileList();
            showSuccessToast('Response received (files cleared)');
        }

        // Compress if needed
        if (currentConversation.messages.length > 20) {
            try {
                currentConversation = await window.electronAPI.invoke('compress-conversation', {
                    model,
                    conversation: currentConversation
                });
                appendCompressionNotice();
            } catch (e) {
                console.warn('Compression failed, continuing without it:', e.message);
            }
        }

        // Save conversation
        currentConversation = await window.electronAPI.invoke('save-conversation', currentConversation);
        renderConversationList();

    } catch (error) {
        thinkingEl.remove();
        appendChatError(error.message);
        showErrorToast(`Bedrock error: ${error.message}`);
    } finally {
        window.electronAPI.removeAllListeners('bedrock-stream-chunk');
        window.electronAPI.removeAllListeners('bedrock-stream-complete');
        setAnalyzeBtnState(false);
    }
}


// Load available Bedrock models on startup
async function loadBedrockModels() {
    try {
        // Get models from config instead of API call
        const bedrockModels = await window.electronAPI.invoke('get-bedrock-models');

        // Populate both Analyze and Work model selects
        const selects = [document.getElementById('modelSelect'), document.getElementById('workModelSelect')];
        for (const modelSelect of selects) {
            if (!modelSelect) continue;
            modelSelect.innerHTML = '';
            bedrockModels.forEach(model => {
                const option = document.createElement('option');
                option.value = model.inferenceProfileId || model.inferenceArn;
                option.text = model.id;
                modelSelect.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading Bedrock models:', error);
    }
}

async function loadPromptTemplates() {
    try {
        const templates = await window.electronAPI.invoke('get-prompt-templates');
        templateSelect.innerHTML = '';

        //add a default option
        const option = document.createElement('option');
        option.value = '';
        option.text = 'Select a prompt template or write a custom one';
        option.disabled = true;
        option.selected = true;
        templateSelect.appendChild(option);

        templates.forEach(template => {
            const option = document.createElement('option');
            option.value = template.prompt;
            option.text = template.name;
            option.dataset.promptId = template.id;
            templateSelect.appendChild(option);
        });
    } catch (error) {
        console.error('Error loading prompt templates:', error);
    }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', async () => {
    loadPromptTemplates();
    loadBedrockModels();
    window.loadBedrockModels = loadBedrockModels;
    setupFileUpload();
    setupCustomPromptsManagement();
    await renderConversationList();

    // Initialize tabs independently so one failure doesn't block the others
    try { if (window.WorkTab) window.WorkTab.init(); } catch (e) { console.error('WorkTab init failed:', e); }
    try { if (window.SwarmTab) window.SwarmTab.init(); } catch (e) { console.error('SwarmTab init failed:', e); }
    try { if (window.SettingsTab) window.SettingsTab.init(); } catch (e) { console.error('SettingsTab init failed:', e); }

    // If main process says no credentials, show settings page
    window.electronAPI.receive('show-settings', () => {
        showSettingsPage();
    });

    // Auto-update notifications
    // Auto-update pill - inject into navbar
    function showUpdatePill() {
        if (document.getElementById('updatePill')) return;
        const template = document.getElementById('updatePillTemplate');
        const pill = template.content.cloneNode(true);
        const navRight = document.querySelector('.navbar-nav.ms-auto');
        navRight.insertBefore(pill, navRight.firstChild);
        document.getElementById('updateInstallBtn')?.addEventListener('click', () => {
            window.electronAPI.invoke('install-update');
        });
    }

    window.electronAPI.receive('update-available', (version) => {
        showUpdatePill();
        const pillEl = document.querySelector('.update-pill');
        pillEl.classList.add('update-pill--downloading');
        document.getElementById('updatePillText').textContent = `v${version} downloading`;
    });
    window.electronAPI.receive('update-downloaded', () => {
        showUpdatePill();
        const pillEl = document.querySelector('.update-pill');
        pillEl.classList.remove('update-pill--downloading');
        document.getElementById('updatePillText').textContent = 'Update ready';
        document.getElementById('updateInstallBtn').style.display = 'inline-block';
    });
    
    // Auto-load the most recent conversation
    const conversations = await window.electronAPI.invoke('list-conversations');
    if (conversations.length > 0) {
        await loadConversation(conversations[0].id);
    }

    document.getElementById('newConversationBtn').addEventListener('click', () => {
        currentConversation = null;
        document.getElementById('chatHistory').innerHTML =
            '<div id="chatPlaceholder" class="chat-placeholder"><i class="bi bi-chat-dots fs-1 mb-3 d-block"></i>Type a message below to start</div>';
        document.getElementById('promptEditor').focus();
        document.getElementById('downloadAnalysis').classList.add('d-none');
        document.getElementById('copyAnalysis').classList.add('d-none');
        renderConversationList();
    });

    const searchInput = document.getElementById('conversationSearch');
    const searchClear = document.getElementById('conversationSearchClear');
    searchInput.addEventListener('input', () => {
        const val = searchInput.value;
        searchClear.classList.toggle('d-none', !val);
        renderConversationList(val);
    });
    searchClear.addEventListener('click', () => {
        searchInput.value = '';
        searchClear.classList.add('d-none');
        searchInput.focus();
        renderConversationList();
    });

    // Set up transcription progress listener once
    window.electronAPI.receive('transcription-progress', (progressData) => {
        const statusElement = document.getElementById('transcriptionStatus');
        if (statusElement) {
            statusElement.textContent = progressData.message;
        }
    });

    // Add event listeners for transcript management buttons
    document.getElementById('downloadTranscript').addEventListener('click', downloadTranscript);
    document.getElementById('copyTranscript').addEventListener('click', copyTranscript);
    document.getElementById('clearTranscriptionBtn').addEventListener('click', clearTranscription);

    // Add event listeners for analysis management buttons
    document.getElementById('downloadAnalysis').addEventListener('click', downloadAnalysis);
    document.getElementById('copyAnalysis').addEventListener('click', copyAnalysis);

    // Add event listeners for clear confirmation modal
    document.getElementById('saveTranscriptBeforeClear').addEventListener('click', () => {
        downloadTranscript();
        performClearTranscription();
        bootstrap.Modal.getInstance(document.getElementById('clearTranscriptionModal')).hide();
    });

    document.getElementById('copyTranscriptBeforeClear').addEventListener('click', async () => {
        await copyTranscript();
        performClearTranscription();
        bootstrap.Modal.getInstance(document.getElementById('clearTranscriptionModal')).hide();
    });

    document.getElementById('clearWithoutSaving').addEventListener('click', () => {
        performClearTranscription();
        bootstrap.Modal.getInstance(document.getElementById('clearTranscriptionModal')).hide();
    });
});

// Function to load knowledge bases
async function loadKnowledgeBases() {
    try {
        const KB_TTL_MS = 30 * 60 * 1000; // 30 minutes
        let knowledgeBases = null;
        const cached = localStorage.getItem('knowledgeBases');
        const cachedAt = parseInt(localStorage.getItem('knowledgeBases_ts') || '0', 10);
        if (cached && (Date.now() - cachedAt) < KB_TTL_MS) {
            knowledgeBases = JSON.parse(cached);
        } else {
            knowledgeBases = await window.electronAPI.invoke('get-knowledge-bases');
            localStorage.setItem('knowledgeBases', JSON.stringify(knowledgeBases));
            localStorage.setItem('knowledgeBases_ts', String(Date.now()));
        }

        const knowledgeBaseSelect = document.getElementById('knowledgeBaseSelect');

        // Clear existing options except the first one (placeholder)
        while (knowledgeBaseSelect.options.length > 1) {
            knowledgeBaseSelect.remove(1);
        }

        // Add knowledge bases to the dropdown
        knowledgeBases.forEach(kb => {
            const option = document.createElement('option');
            option.value = kb.id;
            option.textContent = kb.name;
            option.title = kb.description || '';
            knowledgeBaseSelect.appendChild(option);
        });

        const useKnowledgeBaseCheckbox = document.getElementById('useKnowledgeBase');
        if (useKnowledgeBaseCheckbox.checked) {
            document.getElementById('useKnowledgeBase').checked = true;
            document.getElementById('knowledgeBaseSection').style.display = 'block';
            showSuccessToast('Knowledge bases loaded successfully');
        }
        else {
            document.getElementById('useKnowledgeBase').checked = false;
            document.getElementById('knowledgeBaseSection').style.display = 'none';
            showInfoToast('Removed knowledge bases from Bedrock query');
        }


    } catch (error) {
        console.error('Error loading knowledge bases:', error);
        showErrorToast('Failed to load knowledge bases: ' + error.message);
    }
}

// ── Conversation management ──────────────────────────────────────────────

async function renderConversationList(filter = '') {
    const list = document.getElementById('conversationList');
    const conversations = await window.electronAPI.invoke('list-conversations');
    const query = filter.trim().toLowerCase();
    const filtered = query
        ? conversations.filter(c => c.title.toLowerCase().includes(query))
        : conversations;
    list.innerHTML = '';
    if (filtered.length === 0 && query) {
        list.innerHTML = '<div class="conv-no-results">No conversations found</div>';
        return;
    }
    filtered.forEach(conv => {
        const item = document.createElement('div');
        item.className = 'conv-item' + (currentConversation && currentConversation.id === conv.id ? ' active' : '');
        item.dataset.id = conv.id;
        const escaped = conv.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const title = query
            ? escaped.replace(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>')
            : escaped;
        item.innerHTML = `
            <span class="conv-item-title" title="${escaped}">${title}</span>
            <button class="conv-item-delete" data-id="${conv.id}" title="Delete conversation">
                <i class="bi bi-trash"></i>
            </button>`;
        item.addEventListener('click', (e) => {
            if (!e.target.closest('.conv-item-delete')) loadConversation(conv.id);
        });
        item.querySelector('.conv-item-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteConversation(conv.id);
        });
        list.appendChild(item);
    });
}

async function loadConversation(id) {
    currentConversation = await window.electronAPI.invoke('load-conversation', id);
    renderChatHistory();
    renderConversationList();
    document.getElementById('downloadAnalysis').classList.remove('d-none');
    document.getElementById('copyAnalysis').classList.remove('d-none');
}

async function deleteConversation(id) {
    await window.electronAPI.invoke('delete-conversation', id);
    if (currentConversation && currentConversation.id === id) {
        currentConversation = null;
        document.getElementById('chatHistory').innerHTML =
            '<div id="chatPlaceholder" class="chat-placeholder"><i class="bi bi-chat-dots fs-1 mb-3 d-block"></i>Start a new conversation or select one from the sidebar</div>';
        document.getElementById('downloadAnalysis').classList.add('d-none');
        document.getElementById('copyAnalysis').classList.add('d-none');
    }
    renderConversationList();
}

function renderChatHistory() {
    const history = document.getElementById('chatHistory');
    history.innerHTML = '';
    if (!currentConversation || currentConversation.messages.length === 0) {
        history.innerHTML = '<div id="chatPlaceholder" class="chat-placeholder"><i class="bi bi-chat-dots fs-1 mb-3 d-block"></i>No messages yet</div>';
        return;
    }
    currentConversation.messages.forEach(msg => appendChatMessage(msg));
    history.scrollTop = history.scrollHeight;
}

function appendChatMessage(msg) {
    const history = document.getElementById('chatHistory');
    const el = document.createElement('div');
    el.className = `chat-message ${msg.role}`;
    const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    
    const copyBtn = msg.role === 'assistant' 
        ? `<button class="chat-copy-btn" title="Copy response"><i class="bi bi-clipboard"></i></button>`
        : '';
    
    el.innerHTML = `
        <div class="chat-bubble">
            ${copyBtn}
            ${formatText(msg.content)}
        </div>
        <div class="chat-message-time">${time}</div>`;
    
    if (msg.role === 'assistant') {
        el.querySelector('.chat-copy-btn').addEventListener('click', () => {
            navigator.clipboard.writeText(msg.content)
                .then(() => showSuccessToast('Response copied to clipboard'))
                .catch(() => showErrorToast('Failed to copy to clipboard'));
        });
    }
    
    history.appendChild(el);
    history.scrollTop = history.scrollHeight;
    return el;
}

function appendThinking() {
    const history = document.getElementById('chatHistory');
    const el = document.createElement('div');
    el.className = 'chat-thinking';
    el.innerHTML = '<span></span><span></span><span></span>';
    history.appendChild(el);
    history.scrollTop = history.scrollHeight;
    return el;
}

function appendChatError(message) {
    const history = document.getElementById('chatHistory');
    const el = document.createElement('div');
    el.className = 'chat-message assistant';
    el.innerHTML = `<div class="chat-bubble" style="background:var(--error);color:#fff;">
        <i class="bi bi-exclamation-triangle me-1"></i>${message}</div>`;
    history.appendChild(el);
    history.scrollTop = history.scrollHeight;
}

function appendCompressionNotice() {
    const history = document.getElementById('chatHistory');
    const el = document.createElement('div');
    el.className = 'compression-notice';
    el.textContent = '— Earlier messages were summarized to save context —';
    history.appendChild(el);
    history.scrollTop = history.scrollHeight;
}

// Extract plain text from KB citation response for chat display
function extractKBText(response) {
    if (!response || !response.citations) return String(response);
    return response.citations
        .map(c => c.generatedResponsePart?.textResponsePart?.text || '')
        .filter(Boolean)
        .join('\n\n');
}

function simpleCitationParser(responseData) {
    // Check if we have valid data
    if (!responseData || !responseData.citations || !Array.isArray(responseData.citations)) {
        return '<div class="error">No citation data found</div>';
    }

    let htmlOutput = '';

    // Loop through each citation
    responseData.citations.forEach((citation, index) => {
        // Extract the text content if available
        let citationText = '';
        if (citation.generatedResponsePart &&
            citation.generatedResponsePart.textResponsePart &&
            citation.generatedResponsePart.textResponsePart.text) {
            citationText = citation.generatedResponsePart.textResponsePart.text;
        }

        // Skip if no text content
        if (!citationText) return;

        // Start building the citation block
        htmlOutput += `<div class="citation-item">`;

        // Add the citation text
        htmlOutput += `<div class="citation-content">${formatText(citationText)}</div>`;

        // Add citation sources if available
        if (citation.retrievedReferences && Array.isArray(citation.retrievedReferences)) {
            htmlOutput += `<div class="citation-sources">`;

            citation.retrievedReferences.forEach(reference => {
                if (reference.location && reference.location.s3Location) {
                    const sourceUrl = reference.location.s3Location;
                    const fileName = sourceUrl.uri.split('/').pop();

                    htmlOutput += `<a href="${sourceUrl}" class="source-link" title="${sourceUrl}">`;
                    htmlOutput += `[Source: ${fileName}]`;
                    htmlOutput += `</a>`;
                }
            });

            htmlOutput += `</div>`;
        }

        htmlOutput += `</div>`;
    });

    // If no content was processed, show a message
    if (!htmlOutput) {
        return '<div class="no-data">No citation content found in the data</div>';
    }

    return htmlOutput;
}

function formatText(text) {
    if (window.marked && window.marked.parse) {
        return window.marked.parse(text);
    }
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

function cleanupAnalysisText(text) {
    // Replace erroneous /\n/g pattern
    let cleaned = text.replace('/\\n/g', '\n');

    // Replace <br> tags with newlines
    cleaned = cleaned.replace(/<br>/g, '\n');

    // Fix multiple consecutive newlines to maximum of two
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // Ensure proper spacing after numbered list items
    cleaned = cleaned.replace(/(\d+\.) (?=\*\*)/g, '$1\n');

    // Add proper spacing for bullet points
    cleaned = cleaned.replace(/(\n\s*)-\s+/g, '\n   - ');

    return cleaned;
}

// Transcript management functions
function downloadTranscript() {
    const transcriptText = document.getElementById('transcriptionText').textContent || document.getElementById('transcriptionText').innerText;

    if (!transcriptText || transcriptText.trim() === '' || transcriptText.includes('Upload a file to see transcription')) {
        showWarningToast('No transcript available to download');
        return;
    }

    // Create a Blob with the transcript text
    const blob = new Blob([cleanupTranscript()], { type: 'text/plain' });

    // Create a download link
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'transcript.txt';
    link.click();

    // Clean up
    URL.revokeObjectURL(link.href);

    // Show success toast
    showSuccessToast('Transcript downloaded successfully');
}

function copyTranscript() {
    const transcriptText = document.getElementById('transcriptionText').textContent || document.getElementById('transcriptionText').innerText;

    if (!transcriptText || transcriptText.trim() === '' || transcriptText.includes('Upload a file to see transcription')) {
        showWarningToast('No transcript available to copy');
        return Promise.resolve();
    }

    return navigator.clipboard.writeText(cleanupTranscript())
        .then(() => {
            showSuccessToast('Transcript copied to clipboard');

            // Optional: Show a brief success message on the button
            const copyBtn = document.getElementById('copyTranscript');
            if (copyBtn) {
                const originalText = copyBtn.innerHTML;
                copyBtn.innerHTML = '<i class="fas fa-check me-2"></i>Copied!';
                setTimeout(() => {
                    copyBtn.innerHTML = originalText;
                }, 2000);
            }
        })
        .catch(err => {
            console.error('Failed to copy transcript:', err);
            showErrorToast('Failed to copy transcript to clipboard');
        });
}

function clearTranscription() {
    // Show the confirmation modal
    const modal = new bootstrap.Modal(document.getElementById('clearTranscriptionModal'));
    modal.show();
}

function resetTranscriptionUI() {
    fileInput.value = '';
    videoPlayer.src = '';
    videoContainer.classList.add('d-none');
    uploadZone.classList.remove('d-none');
    uploadZone.style.borderColor = '#ccc';
    transcriptionText.innerHTML = 'Upload a file to see transcription';
    document.getElementById('downloadTranscript').classList.add('d-none');
    document.getElementById('copyTranscript').classList.add('d-none');
    document.getElementById('clearTranscriptionBtn').classList.add('d-none');
}

function performClearTranscription() {
    // Reset the file input
    fileInput.value = '';
    currentTranscript = [];

    // Clear video player and hide video container
    videoPlayer.src = '';
    videoContainer.classList.add('d-none');
    uploadZone.classList.remove('d-none');

    // Clear transcription text
    transcriptionText.innerHTML = 'Upload a file to see transcription';

    // Hide transcript action buttons
    document.getElementById('downloadTranscript').classList.add('d-none');
    document.getElementById('copyTranscript').classList.add('d-none');
    document.getElementById('clearTranscriptionBtn').classList.add('d-none');

    // Reset upload zone border color
    uploadZone.style.borderColor = '#ccc';

    // Show success message
    showSuccessToast('Transcription cleared successfully');
}

// Handle file upload and transcription
async function uploadFile(file) {
    const modalManager = new ModalManager('transcriptionProcessingModal');
    const statusElement = document.getElementById('transcriptionStatus');

    try {
        // Show the processing modal
        statusElement.textContent = 'Preparing transcription...';
        modalManager.show();

        // Clear any previous transcription text
        transcriptionText.innerHTML = '';

        // Convert File to ArrayBuffer to make it cloneable for IPC
        const arrayBuffer = await file.arrayBuffer();
        const fileData = {
            buffer: Array.from(new Uint8Array(arrayBuffer)), // Convert to regular array
            name: file.name,
            type: file.type,
            size: file.size
        };

        // Call the transcription service with the uploaded data
        const response = await window.electronAPI.invoke('transcribe-media', { file: fileData });

        // Hide the modal on success
        modalManager.hide();

        if (response.status === 'COMPLETED') {
            // Display the transcript with timestamps and speaker details
            displayTranscript(response.transcript);

            // Show transcript action buttons
            document.getElementById('downloadTranscript').classList.remove('d-none');
            document.getElementById('copyTranscript').classList.remove('d-none');
            document.getElementById('clearTranscriptionBtn').classList.remove('d-none');

            showSuccessToast('Transcription completed successfully!');
        } else {
            throw new Error('Transcription did not complete successfully');
        }

    } catch (error) {
        console.error('Transcription error:', error);

        // Show error in the modal with dismiss button
        modalManager.showError(error.message || 'Transcription failed');

        // Show error in transcription area with a retry button
        transcriptionText.innerHTML = `<div class="alert alert-danger" role="alert">
            <i class="bi bi-exclamation-triangle me-2"></i>
            <strong>Transcription Failed:</strong> ${error.message || 'An unexpected error occurred'}
            <div class="mt-2">
                <button class="btn btn-sm btn-outline-danger" onclick="resetTranscriptionUI()">
                    <i class="bi bi-arrow-counterclockwise me-1"></i>Try again
                </button>
            </div>
        </div>`;

        showErrorToast(`Transcription failed: ${error.message}`);

        // Restore upload zone so user can retry without dismissing the modal
        uploadZone.classList.remove('d-none');
        videoContainer.classList.add('d-none');
        fileInput.value = '';

        // Restore modal to loading state for next use, then hide
        modalManager.hide();
        setTimeout(() => modalManager.restoreLoadingState('Processing Transcription', 'Starting transcription job...'), 300);
    }
}
function displayTranscript(timestampedTranscript) {
    currentTranscript = [];

    if (!timestampedTranscript || timestampedTranscript.length === 0) {
        transcriptionText.innerHTML = 'No transcription data available';
        showWarningToast('No transcription data was returned');
        return;
    }

    // Format each segment
    const formattedTranscript = timestampedTranscript.map(segment => {
        const startTimeFormatted = formatTimestamp(segment.startTime);
        const endTimeFormatted = formatTimestamp(segment.endTime);
        const speakerLabel = segment.speaker ?
            `<span class="speaker-label">Speaker ${segment.speaker}</span>` :
            '<span class="speaker-label">Unknown</span>';
        currentTranscript.push(segment.text);

        return `<div class="transcript-segment">
            <div class="transcript-header">
                <span class="timestamp">${startTimeFormatted} --> ${endTimeFormatted}</span>
                ${speakerLabel}
            </div>
            <div class="transcript-content">
                <span class="transcript-text">${segment.text}</span>
            </div>
        </div>`;
    }).join('');

    // Update the transcription text content
    transcriptionText.innerHTML = formattedTranscript;

    addTranscriptSegmentListeners();
}

function addTranscriptSegmentListeners() {
    const transcriptSegments = document.querySelectorAll('.transcript-segment');

    transcriptSegments.forEach(segment => {
        // Check if the segment already has a click listener
        if (!segment.hasAttribute('data-listener-attached')) {
            segment.addEventListener('click', () => {
                const timestampElement = segment.querySelector('.timestamp');
                if (timestampElement) {
                    // Extract the start timestamp from the timestamp text (e.g., "1:23:45:678 --> 1:24:00:000")
                    const startTime = timestampElement.textContent.split('-->')[0].trim();
                    const videoElement = document.getElementById('videoPlayer');

                    if (videoElement && startTime) {
                        moveVideoToTimestamp(videoElement, startTime);
                    }
                }
            });

            // Mark the segment as having a listener attached
            segment.setAttribute('data-listener-attached', 'true');
        }
    });
}

function moveVideoToTimestamp(videoElement, timestamp) {
    const [hours, minutes, seconds, milliseconds] = timestamp.split(':').map(Number);
    const totalSeconds = (hours * 3600) + (minutes * 60) + seconds + (milliseconds / 1000);
    videoElement.currentTime = totalSeconds;
    videoElement.play();
}

// Format timestamp into H:mm:ss:milliseconds format
function formatTimestamp(seconds) {
    const totalMilliseconds = seconds * 1000;
    const hours = Math.floor(totalMilliseconds / 3600000);
    const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
    const seconds_ = Math.floor((totalMilliseconds % 60000) / 1000);
    const milliseconds = Math.floor(totalMilliseconds % 1000);

    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds_).padStart(2, '0')}:${String(milliseconds).padStart(3, '0')}`;
}

function cleanupTranscript() {
    // Combine all text segments into a single string, separated by spaces
    return currentTranscript
        .join(' ')
        // Clean up any double spaces that might occur between segments
        .replace(/\s+/g, ' ')
        .trim();
}


// ===== File Upload Functions =====

function setupFileUpload() {
    const fileUpload = document.getElementById('fileUpload');
    const attachFileBtn = document.getElementById('attachFileBtn');
    const attachMenu = document.getElementById('analyzeAttachMenu');
    const attachFilesItem = document.getElementById('analyzeAttachFiles');

    // Popover menu toggle
    attachFileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        attachMenu.classList.toggle('open');
    });
    document.addEventListener('click', () => {
        if (attachMenu) attachMenu.classList.remove('open');
    });

    // Attach files menu item
    attachFilesItem.addEventListener('click', () => {
        attachMenu.classList.remove('open');
        fileUpload.click();
    });

    fileUpload.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);

        if (files.length > 5) {
            showErrorToast('Maximum 5 files allowed for Bedrock Converse API');
            e.target.value = '';
            return;
        }

        const validExtensions = ['.pdf', '.csv', '.doc', '.docx', '.xls', '.xlsx', '.html', '.txt', '.md', '.pptx', '.ppt'];
        const maxSize = 10 * 1024 * 1024; // 10MB

        for (const file of files) {
            const extension = '.' + file.name.split('.').pop().toLowerCase();

            if (!validExtensions.includes(extension)) {
                showErrorToast(`File type ${extension} not supported`);
                e.target.value = '';
                return;
            }

            if (file.size > maxSize) {
                showErrorToast(`File ${file.name} is too large. Maximum size is 10MB`);
                e.target.value = '';
                return;
            }
        }

        try {
            selectedFiles = [];

            for (const file of files) {
                const fileData = await readFileAsArrayBuffer(file);

                selectedFiles.push({
                    name: file.name,
                    content: fileData,
                    mimeType: getMimeType(file.name),
                    size: file.size
                });
            }

            updateFileList();
            showSuccessToast(`${files.length} file${files.length > 1 ? 's' : ''} selected`);

        } catch (error) {
            console.error('Error processing files:', error);
            showErrorToast('Error processing selected files');
            e.target.value = '';
        }
    });
}

function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        const extension = file.name.toLowerCase().split('.').pop();

        reader.onload = (e) => {
            if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'pptx', 'ppt'].includes(extension)) {
                const uint8Array = new Uint8Array(e.target.result);
                const regularArray = Array.from(uint8Array);
                resolve(regularArray);
            } else {
                const text = new TextDecoder().decode(e.target.result);
                resolve(text);
            }
        };

        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsArrayBuffer(file);
    });
}

function getMimeType(filename) {
    const extension = filename.toLowerCase().split('.').pop();

    const mimeTypes = {
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'ppt': 'application/vnd.ms-powerpoint',
        'csv': 'text/csv',
        'html': 'text/html',
        'md': 'text/markdown',
        'txt': 'text/plain'
    };

    return mimeTypes[extension] || 'text/plain';
}

function updateFileList() {
    const fileListSection = document.getElementById('fileListSection');
    const fileList = document.getElementById('fileList');
    const attachFileBtn = document.getElementById('attachFileBtn');

    // Remove old badge
    const oldBadge = attachFileBtn.querySelector('.file-badge');
    if (oldBadge) oldBadge.remove();

    if (selectedFiles.length === 0) {
        fileListSection.style.display = 'none';
        attachFileBtn.classList.remove('has-files');
        return;
    }

    fileListSection.style.display = 'flex';
    attachFileBtn.classList.add('has-files');

    // Add count badge
    const badge = document.createElement('span');
    badge.className = 'file-badge';
    badge.textContent = selectedFiles.length;
    attachFileBtn.appendChild(badge);

    fileList.innerHTML = selectedFiles.map((file, index) => {
        const ext = file.name.toLowerCase().split('.').pop();
        return `<div class="file-chip">
            <i class="${getFileIcon(ext)} chip-icon"></i>
            <span class="chip-name">${file.name}</span>
            <button class="chip-remove" onclick="removeFile(${index})"><i class="bi bi-x"></i></button>
        </div>`;
    }).join('');
}

function getFileIcon(extension) {
    const icons = {
        'pdf': 'bi bi-file-earmark-pdf',
        'doc': 'bi bi-file-earmark-word',
        'docx': 'bi bi-file-earmark-word',
        'xls': 'bi bi-file-earmark-excel',
        'xlsx': 'bi bi-file-earmark-excel',
        'csv': 'bi bi-file-earmark-spreadsheet',
        'html': 'bi bi-file-earmark-code',
        'md': 'bi bi-file-earmark-richtext',
        'txt': 'bi bi-file-earmark-text'
    };

    return icons[extension] || 'bi bi-file-earmark-text';
}

function removeFile(index) {
    selectedFiles.splice(index, 1);
    updateFileList();

    if (selectedFiles.length === 0) {
        document.getElementById('fileUpload').value = '';
    }

    showInfoToast('File removed');
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

window.removeFile = removeFile;


// ===== Custom Prompts Management =====

let editingPromptId = null;

function setupCustomPromptsManagement() {
    const managePromptsBtn = document.getElementById('managePromptsBtn');
    const addPromptBtn = document.getElementById('addPromptBtn');
    const savePromptBtn = document.getElementById('savePromptBtn');
    const cancelPromptBtn = document.getElementById('cancelPromptBtn');
    
    managePromptsBtn.addEventListener('click', () => {
        const modal = new bootstrap.Modal(document.getElementById('managePromptsModal'));
        modal.show();
        loadCustomPromptsList();
    });
    
    addPromptBtn.addEventListener('click', () => {
        showPromptForm();
    });
    
    savePromptBtn.addEventListener('click', async () => {
        await savePrompt();
    });
    
    cancelPromptBtn.addEventListener('click', () => {
        hidePromptForm();
    });
}

function showPromptForm(prompt = null) {
    const form = document.getElementById('promptForm');
    const title = document.getElementById('promptFormTitle');
    const nameInput = document.getElementById('promptName');
    const textInput = document.getElementById('promptText');
    
    if (prompt) {
        title.textContent = 'Edit Prompt';
        nameInput.value = prompt.name;
        textInput.value = prompt.prompt;
        editingPromptId = prompt.id;
    } else {
        title.textContent = 'New Prompt';
        nameInput.value = '';
        textInput.value = '';
        editingPromptId = null;
    }
    
    form.style.display = 'block';
}

function hidePromptForm() {
    document.getElementById('promptForm').style.display = 'none';
    document.getElementById('promptName').value = '';
    document.getElementById('promptText').value = '';
    editingPromptId = null;
}

async function savePrompt() {
    const name = document.getElementById('promptName').value.trim();
    const prompt = document.getElementById('promptText').value.trim();
    
    if (!name || !prompt) {
        showErrorToast('Please fill in both name and prompt text');
        return;
    }
    
    try {
        if (editingPromptId) {
            await window.electronAPI.invoke('update-custom-prompt', {
                id: editingPromptId,
                updates: { name, prompt }
            });
            showSuccessToast('Prompt updated successfully');
        } else {
            await window.electronAPI.invoke('add-custom-prompt', { name, prompt });
            showSuccessToast('Prompt added successfully');
        }
        
        hidePromptForm();
        await loadCustomPromptsList();
        await loadPromptTemplates();
    } catch (error) {
        showErrorToast('Failed to save prompt: ' + error.message);
    }
}

async function loadCustomPromptsList() {
    const list = document.getElementById('customPromptsList');
    
    try {
        const prompts = await window.electronAPI.invoke('get-custom-prompts');
        
        if (prompts.length === 0) {
            list.innerHTML = '<p class="text-muted">No prompts yet. Click "Add New Prompt" to create one.</p>';
            return;
        }
        
        list.innerHTML = prompts.map(prompt => `
            <div class="card mb-2">
                <div class="card-body p-2">
                    <div class="d-flex justify-content-between align-items-start">
                        <div class="flex-grow-1">
                            <h6 class="mb-1">${prompt.name}</h6>
                            <p class="mb-0 small text-muted">${prompt.prompt.substring(0, 100)}${prompt.prompt.length > 100 ? '...' : ''}</p>
                        </div>
                        <div class="d-flex gap-1">
                            <button class="btn btn-sm btn-outline-primary edit-prompt-btn" data-id="${prompt.id}">
                                <i class="bi bi-pencil"></i>
                            </button>
                            <button class="btn btn-sm btn-outline-danger delete-prompt-btn" data-id="${prompt.id}">
                                <i class="bi bi-trash"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
        
        // Attach event listeners
        list.querySelectorAll('.edit-prompt-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                const prompt = prompts.find(p => p.id === id);
                showPromptForm(prompt);
            });
        });
        
        list.querySelectorAll('.delete-prompt-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                if (confirm('Are you sure you want to delete this prompt?')) {
                    await deletePrompt(id);
                }
            });
        });
    } catch (error) {
        list.innerHTML = '<p class="text-danger">Error loading prompts</p>';
        console.error('Error loading prompts:', error);
    }
}

async function deletePrompt(id) {
    try {
        await window.electronAPI.invoke('delete-custom-prompt', id);
        showSuccessToast('Prompt deleted successfully');
        await loadCustomPromptsList();
        await loadPromptTemplates();
    } catch (error) {
        showErrorToast('Failed to delete prompt: ' + error.message);
    }
}
