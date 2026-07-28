/**
 * Tests for buildFileContentBlocks()'s handling of oversized document
 * attachments. Documents at or under Bedrock's inline limit use native
 * document blocks (source.bytes) unchanged. Documents over the limit are
 * uploaded into the AgentCore Code Interpreter sandbox and the agent is
 * pointed at the sandbox path via a text block — the agent then uses its
 * own execute_code tool to inspect/search/extract whatever it needs. This
 * deliberately avoids pre-extracting or summarizing the file on our side
 * (no fixed-format conversion, no upfront context-window spend, no risk of
 * a full-document dump overflowing the model's context window), and
 * sidesteps a confirmed, currently-unfixed Bedrock service-side bug that
 * rejects S3-referenced document sources
 * (see https://github.com/aws/aws-sdk-js-v3/issues/7732).
 *
 * Also covers toStrandsContentBlocks(), the adapter that converts
 * buildFileContentBlocks()'s raw-Bedrock-shaped blocks into real Strands SDK
 * class instances for the one consumer (agentToolExecutor.js) that drives a
 * Strands `Agent` instead of calling the Converse API directly.
 */

// Minimal stand-ins matching the real Strands SDK classes' observable shape
// (constructor args -> readonly properties) closely enough to verify the
// adapter passes the right data through, without depending on the real SDK.
jest.mock('@strands-agents/sdk', () => ({
  TextBlock: class TextBlock {
    constructor(text) { this.type = 'textBlock'; this.text = text; }
  },
  DocumentBlock: class DocumentBlock {
    constructor({ name, format, source }) {
      this.type = 'documentBlock';
      this.name = name;
      this.format = format;
      this.source = source;
    }
  },
}));

const {
  buildFileContentBlocks,
  toStrandsContentBlocks,
  INLINE_DOCUMENT_LIMIT_BYTES,
  sanitizeFileName,
} = require('../../src/main/utils');

