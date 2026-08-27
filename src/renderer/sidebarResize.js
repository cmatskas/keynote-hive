/**
 * sidebarResize.js — horizontal drag-resize for the app's list sidebars.
 *
 * All three sidebars (Chat, Work, Transcribe) were fixed-width, which forced
 * their rows to truncate names and cram metadata onto one line. Reducing what a
 * row shows helps, but the real fix is letting the user decide how much room the
 * list gets — so this removes the constraint rather than working around it.
 *
 * One helper for all three, because three separate implementations would drift.
 *
 * Width is persisted to `localStorage` rather than the settings file: it is pure
 * per-machine UI state, not user configuration that needs validating, syncing, or
 * surfacing anywhere. A monitor-shaped preference doesn't belong in settings.json.
 */

(function () {
    'use strict';

    const DEFAULT_MIN = 180;
    const DEFAULT_MAX = 560;
    const KEYBOARD_STEP = 16;

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function readStored(storageKey) {
        try {
            const raw = window.localStorage?.getItem(storageKey);
            const parsed = raw === null || raw === undefined ? NaN : parseInt(raw, 10);
            return Number.isFinite(parsed) ? parsed : null;
        } catch {
            return null;   // storage unavailable — fall back to the CSS default
        }
    }

    function persist(storageKey, width) {
        try {
            window.localStorage?.setItem(storageKey, String(Math.round(width)));
        } catch { /* not worth surfacing */ }
    }

    /**
     * Apply a width. Both `width` and `minWidth` are set because the stylesheet
     * pins them together to stop flex shrinking the sidebar — overriding only one
     * would leave the other fighting it.
     */
    function applyWidth(el, width) {
        el.style.width = `${width}px`;
        el.style.minWidth = `${width}px`;
        el.style.flexBasis = `${width}px`;
    }

    /**
     * Make a sidebar resizable.
     *
     * @param {object} opts
     * @param {HTMLElement} opts.el          the sidebar
     * @param {string} opts.storageKey       where to remember the width
     * @param {number} [opts.min]
     * @param {number} [opts.max]
     * @param {number} [opts.defaultWidth]   used by the reset gesture
     * @returns {boolean} whether it was enabled
     */
    function enable({ el, storageKey, min = DEFAULT_MIN, max = DEFAULT_MAX, defaultWidth = null }) {
        if (!el || el.dataset.resizable === 'true') return false;
        el.dataset.resizable = 'true';

        const initial = defaultWidth || el.getBoundingClientRect().width || min;
        const stored = readStored(storageKey);
        if (stored !== null) applyWidth(el, clamp(stored, min, max));

        const handle = document.createElement('div');
        handle.className = 'sidebar-resize-handle';
        // A separator role with a tabindex makes this reachable without a mouse —
        // a drag-only control would be unusable by keyboard entirely.
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-orientation', 'vertical');
        handle.setAttribute('aria-label', 'Resize sidebar');
        handle.tabIndex = 0;
        handle.title = 'Drag to resize · double-click to reset';
        el.appendChild(handle);

        const currentWidth = () => el.getBoundingClientRect().width || initial;

        const setWidth = (next) => {
            const width = clamp(next, min, max);
            applyWidth(el, width);
            return width;
        };

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = currentWidth();

            // Suppress the width transition and text selection for the drag, or
            // the sidebar lags the cursor and the page selects as you move.
            el.classList.add('is-resizing');
            document.body.classList.add('sidebar-resizing');

            const onMove = (moveEvent) => setWidth(startWidth + (moveEvent.clientX - startX));
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                el.classList.remove('is-resizing');
                document.body.classList.remove('sidebar-resizing');
                persist(storageKey, currentWidth());
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        handle.addEventListener('keydown', (e) => {
            let next = null;
            if (e.key === 'ArrowLeft') next = currentWidth() - KEYBOARD_STEP;
            else if (e.key === 'ArrowRight') next = currentWidth() + KEYBOARD_STEP;
            else if (e.key === 'Home') next = min;
            else if (e.key === 'End') next = max;
            if (next === null) return;
            e.preventDefault();
            persist(storageKey, setWidth(next));
        });

        // Escape hatch from an awkward width without hunting for the original.
        handle.addEventListener('dblclick', () => {
            persist(storageKey, setWidth(initial));
        });

        return true;
    }

    window.SidebarResize = { enable, DEFAULT_MIN, DEFAULT_MAX };
})();
