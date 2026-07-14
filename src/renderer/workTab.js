/**
 * Work tab — agentic chat interface using AgentCore Code Interpreter.
 * Uses shared ChatRenderer and FileManager modules.
 * Each session gets its own DOM container for full isolation.
 */

(function () {
  const CR = window.ChatRenderer;
  const FM = window.FileManager;

  // ── Per-session state map ─────────────────────────────────
  // Key: sessionId, Value: { container, messages, streamingEl, streamingText, activityLog, lastEntry, processing }
  const sessions = new Map();

  let activeSessionId = localStorage.getItem('workSessionId') || generateSessionId();
  let workingDirectory = null;
  let credentialsVerified = false;

  function generateSessionId() {
    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem('workSessionId', id);
    return id;
  }

  function getOrCreateSession(id) {
    if (!sessions.has(id)) {
      const container = document.createElement('div');
      container.className = 'chat-history-inner';
      sessions.set(id, {
        container,
        messages: [],
        streamingEl: null,
        streamingText: '',
        activityLog: null,
        lastEntry: null,
        processing: false,
      });
    }
    return sessions.get(id);
  }

  function getActiveSession() {
    return getOrCreateSession(activeSessionId);
  }

  // The outer wrapper that holds the active session's container
  function getHost() {
    return document.getElementById('workChatHistory');
  }

  // Swap the visible DOM container to the given session
  function showSession(id) {
    const host = getHost();
    // Detach current (but keep in map)
    while (host.firstChild) host.removeChild(host.firstChild);
    // Attach target
    const session = getOrCreateSession(id);
    host.appendChild(session.container);
    activeSessionId = id;
    localStorage.setItem('workSessionId', id);
  }

  // File manager for the Work tab's own file input
  const workFiles = FM.createFileManager({
    fileInputId: 'workFileUpload',
    attachBtnId: 'workAttachFiles',
    clearBtnId: 'workClearFiles',
    listSectionId: 'workFileListSection',
    listId: 'workFileList',
    countId: 'workFileCount',
    toolBtnId: 'workAttachFileBtn',
    maxFiles: 5,
  });

  function showToast(msg, type) {
    if (window.electronAPI && window.electronAPI.showToast) {
      window.electronAPI.showToast(msg, type);
    }
  }

  async function init() {
    workFiles.setup(showToast);

    const sendBtn = document.getElementById('workSendBtn');
    const promptInput = document.getElementById('workPromptEditor');
    const attachBtn = document.getElementById('workAttachFileBtn');
    const attachMenu = document.getElementById('workAttachMenu');

    sendBtn.addEventListener('click', () => {
      const session = getActiveSession();
      if (session.processing) {
        cancelWorkMessage();
      } else {
        sendWorkMessage();
      }
    });
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendWorkMessage();
      }
    });
    promptInput.addEventListener('input', () => {
      promptInput.style.height = 'auto';
      promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
    });

    // Popover menu toggle
    attachBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      attachMenu.classList.toggle('open');
    });
    document.addEventListener('click', () => attachMenu.classList.remove('open'));

    document.getElementById('workAttachFiles').addEventListener('click', () => {
      attachMenu.classList.remove('open');
    });

    // Select workspace option
    document.getElementById('workSelectDir').addEventListener('click', async () => {
      attachMenu.classList.remove('open');
      const dir = await window.electronAPI.invoke('select-directory');
      if (dir) {
        workingDirectory = dir;
        const badge = document.getElementById('workDirBadge');
        document.getElementById('workDirBadgeText').textContent = dir.split('/').pop() || dir;
        badge.title = dir;
        badge.classList.remove('d-none');
        showToast(`Workspace: ${dir}`, 'info');
      }
    });

    // Remove workspace directory
    document.getElementById('workDirRemoveBtn').addEventListener('click', () => {
      workingDirectory = null;
      const badge = document.getElementById('workDirBadge');
      badge.classList.add('d-none');
    });

    // Skills Palette
    const skillsBtn = document.getElementById('workSkillsBtn');
    const skillsPalette = document.getElementById('workSkillsPalette');
    const skillsPaletteClose = document.getElementById('workSkillsPaletteClose');

    skillsBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const isOpen = skillsPalette.classList.contains('open');
      if (isOpen) {
        skillsPalette.classList.remove('open');
      } else {
        skillsPalette.classList.add('open');
        await loadSkillsPalette();
      }
    });

    skillsPaletteClose.addEventListener('click', (e) => {
      e.stopPropagation();
      skillsPalette.classList.remove('open');
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.skills-menu-wrap')) {
        skillsPalette.classList.remove('open');
      }
    });

    // New Chat button
    const newChatBtn = document.getElementById('workNewChatBtn');
    if (newChatBtn) {
      newChatBtn.addEventListener('click', startNewChat);
    }

    // Sidebar
    const sidebar = document.getElementById('workSidebar');
    const sidebarState = localStorage.getItem('sidebarOpen') === 'true';
    if (sidebarState) sidebar.classList.remove('collapsed');

    document.getElementById('workSidebarToggle').addEventListener('click', toggleSidebar);
    document.getElementById('sidebarToggle').addEventListener('click', toggleSidebar);
    document.getElementById('sidebarNewChat').addEventListener('click', startNewChat);

    initContextMenu();
    initRenameModal();

    // Initialize the active session's container
    // Try to restore from disk first; fall back to greeting for new sessions
    const session = getActiveSession();
    try {
      const data = await window.electronAPI.invoke('work-history-load', { id: activeSessionId });
      if (data && data.messages && data.messages.length > 0) {
        session.messages = data.messages;
        session.container.innerHTML = '';
        session.messages.forEach(msg => {
          CR.appendChatMessage(session.container, msg, {
            onCopy: () => navigator.clipboard.writeText(msg.content).then(
              () => showToast('Copied to clipboard', 'success'),
              () => showToast('Failed to copy', 'error')
            ),
          });
        });
      } else {
        session.container.innerHTML = `
          <div id="workPlaceholder" class="work-greeting">
            <div class="work-greeting-icon"><img src="../assets/agentic-tool-icon-light.svg" alt="Agent" class="greeting-icon-img greeting-icon-light"><img src="../assets/agentic-tool-icon-dark.svg" alt="Agent" class="greeting-icon-img greeting-icon-dark"></div>
            <div class="work-greeting-text">What can I help you build today?</div>
          </div>`;
      }
    } catch {
      session.container.innerHTML = `
        <div id="workPlaceholder" class="work-greeting">
          <div class="work-greeting-icon"><img src="../assets/agentic-tool-icon-light.svg" alt="Agent" class="greeting-icon-img greeting-icon-light"><img src="../assets/agentic-tool-icon-dark.svg" alt="Agent" class="greeting-icon-img greeting-icon-dark"></div>
          <div class="work-greeting-text">What can I help you build today?</div>
        </div>`;
    }
    showSession(activeSessionId);
    refreshSidebar();
    // Scroll to bottom after restoring history
    setTimeout(() => { getHost().scrollTop = getHost().scrollHeight; }, 50);

    // ── IPC listeners — route by sessionId ──────────────────
    window.electronAPI.receive('agent-status', (data) => {
      const { sessionId, status } = data;
      const s = sessions.get(sessionId);
      if (!s) return;

      if (typeof status === 'object' && status.tool) {
        if (!s.activityLog) {
          s.activityLog = CR.createActivityLog(s.container);
        }
        if (status.state === 'running') {
          s.lastEntry = CR.addActivityEntry(s.activityLog, status);
        } else if (status.state === 'done' && s.lastEntry) {
          CR.completeActivityEntry(s.lastEntry);
          s.lastEntry = null;
        }
      } else {
        const prev = s.container.querySelector('.chat-status-message:last-child');
        if (prev) prev.remove();
        CR.appendStatusMessage(s.container, status);
      }

      // Auto-scroll if this is the visible session
      if (sessionId === activeSessionId) {
        getHost().scrollTop = getHost().scrollHeight;
      }
    });

    window.electronAPI.receive('agent-stream-chunk', (data) => {
      const { sessionId, chunk } = data;
      const s = sessions.get(sessionId);
      if (!s) return;

      s.streamingText += chunk;

      if (!s.streamingEl) {
        const msg = { role: 'assistant', content: '', timestamp: new Date().toISOString() };
        s.streamingEl = CR.appendChatMessage(s.container, msg, {
          onCopy: () => navigator.clipboard.writeText(s.streamingText).then(
            () => showToast('Copied to clipboard', 'success'),
            () => showToast('Failed to copy', 'error')
          ),
        });
      }

      const bubble = s.streamingEl.querySelector('.chat-bubble');
      const contentEl = bubble.querySelector('.chat-bubble-content');
      if (contentEl) {
        contentEl.innerHTML = CR.formatText(s.streamingText);
      }

      if (sessionId === activeSessionId) {
        getHost().scrollTop = getHost().scrollHeight;
      }
    });
  }

  function setSendBtnState(processing) {
    const btn = document.getElementById('workSendBtn');
    if (!btn) return;
    const icon = btn.querySelector('i');
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

  async function cancelWorkMessage() {
    const sid = activeSessionId;
    await window.electronAPI.invoke('cancel-agent', { sessionId: sid }).catch(() => {});
  }

  // ── Skills Palette ─────────────────────────────────────────
  const SKILL_STARTERS = {
    'storybrand': 'Run a StoryBrand SB7 audit on this content:\n\n',
    'copywriting': 'Write copy for: ',
    'copy-editing': 'Edit and improve this copy:\n\n',
    'marketing-psychology': 'Apply marketing psychology principles to: ',
    'customer-research': 'Analyze this customer feedback:\n\n',
    'launch-strategy': 'Help me plan a launch for: ',
    'demo-storyboard': 'Create a demo storyboard for: ',
    'doc-coauthoring': 'Help me write a document about: ',
    'analysis-framework': 'Analyze this:\n\n',
    'research-first': 'Research this topic: ',
    'docx': 'Create a Word document: ',
    'pptx': 'Create a PowerPoint presentation: ',
    'xlsx': 'Create a spreadsheet: ',
    'pdf': 'Create or read a PDF: ',
    'web-browse': 'Search the web for: ',
    'algorithmic-art': 'Create generative art: ',
    'task-planner': 'Plan this task: ',
    'self-correction': '',
  };

  const SKILL_ICONS = {
    'storybrand': 'bi-bullseye',
    'copywriting': 'bi-pencil-square',
    'copy-editing': 'bi-spellcheck',
    'marketing-psychology': 'bi-lightbulb',
    'customer-research': 'bi-people',
    'launch-strategy': 'bi-rocket-takeoff',
    'demo-storyboard': 'bi-camera-reels',
    'doc-coauthoring': 'bi-file-earmark-text',
    'analysis-framework': 'bi-graph-up',
    'research-first': 'bi-search',
    'docx': 'bi-file-earmark-word',
    'pptx': 'bi-file-earmark-ppt',
    'xlsx': 'bi-file-earmark-spreadsheet',
    'pdf': 'bi-file-earmark-pdf',
    'web-browse': 'bi-globe',
    'algorithmic-art': 'bi-palette',
    'task-planner': 'bi-list-check',
    'self-correction': 'bi-arrow-repeat',
  };

  async function loadSkillsPalette() {
    const list = document.getElementById('workSkillsList');
    try {
      const skills = await window.electronAPI.invoke('get-skills');
      const enabled = (skills || []).filter(s => !s.disabled);
      if (enabled.length === 0) {
        list.innerHTML = '<div class="text-muted small text-center py-3">No skills available.</div>';
        return;
      }
      list.innerHTML = enabled.map(s => {
        const icon = SKILL_ICONS[s.name] || 'bi-lightning';
        const desc = s.description.replace(/Use when.*$/, '').replace(/\.$/, '').trim();
        // Truncate description to first sentence
        const shortDesc = desc.length > 100 ? desc.slice(0, 100).replace(/[,;]?\s+\S*$/, '…') : desc;
        return `
          <div class="skill-palette-item" data-skill="${escapeHtml(s.name)}">
            <div class="skill-palette-item-icon"><i class="bi ${icon}"></i></div>
            <div class="skill-palette-item-info">
              <div class="skill-palette-item-name">${escapeHtml(s.name)}</div>
              <div class="skill-palette-item-desc">${escapeHtml(shortDesc)}</div>
            </div>
            <button class="skill-palette-item-use" data-skill="${escapeHtml(s.name)}">Use</button>
          </div>`;
      }).join('');

      list.querySelectorAll('.skill-palette-item').forEach(item => {
        item.addEventListener('click', () => useSkill(item.dataset.skill));
      });
    } catch (err) {
      list.innerHTML = `<div class="text-danger small text-center py-3">${escapeHtml(err.message)}</div>`;
    }
  }

  function useSkill(name) {
    const promptInput = document.getElementById('workPromptEditor');
    const starter = SKILL_STARTERS[name] || `Use the ${name} skill: `;
    promptInput.value = starter;
    promptInput.focus();
    // Adjust textarea height
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
    // Close palette
    document.getElementById('workSkillsPalette').classList.remove('open');
  }

  async function sendWorkMessage() {
    const session = getActiveSession();
    if (session.processing) return;

    const promptInput = document.getElementById('workPromptEditor');
    const model = document.getElementById('workModelSelect').value;
    const prompt = promptInput.value.trim();

    if (!prompt) {
      showToast('Please enter a message', 'error');
      return;
    }

    if (!credentialsVerified) {
      const check = await window.electronAPI.invoke('quick-validate-credentials');
      if (!check.valid) {
        showToast('AWS credentials are invalid or expired. Update in Settings → AWS Credentials.', 'error');
        return;
      }
      credentialsVerified = true;
    }

    const fullPrompt = workingDirectory
      ? `[Working directory: ${workingDirectory}]\n\n${prompt}`
      : prompt;

    session.processing = true;
    setSendBtnState(true);
    const container = session.container;

    // Capture sessionId for this invocation (before any async work)
    const sid = activeSessionId;

    // Remove placeholder/greeting
    const placeholder = container.querySelector('.work-greeting') || container.querySelector('.chat-placeholder');
    if (placeholder) placeholder.remove();

    // Show user message
    const userMsg = { role: 'user', content: prompt, timestamp: new Date().toISOString() };
    session.messages.push(userMsg);
    CR.appendChatMessage(container, userMsg);
    promptInput.value = '';
    promptInput.style.height = 'auto';

    // Save immediately so the conversation exists in history
    await saveSession(sid, session.messages);
    refreshSidebar();

    // Show thinking
    const thinkingEl = CR.appendThinking(container);

    // Reset streaming and activity state for this session
    session.streamingEl = null;
    session.streamingText = '';
    session.activityLog = null;
    session.lastEntry = null;

    const history = session.messages.slice(0, -1).map(m => ({
      role: m.role,
      content: [{ text: m.content }],
    }));

    // Update sidebar to show working state
    refreshSidebar();

    try {
      const files = workFiles.getFiles();

      const response = await window.electronAPI.invoke('invoke-agent', {
        model,
        prompt: fullPrompt,
        conversationHistory: history,
        files,
        sessionId: sid,
      });

      thinkingEl.remove();
      CR.finishActivityLog(session.activityLog);
      container.querySelectorAll('.chat-status-message').forEach(el => el.remove());

      if (!session.streamingEl && response) {
        const assistantMsg = { role: 'assistant', content: response, timestamp: new Date().toISOString() };
        CR.appendChatMessage(container, assistantMsg, {
          onCopy: () => navigator.clipboard.writeText(response).then(
            () => showToast('Copied to clipboard', 'success'),
            () => showToast('Failed to copy', 'error')
          ),
        });
        session.messages.push(assistantMsg);
      } else if (session.streamingText) {
        session.messages.push({ role: 'assistant', content: session.streamingText, timestamp: new Date().toISOString() });
      }

      saveSession(sid, session.messages);
      refreshSidebar();

    } catch (error) {
      thinkingEl.remove();
      CR.finishActivityLog(session.activityLog);
      container.querySelectorAll('.chat-status-message').forEach(el => el.remove());

      // Preserve any partial streaming content
      if (session.streamingText) {
        session.messages.push({ role: 'assistant', content: session.streamingText, timestamp: new Date().toISOString() });
      }

      CR.appendChatError(container, error.message);
      showToast(`Agent error: ${error.message}`, 'error');
      saveSession(sid, session.messages);
    } finally {
      session.processing = false;
      setSendBtnState(false);
      refreshSidebar();
    }
  }

  // ── Sidebar & History ─────────────────────────────────────

  function toggleSidebar() {
    const sidebar = document.getElementById('workSidebar');
    sidebar.classList.toggle('collapsed');
    localStorage.setItem('sidebarOpen', !sidebar.classList.contains('collapsed'));
  }

  function startNewChat() {
    // Stash draft prompt + files from current session
    const promptInput = document.getElementById('workPromptEditor');
    const currentSession = getActiveSession();
    currentSession.draftPrompt = promptInput.value;
    currentSession.files = workFiles.getFiles();

    // If there's an in-progress streaming response, capture it before saving
    if (currentSession.processing && currentSession.streamingText) {
      const alreadyHasAssistant = currentSession.messages.length > 0 &&
        currentSession.messages[currentSession.messages.length - 1].role === 'assistant';
      if (!alreadyHasAssistant) {
        currentSession.messages.push({ role: 'assistant', content: currentSession.streamingText, timestamp: new Date().toISOString() });
      }
    }

    saveSession(activeSessionId, currentSession.messages);
    if (currentSession.messages.length > 0) {
      window.electronAPI.invoke('memory-extract', { sessionId: activeSessionId }).catch(() => {});
    }
    // Clean up sandbox only if the old conversation is idle
    if (!currentSession.processing) {
      window.electronAPI.invoke('work-cleanup-session', { sessionId: activeSessionId }).catch(() => {});
    }

    const newId = generateSessionId();
    const session = getOrCreateSession(newId);
    session.container.innerHTML = `
      <div id="workPlaceholder" class="work-greeting">
        <div class="work-greeting-icon"><img src="../assets/agentic-tool-icon-light.svg" alt="Agent" class="greeting-icon-img greeting-icon-light"><img src="../assets/agentic-tool-icon-dark.svg" alt="Agent" class="greeting-icon-img greeting-icon-dark"></div>
        <div class="work-greeting-text">What can I help you build today?</div>
      </div>`;
    showSession(newId);
    workFiles.clearFiles();
    workingDirectory = null;
    document.getElementById('workDirBadge').classList.add('d-none');
    promptInput.value = '';
    promptInput.style.height = 'auto';
    refreshSidebar();
  }

  async function saveSession(id, messages) {
    if (!messages || messages.length === 0) return;
    try {
      await window.electronAPI.invoke('work-history-save', {
        id,
        messages,
        createdAt: messages[0]?.timestamp || new Date().toISOString(),
      });
    } catch { /* non-critical */ }
  }

  async function refreshSidebar() {
    const list = document.getElementById('sidebarList');
    try {
      const allSessions = await window.electronAPI.invoke('work-history-list');
      if (allSessions.length === 0) {
        list.innerHTML = '<div class="sidebar-empty">No conversations yet</div>';
        return;
      }

      const starred = allSessions.filter(s => s.starred);
      const unstarred = allSessions.filter(s => !s.starred);
      const groups = groupByDate(unstarred);

      let html = '';
      if (starred.length > 0) {
        html += '<div class="sidebar-group-label">Starred</div>';
        html += starred.map(s => renderItem(s)).join('');
      }
      html += groups.map(g => `
        <div class="sidebar-group-label">${g.label}</div>
        ${g.items.map(s => renderItem(s)).join('')}
      `).join('');

      list.innerHTML = html;

      list.querySelectorAll('.sidebar-item').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('.sidebar-menu-btn')) return;
          switchToSession(el.dataset.id);
        });
      });

      list.querySelectorAll('.sidebar-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          showContextMenu(e, btn.dataset.id, !!btn.dataset.starred);
        });
      });
    } catch { list.innerHTML = '<div class="sidebar-empty">Error loading history</div>'; }
  }

  function renderItem(s) {
    const isActive = s.id === activeSessionId;
    const sess = sessions.get(s.id);
    const isWorking = sess && sess.processing;
    return `<div class="sidebar-item${isActive ? ' active' : ''}" data-id="${s.id}">
      ${s.starred ? '<i class="bi bi-star-fill sidebar-item-star"></i>' : ''}
      <span class="sidebar-item-title">${escapeHtml(s.title || 'Untitled')}</span>
      ${isWorking ? '<span class="sidebar-working-indicator" title="Agent working"></span>' : ''}
      <button class="sidebar-menu-btn" data-id="${s.id}" data-starred="${s.starred ? '1' : ''}" title="More"><i class="bi bi-three-dots"></i></button>
    </div>`;
  }

  async function switchToSession(id) {
    if (id === activeSessionId) return;

    // Save current session + stash draft prompt and files
    const promptInput = document.getElementById('workPromptEditor');
    const currentSession = getActiveSession();
    currentSession.draftPrompt = promptInput.value;
    currentSession.files = workFiles.getFiles();
    saveSession(activeSessionId, currentSession.messages);

    // If target session is already in memory (live DOM), just swap
    if (sessions.has(id)) {
      showSession(id);
      const target = sessions.get(id);
      promptInput.value = target.draftPrompt || '';
      promptInput.style.height = 'auto';
      workFiles.setFiles(target.files || []);
      refreshSidebar();
      return;
    }

    // Otherwise load from disk — no files to restore (they were in-memory only)
    workFiles.clearFiles();
    try {
      const data = await window.electronAPI.invoke('work-history-load', { id });
      const session = getOrCreateSession(id);
      session.messages = data.messages || [];
      session.container.innerHTML = '';
      session.messages.forEach(msg => {
        CR.appendChatMessage(session.container, msg, {
          onCopy: () => navigator.clipboard.writeText(msg.content).then(
            () => showToast('Copied to clipboard', 'success'),
            () => showToast('Failed to copy', 'error')
          ),
        });
      });
      showSession(id);
      promptInput.value = '';
      promptInput.style.height = 'auto';
      getHost().scrollTop = getHost().scrollHeight;
      refreshSidebar();
    } catch (err) {
      showToast(`Failed to load session: ${err.message}`, 'error');
    }
  }

  // ── Context Menu ──────────────────────────────────────────
  let ctxTargetId = null;

  function showContextMenu(e, id, isStarred) {
    ctxTargetId = id;
    const menu = document.getElementById('sidebarContextMenu');
    const starBtn = menu.querySelector('[data-action="star"]');
    starBtn.innerHTML = isStarred
      ? '<i class="bi bi-star-fill"></i> <span>Unstar</span>'
      : '<i class="bi bi-star"></i> <span>Star</span>';
    menu.style.display = 'block';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
      if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;
    });
  }

  function hideContextMenu() {
    document.getElementById('sidebarContextMenu').style.display = 'none';
    ctxTargetId = null;
  }

  function initContextMenu() {
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.sidebar-context-menu')) hideContextMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideContextMenu(); hideRenameModal(); } });

    document.querySelectorAll('#sidebarContextMenu .ctx-item').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const id = ctxTargetId;
        hideContextMenu();
        if (!id) return;
        if (action === 'star') {
          await window.electronAPI.invoke('work-history-star', { id });
          refreshSidebar();
        } else if (action === 'rename') {
          showRenameModal(id);
        } else if (action === 'delete') {
          if (!confirm('Delete this conversation?')) return;
          await window.electronAPI.invoke('work-history-delete', { id });
          sessions.delete(id);
          if (id === activeSessionId) startNewChat();
          else refreshSidebar();
        }
      });
    });
  }

  // ── Rename Modal ──────────────────────────────────────────
  let renameTargetId = null;

  function showRenameModal(id) {
    renameTargetId = id;
    const item = document.querySelector(`.sidebar-item[data-id="${id}"] .sidebar-item-title`);
    const modal = document.getElementById('renameModal');
    const input = document.getElementById('renameInput');
    input.value = item ? item.textContent : '';
    modal.style.display = 'flex';
    input.focus();
    input.select();
  }

  function hideRenameModal() {
    const modal = document.getElementById('renameModal');
    if (modal) modal.style.display = 'none';
    renameTargetId = null;
  }

  function initRenameModal() {
    document.getElementById('renameCancelBtn').addEventListener('click', hideRenameModal);
    document.getElementById('renameSaveBtn').addEventListener('click', async () => {
      const title = document.getElementById('renameInput').value.trim();
      if (title && renameTargetId) {
        await window.electronAPI.invoke('work-history-rename', { id: renameTargetId, title });
        refreshSidebar();
      }
      hideRenameModal();
    });
    document.getElementById('renameInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('renameSaveBtn').click();
    });
  }

  function groupByDate(sessionList) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today - 86400000);
    const weekAgo = new Date(today - 7 * 86400000);

    const groups = { Today: [], Yesterday: [], 'This Week': [], Older: [] };
    for (const s of sessionList) {
      const d = new Date(s.updatedAt);
      if (d >= today) groups.Today.push(s);
      else if (d >= yesterday) groups.Yesterday.push(s);
      else if (d >= weekAgo) groups['This Week'].push(s);
      else groups.Older.push(s);
    }
    return Object.entries(groups).filter(([, items]) => items.length > 0).map(([label, items]) => ({ label, items }));
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Trigger LTM extraction on app quit
  window.electronAPI.receive('app-before-quit', () => {
    const session = getActiveSession();
    if (session.messages.length > 0) {
      window.electronAPI.invoke('memory-extract', { sessionId: activeSessionId }).catch(() => {});
    }
  });

  if (typeof window !== 'undefined') {
    window.WorkTab = { init };
  }
})();
