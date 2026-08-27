/**
 * Tests for ConnectivityMonitor.
 *
 * The interesting property is that it doesn't trust the OS. `net.isOnline()`
 * (and `navigator.onLine` in the renderer) only report whether an interface is
 * up, which is true on a captive portal or a VPN routing nowhere — so a
 * reachability probe has to confirm before a transition is broadcast. The other
 * property worth pinning down is debouncing: waking a laptop or switching
 * networks emits a burst of events, and each one would otherwise re-broadcast
 * and re-trigger reconnect work (web search init, transcription resume).
 */

jest.mock('electron-log/main', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockIsOnline = jest.fn(() => true);
jest.mock('electron', () => ({ net: { isOnline: () => mockIsOnline() } }));

// Stands in for the HTTPS HEAD probe against the STS endpoint.
const mockRequest = jest.fn();
jest.mock('https', () => ({ request: (...args) => mockRequest(...args) }));

const ConnectivityMonitor = require('../../src/main/models/connectivityMonitor');
const { DEBOUNCE_MS } = ConnectivityMonitor;

/**
 * Makes the fake https.request behave like a reachable endpoint (any HTTP
 * response counts) or an unreachable one (transport error).
 */
function setProbeResult(reachable) {
  mockRequest.mockImplementation((opts, callback) => {
    const req = {
      on: (eventName, handler) => {
        if (!reachable && eventName === 'error') {
          setTimeout(() => handler(new Error('ENOTFOUND')), 0);
        }
        return req;
      },
      end: () => {
        if (reachable) setTimeout(() => callback({ resume: () => {} }), 0);
      },
      destroy: () => {},
    };
    return req;
  });
}

function build() {
  const onChange = jest.fn();
  const monitor = new ConnectivityMonitor({
    getRegion: () => 'us-east-1',
    onChange,
  });
  return { monitor, onChange };
}

/** Lets pending promises and timer callbacks drain. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('ConnectivityMonitor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsOnline.mockReturnValue(true);
    setProbeResult(true);
  });

  test('starts optimistically online so a healthy launch never flashes the banner', () => {
    const { monitor } = build();
    expect(monitor.isOnline()).toBe(true);
    monitor.stop();
  });

  test('probes the regional STS endpoint', async () => {
    const { monitor } = build();
    monitor.start();
    await flush();

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'HEAD', host: 'sts.us-east-1.amazonaws.com' }),
      expect.any(Function)
    );
    monitor.stop();
  });

  test('goes offline when the probe cannot reach AWS, after the debounce', async () => {
    const { monitor, onChange } = build();
    monitor.start();
    await flush();

    setProbeResult(false);
    await monitor.recheck();

    // Not applied until the debounce elapses.
    expect(monitor.isOnline()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 50));

    expect(monitor.isOnline()).toBe(false);
    expect(onChange).toHaveBeenCalledWith(false);
    monitor.stop();
  });

  test('probes even when the OS claims there is no interface', async () => {
    // This used to be gated: "don't bother probing if net.isOnline() is false".
    // That gate is what latched the monitor offline for three hours in
    // production — net.isOnline() can stick false after sleep or a network
    // change, and while it did, the real reachability test never ran.
    const { monitor } = build();
    monitor.start();
    await flush();
    mockRequest.mockClear();

    mockIsOnline.mockReturnValue(false);
    await monitor.recheck();

    expect(mockRequest).toHaveBeenCalled();
    monitor.stop();
  });

  test('trusts the probe over a stuck net.isOnline()', async () => {
    // The exact production failure: OS reports offline, network is actually fine.
    const { monitor, onChange } = build();
    monitor.start();
    await flush();

    mockIsOnline.mockReturnValue(false);
    setProbeResult(true);
    await monitor.recheck();
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 50));

    expect(monitor.isOnline()).toBe(true);
    expect(onChange).not.toHaveBeenCalledWith(false);
    monitor.stop();
  });

  test('recovers from being offline while net.isOnline() stays stuck false', async () => {
    const { monitor } = build();
    monitor.start();
    await flush();

    // Go offline for real, with the OS also reporting offline.
    mockIsOnline.mockReturnValue(false);
    setProbeResult(false);
    await monitor.recheck();
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 50));
    expect(monitor.isOnline()).toBe(false);

    // Network comes back but net.isOnline() is still wrong. The probe must be
    // what decides, or the app stays offline until it is restarted.
    setProbeResult(true);
    await monitor.recheck();
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 50));

    expect(monitor.isOnline()).toBe(true);
    monitor.stop();
  });

  test('stays offline when the OS claims online but nothing is reachable', async () => {
    // The captive-portal case: the interface is up, the network is useless.
    const { monitor, onChange } = build();
    monitor.start();
    await flush();

    mockIsOnline.mockReturnValue(true);
    setProbeResult(false);
    await monitor.recheck();
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 50));

    expect(monitor.isOnline()).toBe(false);
    expect(onChange).toHaveBeenCalledWith(false);
    monitor.stop();
  });

  test('collapses concurrent rechecks onto a single probe', async () => {
    const { monitor } = build();
    monitor.start();
    await flush();
    mockRequest.mockClear();

    // Several subsystems can notice a failure in the same tick.
    await Promise.all([monitor.recheck(), monitor.recheck(), monitor.recheck()]);

    expect(mockRequest).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  test('a burst of transitions notifies once, not once per event', async () => {
    const { monitor, onChange } = build();
    monitor.start();
    await flush();

    setProbeResult(false);
    await monitor.recheck();
    await monitor.recheck();
    await monitor.recheck();
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 50));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(false);
    monitor.stop();
  });

  test('reports coming back online', async () => {
    const { monitor, onChange } = build();
    monitor.start();
    await flush();

    setProbeResult(false);
    await monitor.recheck();
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 50));
    expect(monitor.isOnline()).toBe(false);

    setProbeResult(true);
    await monitor.recheck();
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 50));

    expect(monitor.isOnline()).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(true);
    monitor.stop();
  });

  test('stop() prevents any further state changes', async () => {
    const { monitor, onChange } = build();
    monitor.start();
    await flush();
    monitor.stop();

    setProbeResult(false);
    await monitor.recheck();
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 50));

    expect(onChange).not.toHaveBeenCalled();
  });

  test('a throwing onChange handler does not break the monitor', async () => {
    const monitor = new ConnectivityMonitor({
      getRegion: () => 'us-east-1',
      onChange: () => { throw new Error('handler exploded'); },
    });
    monitor.start();
    await flush();

    setProbeResult(false);
    await monitor.recheck();
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 50));

    expect(monitor.isOnline()).toBe(false);
    monitor.stop();
  });

  test('reportNetworkFailure triggers a re-check rather than trusting the caller', async () => {
    // One flaky endpoint must not be able to declare the whole app offline.
    const { monitor } = build();
    monitor.start();
    await flush();
    mockRequest.mockClear();

    monitor.reportNetworkFailure();
    await flush();

    expect(mockRequest).toHaveBeenCalled();
    monitor.stop();
  });
});

/**
 * Regression tests for the latch observed in production: the monitor went offline
 * at 12:05 after a genuine transient (laptop sleep / network change), then never
 * recovered for three hours despite a working network. Restarting the app was the
 * only cure.
 *
 * Cause: `_applyState()`'s same-state path reschedules the next check, but the
 * transition path only armed a debounce — and that debounce's early return exited
 * without rescheduling anything. Once taken, no timer remained and the state
 * machine was dead.
 *
 * These use fake timers so "three hours later" is expressible, and so the test
 * asserts the monitor's *own* liveness rather than being nudged by the harness.
 */
describe('recovering without an external nudge (regression)', () => {
  const { OFFLINE_RECHECK_MS, ONLINE_RECHECK_MS } = ConnectivityMonitor;

  /** Advances fake timers while letting the async probe chain settle. */
  async function advance(ms, step = 500) {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      jest.advanceTimersByTime(step);
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }
  }

  /**
   * Advances until the monitor reaches `expected`, or the budget runs out.
   * Deliberately not tied to a specific interval — the recheck cadence differs by
   * direction (20s offline, 5min online), and the property under test is that the
   * monitor gets there on its own, not how quickly.
   */
  async function settleTo(monitor, expected, budgetMs = 15 * 60 * 1000) {
    for (let elapsed = 0; elapsed < budgetMs; elapsed += 1000) {
      if (monitor.isOnline() === expected) return true;
      await advance(1000, 500);
    }
    return monitor.isOnline() === expected;
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('comes back online by itself once the network returns', async () => {
    const { monitor, onChange } = build();
    monitor.start();
    await advance(2000);

    // A transient failure takes it offline, as it should.
    setProbeResult(false);
    expect(await settleTo(monitor, false)).toBe(true);
    expect(onChange).toHaveBeenCalledWith(false);

    // Network returns. Nothing calls recheck() — the monitor has to notice on
    // its own, which is exactly what it failed to do in production.
    setProbeResult(true);
    expect(await settleTo(monitor, true)).toBe(true);

    expect(monitor.isOnline()).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(true);
    monitor.stop();
  });

  test('is still probing hours after going offline', async () => {
    // The production symptom was silence: no probes, no recovery, for 3 hours.
    const { monitor } = build();
    monitor.start();
    await advance(2000);

    setProbeResult(false);
    expect(await settleTo(monitor, false)).toBe(true);

    mockRequest.mockClear();
    await advance(3 * 60 * 60 * 1000, 5000);

    expect(mockRequest.mock.calls.length).toBeGreaterThan(0);
    monitor.stop();
  });

  test('keeps a recheck scheduled across repeated transitions', async () => {
    const { monitor } = build();
    monitor.start();
    await advance(2000);

    // Flap several times; the monitor must remain live throughout.
    for (const reachable of [false, true, false, true]) {
      setProbeResult(reachable);
      expect(await settleTo(monitor, reachable)).toBe(true);
    }

    mockRequest.mockClear();
    await advance(ONLINE_RECHECK_MS + 4000, 5000);
    expect(mockRequest.mock.calls.length).toBeGreaterThan(0);
    monitor.stop();
  });

  test('a pending transition is not starved by repeated failure reports', async () => {
    // reportNetworkFailure() fires on every failing AWS call. Each one used to
    // clearTimeout the pending debounce and re-arm it, so a retrying app could
    // push the offline->online transition out indefinitely.
    const { monitor, onChange } = build();
    monitor.start();
    await advance(2000);

    setProbeResult(false);
    expect(await settleTo(monitor, false)).toBe(true);

    setProbeResult(true);
    // Hammer it faster than the debounce window.
    for (let i = 0; i < 10; i++) {
      monitor.reportNetworkFailure();
      await advance(400, 200);
    }

    expect(monitor.isOnline()).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(true);
    monitor.stop();
  });
});
