/**
 * @jest-environment jsdom
 */

/**
 * Tests for the Chat tab's rewind-on-stop.
 *
 * The Work tab equivalent lives in workTab.test.js; this covers index.js's
 * rewindChatTo(), which is deliberately shaped the same way. It takes the
 * conversation as an argument rather than reading the module's currentConversation
 * so the truncation — the part that must be exact, since the next request's
 * history is derived from conversation.messages — can be driven directly.
 */

global.ModalManager = jest.fn().mockImplementation(() => ({
    show: jest.fn(), hide: jest.fn(), showError: jest.fn(),
}));

const mockElectronAPI = {
    showToast: jest.fn(), invoke: jest.fn(), receive: jest.fn(), invokeAsync: jest.fn(),
    removeAllListeners: jest.fn(),
};
Object.defineProperty(window, 'electronAPI', { value: mockElectronAPI, writable: true });
Object.defineProperty(window, 'marked', { value: { parse: (md) => md }, writable: true });
Object.defineProperty(navigator, 'clipboard', { value: { writeText: jest.fn() }, writable: true });
global.fetch = jest.fn();
global.URL.createObjectURL = jest.fn(() => 'mock-url');
global.URL.revokeObjectURL = jest.fn();

// chatRenderer must load first, exactly as index.html orders the script tags —
// index.js reaches the shared helpers through window.ChatRenderer.
require('../../src/renderer/chatRenderer.js');

/**
 * The app's real page markup, minus its script tags.
 *
 * index.js binds listeners to a large number of elements at load time, so it
 * needs a faithful DOM. Taken from src/pages/index.html rather than hand-written
 * here: a hand-rolled fixture drifts, and an id renamed in the page would keep
 * these tests passing while the feature was broken in the app.
 */
function realPageBody() {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'pages', 'index.html'),
        'utf8',
    );
    const start = html.indexOf('<body');
    const end = html.lastIndexOf('</body>');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return html
        .slice(html.indexOf('>', start) + 1, end)
        .replace(/<script[\s\S]*?<\/script>/g, '');
}

beforeAll(() => {
    document.body.innerHTML = realPageBody();
    require('../../src/renderer/index.js');
});

describe('rewindChatTo()', () => {
    /** A conversation whose last turn was stopped mid-reply. */
    function buildStopped() {
        const history = document.getElementById('chatHistory');
        history.innerHTML = '';

        const messages = [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'first reply' },
            { role: 'user', content: 'second' },          // index 2 — stopped turn
            { role: 'assistant', content: 'partial...' },  // pushed by stream-complete
        ];

        const nodes = messages.map((m) => {
            const el = document.createElement('div');
            el.className = `chat-message ${m.role}`;
            el.innerHTML = '<div class="chat-bubble"></div>';
            history.appendChild(el);
            return el;
        });
        const notice = document.createElement('div');
        notice.className = 'chat-interrupted';
        history.appendChild(notice);

        const conversation = { id: 'c1', messages };
        const turn = { el: nodes[2], index: 2, text: 'second', files: [] };
        return { conversation, turn, nodes, notice, history };
    }

    test('truncates history to just before the stopped turn', () => {
        const { conversation, turn } = buildStopped();

        window.rewindChatTo(conversation, turn);

        expect(conversation.messages.map(m => m.content)).toEqual(['first', 'first reply']);
    });

    test('discards the partial reply along with the prompt', () => {
        const { conversation, turn } = buildStopped();

        window.rewindChatTo(conversation, turn);

        const contents = conversation.messages.map(m => m.content);
        expect(contents).not.toContain('second');
        expect(contents).not.toContain('partial...');
    });

    test('removes the stopped turn, the partial reply and the notice from the DOM', () => {
        const { conversation, turn, nodes, notice, history } = buildStopped();

        window.rewindChatTo(conversation, turn);

        expect(history.contains(nodes[0])).toBe(true);
        expect(history.contains(nodes[1])).toBe(true);
        expect(history.contains(nodes[2])).toBe(false);
        expect(history.contains(nodes[3])).toBe(false);
        expect(history.contains(notice)).toBe(false);
        expect(history.querySelectorAll('.chat-message')).toHaveLength(2);
    });

    test('rewinding the only turn empties the conversation', () => {
        const history = document.getElementById('chatHistory');
        history.innerHTML = '';
        const el = document.createElement('div');
        history.appendChild(el);

        const conversation = { id: 'c2', messages: [{ role: 'user', content: 'only' }] };
        window.rewindChatTo(conversation, { el, index: 0, text: 'only', files: [] });

        expect(conversation.messages).toEqual([]);
        expect(history.children).toHaveLength(0);
    });

    test('keeps earlier turns intact', () => {
        // Over-truncating would erase conversation the user never asked to lose.
        const { conversation, turn } = buildStopped();

        window.rewindChatTo(conversation, turn);

        expect(conversation.messages).toHaveLength(2);
        expect(conversation.messages[0]).toEqual({ role: 'user', content: 'first' });
    });
});

