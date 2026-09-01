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


/**
 * The "your run was stopped" notice, with the two things worth offering next.
 *
 * Deliberately not styled as an error (compare appendChatError above, which is
 * filled with --error): cancelling is something the user chose to do, not a
 * fault, and dressing it in red reads as "something went wrong" when nothing did.
 *
 * "Stopped" rather than "interrupted", and "resend" rather than any wording
 * implying an undo — a Work session's sandbox keeps whatever the stopped run
 * already created, so re-running is a fresh attempt against existing state, not
 * a rewind. Claiming otherwise would be a lie the UI can't back up.
 *
 * @param {HTMLElement} container
 * @param {object}   handlers
 * @param {Function} handlers.onEdit  - "Edit prompt" clicked
 * @param {Function} handlers.onRetry - "Try again" clicked
 * @returns {HTMLElement} the notice, so the caller can remove it on resend
 */
function appendInterruptedNotice(container, { onEdit, onRetry } = {}) {
  const el = document.createElement('div');
  el.className = 'chat-interrupted';
  el.innerHTML = `
    <span class="chat-interrupted-text">
      <i class="bi bi-info-circle"></i>
      <span>Response stopped.</span>
    </span>
    <span class="chat-interrupted-actions">
      <button type="button" class="chat-interrupted-btn" data-action="edit">Edit prompt</button>
      <button type="button" class="chat-interrupted-btn" data-action="retry">Try again</button>
    </span>`;

  el.querySelector('[data-action="edit"]').addEventListener('click', () => { if (onEdit) onEdit(); });
  el.querySelector('[data-action="retry"]').addEventListener('click', () => { if (onRetry) onRetry(); });

  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

/**
 * Turn an already-rendered user bubble into an editor, in place.
 *
 * In place rather than repopulating the composer at the bottom: the message
 * stays where it is in the conversation, so it is unambiguous which turn is
 * being changed, and the stopped output below remains visible to amend away
 * from.
 *
 * The original markup is captured and restored verbatim on cancel, so backing
 * out cannot subtly alter the message — re-rendering it from text would drop
 * whatever formatText() had produced.
 *
 * @param {HTMLElement} messageEl - the .chat-message.user element to edit
 * @param {object}   handlers
 * @param {string}   handlers.text     - raw text to edit (not the rendered HTML)
 * @param {Function} handlers.onSave   - called with the edited text
 * @param {Function} handlers.onCancel - called when editing is abandoned
 */
function beginEditUserMessage(messageEl, { text, onSave, onCancel } = {}) {
  const bubble = messageEl.querySelector('.chat-bubble');
  if (!bubble || messageEl.classList.contains('editing')) return;

  const originalHtml = bubble.innerHTML;
  messageEl.classList.add('editing');

  bubble.innerHTML = `
    <textarea class="chat-edit-input" rows="1"></textarea>
    <div class="chat-edit-actions">
      <button type="button" class="chat-edit-btn" data-action="cancel">Cancel</button>
      <button type="button" class="chat-edit-btn primary" data-action="save">Save</button>
    </div>`;

  const input = bubble.querySelector('.chat-edit-input');
  // Assigned, not interpolated into the template above. A textarea's content is
  // RCDATA, so innerHTML would *probably* also be safe here — tags arrive as
  // literal text, and in fragment-parsing context even a closing </textarea>
  // does not end the span (verified in jsdom, and it follows from the spec's
  // "appropriate end tag" rule). But that is a subtle argument to have to make
  // about handling user input, and .value has no parsing step to reason about
  // at all. Prefer the version that needs no argument.
  input.value = text || '';

  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 320) + 'px';
  };
  autoGrow();
  input.addEventListener('input', autoGrow);

  const restore = () => {
    messageEl.classList.remove('editing');
    bubble.innerHTML = originalHtml;
  };

  const save = () => {
    const edited = input.value.trim();
    // An empty prompt would be rejected by the send path anyway; treating it as
    // a no-op keeps the user in the editor with their text rather than silently
    // discarding the turn.
    if (!edited) { input.focus(); return; }
    restore();
    if (onSave) onSave(edited);
  };

  bubble.querySelector('[data-action="save"]').addEventListener('click', save);
  bubble.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    restore();
    if (onCancel) onCancel();
  });

  input.addEventListener('keydown', (e) => {
    // Enter sends, Shift+Enter newlines — same contract as the composer, so the
    // muscle memory carries over. Escape backs out.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); restore(); if (onCancel) onCancel(); }
  });

  input.focus();
  // Caret at the end: the common edit is appending a clarification, and
  // select-all would put one keystroke between the user and losing the prompt.
  input.setSelectionRange(input.value.length, input.value.length);
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
    appendInterruptedNotice, beginEditUserMessage,
    createActivityLog, addActivityEntry, completeActivityEntry, finishActivityLog,
    updateThinkingEntry, removeActivityNarrationLine,
  };
}
if (typeof window !== 'undefined') {
  window.ChatRenderer = {
    formatText, cleanupAnalysisText, appendChatMessage, appendThinking,
    appendChatError, appendStatusMessage, showPlaceholder, renderChatHistory,
    appendInterruptedNotice, beginEditUserMessage,
    createActivityLog, addActivityEntry, completeActivityEntry, finishActivityLog,
    updateThinkingEntry, removeActivityNarrationLine,
  };
}
