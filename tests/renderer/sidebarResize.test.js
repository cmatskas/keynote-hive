/**
 * @jest-environment jsdom
 */

/**
 * Tests for sidebarResize.js.
 *
 * All three list sidebars were fixed-width, which forced rows to truncate names
 * and cram metadata onto one line. Trimming what a row shows helps; letting the
 * user decide how much room the list gets removes the constraint outright.
 *
 * jsdom reports every element as 0×0, so `getBoundingClientRect` is stubbed to
 * report whatever width has been applied — the behaviour under test is the
 * arithmetic and the clamping, not layout.
 */

const store = new Map();
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  },
  writable: true,
});

require('../../src/renderer/sidebarResize.js');
const { DEFAULT_MIN, DEFAULT_MAX } = window.SidebarResize;

let sidebar;

/** Reports the inline width back, since jsdom does no layout. */
function stubMeasurement(el, fallback) {
  el.getBoundingClientRect = () => ({
    width: parseInt(el.style.width, 10) || fallback,
    height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {},
  });
}

function build({ storageKey = 'hive.sidebarWidth.test', defaultWidth = 260, ...rest } = {}) {
  sidebar = document.createElement('div');
  sidebar.id = 'testSidebar';
  document.body.appendChild(sidebar);
  stubMeasurement(sidebar, defaultWidth);

  const enabled = window.SidebarResize.enable({ el: sidebar, storageKey, defaultWidth, ...rest });
  return { enabled, handle: sidebar.querySelector('.sidebar-resize-handle') };
}

const drag = (handle, dx, from = 300) => {
  handle.dispatchEvent(new MouseEvent('mousedown', { clientX: from, bubbles: true }));
  document.dispatchEvent(new MouseEvent('mousemove', { clientX: from + dx, bubbles: true }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
};

const widthOf = () => parseInt(sidebar.style.width, 10);

beforeEach(() => {
  store.clear();
  document.body.innerHTML = '';
  document.body.className = '';
});

describe('enabling', () => {
  test('adds a handle and reports success', () => {
    const { enabled, handle } = build();
    expect(enabled).toBe(true);
    expect(handle).not.toBeNull();
  });

  test('does not enable the same sidebar twice', () => {
    build();
    const second = window.SidebarResize.enable({ el: sidebar, storageKey: 'k' });
    expect(second).toBe(false);
    expect(sidebar.querySelectorAll('.sidebar-resize-handle')).toHaveLength(1);
  });

  test('ignores a missing element rather than throwing', () => {
    expect(window.SidebarResize.enable({ el: null, storageKey: 'k' })).toBe(false);
  });

  test('the handle is reachable and described without a mouse', () => {
    // A drag-only control would exclude keyboard users entirely.
    const { handle } = build();
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-label')).toBe('Resize sidebar');
    expect(handle.tabIndex).toBe(0);
  });
});

describe('dragging', () => {
  test('widens the sidebar as the cursor moves right', () => {
    const { handle } = build({ defaultWidth: 260 });
    drag(handle, 100);
    expect(widthOf()).toBe(360);
  });

  test('narrows it as the cursor moves left', () => {
    const { handle } = build({ defaultWidth: 300 });
    drag(handle, -80);
    expect(widthOf()).toBe(220);
  });

  test('pins width, min-width and flex-basis together', () => {
    // The stylesheet ties width to min-width to stop flex shrinking the sidebar,
    // so overriding only one would leave the other fighting it.
    const { handle } = build({ defaultWidth: 260 });
    drag(handle, 40);
    expect(sidebar.style.width).toBe('300px');
    expect(sidebar.style.minWidth).toBe('300px');
    expect(sidebar.style.flexBasis).toBe('300px');
  });

  test('clamps at the minimum however far left you drag', () => {
    const { handle } = build({ defaultWidth: 260 });
    drag(handle, -5000);
    expect(widthOf()).toBe(DEFAULT_MIN);
  });

  test('clamps at the maximum however far right you drag', () => {
    const { handle } = build({ defaultWidth: 260 });
    drag(handle, 5000);
    expect(widthOf()).toBe(DEFAULT_MAX);
  });

  test('honours custom bounds', () => {
    const { handle } = build({ defaultWidth: 300, min: 250, max: 400 });
    drag(handle, -500);
    expect(widthOf()).toBe(250);
    drag(handle, 500);
    expect(widthOf()).toBe(400);
  });

  test('suppresses transitions and text selection for the drag, then restores them', () => {
    const { handle } = build();

    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 300, bubbles: true }));
    expect(sidebar.classList.contains('is-resizing')).toBe(true);
    expect(document.body.classList.contains('sidebar-resizing')).toBe(true);

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(sidebar.classList.contains('is-resizing')).toBe(false);
    expect(document.body.classList.contains('sidebar-resizing')).toBe(false);
  });

  test('stops tracking the cursor after release', () => {
    const { handle } = build({ defaultWidth: 260 });
    drag(handle, 50);
    const settled = widthOf();

    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 9999, bubbles: true }));

    expect(widthOf()).toBe(settled);
  });
});