describe('utils — oversized document handling (sandbox pointer, no pre-extraction)', () => {
  function makeFakeCodeInterpreter() {
    return {
      sessionId: 'fake-session',
      startSession: jest.fn().mockResolvedValue('fake-session'),
      writeFiles: jest.fn().mockResolvedValue({ success: true }),
      executeCode: jest.fn().mockResolvedValue({ success: true, text: 'unused' }),
      stopSession: jest.fn().mockResolvedValue(undefined),
    };
  }

  describe('buildFileContentBlocks — size-threshold routing', () => {
    test('small documents use inline bytes (native Bedrock document block, unchanged behavior)', async () => {
      const smallBuffer = Buffer.alloc(1024); // 1KB, well under the limit
      const ci = makeFakeCodeInterpreter();
      const blocks = await buildFileContentBlocks([{ name: 'small.pdf', content: smallBuffer }], { codeInterpreter: ci });
      expect(blocks).toHaveLength(1);
      expect(blocks[0].document.source.bytes).toBeDefined();
      expect(ci.writeFiles).not.toHaveBeenCalled();
    });

    test('documents over the inline limit are uploaded to the sandbox and referenced via a text pointer, not pre-extracted', async () => {
      const ci = makeFakeCodeInterpreter();
      const largeBuffer = Buffer.alloc(INLINE_DOCUMENT_LIMIT_BYTES + 1024);
      const blocks = await buildFileContentBlocks([{ name: 'large-report.docx', content: largeBuffer }], { codeInterpreter: ci });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].document).toBeUndefined();
      expect(blocks[0].text).toContain('large-report.docx');
      expect(blocks[0].text).toContain('"large-report.docx"');
      expect(blocks[0].text).toContain('too large to attach directly');
      expect(blocks[0].text).toContain('ALREADY been written');
      expect(blocks[0].text).toContain('Do NOT call read_local_file');
      expect(blocks[0].text).toContain('execute_code');

      // The file must actually be written into the sandbox — no content
      // extraction/execution should happen on our side.
      expect(ci.writeFiles).toHaveBeenCalledWith([{ path: 'large-report.docx', blob: largeBuffer }]);
      expect(ci.executeCode).not.toHaveBeenCalled();
    });

    test('starts a sandbox session automatically for a large file if none is active', async () => {
      const ci = makeFakeCodeInterpreter();
      ci.sessionId = null;
      const largeBuffer = Buffer.alloc(INLINE_DOCUMENT_LIMIT_BYTES + 1024);
      await buildFileContentBlocks([{ name: 'large.xlsx', content: largeBuffer }], { codeInterpreter: ci });
      expect(ci.startSession).toHaveBeenCalled();
    });

    test('throws a clear error for a large document when no sandbox is available', async () => {
      const largeBuffer = Buffer.alloc(INLINE_DOCUMENT_LIMIT_BYTES + 1);
      await expect(
        buildFileContentBlocks([{ name: 'large.xlsx', content: largeBuffer }], {})
      ).rejects.toThrow(/no sandbox is available/i);
    });

    test('non-document files (csv, md, html) are unaffected by the size check', async () => {
      const ci = makeFakeCodeInterpreter();
      const blocks = await buildFileContentBlocks([{ name: 'data.csv', content: 'a,b,c\n1,2,3' }], { codeInterpreter: ci });
      expect(blocks).toHaveLength(1);
      expect(blocks[0].text).toContain('CSV Data');
      expect(ci.writeFiles).not.toHaveBeenCalled();
    });

    test('multiple files: small stays inline as a document block, large is uploaded and referenced, in the same call', async () => {
      const ci = makeFakeCodeInterpreter();
      const smallBuffer = Buffer.alloc(2048);
      const largeBuffer = Buffer.alloc(INLINE_DOCUMENT_LIMIT_BYTES + 2048);
      const blocks = await buildFileContentBlocks(
        [
          { name: 'small.pdf', content: smallBuffer },
          { name: 'large.docx', content: largeBuffer },
        ],
        { codeInterpreter: ci }
      );
      expect(blocks).toHaveLength(2);
      expect(blocks[0].document.source.bytes).toBeDefined();
      expect(blocks[1].text).toContain('"large.docx"');
    });

    test('stops the sandbox session when stopSession is requested and a session is active', async () => {
      const ci = makeFakeCodeInterpreter();
      const largeBuffer = Buffer.alloc(INLINE_DOCUMENT_LIMIT_BYTES + 1024);
      await buildFileContentBlocks([{ name: 'large.docx', content: largeBuffer }], { codeInterpreter: ci, stopSession: true });
      expect(ci.stopSession).toHaveBeenCalled();
    });
  });

  describe('toStrandsContentBlocks — adapter from raw Bedrock shape to Strands SDK classes', () => {
    test('converts a text block into a TextBlock instance', () => {
      const [result] = toStrandsContentBlocks([{ text: 'hello world' }]);
      expect(result.type).toBe('textBlock');
      expect(result.text).toBe('hello world');
    });

    test('converts an inline-bytes document block into a DocumentBlock with source.bytes', () => {
      const bytes = Buffer.from('pdf-content');
      const [result] = toStrandsContentBlocks([
        { document: { name: 'report', format: 'pdf', source: { bytes } } },
      ]);
      expect(result.type).toBe('documentBlock');
      expect(result.name).toBe('report');
      expect(result.format).toBe('pdf');
      expect(result.source.bytes).toBe(bytes);
    });

    test('converts a full mixed batch (text + inline doc + sandbox pointer text) preserving order', () => {
      const results = toStrandsContentBlocks([
        { text: 'prompt text' },
        { document: { name: 'small', format: 'pdf', source: { bytes: Buffer.from('x') } } },
        { text: 'sandbox pointer for the large file' },
      ]);
      expect(results).toHaveLength(3);
      expect(results[0].type).toBe('textBlock');
      expect(results[1].type).toBe('documentBlock');
      expect(results[2].type).toBe('textBlock');
    });

    test('throws a clear error for an unrecognized block shape instead of silently dropping content', () => {
      expect(() => toStrandsContentBlocks([{ unknownField: 'oops' }])).toThrow(/unsupported block shape/i);
    });
  });

  describe('sanitizeFileName (regression check — unchanged)', () => {
    test('strips extension and disallowed characters', () => {
      expect(sanitizeFileName('My Report (final)!!.docx')).toBe('My Report (final)__');
    });
  });
});
