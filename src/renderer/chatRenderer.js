/**
 * Shared chat rendering utilities.
 * All functions take a container element as parameter — no hardcoded IDs.
 */

function formatText(text) {
  if (typeof window !== 'undefined' && window.marked) {
    return window.marked.parse(text);
  }
  // Fallback for tests or non-browser
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\n/g, '<br>');
  return text;
}

function cleanupAnalysisText(text) {
  let cleaned = text.replace('/\\n/g', '\n');
  cleaned = cleaned.replace(/<br>/g, '\n');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.replace(/(\d+\.) (?=\*\*)/g, '$1\n');
  cleaned = cleaned.replace(/(\n\s*)-\s+/g, '\n   - ');
  return cleaned;
}

function appendChatMessage(container, msg, { onCopy } = {}) {
  const el = document.createElement('div');
  el.className = `chat-message ${msg.role}`;
  const time = msg.timestamp
    ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  const copyBtn = msg.role === 'assistant'
    ? '<button class="chat-copy-btn" title="Copy response"><i class="bi bi-clipboard"></i></button>'
    : '';

  el.innerHTML = `
    <div class="chat-bubble">
      <div class="chat-bubble-content">${formatText(msg.content)}</div>${copyBtn}
    </div>
    <div class="chat-message-time">${time}</div>`;

  if (msg.role === 'assistant') {
    el.querySelector('.chat-copy-btn').addEventListener('click', () => {
      if (onCopy) onCopy(msg.content);
    });
  }

  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

function appendThinking(container) {
  const el = document.createElement('div');
  el.className = 'chat-thinking';
  el.innerHTML = '<span></span><span></span><span></span>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

function appendChatError(container, message) {
  const el = document.createElement('div');
  el.className = 'chat-message assistant';
  el.innerHTML = `<div class="chat-bubble" style="background:var(--error);color:#fff;">
    <i class="bi bi-exclamation-triangle me-1"></i>${message}</div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

// ── Activity Log (timeline) ──────────────────────────────────

/** Escapes a string for safe use inside an HTML attribute value. */
function escapeHtmlAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const TOOL_META = {
  'activate_skill':    { icon: '🎯', label: 'Loaded skill' },
  'execute_code':      { icon: '⟩_', label: 'Running code' },
  'save_file_locally': { icon: '💾', label: 'Saving file' },
  'read_local_file':   { icon: '📄', label: 'Reading file' },
  'generate_image':    { icon: '🎨', label: 'Generating image' },
  'web':               { icon: '🌐', label: 'Web' },
  'list_directory':    { icon: '📂', label: 'Listing files' },
  'memory':            { icon: '🧠', label: 'Memory' },
  'sandbox':           { icon: '📦', label: 'Sandbox' },
  'cleanup':           { icon: '🧹', label: 'Cleanup' },
  'thinking':          { icon: '💭', label: 'Thinking' },
  // Generic agent-loop startup — distinct from 'sandbox', which should only
  // ever appear when a real AgentCore Code Interpreter session actually
  // starts (execute_code's own onStatus call in swarmTools.js). Previously
  // agentToolExecutor.js tagged its very first, purely cosmetic "no dead
  // air" status as tool:'sandbox', making it look like a real (billable)
  // sandbox session spins up on every single message even when the model
  // never calls execute_code.
  'agent':             { icon: '🤖', label: 'Agent' },
};

function createActivityLog(container) {
  const wrapper = document.createElement('div');
  wrapper.className = 'activity-log';
  wrapper.innerHTML = `
    <div class="activity-header">
      <span class="activity-header-text">Working...</span>
      <span class="activity-counter"></span>
      <button class="activity-toggle" title="Toggle details"><i class="bi bi-chevron-down"></i></button>
    </div>
    <div class="activity-timeline"></div>`;

  wrapper.querySelector('.activity-toggle').addEventListener('click', () => {
    wrapper.classList.toggle('collapsed');
    const icon = wrapper.querySelector('.activity-toggle i');
    icon.className = wrapper.classList.contains('collapsed') ? 'bi bi-chevron-right' : 'bi bi-chevron-down';
  });

  // Starts expanded (no 'collapsed' class) — auto-expanded while the agent
  // is actively running is the whole point of this log; finishActivityLog()
  // collapses it once the run completes.
  container.appendChild(wrapper);
  container.scrollTop = container.scrollHeight;
  return wrapper;
}

/**
 * Updates the activity log's header counter/label to reflect a "Thought · N
 * steps" summary while the run is in progress (Quick Desktop reference
 * pattern) — distinct from the plain numeric counter used once no
 * narration has occurred yet, and from finishActivityLog()'s "Completed"
 * label once the run ends.
 */
function updateActivityStepSummary(logEl, stepCount) {
  if (!logEl || !stepCount) return;
  const counterEl = logEl.querySelector('.activity-counter');
  if (counterEl) counterEl.textContent = `Thought · ${stepCount} step${stepCount === 1 ? '' : 's'}`;
}

/**
 * Renders (or updates, if already present) the "💡 Thinking" entry as an
 * expandable box at the top of the timeline, accumulating each new
 * narration/reasoning summary as its own line inside the box — rather than
 * a single line that gets overwritten — and mirrors the single most recent
 * line as a standalone, always-visible line directly below the whole
 * activity log (so the gist is visible without expanding anything).
 */
function updateThinkingEntry(logEl, text) {
  if (!logEl || !text) return null;
  const timeline = logEl.querySelector('.activity-timeline');
  let entry = timeline.querySelector('.activity-entry.thinking-entry');

  if (!entry) {
    entry = document.createElement('div');
    entry.className = 'activity-entry thinking-entry done';
    entry.dataset.tool = 'thinking';
    entry.innerHTML = `
      <span class="activity-dot"></span>
      <span class="activity-icon">💭</span>
      <span class="activity-label">Thinking</span>
      <div class="thinking-history"></div>`;
    timeline.insertBefore(entry, timeline.firstChild);
  }

  const historyEl = entry.querySelector('.thinking-history');
  const line = document.createElement('div');
  line.className = 'thinking-history-entry';
  line.textContent = text;
  historyEl.appendChild(line);

  const stepCount = historyEl.querySelectorAll('.thinking-history-entry').length;
  updateActivityStepSummary(logEl, stepCount);

  // Standalone "most recent line" beneath the whole log, mirroring the
  // reference's plain narration line under the Thinking box.
  const container = logEl.closest('.chat-history-inner') || logEl.parentElement;
  let narrationLine = logEl.nextElementSibling;
  if (!narrationLine || !narrationLine.classList?.contains('activity-narration-line')) {
    narrationLine = document.createElement('div');
    narrationLine.className = 'activity-narration-line';
    logEl.insertAdjacentElement('afterend', narrationLine);
  }
  narrationLine.textContent = text;

  const scrollContainer = logEl.closest('.chat-history');
  if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;

  return entry;
}

/** Removes the standalone narration line shown below the activity log, if present. */
function removeActivityNarrationLine(logEl) {
  if (!logEl) return;
  const narrationLine = logEl.nextElementSibling;
  if (narrationLine && narrationLine.classList?.contains('activity-narration-line')) {
    narrationLine.remove();
  }
}

function addActivityEntry(logEl, { tool, detail, state = 'running', append = false }) {
  const timeline = logEl.querySelector('.activity-timeline');
  const meta = TOOL_META[tool] || { icon: '⚙️', label: tool };

  // append=true (used for live-streamed reasoning/thinking deltas) updates
  // the most recent still-running entry for this tool in place instead of
  // creating a new entry per delta, which would otherwise flood the timeline
  // with one row per token.
  if (append) {
    const existing = timeline.querySelector(`.activity-entry.running[data-tool="${tool}"]`);
    if (existing) {
      const detailEl = existing.querySelector('.activity-detail');
      if (detailEl) {
        const fullText = (detailEl.title || detailEl.textContent || '') + (detail || '');
        detailEl.textContent = fullText;
        detailEl.title = fullText;
      } else if (detail) {
        existing.insertAdjacentHTML('beforeend', `<span class="activity-detail" title="${escapeHtmlAttr(detail)}">${detail}</span>`);
      }
      const container = logEl.closest('.chat-history');
      if (container) container.scrollTop = container.scrollHeight;
      return existing;
    }
  }

  // title attribute shows the full, untruncated text on hover — the visible
  // text is clipped with an ellipsis (.activity-detail's CSS), which made
  // genuinely distinct entries (e.g. two different search queries sharing a
  // long common prefix) look like exact duplicates with no way to tell them
  // apart.
  const detailText = detail ? `<span class="activity-detail" title="${escapeHtmlAttr(detail)}">${detail}</span>` : '';

  const entry = document.createElement('div');
  entry.className = `activity-entry ${state}`;
  entry.dataset.tool = tool;
  entry.innerHTML = `
    <span class="activity-dot"></span>
    <span class="activity-icon">${meta.icon}</span>
    <span class="activity-label">${meta.label}</span>
    ${detailText}`;

  timeline.appendChild(entry);

  // Update counter — if a Thinking box already exists, keep its
  // "Thought · N steps" wording (recalculated fresh, since this call may
  // have added a non-thinking entry after it) rather than clobbering it
  // with a plain total-entry count.
  const thinkingHistory = timeline.querySelector('.thinking-entry .thinking-history');
  if (thinkingHistory) {
    updateActivityStepSummary(logEl, thinkingHistory.querySelectorAll('.thinking-history-entry').length);
  } else {
    const count = timeline.querySelectorAll('.activity-entry').length;
    logEl.querySelector('.activity-counter').textContent = count;
  }

  // Auto-scroll
  const container = logEl.closest('.chat-history');
  if (container) container.scrollTop = container.scrollHeight;

  return entry;
}

function completeActivityEntry(entry) {
  if (entry) {
    entry.classList.remove('running');
    entry.classList.add('done');
  }
}

function finishActivityLog(logEl) {
  if (!logEl) return;
  logEl.querySelector('.activity-header-text').textContent = 'Completed';
  logEl.classList.add('finished', 'collapsed');
  const icon = logEl.querySelector('.activity-toggle i');
  icon.className = 'bi bi-chevron-right';
  // Mark any remaining running entries as done
  logEl.querySelectorAll('.activity-entry.running').forEach(e => {
    e.classList.remove('running');
    e.classList.add('done');
  });
}

// ── Legacy compat ────────────────────────────────────────────

function appendStatusMessage(container, message) {
  const el = document.createElement('div');
  el.className = 'chat-status-message';
  el.innerHTML = `<i class="bi bi-gear-wide-connected me-1"></i>${message}`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

function showPlaceholder(container, text) {
  container.innerHTML = `<div class="chat-placeholder">
    <i class="bi bi-chat-dots fs-1 mb-3 d-block"></i>${text}</div>`;
}

function renderChatHistory(container, messages, opts) {
  container.innerHTML = '';
  if (!messages || messages.length === 0) {
    showPlaceholder(container, 'No messages yet');
    return;
  }
  messages.forEach(msg => appendChatMessage(container, msg, opts));
  container.scrollTop = container.scrollHeight;
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    formatText, cleanupAnalysisText, appendChatMessage, appendThinking,
    appendChatError, appendStatusMessage, showPlaceholder, renderChatHistory,
    createActivityLog, addActivityEntry, completeActivityEntry, finishActivityLog,
    updateThinkingEntry, removeActivityNarrationLine,
  };
}
if (typeof window !== 'undefined') {
  window.ChatRenderer = {
    formatText, cleanupAnalysisText, appendChatMessage, appendThinking,
    appendChatError, appendStatusMessage, showPlaceholder, renderChatHistory,
    createActivityLog, addActivityEntry, completeActivityEntry, finishActivityLog,
    updateThinkingEntry, removeActivityNarrationLine,
  };
}
