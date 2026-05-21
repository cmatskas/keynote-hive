/** Strip extension and remove chars not allowed by Bedrock Converse document name field. */
function sanitizeFileName(fileName) {
  const stem = fileName.replace(/\.[^.]+$/, '');
  return stem
    .replace(/[^a-zA-Z0-9\s\-\(\)\[\]]/g, '_')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Convert an array of file objects into Bedrock Converse content blocks.
 * Handles pdf, doc(x), xls(x) as document blocks; pptx via code interpreter; text as inline.
 *
 * @param {Array} files - [{name, content}] where content is array/buffer for binary, string for text
 * @param {object} [options]
 * @param {object} [options.codeInterpreter] - CodeInterpreterManager instance (must have sessionId or will start one)
 * @param {boolean} [options.stopSession] - stop the code interpreter after PPTX extraction (default false)
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
    if (options.stopSession) await ci.stopSession();
  }

  for (const file of files) {
    const ext = file.name.toLowerCase().split('.').pop();
    if (['pptx', 'ppt'].includes(ext)) continue;

    if (['pdf', 'doc', 'docx', 'xls', 'xlsx'].includes(ext)) {
      const bytes = Buffer.from(Array.isArray(file.content) ? file.content : file.content);
      blocks.push({
        document: { name: sanitizeFileName(file.name), format: ext, source: { bytes } },
      });
    } else {
      const label = ext === 'csv' ? 'CSV Data' : ext === 'html' ? 'HTML Content' : ext === 'md' ? 'Markdown Content' : 'Content';
      blocks.push({ text: `\n--- ${label} from ${file.name} ---\n${file.content}\n--- End of ${file.name} ---\n` });
    }
  }

  return blocks;
}

module.exports = { sanitizeFileName, buildFileContentBlocks };
