/**
 * storyboardExtractor.js — turn an uploaded keynote script or outline into
 * numbered, classifiable units.
 *
 * WHY EXTRACTION IS LOCAL
 * -----------------------
 * Hive already has a path for handing documents to a model:
 * `utils.buildFileContentBlocks()`, used by Chat and Work for attachments. It is
 * the wrong tool here, for three reasons:
 *
 *   1. It starts an AgentCore Code Interpreter session — billable, slow, and it
 *      fails without a network, so you could not even open a saved analysis
 *      offline.
 *   2. It gives the *model* the text. The StoryBrand tab renders the user's own
 *      words back to them with colours applied, so the text must come from the
 *      document and only from the document. If a model produces the text, it will
 *      quietly reflow paragraphs, "fix" perceived typos, and drop clauses — and
 *      the user gets back a keynote that looks right and is not theirs.
 *   3. Classification is a mapping onto *positions*. Positions have to be stable
 *      and derived from the document structure, not from prose an LLM emitted.
 *
 * So .docx and .pptx are unzipped directly (both are ZIP containers of XML, and
 * `jszip` is already a dependency), and .txt/.md are read as-is. No model, no
 * cost, works offline.
 *
 * PDF is deliberately unsupported: there is no local PDF parser in the
 * dependency tree, and routing PDFs through the Code Interpreter would reintroduce
 * every problem above.
 *
 * OUTLINES VS PROSE
 * -----------------
 * A keynote script splits cleanly on blank lines. A detailed outline does not: it
 * is short nested lines where a single bullet is often a fragment ("Three
 * analogies"), and classifying each fragment separately produces a wall of
 * one-line colour changes rather than a readable document.
 *
 * So when a run of lines looks like an outline, a top-level bullet and its
 * indented children are collapsed into one unit. The child lines are preserved
 * verbatim inside that unit so the reading view can still show the structure —
 * only the *classification boundary* is coarsened.
 */

const path = require('path');

/** Extensions we can read without a model or a network call. */
const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.docx', '.pptx'];

/** OOXML namespaces. Matching on local names avoids prefix surprises. */
const MAX_UNITS = 2000;

/**
 * A line is a bullet if it opens with a common list marker. Covers "-", "*",
 * "•", "1.", "1)", "a." and the tab/space indentation that carries nesting.
 */
const BULLET_RE = /^(\s*)(?:[-*•‣◦·]|\d+[.)]|[a-z][.)])\s+(.*)$/i;
/** A heading in markdown or a bare ALL-CAPS section label. */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

function extensionOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

/** Can this filename be handled at all? */
function isSupportedFile(name) {
  return SUPPORTED_EXTENSIONS.includes(extensionOf(name));
}

/**
 * Collapse runs of whitespace inside a line without touching its content.
 *
 * OOXML splits a sentence across multiple <w:t> runs whenever formatting
 * changes mid-sentence, which reassembles with no separator; and both formats
 * are full of incidental tabs. This normalises spacing only — no punctuation is
 * substituted, nothing is trimmed from the middle, and no characters are dropped.
 */
function normaliseWhitespace(text) {
  return String(text).replace(/[ \t\u00A0]+/g, ' ').trim();
}

// ── Format readers ──────────────────────────────────────────────────────────

/** Plain text and markdown need no parsing at all. */
function readPlainText(buffer) {
  return Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
}

/**
 * Pull paragraph text out of WordprocessingML.
 *
 * Each <w:p> is one paragraph, and its text is the concatenation of the <w:t>
 * runs inside it. <w:br> and <w:tab> are rendered as whitespace so a manually
 * broken line doesn't glue two sentences together. Everything else — styles,
 * revision marks, comments — is ignored.
 */
function paragraphsFromDocumentXml(xml) {
  const paragraphs = [];
  const paraMatches = String(xml).match(/<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g) || [];

  for (const para of paraMatches) {
    // Turn explicit breaks into spaces. They must be injected *as text runs* —
    // replacing the tag with a bare space would put it outside the <w:t> elements,
    // and joining the runs would then glue the two words together.
    const withBreaks = para
      .replace(/<w:br\b[^>]*\/?>/g, '<w:t> </w:t>')
      .replace(/<w:tab\b[^>]*\/?>/g, '<w:t> </w:t>');

    const runs = withBreaks.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g) || [];
    const text = runs
      .map(run => run.replace(/<w:t\b[^>]*>/, '').replace(/<\/w:t>$/, ''))
      .join('');

    const decoded = decodeXmlEntities(text);
    if (normaliseWhitespace(decoded)) paragraphs.push(normaliseWhitespace(decoded));
  }
  return paragraphs;
}