describe('persistence', () => {
  test('remembers the width after a drag', () => {
    const { handle } = build({ storageKey: 'hive.sidebarWidth.chat', defaultWidth: 240 });
    drag(handle, 60);
    expect(store.get('hive.sidebarWidth.chat')).toBe('300');
  });

  test('restores a stored width on enable', () => {
    store.set('hive.sidebarWidth.chat', '420');
    build({ storageKey: 'hive.sidebarWidth.chat', defaultWidth: 240 });
    expect(widthOf()).toBe(420);
  });

  test('clamps a stored width that is out of bounds', () => {
    // A value from a previous build with different limits must not escape them.
    store.set('hive.sidebarWidth.chat', '9999');
    build({ storageKey: 'hive.sidebarWidth.chat' });
    expect(widthOf()).toBe(DEFAULT_MAX);
  });

  test('ignores a corrupt stored value and leaves the CSS default alone', () => {
    store.set('hive.sidebarWidth.chat', 'not-a-number');
    build({ storageKey: 'hive.sidebarWidth.chat' });
    expect(sidebar.style.width).toBe('');
  });

  test('keeps each sidebar independent', () => {
    const first = build({ storageKey: 'hive.sidebarWidth.chat', defaultWidth: 240 });
    drag(first.handle, 60);

    document.body.innerHTML = '';
    const second = build({ storageKey: 'hive.sidebarWidth.work', defaultWidth: 260 });
    drag(second.handle, -20);

    expect(store.get('hive.sidebarWidth.chat')).toBe('300');
    expect(store.get('hive.sidebarWidth.work')).toBe('240');
  });

  test('survives storage being unavailable', () => {
    const original = window.localStorage;
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: () => { throw new Error('denied'); },
        setItem: () => { throw new Error('denied'); },
      },
      writable: true,
    });

    const { handle } = build({ defaultWidth: 260 });
    expect(() => drag(handle, 40)).not.toThrow();
    expect(widthOf()).toBe(300);

    Object.defineProperty(window, 'localStorage', { value: original, writable: true });
  });
});

describe('keyboard and reset', () => {
  const press = (handle, key) => handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

  test('arrow keys nudge the width and persist it', () => {
    const { handle } = build({ storageKey: 'k', defaultWidth: 260 });

    press(handle, 'ArrowRight');
    expect(widthOf()).toBe(276);
    press(handle, 'ArrowLeft');
    expect(widthOf()).toBe(260);
    expect(store.get('k')).toBe('260');
  });

  test('Home and End jump to the bounds', () => {
    const { handle } = build({ defaultWidth: 300 });

    press(handle, 'End');
    expect(widthOf()).toBe(DEFAULT_MAX);
    press(handle, 'Home');
    expect(widthOf()).toBe(DEFAULT_MIN);
  });

  test('keyboard resizing respects custom bounds', () => {
    const { handle } = build({ defaultWidth: 260, min: 250, max: 270 });

    press(handle, 'ArrowLeft');
    expect(widthOf()).toBe(250);
    press(handle, 'End');
    expect(widthOf()).toBe(270);
  });

  test('ignores unrelated keys', () => {
    const { handle } = build({ defaultWidth: 260 });
    press(handle, 'a');
    expect(sidebar.style.width).toBe('');
  });

  test('double-click resets to the starting width', () => {
    // An escape hatch from an awkward width without hunting for the original.
    const { handle } = build({ storageKey: 'k', defaultWidth: 260 });
    drag(handle, 200);
    expect(widthOf()).toBe(460);

    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(widthOf()).toBe(260);
    expect(store.get('k')).toBe('260');
  });
});