describe('the Chat tab reuses the shared notice and editor', () => {
    test('showChatInterrupted is wired to the shared renderer helpers', () => {
        // Rather than a third copy of the markup: the two tabs must look
        // identical, and index.js keeps its own appendChatMessage/appendThinking,
        // so it would have been easy to duplicate these too.
        expect(typeof window.ChatRenderer.appendInterruptedNotice).toBe('function');
        expect(typeof window.ChatRenderer.beginEditUserMessage).toBe('function');
        expect(typeof window.showChatInterrupted).toBe('function');
    });
});

describe('resending carries the stopped turn\'s attachments', () => {
    /**
     * The one place Chat genuinely differs from Work: Chat calls
     * clearSelectedFilesAndTranscript() after every send, so by the time the user
     * clicks Edit prompt the selection is already empty. Without the override the
     * resend would silently go without the documents the question was about, and
     * the model would answer about nothing.
     */
    beforeEach(() => {
        mockElectronAPI.invoke.mockReset();
        mockElectronAPI.invoke.mockImplementation((channel, payload) => {
            switch (channel) {
                case 'quick-validate-credentials': return Promise.resolve({ valid: true });
                case 'create-conversation': return Promise.resolve({ id: 'c-new', messages: [] });
                case 'send-to-bedrock': return Promise.resolve({ text: 'answer', aborted: false });
                case 'save-conversation': return Promise.resolve(payload);
                // renderConversationList() iterates this, so it must be an array
                // rather than the generic empty object below.
                case 'list-conversations': return Promise.resolve([]);
                default: return Promise.resolve({});
            }
        });
        document.getElementById('chatHistory').innerHTML = '';
    });

    test('files passed as an override reach the model call', async () => {
        const files = [{ name: 'report.pdf' }];

        await window.sendMessage({ promptOverride: 'summarise it', filesOverride: files });

        const call = mockElectronAPI.invoke.mock.calls.find(c => c[0] === 'send-to-bedrock');
        expect(call).toBeDefined();
        expect(call[1].files).toEqual(files);
        expect(call[1].prompt).toBe('summarise it');
    });

    test('the attachment chips are rendered on the resent bubble', async () => {
        // Not just sent to the model — shown, so the resent turn does not look
        // like it was asked without context. Self-contained rather than relying
        // on the previous test's DOM, which beforeEach clears.
        await window.sendMessage({ promptOverride: 'summarise it', filesOverride: [{ name: 'report.pdf' }] });

        const bubble = document.querySelector('#chatHistory .chat-message.user');
        expect(bubble).not.toBeNull();
        expect(bubble.textContent).toContain('report.pdf');
    });

    test('an override leaves the composer untouched', async () => {
        // The composer may hold a draft of the user's next message; a resend must
        // not clear it, unlike a normal send.
        const editor = document.getElementById('promptEditor');
        editor.value = 'a draft I am still writing';

        await window.sendMessage({ promptOverride: 'resent prompt', filesOverride: [] });

        expect(editor.value).toBe('a draft I am still writing');
    });

    test('a normal send still clears the composer', async () => {
        const editor = document.getElementById('promptEditor');
        editor.value = 'typed normally';

        await window.sendMessage();

        expect(editor.value).toBe('');
    });
});
