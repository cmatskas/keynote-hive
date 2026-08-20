/**
 * @jest-environment jsdom
 */

/**
 * Tests for fileManager.js's configurable per-file size limit.
 *
 * Context: Bedrock's inline document limit is 4.5MB, and that used to be a
 * hardcoded gate in createFileManager — which silently made the v2.17.0
 * backend fix (oversized Work tab documents routed into the Code Interpreter
 * sandbox, see src/main/utils.js) unreachable from the Work tab UI. The gate
 * is now a `maxSize` option: the default stays 4.5MB (correct for tabs with
 * no sandbox, like Chat), and the Work tab passes 100MB.
 */

const { createFileManager, formatFileSize } = require('../../src/renderer/fileManager.js');

const MB = 1024 * 1024;

function buildDom() {
  document.body.innerHTML = `
    <input type="file" id="testFileUpload" />
    <button id="testAttachFiles"></button>
    <button id="testClearFiles"></button>
    <div id="testFileListSection" style="display:none"></div>
    <div id="testFileList"></div>
    <span id="testFileCount"></span>
  `;
}

function makeFile(name, sizeBytes) {
  const file = new File(['x'], name, { type: 'application/pdf' });
  // Shadow the Blob size getter so we don't have to allocate real multi-MB buffers.
  Object.defineProperty(file, 'size', { value: sizeBytes });
  return file;
}

function dispatchFiles(files) {
  const input = document.getElementById('testFileUpload');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));
}

// The change handler awaits FileReader for accepted files; flush those microtasks/events.
async function flushAsync() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function setupManager(options = {}) {
  const showToast = jest.fn();
  const manager = createFileManager({
    fileInputId: 'testFileUpload',
    attachBtnId: 'testAttachFiles',
    clearBtnId: 'testClearFiles',
    listSectionId: 'testFileListSection',
    listId: 'testFileList',
    countId: 'testFileCount',
    ...options,
  });
  manager.setup(showToast);
  return { manager, showToast };
}

describe('createFileManager maxSize option', () => {
  beforeEach(() => buildDom());

  test('default limit still rejects files over 4.5MB (Chat-style callers unaffected)', () => {
    const { manager, showToast } = setupManager();

    dispatchFiles([makeFile('big.pdf', 5 * MB)]);

    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('exceeds the 4.5 MB limit'),
      'error'
    );
    expect(manager.getFiles()).toHaveLength(0);
  });

  test('default limit accepts files under 4.5MB', async () => {
    const { manager, showToast } = setupManager();

    dispatchFiles([makeFile('small.pdf', 4 * MB)]);
    await flushAsync();

    expect(manager.getFiles()).toHaveLength(1);
    expect(manager.getFiles()[0].name).toBe('small.pdf');
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('attached'), 'success');
  });

  test('Work-tab-style 100MB limit accepts a file over 4.5MB', async () => {
    const { manager } = setupManager({ maxSize: 100 * MB });

    dispatchFiles([makeFile('big-report.pdf', 25 * MB)]);
    await flushAsync();

    expect(manager.getFiles()).toHaveLength(1);
    expect(manager.getFiles()[0].name).toBe('big-report.pdf');
  });

  test('Work-tab-style 100MB limit still rejects files over 100MB', () => {
    const { manager, showToast } = setupManager({ maxSize: 100 * MB });

    dispatchFiles([makeFile('huge.pdf', 101 * MB)]);

    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('exceeds the 100 MB limit'),
      'error'
    );
    expect(manager.getFiles()).toHaveLength(0);
  });

  test('rejection toast reflects the configured limit, not a hardcoded 4.5MB', () => {
    const { showToast } = setupManager({ maxSize: 10 * MB });

    dispatchFiles([makeFile('medium.pdf', 11 * MB)]);

    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining(formatFileSize(10 * MB)),
      'error'
    );
    expect(showToast).not.toHaveBeenCalledWith(expect.stringContaining('4.5'), 'error');
  });

  test('one oversized file rejects the whole batch before anything is attached', () => {
    const { manager, showToast } = setupManager();

    dispatchFiles([makeFile('ok.pdf', 1 * MB), makeFile('big.pdf', 5 * MB)]);

    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('exceeds'), 'error');
    expect(manager.getFiles()).toHaveLength(0);
  });
});