/**
 * Pull text out of a PowerPoint slide, one line per <a:p>.
 *
 * A keynote outline in slide form is exactly the bullet structure the outline
 * path below is built for, so slides are emitted as lines rather than pre-joined
 * paragraphs and left for the same grouping logic.
 */
function linesFromSlideXml(xml) {
  const lines = [];
  const paraMatches = String(xml).match(/<a:p\b[\s\S]*?<\/a:p>|<a:p\b[^>]*\/>/g) || [];

  for (const para of paraMatches) {
    const runs = para.match(/<a:t\b[^>]*>[\s\S]*?<\/a:t>/g) || [];
    const text = decodeXmlEntities(
      runs.map(r => r.replace(/<a:t\b[^>]*>/, '').replace(/<\/a:t>$/, '')).join(''),
    );

    // Indentation in PPTX is an attribute, not leading whitespace. Preserve it as
    // leading spaces so the outline grouping below sees the same shape it sees in
    // a text file.
    const lvlMatch = para.match(/<a:pPr\b[^>]*\blvl="(\d+)"/);
    const depth = lvlMatch ? Number(lvlMatch[1]) : 0;

    // Emit an explicit bullet marker. PPTX carries nesting in a `lvl` attribute
    // with no bullet character in the text, so without this the outline detector
    // sees plain lines and merges a whole slide into one paragraph.
    const clean = normaliseWhitespace(text);
    if (clean) lines.push('  '.repeat(depth) + '- ' + clean);
  }
  return lines;
}

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    // Ampersand last, so a literal &amp;lt; is not double-decoded.
    .replace(/&amp;/g, '&');
}

// ── Unit grouping ───────────────────────────────────────────────────────────

/** Indentation depth of a line, tabs counted as two spaces. */
function indentOf(line) {
  const match = String(line).match(/^[ \t]*/);
  return match ? match[0].replace(/\t/g, '  ').length : 0;
}

/**
 * Does this block of lines read as an outline rather than prose?
 *
 * The test is deliberately conservative — misreading prose as an outline would
 * merge unrelated paragraphs, which is worse than leaving an outline ungrouped.
 * Requires that a real majority of non-empty lines are bullets.
 */
function looksLikeOutline(lines) {
  const meaningful = lines.filter(l => normaliseWhitespace(l));
  if (meaningful.length < 2) return false;
  const bulletCount = meaningful.filter(l => BULLET_RE.test(l)).length;
  return bulletCount / meaningful.length > 0.6;
}

/**
 * Group outline lines so a top-level bullet carries its children.
 *
 * "1- Focusing on the wrong problem" plus its three sub-points is one thing to
 * classify, not four. The children are kept verbatim on the unit so the reading
 * view can render the nesting; only the classification boundary is coarsened.
 */
function groupOutline(lines) {
  const units = [];
  let current = null;
  let baseIndent = null;

  for (const rawLine of lines) {
    if (!normaliseWhitespace(rawLine)) continue;

    const indent = indentOf(rawLine);
    const bullet = rawLine.match(BULLET_RE);
    const heading = rawLine.match(HEADING_RE);
    const text = normaliseWhitespace(bullet ? bullet[2] : heading ? heading[2] : rawLine);

    // A heading always starts a new unit and is never absorbed as a child.
    if (heading) {
      if (current) units.push(current);
      current = { text, children: [], kind: 'heading', level: heading[1].length };
      baseIndent = null;
      continue;
    }

    if (baseIndent === null) baseIndent = indent;

    if (indent > baseIndent && current) {
      current.children.push(text);
    } else {
      if (current) units.push(current);
      current = { text, children: [], kind: 'bullet' };
      baseIndent = indent;
    }
  }
  if (current) units.push(current);
  return units;
}

/**
 * Split lines into blocks on blank lines. Headings always stand alone, so a
 * bulleted section under one heading is never judged together with prose under
 * the next.
 */
function splitIntoBlocks(lines) {
  const blocks = [];
  let block = [];

  const flush = () => { if (block.length) { blocks.push(block); block = []; } };

  for (const rawLine of lines) {
    const line = String(rawLine);
    if (!normaliseWhitespace(line)) { flush(); continue; }
    if (HEADING_RE.test(line)) { flush(); blocks.push([line]); continue; }
    block.push(line);
  }
  flush();
  return blocks;
}

/** Drop a leading list marker, keeping the line's actual text. */
function stripBullet(line) {
  const m = String(line).match(BULLET_RE);
  return normaliseWhitespace(m ? m[2] : line);
}

