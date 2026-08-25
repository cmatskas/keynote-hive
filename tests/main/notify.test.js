/**
 * Tests for the shared OS notification helper (src/main/notify.js).
 *
 * Every notification Hive raises goes through notify() so that the "Hive — "
 * title prefix, the isSupported() guard, and click-to-focus behaviour stay
 * consistent across call sites (swarm pipeline events, credential expiry,
 * transcription completion).
 */

jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockShow = jest.fn();
const mockOn = jest.fn();
const mockCtor = jest.fn();
const mockState = { isSupported: true };

jest.mock('electron', () => ({
  Notification: class MockNotification {
    static isSupported() { return mockState.isSupported; }
    constructor(opts) {
      mockCtor(opts);
      this.show = mockShow;
      this.on = mockOn;
    }
  },
}));

const { notify } = require('../../src/main/notify');

describe('notify()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockState.isSupported = true;
  });

  test('prefixes the title with "Hive — " and shows the notification', () => {
    const shown = notify({ title: 'Transcription Complete', body: 'clip.mp4 is ready to read.' });

    expect(shown).toBe(true);
    expect(mockCtor).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Hive — Transcription Complete',
      body: 'clip.mp4 is ready to read.',
      urgency: 'normal',
      silent: false,
    }));
    expect(mockShow).toHaveBeenCalled();
  });

  test('passes urgency through for critical notifications', () => {
    notify({ title: 'Transcription Failed', body: 'boom', urgency: 'critical' });
    expect(mockCtor).toHaveBeenCalledWith(expect.objectContaining({ urgency: 'critical' }));
  });

  test('is a no-op when notifications are unsupported', () => {
    mockState.isSupported = false;
    expect(notify({ title: 'x', body: 'y' })).toBe(false);
    expect(mockShow).not.toHaveBeenCalled();
  });

  test('registers no click handler when neither window nor onClick is given', () => {
    notify({ title: 'x', body: 'y' });
    expect(mockOn).not.toHaveBeenCalled();
  });

  test('click shows and focuses the window, then runs onClick', () => {
    const win = { show: jest.fn(), focus: jest.fn(), isDestroyed: () => false };
    const onClick = jest.fn();

    notify({ title: 'x', body: 'y', window: win, onClick });

    expect(mockOn).toHaveBeenCalledWith('click', expect.any(Function));
    // Invoke the registered click handler
    mockOn.mock.calls[0][1]();

    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalled();
  });

  test('click skips a destroyed window but still runs onClick', () => {
    const win = { show: jest.fn(), focus: jest.fn(), isDestroyed: () => true };
    const onClick = jest.fn();

    notify({ title: 'x', body: 'y', window: win, onClick });
    mockOn.mock.calls[0][1]();

    expect(win.show).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalled();
  });

  test('a throwing Notification constructor never propagates to the caller', () => {
    mockCtor.mockImplementationOnce(() => { throw new Error('dbus unavailable'); });
    expect(() => notify({ title: 'x', body: 'y' })).not.toThrow();
    expect(notify({ title: 'x', body: 'y' })).toBe(true); // still works afterwards
  });
});
