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

// Plain-text-ish attachments (txt/csv/html/md, including the Chat tab's
// transcript attachment) are always sent as an inline text block — there is
// no sandbox-offload equivalent for them like the pdf/doc/xlsx branch above,
// because that offload pattern relies on the agent having an execute_code
// tool to go read the file itself. The Chat tab's agent is intentionally
// toolless (tools: [] — see ipc/bedrock.js), so a large inline text block
// has nowhere to go but directly into the prompt, where it can blow past the
// model's input context window and surface as an opaque MaxTokensError from
// the Bedrock/Mantle backend instead of a clear, actionable message.
//
// This cap truncates any inline text block before it's sent, independent of
// sandbox availability, so oversized attachments fail predictably (visible
// truncation marker) rather than unpredictably (backend token-limit crash).
// 300,000 characters is a rough heuristic (~4 chars/token for English text,
// so ~75K tokens) chosen to leave generous headroom for the user's prompt,
// conversation history, and the model's own output budget within a typical
// large-context model's total window — not derived from a specific measured
// Mantle context-window number (none is published per-model on Mantle; see
// the DEFAULT_MAX_OUTPUT_TOKENS comment in strandsAgentFactory.js for the
// same caveat about Mantle not publishing per-model limits).
const INLINE_TEXT_CHAR_LIMIT = 300000;

function truncateInlineText(text, fileName) {
  if (text.length <= INLINE_TEXT_CHAR_LIMIT) return text;
  const truncated = text.slice(0, INLINE_TEXT_CHAR_LIMIT);
  return `${truncated}\n\n[... content truncated — "${fileName}" is ` +
    `${text.length.toLocaleString()} characters, exceeding the ` +
    `${INLINE_TEXT_CHAR_LIMIT.toLocaleString()}-character limit for inline text ` +
    `attachments. Only the first portion is shown above. For the full content, ` +
    `use the Work tab instead — it can process large files with code execution ` +
    `rather than requiring the whole file to fit in the prompt. ...]`;
}

/**
 * Convert an array of file objects into Bedrock Converse-shaped content
 * blocks (consumed either directly by ipc/bedrock.js, or converted to real
 * Strands SDK class instances via toStrandsContentBlocks() for
 * agentToolExecutor.js).
 *
 * - pdf at or under the inline limit: native document block (source.bytes).
 *   AnthropicModel supports pdf natively; OpenAIModel supports any format
 *   generically (see below), so pdf is inline-safe for both families.
 * - doc/docx/xls/xlsx:
 *     - For Anthropic-family models: ALWAYS extracted via the sandbox,
 *       regardless of size. @strands-agents/sdk's AnthropicModel provider
 *       only natively supports `pdf` and a fixed plain-text format list for
 *       DocumentBlock — anything else (docx/xls/xlsx) is SILENTLY DROPPED
 *       with no error, just an internal logger.warn() Hive never sees (see
 *       node_modules/@strands-agents/sdk/dist/src/models/anthropic.js,
 *       confirmed by reproducing the exact drop against a real .docx file).
 *       The model then correctly (from its own perspective) reports no file
 *       was attached, since none was — Hive's own logs never show the SDK
 *       dropping it. Reported upstream to the strands-agents/harness-sdk
 *       maintainers.
 *     - For OpenAI-compatible models: at or under the inline limit, sent as
 *       a native document block (source.bytes) — OpenAIModel's adapter
 *       base64-encodes ANY byte-source document generically as a `file`
 *       content part, with no format allowlist, so this is safe.
 *     - Over the inline limit (OpenAI-compatible models only — Anthropic's
 *       docx/xls/xlsx is always fully handled by the extraction branch
 *       above, regardless of size): uploaded into the sandbox; the agent
 *       gets a text block pointing at the sandbox path and is expected to
 *       use execute_code to read whatever it needs.
 * - pptx/ppt: always extracted via the sandbox (no native pptx document
 *   format on either provider, independent of size or model family).
 * - csv/html/md/other text: sent inline as a text block, unchanged.
 *
 * @param {Array} files - [{name, content}] where content is array/buffer for binary, string for text
 * @param {object} [options]
 * @param {object} [options.codeInterpreter] - CodeInterpreterManager instance (must have sessionId or will start one)
 * @param {boolean} [options.stopSession] - stop the code interpreter after processing (default false)
 * @param {number} [options.sessionTimeout] - sessionTimeoutSeconds used if this function has to start the session itself (default 300). Callers passing a LONG-LIVED CodeInterpreterManager (e.g. the Work tab's per-conversation sandbox) MUST pass their own timeout here — otherwise a conversation whose first message has an attachment gets a 5-minute session, and every tool call after that window dies with "session is not active". Chat's throwaway manager (stopSession: true) is fine with the short default.
 * @param {boolean} [options.isAnthropicModel] - whether the target model is Anthropic-family (see isAnthropicModel() in strandsAgentFactory.js). Defaults false — callers that don't pass this get the OpenAI-compatible (native document block) behavior, which is safe for non-Anthropic models and was the only behavior that existed before this parameter was added.
 * @returns {Promise<Array>} Converse content blocks
 */
