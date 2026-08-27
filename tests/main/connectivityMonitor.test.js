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

  test('does not probe at all when the OS reports no interface', async () => {
    const { monitor } = build();
    monitor.start();
    await flush();
    mockRequest.mockClear();

    mockIsOnline.mockReturnValue(false);
    await monitor.recheck();

    expect(mockRequest).not.toHaveBeenCalled();
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
