/**
 * @jest-environment jsdom
 */

/**
 * Tests for the stopped-run notice and in-place prompt editing.
 *
 * Both are shared by the Work and Chat tabs, so they are tested here against
 * bare DOM rather than through either tab. The behaviours worth pinning:
 *
 *  - Cancel must restore the message *exactly*, since backing out of an edit
 *    should be a no-op rather than a subtle rewrite.
 *  - The editor is seeded from raw text, so it must not be possible for that
 *    text to be interpreted as markup.
 */

const CR = require('../../src/renderer/chatRenderer.js');

describe('appendInterruptedNotice()', () => {
  let container;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => { document.body.innerHTML = ''; });

  test('offers both next steps', () => {
    CR.appendInterruptedNotice(container, { onEdit: jest.fn(), onRetry: jest.fn() });

    const notice = container.querySelector('.chat-interrupted');
    expect(notice).not.toBeNull();
    expect(notice.textContent).toMatch(/stopped/i);
    expect(notice.querySelector('[data-action="edit"]').textContent).toBe('Edit prompt');
    expect(notice.querySelector('[data-action="retry"]').textContent).toBe('Try again');
  });

  test('is not styled as an error', () => {
    // Stopping is a user's choice, not a fault. appendChatError paints its bubble
    // with --error; this must not.
    CR.appendInterruptedNotice(container, {});

    const notice = container.querySelector('.chat-interrupted');
    expect(notice.outerHTML).not.toMatch(/--error/);
    expect(notice.querySelector('.bi-exclamation-triangle')).toBeNull();
  });

  test('the buttons call their handlers', () => {
    const onEdit = jest.fn();
    const onRetry = jest.fn();
    CR.appendInterruptedNotice(container, { onEdit, onRetry });

    container.querySelector('[data-action="edit"]').click();
    expect(onEdit).toHaveBeenCalledTimes(1);

    container.querySelector('[data-action="retry"]').click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('missing handlers do not throw', () => {
    CR.appendInterruptedNotice(container, {});
    expect(() => container.querySelector('[data-action="edit"]').click()).not.toThrow();
    expect(() => container.querySelector('[data-action="retry"]').click()).not.toThrow();
  });

  test('returns the notice so the caller can remove it', () => {
    const notice = CR.appendInterruptedNotice(container, {});
    expect(notice).toBe(container.querySelector('.chat-interrupted'));
  });
});

describe('beginEditUserMessage()', () => {
  let container;

  /** A rendered user message, as appendChatMessage would leave it. */
  function userMessage(text) {
    const el = CR.appendChatMessage(container, { role: 'user', content: text });
    return el;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => { document.body.innerHTML = ''; });

  test('replaces the bubble with an editor seeded from the raw text', () => {
    const el = userMessage('original prompt');

    CR.beginEditUserMessage(el, { text: 'original prompt' });

    const input = el.querySelector('.chat-edit-input');
    expect(input).not.toBeNull();
    expect(input.value).toBe('original prompt');
    expect(el.classList.contains('editing')).toBe(true);
    expect(el.querySelector('[data-action="save"]')).not.toBeNull();
    expect(el.querySelector('[data-action="cancel"]')).not.toBeNull();
  });

  test('Save reports the edited text and leaves edit mode', () => {
    const el = userMessage('original prompt');
    const onSave = jest.fn();
    CR.beginEditUserMessage(el, { text: 'original prompt', onSave });

    el.querySelector('.chat-edit-input').value = '  amended prompt  ';
    el.querySelector('[data-action="save"]').click();

    expect(onSave).toHaveBeenCalledWith('amended prompt');
    expect(el.classList.contains('editing')).toBe(false);
  });

  test('Cancel restores the original markup byte for byte', () => {
    // Re-rendering from text instead of restoring would drop whatever
    // formatText() produced — links, code, escaping — and quietly change the
    // message the user chose to keep.
    const el = userMessage('keep **this** exactly');
    const before = el.querySelector('.chat-bubble').innerHTML;
    const onCancel = jest.fn();

    CR.beginEditUserMessage(el, { text: 'keep **this** exactly', onCancel });
    el.querySelector('.chat-edit-input').value = 'discard me';
    el.querySelector('[data-action="cancel"]').click();

    expect(el.querySelector('.chat-bubble').innerHTML).toBe(before);
    expect(el.classList.contains('editing')).toBe(false);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('Escape cancels, Enter saves, Shift+Enter does not', () => {
    const el = userMessage('prompt');
    const onSave = jest.fn();
    const onCancel = jest.fn();
    CR.beginEditUserMessage(el, { text: 'prompt', onSave, onCancel });
    const input = el.querySelector('.chat-edit-input');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(onSave).not.toHaveBeenCalled();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSave).toHaveBeenCalledWith('prompt');

    const el2 = userMessage('second');
    CR.beginEditUserMessage(el2, { text: 'second', onCancel });
    el2.querySelector('.chat-edit-input')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('saving an empty prompt is a no-op rather than a discarded turn', () => {
    const el = userMessage('original');
    const onSave = jest.fn();
    CR.beginEditUserMessage(el, { text: 'original', onSave });

    el.querySelector('.chat-edit-input').value = '   ';
    el.querySelector('[data-action="save"]').click();

    expect(onSave).not.toHaveBeenCalled();
    // Still editing, with the text still there to fix.
    expect(el.classList.contains('editing')).toBe(true);
    expect(el.querySelector('.chat-edit-input')).not.toBeNull();
  });

  test('prompt text reaches the editor as text, not markup', () => {
    const hostile = '<img src=x onerror="window.__pwned=1">';
    const el = userMessage('placeholder');

    CR.beginEditUserMessage(el, { text: hostile });

    const input = el.querySelector('.chat-edit-input');
    expect(input.value).toBe(hostile);
    expect(input.querySelector('img')).toBeNull();
    expect(window.__pwned).toBeUndefined();
  });

  test('a prompt containing a closing textarea tag survives verbatim', () => {
    // Not a security test, despite appearances: a textarea's content is RCDATA,
    // and in fragment-parsing context even </textarea> does not end the span, so
    // assigning innerHTML here would behave the same. Verified empirically in
    // jsdom rather than assumed. What this does pin is that a prompt full of
    // angle brackets comes back byte-identical for editing instead of being
    // escaped, unescaped, or truncated on the way in.
    const breakout = '</textarea><img src=x onerror="window.__brokeOut=1">';
    const el = userMessage('placeholder');

    CR.beginEditUserMessage(el, { text: breakout });

    const input = el.querySelector('.chat-edit-input');
    expect(input.value).toBe(breakout);
    expect(el.querySelector('img')).toBeNull();
    expect(window.__brokeOut).toBeUndefined();
  });

  test('editing twice is ignored rather than nesting editors', () => {
    const el = userMessage('prompt');
    CR.beginEditUserMessage(el, { text: 'prompt' });
    CR.beginEditUserMessage(el, { text: 'prompt' });

    expect(el.querySelectorAll('.chat-edit-input')).toHaveLength(1);
  });

  test('does nothing on an element with no bubble', () => {
    const orphan = document.createElement('div');
    expect(() => CR.beginEditUserMessage(orphan, { text: 'x' })).not.toThrow();
  });
});