async function buildFileContentBlocks(files, options = {}) {
  if (!files || files.length === 0) return [];

  const blocks = [];
  const sessionTimeout = options.sessionTimeout || 300;
  const ci = options.codeInterpreter || null;
  const isAnthropicModel = !!options.isAnthropicModel;
  const pptxFiles = files.filter(f => ['pptx', 'ppt'].includes(f.name.toLowerCase().split('.').pop()));
  // docx/doc/xls/xlsx for Anthropic models — see the function doc comment
  // above for why this is unconditional on size, unlike the OpenAI-compat
  // branch below.
  const officeFilesForAnthropic = isAnthropicModel
    ? files.filter(f => ['doc', 'docx', 'xls', 'xlsx'].includes(f.name.toLowerCase().split('.').pop()))
    : [];

  if (pptxFiles.length > 0 && ci) {
    if (!ci.sessionId) await ci.startSession(sessionTimeout);
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

  if (officeFilesForAnthropic.length > 0) {
    if (!ci) {
      throw new Error(
        `File "${officeFilesForAnthropic[0].name}" is a Word/Excel document, which Anthropic (Claude) models cannot read directly on Mantle — ` +
        'it needs to be processed through a Code Interpreter sandbox first, and none is available here. ' +
        '(This attachment path requires a Code Interpreter session; the Chat tab creates one automatically for file processing, so if you see ' +
        'this error, something else prevented that setup — check AWS credentials/permissions.)'
      );
    }
    if (!ci.sessionId) await ci.startSession(sessionTimeout);
    await ci.writeFiles(officeFilesForAnthropic.map(f => ({
      path: f.name,
      blob: Buffer.from(Array.isArray(f.content) ? f.content : f.content),
    })));
    for (const file of officeFilesForAnthropic) {
      const ext = file.name.toLowerCase().split('.').pop();
      const safeName = file.name.replace(/"/g, '\\"');
      const extractCode = ['doc', 'docx'].includes(ext)
        ? `from docx import Document
doc = Document("${safeName}")
paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
tables = []
for t_idx, table in enumerate(doc.tables):
    rows = [" | ".join(cell.text for cell in row.cells) for row in table.rows]
    tables.append(f"Table {t_idx+1}:\\n" + "\\n".join(rows))
print("\\n\\n".join(paragraphs + tables))`
        : `import openpyxl
wb = openpyxl.load_workbook("${safeName}", data_only=True)
sheets = []
for name in wb.sheetnames:
    ws = wb[name]
    rows = [" | ".join(str(c) if c is not None else "" for c in row) for row in ws.iter_rows(values_only=True)]
    sheets.append(f"Sheet '{name}':\\n" + "\\n".join(rows))
print("\\n\\n".join(sheets))`;
      const result = await ci.executeCode(extractCode);
      blocks.push({ text: `\n--- Content from ${file.name} (extracted for Claude — this format isn't natively supported by Anthropic's document API) ---\n${result.text}\n--- End of ${file.name} ---\n` });
    }
  }

  for (const file of files) {
    const ext = file.name.toLowerCase().split('.').pop();
    if (['pptx', 'ppt'].includes(ext)) continue;
    if (isAnthropicModel && ['doc', 'docx', 'xls', 'xlsx'].includes(ext)) continue; // already handled above

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
        if (!ci.sessionId) await ci.startSession(sessionTimeout);
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
      const content = truncateInlineText(String(file.content ?? ''), file.name);
      blocks.push({ text: `\n--- ${label} from ${file.name} ---\n${content}\n--- End of ${file.name} ---\n` });
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
  INLINE_TEXT_CHAR_LIMIT,
  truncateInlineText,
};