function headingUnit(line) {
  const heading = String(line).match(HEADING_RE);
  return {
    text: normaliseWhitespace(heading[2]),
    children: [],
    kind: 'heading',
    level: heading[1].length,
  };
}

/**
 * Turn raw lines into classifiable units.
 *
 * The outline-vs-prose decision is made **per block**, not per document: a real
 * keynote interleaves prose sections with bulleted lists, and judging the whole
 * file at once gets both wrong.
 *
 * `preSplit` says the source already carries paragraph boundaries — .docx gives
 * one <w:p> per paragraph — so lines must not be re-joined the way hard-wrapped
 * plain text has to be. Without it, every paragraph of a Word document collapses
 * into a single unit.
 */
function unitsFromLines(lines, { preSplit = false } = {}) {
  const units = [];

  for (const block of splitIntoBlocks(lines)) {
    if (block.length === 1 && HEADING_RE.test(String(block[0]))) {
      units.push(headingUnit(block[0]));
      continue;
    }

    if (looksLikeOutline(block)) {
      units.push(...groupOutline(block));
    } else if (preSplit) {
      // Already one paragraph per line.
      for (const line of block) {
        units.push({ text: stripBullet(line), children: [], kind: 'paragraph' });
      }
    } else {
      // Hard-wrapped prose: the whole block is one paragraph.
      units.push({
        text: normaliseWhitespace(block.map(stripBullet).join(' ')),
        children: [],
        kind: 'paragraph',
      });
    }
  }

  return units
    .filter(u => u.text)
    .slice(0, MAX_UNITS)
    .map((u, i) => ({ index: i + 1, ...u }));
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract classifiable units from an uploaded file.
 *
 * @param {{name: string, content: Buffer|Uint8Array|string}} file
 * @param {{loadZip?: Function}} [deps] - injectable JSZip, for tests
 * @returns {Promise<{units: Array, sourceName: string, format: string, wordCount: number}>}
 */
async function extractFromFile(file, deps = {}) {
  if (!file || !file.name) throw new Error('No file provided');

  const ext = extensionOf(file.name);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Cannot read ${ext || 'that file type'}. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}. ` +
      'PDF is not supported — export it to .docx or paste the text instead.',
    );
  }

  let lines;
  let preSplit = false;   // .docx already carries paragraph boundaries
  if (ext === '.docx') {
    const zip = await loadZip(file.content, deps);
    const entry = zip.file('word/document.xml');
    if (!entry) throw new Error('That .docx has no word/document.xml — it may be corrupt.');
    lines = paragraphsFromDocumentXml(await entry.async('string'));
    preSplit = true;
  } else if (ext === '.pptx') {
    const zip = await loadZip(file.content, deps);
    lines = [];
    // Slide files are slide1.xml, slide2.xml… and must be read in numeric order;
    // lexical order would put slide10 before slide2.
    const slideNames = Object.keys(zip.files)
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => slideNumber(a) - slideNumber(b));
    if (slideNames.length === 0) throw new Error('That .pptx contains no slides.');
    preSplit = true;
    for (const name of slideNames) {
      lines.push(...linesFromSlideXml(await zip.file(name).async('string')));
      lines.push(''); // slide boundary, so grouping never spans two slides
    }
  } else {
    lines = readPlainText(file.content).split(/\r?\n/);
  }

  const units = unitsFromLines(lines, { preSplit });
  if (units.length === 0) throw new Error('No text found in that file.');

  return {
    units,
    sourceName: file.name,
    format: ext.replace('.', ''),
    wordCount: countWords(units),
  };
}

/** Extract from text the user pasted directly. */
function extractFromText(text, sourceName = 'Pasted text') {
  const units = unitsFromLines(String(text || '').split(/\r?\n/));
  if (units.length === 0) throw new Error('No text to analyse.');
  return { units, sourceName, format: 'text', wordCount: countWords(units) };
}

function countWords(units) {
  return units.reduce((total, u) => {
    const text = [u.text, ...(u.children || [])].join(' ');
    return total + text.split(/\s+/).filter(Boolean).length;
  }, 0);
}

function slideNumber(name) {
  const m = name.match(/slide(\d+)\.xml$/);
  return m ? Number(m[1]) : 0;
}

async function loadZip(content, deps) {
  const JSZip = deps.loadZip || require('jszip');
  return JSZip.loadAsync(content);
}

module.exports = {
  extractFromFile,
  stripBullet,
  extractFromText,
  isSupportedFile,
  normaliseWhitespace,
  looksLikeOutline,
  unitsFromLines,
  paragraphsFromDocumentXml,
  linesFromSlideXml,
  decodeXmlEntities,
  SUPPORTED_EXTENSIONS,
  MAX_UNITS,
};
