/** Strip extension and remove chars not allowed by Bedrock Converse document name field. */
function sanitizeFileName(fileName) {
  const stem = fileName.replace(/\.[^.]+$/, '');
  return stem
    .replace(/[^a-zA-Z0-9\s\-\(\)\[\]]/g, '_')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Bedrock Converse API's actual inline document limit. Files at or under this
// size are sent as native document blocks (source.bytes) and processed
// directly by Bedrock — the normal path.
//
// Files over this limit are instead uploaded into the AgentCore Code
// Interpreter sandbox and the agent is told where to find them. The agent
// then uses its own execute_code tool to inspect, search, and extract
// whatever it actually needs (e.g. pdfplumber/python-docx/openpyxl, grep-style
// text search, page ranges, specific sheets) — the same way it already
// explores any other file or dataset in the sandbox. This deliberately does
// NOT pre-extract or summarize the file on our side: no fixed-format
// conversion, no context-window budget spent up front, and no risk of
// blowing past the model's context window the way a full-document dump
// would for very large files. It also sidesteps a confirmed, currently
// unfixed Bedrock service-side bug that rejects S3-referenced document
// sources (see https://github.com/aws/aws-sdk-js-v3/issues/7732).
const INLINE_DOCUMENT_LIMIT_BYTES = 4.5 * 1024 * 1024;

/**
 * Convert an array of file objects into Bedrock Converse content blocks.
 *
 * - pdf/doc/docx/xls/xlsx at or under the inline limit: native document
 *   block (source.bytes), processed directly by Bedrock.
 * - pdf/doc/docx/xls/xlsx over the inline limit: uploaded into the sandbox;
 *   the agent gets a text block pointing at the sandbox path and is expected
 *   to use execute_code to read whatever it needs.
 * - pptx/ppt: always extracted via the sandbox (Bedrock has no native pptx
 *   document format, independent of size).
 * - csv/html/md/other text: sent inline as a text block, unchanged.
 *
 * @param {Array} files - [{name, content}] where content is array/buffer for binary, string for text
 * @param {object} [options]
 * @param {object} [options.codeInterpreter] - CodeInterpreterManager instance (must have sessionId or will start one)
 * @param {boolean} [options.stopSession] - stop the code interpreter after processing (default false)
 * @returns {Promise<Array>} Converse content blocks
 */
async function buildFileContentBlocks(files, options = {}) {
  if (!files || files.length === 0) return [];

  const blocks = [];
  const ci = options.codeInterpreter || null;
  const pptxFiles = files.filter(f => ['pptx', 'ppt'].includes(f.name.toLowerCase().split('.').pop()));

  if (pptxFiles.length > 0 && ci) {
    if (!ci.sessionId) await ci.startSession(300);
    await ci.writeFiles(pptxFiles.map(f => ({
      path: f.name,
      blob: Buffer.from(Array.isArray(f.content) ? f.content : f.content),
    })));
    for (const file of pptxFiles) {
      const safeName = file.name.replace(/"/g, '\\"');
      const result = await ci.executeCode(
`from pptx import Presentation
prs = Presentation("${safeName}")
slides = []
for i, slide in enumerate(prs.slides):
    texts = [shape.text_frame.text for shape in slide.shapes if shape.has_text_frame and shape.text_frame.text.strip()]
    if texts:
        slides.append(f"Slide {i+1}:\\n" + "\\n".join(texts))
print("\\n\\n".join(slides))`
      );
      blocks.push({ text: `\n--- Content from ${file.name} ---\n${result.text}\n--- End of ${file.name} ---\n` });
    }
  }

  for (const file of files) {
    const ext = file.name.toLowerCase().split('.').pop();
    if (['pptx', 'ppt'].includes(ext)) continue;

    if (['pdf', 'doc', 'docx', 'xls', 'xlsx'].includes(ext)) {
      const bytes = Buffer.from(Array.isArray(file.content) ? file.content : file.content);
      const name = sanitizeFileName(file.name);

      if (bytes.length > INLINE_DOCUMENT_LIMIT_BYTES) {
        if (!ci) {
          throw new Error(
            `File "${file.name}" exceeds Bedrock's inline document limit (${(INLINE_DOCUMENT_LIMIT_BYTES / 1024 / 1024).toFixed(1)}MB) and no sandbox is available to process it. ` +
            'This attachment path requires a Code Interpreter session.'
          );
        }
        if (!ci.sessionId) await ci.startSession(300);
        // writeFiles() places files in the sandbox's working directory using
        // the bare relative filename (matching AWS's own writeFiles example —
        // https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-file-operations.html —
        // and the existing PPTX extraction code below, which opens files the
        // same way). It is NOT /tmp/<name> — that was an incorrect assumption
        // that caused the model to be told the wrong path and be unable to
        // find the file it had, in fact, correctly received.
        const sandboxPath = file.name;
        await ci.writeFiles([{ path: file.name, blob: bytes }]);
        blocks.push({
          text: `\n--- ${file.name} (${(bytes.length / 1024 / 1024).toFixed(1)}MB — too large to attach directly) ---\n` +
            `This file has ALREADY been written to your sandbox as "${sandboxPath}" (in the sandbox's working ` +
            `directory — open it with that exact relative filename, do not prefix it with /tmp/ or any other path). ` +
            `Do NOT call read_local_file for it — it is not on the user's local disk, it exists only in your sandbox ` +
            `right now. Use execute_code to open "${sandboxPath}" directly and extract whatever content you need to ` +
            `answer the user (e.g. read specific pages/sheets, search for keywords, list structure). Common libraries ` +
            `are pre-installed: python-docx (.docx), openpyxl (.xlsx). For PDFs, install pdfplumber or PyPDF2 first ` +
            `via pip.\n--- End of ${file.name} reference ---\n`,
        });
      } else {
        blocks.push({
          document: { name, format: ext, source: { bytes } },
        });
      }
    } else {
      const label = ext === 'csv' ? 'CSV Data' : ext === 'html' ? 'HTML Content' : ext === 'md' ? 'Markdown Content' : 'Content';
      blocks.push({ text: `\n--- ${label} from ${file.name} ---\n${file.content}\n--- End of ${file.name} ---\n` });
    }
  }

  if (options.stopSession && ci?.sessionId) await ci.stopSession();

  return blocks;
}

/**
 * Convert buildFileContentBlocks()'s raw-Bedrock-API-shaped blocks into real
 * Strands SDK class instances (TextBlock/DocumentBlock), for the one consumer
 * that drives a Strands `Agent` (agentToolExecutor.js) rather than calling
 * the Bedrock Converse API directly (ipc/bedrock.js). Strands' `ContentBlock[]`
 * variant of `InvokeArgs` expects actual class instances — passing plain
 * objects skips the constructor logic that normalizes shapes correctly.
 *
 * @param {Array} blocks - output of buildFileContentBlocks()
 * @returns {Array} Strands ContentBlock instances (TextBlock | DocumentBlock)
 */
function toStrandsContentBlocks(blocks) {
  const { TextBlock, DocumentBlock } = require('@strands-agents/sdk');
  return blocks.map((block) => {
    if (block.text !== undefined) {
      return new TextBlock(block.text);
    }
    if (block.document) {
      const { name, format, source } = block.document;
      return new DocumentBlock({ name, format, source: { bytes: source.bytes } });
    }
    // Unrecognized block shape — should not happen given buildFileContentBlocks()'s
    // current output, but fail loudly rather than silently dropping content.
    throw new Error(`toStrandsContentBlocks: unsupported block shape: ${JSON.stringify(Object.keys(block))}`);
  });
}

module.exports = {
  sanitizeFileName,
  buildFileContentBlocks,
  toStrandsContentBlocks,
  INLINE_DOCUMENT_LIMIT_BYTES,
};
