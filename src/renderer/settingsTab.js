/**
 * Settings tab — in-page settings with Credentials, Configuration, and About sub-tabs.
 */
(function () {
  function init() {
    // Sub-tab switching
    document.querySelectorAll('[data-settings-tab]').forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        const target = tab.dataset.settingsTab;
        document.querySelectorAll('.settings-tab-content').forEach(c => c.style.display = 'none');
        document.querySelectorAll('[data-settings-tab]').forEach(t => t.classList.remove('active'));
        document.getElementById(`settings-${target}`).style.display = '';
        tab.classList.add('active');
        if (target === 'credentials') loadCredentials();
        if (target === 'configuration') loadConfig();
        if (target === 'about') loadAbout();
        if (target === 'skills') loadSkills();
        if (target === 'models') loadModels();
        if (target === 'analytics') loadAnalytics();
      });
    });

    // Credentials form
    document.getElementById('credentialsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveCredentials();
    });

    document.getElementById('pasteCredBtn').addEventListener('click', pasteFromClipboard);

    // Paste detection on credential fields
    ['accessKeyId', 'secretAccessKey', 'sessionToken'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('paste', (e) => {
        setTimeout(() => tryParseCredentials(el.value), 50);
      });
    });

    // Jina API key — debounced autosave
    let jinaDebounce = null;
    document.getElementById('jinaApiKey').addEventListener('input', (e) => {
      const status = document.getElementById('jinaKeyStatus');
      clearTimeout(jinaDebounce);
      const val = e.target.value.trim();
      if (!val) {
        status.textContent = '';
        jinaDebounce = setTimeout(async () => {
          await window.electronAPI.invoke('delete-jina-key');
          status.textContent = 'Cleared';
          setTimeout(() => { status.textContent = ''; }, 2000);
        }, 500);
        return;
      }
      status.textContent = 'Saving...';
      jinaDebounce = setTimeout(async () => {
        try {
          await window.electronAPI.invoke('save-jina-key', val);
          status.textContent = 'Saved ✓';
          status.className = 'text-success small text-nowrap';
          setTimeout(() => { status.textContent = ''; status.className = 'text-muted small text-nowrap'; }, 2000);
        } catch {
          status.textContent = 'Error';
          status.className = 'text-danger small text-nowrap';
        }
      }, 500);
    });

    // Config save
    document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);

    // Memory
    document.getElementById('memoryRefreshBtn').addEventListener('click', loadMemoryList);
    document.getElementById('memorySelect').addEventListener('change', () => {
      const val = document.getElementById('memorySelect').value;
      document.getElementById('memoryConnectBtn').disabled = !val;
    });
    document.getElementById('memoryConnectBtn').addEventListener('click', connectMemory);
    document.getElementById('memoryDeleteBtn').addEventListener('click', deleteMemory);

    loadMemoryList();

    // Load credentials on first show
    loadCredentials();
  }

  // ── Credentials ────────────────────────────────────────────

  async function loadCredentials() {
    try {
      const creds = await window.electronAPI.invoke('load-credentials');
      if (creds) {
        document.getElementById('accessKeyId').value = creds.accessKeyId || '';
        document.getElementById('secretAccessKey').value = creds.secretAccessKey || '';
        document.getElementById('credRegion').value = creds.region || '';
        document.getElementById('sessionToken').value = creds.sessionToken || '';
      }
    } catch { /* no credentials yet */ }

    // Load Jina key status (masked value returned from main process)
    try {
      const jinaKey = await window.electronAPI.invoke('load-jina-key');
      document.getElementById('jinaApiKey').value = jinaKey || '';
    } catch { /* no key yet */ }
  }

  async function saveCredentials() {
    const btn = document.getElementById('saveCredBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Testing...';

    try {
      const credentials = {
        accessKeyId: document.getElementById('accessKeyId').value.trim(),
        secretAccessKey: document.getElementById('secretAccessKey').value.trim(),
        region: document.getElementById('credRegion').value,
        sessionToken: document.getElementById('sessionToken').value.trim() || null,
        profileName: 'default',
      };

      if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.region) {
        throw new Error('Please fill in all required fields');
      }

      await window.electronAPI.invoke('save-credentials', credentials);
      window.electronAPI.showToast('Credentials saved!', 'success');

      // Test connection inline
      await testConnection();
    } catch (err) {
      window.electronAPI.showToast(`Error: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-check-circle me-1"></i>Save & Test';
    }
  }

  async function testConnection() {
    const card = document.getElementById('connStatusCard');
    const body = document.getElementById('connStatusBody');
    card.style.display = '';
    body.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Testing...';

    try {
      const result = await window.electronAPI.invoke('validate-credentials');
      if (result.valid) {
        const perms = result.permissions;
        body.innerHTML = `
          <div class="mb-2"><span class="badge bg-success">Connected</span> <small class="text-muted">Account: ${result.identity.account}</small></div>
          <div class="small">
            <div><i class="bi bi-${perms.bedrock ? 'check-circle text-success' : 'x-circle text-danger'} me-1"></i>Bedrock</div>
            <div><i class="bi bi-${perms.transcribe ? 'check-circle text-success' : 'x-circle text-danger'} me-1"></i>Transcribe</div>
            <div><i class="bi bi-${perms.s3 ? 'check-circle text-success' : 'x-circle text-danger'} me-1"></i>S3</div>
          </div>`;
      } else {
        body.innerHTML = `<span class="badge bg-danger">Failed</span> <small class="text-muted">${result.errors.join(', ')}</small>`;
      }
    } catch (err) {
      body.innerHTML = `<span class="badge bg-danger">Error</span> <small>${err.message}</small>`;
    }
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      tryParseCredentials(text);
    } catch {
      window.electronAPI.showToast('Could not read clipboard', 'error');
    }
  }

  function tryParseCredentials(text) {
    const patterns = {
      accessKeyId: /(?:AWS_ACCESS_KEY_ID|aws_access_key_id)\s*[=:]\s*(.+)/i,
      secretAccessKey: /(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key)\s*[=:]\s*(.+)/i,
      sessionToken: /(?:AWS_SESSION_TOKEN|aws_session_token)\s*[=:]\s*(.+)/i,
      region: /(?:AWS_(?:DEFAULT_)?REGION|aws_(?:default_)?region)\s*[=:]\s*(.+)/i,
    };

    let found = false;
    for (const [key, regex] of Object.entries(patterns)) {
      const match = text.match(regex);
      if (match) {
        const val = match[1].trim().replace(/^["']|["']$/g, '');
        const elId = key === 'region' ? 'credRegion' : key;
        const el = document.getElementById(elId);
        if (el) { el.value = val; found = true; }
      }
    }
    if (found) window.electronAPI.showToast('Credentials auto-populated!', 'success');
  }

  // ── Configuration ──────────────────────────────────────────

  async function loadConfig() {
    try {
      const settings = await window.electronAPI.invoke('load-settings');
      if (settings) {
        document.getElementById('bucketName').value = settings.bucketName || '';
        document.getElementById('outputBucketName').value = settings.outputBucketName || '';
        document.getElementById('transcriptionLanguage').value = settings.transcriptionLanguage || 'en-US';
        document.getElementById('defaultTheme').value = settings.defaultTheme || 'auto';
        document.getElementById('sagemakerImageEndpoint').value = settings.sagemakerImageEndpoint || '';
        document.getElementById('sagemakerImageComponent').value = settings.sagemakerImageComponent || '';
      }
    } catch { /* defaults */ }

    // Memory status — read toggle state directly from settings (no AWS call needed)
    // (handled by loadMemoryList called from init)
  }

  async function loadMemoryList() {
    const select = document.getElementById('memorySelect');
    const statusText = document.getElementById('memoryStatusText');
    const deleteBtn = document.getElementById('memoryDeleteBtn');
    const connectBtn = document.getElementById('memoryConnectBtn');

    select.innerHTML = '<option value="">Loading…</option>';
    connectBtn.disabled = true;

    try {
      const [memories, settings] = await Promise.all([
        window.electronAPI.invoke('memory-list'),
        window.electronAPI.invoke('load-settings'),
      ]);

      select.innerHTML = '<option value="">— select a memory —</option>' +
        memories.map(m => `<option value="${m.id}"${m.id === settings.memoryId ? ' selected' : ''}>${m.name} (${m.status})</option>`).join('') +
        '<option value="__new__">+ Create new memory</option>';

      const connected = settings.memoryId && settings.memoryEnabled;
      statusText.textContent = connected
        ? `Connected: ${memories.find(m => m.id === settings.memoryId)?.name || settings.memoryId}`
        : '';
      deleteBtn.style.display = settings.memoryId ? 'inline-block' : 'none';
      connectBtn.disabled = !select.value;
    } catch (err) {
      select.innerHTML = '<option value="">— select a memory —</option><option value="__new__">+ Create new memory</option>';
      statusText.textContent = `Error: ${err.message}`;
    }
  }

  async function connectMemory() {
    const select = document.getElementById('memorySelect');
    const statusText = document.getElementById('memoryStatusText');
    const connectBtn = document.getElementById('memoryConnectBtn');
    const deleteBtn = document.getElementById('memoryDeleteBtn');
    const val = select.value;
    if (!val) return;

    connectBtn.disabled = true;
    statusText.textContent = val === '__new__' ? 'Creating memory…' : 'Connecting…';

    try {
      if (val === '__new__') {
        const result = await window.electronAPI.invoke('memory-enable');
        statusText.textContent = `Connected: ${result.id}`;
      } else {
        const result = await window.electronAPI.invoke('memory-connect', val);
        statusText.textContent = `Connected: ${val} (${result.status})`;
      }
      deleteBtn.style.display = 'inline-block';
      window.electronAPI.showToast('Agent Memory connected!', 'success');
      await loadMemoryList();
    } catch (err) {
      statusText.textContent = '';
      window.electronAPI.showToast(`Failed: ${err.message}`, 'error');
    } finally {
      connectBtn.disabled = false;
    }
  }

  async function deleteMemory() {
    if (!confirm('This will permanently delete the memory resource and all stored memories. Continue?')) return;
    const statusText = document.getElementById('memoryStatusText');
    try {
      await window.electronAPI.invoke('memory-delete');
      statusText.textContent = '';
      document.getElementById('memoryDeleteBtn').style.display = 'none';
      window.electronAPI.showToast('Memory deleted', 'info');
      await loadMemoryList();
    } catch (err) {
      window.electronAPI.showToast(`Failed: ${err.message}`, 'error');
    }
  }

  async function saveConfig() {
    const btn = document.getElementById('saveConfigBtn');
    btn.disabled = true;

    try {
      const settings = {
        bucketName: document.getElementById('bucketName').value.trim(),
        outputBucketName: document.getElementById('outputBucketName').value.trim(),
        transcriptionLanguage: document.getElementById('transcriptionLanguage').value,
        defaultTheme: document.getElementById('defaultTheme').value,
        sagemakerImageEndpoint: document.getElementById('sagemakerImageEndpoint').value.trim(),
        sagemakerImageComponent: document.getElementById('sagemakerImageComponent').value.trim(),
      };

      await window.electronAPI.invoke('save-settings', settings);

      // Apply theme immediately
      if (window.themeManager) {
        window.themeManager.applyTheme(settings.defaultTheme);
      }

      window.electronAPI.showToast('Configuration saved!', 'success');
    } catch (err) {
      window.electronAPI.showToast(`Error: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ── Skills ──────────────────────────────────────────────

  let _editingSkill = null;

  async function loadSkills() {
    const list = document.getElementById('skillsList');
    const editor = document.getElementById('skillEditorPanel');
    const newPanel = document.getElementById('newSkillPanel');
    editor.style.display = 'none';
    newPanel.style.display = 'none';

    try {
      const skills = await window.electronAPI.invoke('get-skills');
      if (!skills || skills.length === 0) {
        list.innerHTML = '<div class="text-muted small text-center py-4">No skills installed.</div>';
        return;
      }
      list.innerHTML = skills.map(s => `
        <div class="card mb-2">
          <div class="card-body py-2 px-3 d-flex align-items-center justify-content-between">
            <div class="flex-grow-1 me-3" style="min-width:0;">
              <div class="d-flex align-items-center gap-2">
                <strong class="small">${esc(s.name)}</strong>
                ${s.autoActivate ? '<span class="badge bg-primary bg-opacity-25 text-primary" style="font-size:0.65rem;">always-on</span>' : ''}
                ${s.scope ? `<span class="badge bg-secondary bg-opacity-25 text-muted" style="font-size:0.65rem;">${esc(s.scope)}</span>` : ''}
              </div>
              <div class="text-muted small text-truncate">${esc(s.description)}</div>
            </div>
            <div class="d-flex align-items-center gap-1 flex-shrink-0">
              <button class="btn btn-sm btn-outline-secondary skill-edit-btn" data-skill="${esc(s.name)}" title="Edit"><i class="bi bi-pencil"></i></button>
              <button class="btn btn-sm btn-outline-danger skill-delete-btn" data-skill="${esc(s.name)}" title="Delete"><i class="bi bi-trash"></i></button>
              <div class="form-check form-switch mb-0 ms-2">
                <input class="form-check-input skill-toggle" type="checkbox" data-skill="${esc(s.name)}" ${s.disabled ? '' : 'checked'}>
              </div>
            </div>
          </div>
        </div>`).join('');

      // Wire edit buttons
      list.querySelectorAll('.skill-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => openSkillEditor(btn.dataset.skill));
      });
      // Wire delete buttons
      list.querySelectorAll('.skill-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteSkill(btn.dataset.skill));
      });
      // Wire toggles
      list.querySelectorAll('.skill-toggle').forEach(toggle => {
        toggle.addEventListener('change', () => {
          window.electronAPI.invoke('toggle-skill', { name: toggle.dataset.skill, enabled: toggle.checked });
        });
      });
    } catch (err) {
      list.innerHTML = `<div class="text-danger small">${esc(err.message)}</div>`;
    }
  }

  async function openSkillEditor(name) {
    _editingSkill = name;
    const editor = document.getElementById('skillEditorPanel');
    const list = document.getElementById('skillsList');
    const newPanel = document.getElementById('newSkillPanel');
    newPanel.style.display = 'none';
    document.getElementById('skillEditorTitle').textContent = `Edit: ${name}`;
    document.getElementById('skillEditorContent').value = 'Loading...';
    list.style.display = 'none';
    editor.style.display = '';

    try {
      const content = await window.electronAPI.invoke('get-skill-content', name);
      document.getElementById('skillEditorContent').value = content || '';
    } catch (err) {
      document.getElementById('skillEditorContent').value = `Error: ${err.message}`;
    }
  }

  async function saveSkillEditor() {
    if (!_editingSkill) return;
    try {
      await window.electronAPI.invoke('save-skill-content', {
        name: _editingSkill,
        content: document.getElementById('skillEditorContent').value,
      });
      window.electronAPI.showToast('Skill saved!', 'success');
      closeSkillEditor();
      loadSkills();
    } catch (err) {
      window.electronAPI.showToast(`Error: ${err.message}`, 'error');
    }
  }

  function closeSkillEditor() {
    _editingSkill = null;
    document.getElementById('skillEditorPanel').style.display = 'none';
    document.getElementById('skillsList').style.display = '';
  }

  async function deleteSkill(name) {
    if (!confirm(`Delete skill "${name}"? This cannot be undone.`)) return;
    try {
      await window.electronAPI.invoke('delete-skill', name);
      window.electronAPI.showToast('Skill deleted', 'info');
      loadSkills();
    } catch (err) {
      window.electronAPI.showToast(`Error: ${err.message}`, 'error');
    }
  }

  function openNewSkillPanel() {
    document.getElementById('newSkillPanel').style.display = '';
    document.getElementById('skillsList').style.display = 'none';
    document.getElementById('skillEditorPanel').style.display = 'none';
    document.getElementById('newSkillName').value = '';
    document.getElementById('newSkillContent').value = `---\nname: my-skill\ndescription: "Describe when this skill should be activated."\nmetadata:\n  provider: agentcore-code-interpreter\n  version: "1.0"\n---\n\n# My Skill\n\nInstructions for the agent go here.\n`;
  }

  function closeNewSkillPanel() {
    document.getElementById('newSkillPanel').style.display = 'none';
    document.getElementById('skillsList').style.display = '';
  }

  async function createNewSkill() {
    const name = document.getElementById('newSkillName').value.trim().toLowerCase().replace(/[^a-z0-9\-]/g, '-');
    const content = document.getElementById('newSkillContent').value;
    if (!name) { window.electronAPI.showToast('Skill name is required', 'error'); return; }
    try {
      await window.electronAPI.invoke('create-skill', { name, content });
      window.electronAPI.showToast('Skill created!', 'success');
      closeNewSkillPanel();
      loadSkills();
    } catch (err) {
      window.electronAPI.showToast(`Error: ${err.message}`, 'error');
    }
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

  // Wire skill buttons
  document.getElementById('createSkillBtn').addEventListener('click', openNewSkillPanel);
  document.getElementById('openSkillsFolderBtn').addEventListener('click', () => window.electronAPI.invoke('open-skills-folder'));
  document.getElementById('skillEditorCloseBtn').addEventListener('click', closeSkillEditor);
  document.getElementById('skillEditorCancelBtn').addEventListener('click', closeSkillEditor);
  document.getElementById('skillEditorSaveBtn').addEventListener('click', saveSkillEditor);
  document.getElementById('newSkillCloseBtn').addEventListener('click', closeNewSkillPanel);
  document.getElementById('newSkillCancelBtn').addEventListener('click', closeNewSkillPanel);
  document.getElementById('newSkillSaveBtn').addEventListener('click', createNewSkill);

  // ── About ──────────────────────────────────────────────────

  async function loadAbout() {
    try {
      const version = await window.electronAPI.invoke('get-app-version');
      document.getElementById('appVersionText').textContent = `Version ${version}`;
    } catch {
      document.getElementById('appVersionText').textContent = 'Version unknown';
    }
  }

  // ── Analytics Tab ────────────────────────────────────────

  async function loadAnalytics() {
    const container = document.getElementById('analyticsContent');
    const data = await window.electronAPI.invoke('swarm-get-analytics');

    if (!data.summary) {
      container.innerHTML = `<div class="text-center text-muted py-5">
        <i class="bi bi-bar-chart fs-1 d-block mb-2"></i>
        No pipeline runs yet. Run a swarm pipeline to see analytics here.
      </div>`;
      return;
    }

    const s = data.summary;

    // Summary cards
    let html = `<div class="analytics-cards mb-4">
      <div class="analytics-card">
        <div class="analytics-card-num">${s.totalRuns}</div>
        <div class="analytics-card-label">Total Runs</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-num">${s.passRate}%</div>
        <div class="analytics-card-label">Pass Rate</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-num">${s.avgScore}%</div>
        <div class="analytics-card-label">Avg Score</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-num">${s.errors}</div>
        <div class="analytics-card-label">Errors</div>
      </div>
    </div>`;

    // Per-template breakdown
    for (const [tid, t] of Object.entries(data.templates)) {
      const avg = t.scores.length ? Math.round(t.scores.reduce((a, b) => a + b, 0) / t.scores.length * 100) : 0;
      const barWidth = Math.max(avg, 2);

      html += `<div class="card mb-3">
        <div class="card-header py-2"><strong>${esc(t.name)}</strong>
          <span class="text-muted small ms-2">${t.runs} run${t.runs !== 1 ? 's' : ''} · ${t.completed} completed · ${t.errors} errors</span>
        </div>
        <div class="card-body py-2">
          <div class="d-flex align-items-center gap-2 mb-2">
            <span class="small text-muted" style="width:70px">Avg: ${avg}%</span>
            <div class="analytics-bar-bg"><div class="analytics-bar-fill" style="width:${barWidth}%"></div></div>
          </div>`;

      // Criteria heatmap
      const criteria = Object.entries(t.criteriaStats).sort((a, b) => {
        const aRate = a[1].fail / (a[1].pass + a[1].fail);
        const bRate = b[1].fail / (b[1].pass + b[1].fail);
        return bRate - aRate;
      });

      if (criteria.length) {
        html += `<div class="small text-muted mb-1" style="font-size:0.7rem;letter-spacing:0.05em;font-weight:600">CRITERIA PERFORMANCE</div>`;
        for (const [axis, stats] of criteria) {
          const total = stats.pass + stats.fail;
          const failRate = total ? stats.fail / total : 0;
          const cls = failRate > 0.5 ? 'analytics-heat-red' : failRate > 0.2 ? 'analytics-heat-yellow' : 'analytics-heat-green';
          html += `<div class="analytics-heat-row">
            <span class="analytics-heat-icon ${cls}"><i class="bi ${failRate > 0.5 ? 'bi-x-circle-fill' : failRate > 0 ? 'bi-exclamation-circle-fill' : 'bi-check-circle-fill'}"></i></span>
            <span class="analytics-heat-label">${esc(axis)}</span>
            <span class="analytics-heat-stat ${cls}">${stats.pass}/${total}</span>
          </div>`;
        }
      }

      html += `</div></div>`;
    }

    // Insights
    if (data.insights.length) {
      html += `<div class="card"><div class="card-header py-2"><strong><i class="bi bi-lightbulb me-1"></i>Insights</strong></div>
        <div class="card-body py-2">`;
      for (const insight of data.insights) {
        const icon = insight.severity === 'error' ? 'bi-exclamation-triangle text-danger'
          : insight.severity === 'warn' ? 'bi-exclamation-circle text-warning'
          : 'bi-info-circle text-info';
        html += `<div class="small mb-2"><i class="bi ${icon} me-1"></i>${esc(insight.message)}</div>`;
      }
      html += `</div></div>`;
    }

    container.innerHTML = html;
  }

  // ── Models Tab ──────────────────────────────────────────

  async function loadModels() {
    const settings = await window.electronAPI.invoke('load-settings');
    const models = settings.bedrockModels || [];
    renderModelsTable(models);

    document.getElementById('addModelBtn').onclick = async () => {
      const name = document.getElementById('newModelName').value.trim();
      const profileId = document.getElementById('newModelId').value.trim();
      const role = document.getElementById('newModelRole').value;
      if (!name || !profileId) { window.electronAPI.showToast('Name and Profile ID are required', 'error'); return; }

      // If assigning a role, clear it from any other model
      if (role) models.forEach(m => { if (m.role === role) m.role = ''; });
      models.push({ id: name, inferenceProfileId: profileId, role });
      await saveModels(models);
    };
  }

  function renderModelsTable(models) {
    const tbody = document.getElementById('modelsTableBody');
    tbody.innerHTML = models.map((m, i) => `
      <tr draggable="true" data-index="${i}" style="cursor:default">
        <td style="width:24px;cursor:grab;color:var(--text-muted)" class="drag-handle">⠿</td>
        <td>${esc(m.id)}</td>
        <td><code class="small">${esc(m.inferenceProfileId)}</code></td>
        <td>
          <select class="form-select form-select-sm model-role-select" data-index="${i}">
            <option value=""${m.role ? '' : ' selected'}>None</option>
            <option value="creator"${m.role === 'creator' ? ' selected' : ''}>Creator</option>
            <option value="worker"${m.role === 'worker' ? ' selected' : ''}>Worker</option>
            <option value="formatter"${m.role === 'formatter' ? ' selected' : ''}>Formatter</option>
          </select>
        </td>
        <td><button class="btn btn-sm btn-outline-danger model-delete-btn" data-index="${i}"><i class="bi bi-trash"></i></button></td>
      </tr>`).join('');

    tbody.querySelectorAll('.model-role-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const idx = parseInt(sel.dataset.index);
        const newRole = sel.value;
        if (newRole) models.forEach((m, j) => { if (j !== idx && m.role === newRole) m.role = ''; });
        models[idx].role = newRole;
        await saveModels(models);
      });
    });

    tbody.querySelectorAll('.model-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        models.splice(parseInt(btn.dataset.index), 1);
        await saveModels(models);
      });
    });

    // ── Drag-and-drop reordering ──────────────────────────
    let dragSrcIndex = null;

    tbody.querySelectorAll('tr').forEach(row => {
      row.addEventListener('dragstart', e => {
        dragSrcIndex = parseInt(row.dataset.index);
        e.dataTransfer.effectAllowed = 'move';
        row.style.opacity = '0.4';
      });
      row.addEventListener('dragend', () => { row.style.opacity = ''; });
      row.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
      row.addEventListener('drop', async e => {
        e.preventDefault();
        const dropIndex = parseInt(row.dataset.index);
        if (dragSrcIndex === null || dragSrcIndex === dropIndex) return;
        const [moved] = models.splice(dragSrcIndex, 1);
        models.splice(dropIndex, 0, moved);
        dragSrcIndex = null;
        await saveModels(models);
      });
    });
  }

  async function saveModels(models) {
    await window.electronAPI.invoke('save-settings', { bedrockModels: models });
    renderModelsTable(models);
    document.getElementById('newModelName').value = '';
    document.getElementById('newModelId').value = '';
    document.getElementById('newModelRole').value = '';
    window.electronAPI.showToast('Models updated', 'success');
    // Refresh model dropdowns in Work and Chat tabs
    if (typeof loadBedrockModels === 'function') await loadBedrockModels();
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

  if (typeof window !== 'undefined') {
    window.SettingsTab = { init };
  }
})();
