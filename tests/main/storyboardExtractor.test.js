/**
 * Tests for storyboardExtractor.
 *
 * The property that matters most is fidelity: the StoryBrand tab renders the
 * user's own keynote back to them with colours applied, so the text it displays
 * must come from the document and nowhere else. Extraction is therefore local —
 * no model, no Code Interpreter — and these tests pin that the words survive the
 * trip unchanged, including the awkward cases (a sentence split across formatting
 * runs, XML entities, hard line breaks) where a naive parser silently mangles them.
 *
 * The second property is stable positions. Classification is a mapping onto unit
 * indices, so indices must be contiguous, 1-based, and derived from document
 * structure.
 */

const {
  extractFromFile,
  extractFromText,
  isSupportedFile,
  looksLikeOutline,
  unitsFromLines,
  paragraphsFromDocumentXml,
  linesFromSlideXml,
  decodeXmlEntities,
  SUPPORTED_EXTENSIONS,
} = require('../../src/main/models/storyboardExtractor');

/** Minimal JSZip stand-in: a map of entry name -> XML string. */
function fakeZip(entries) {
  return {
    loadAsync: async () => ({
      files: Object.fromEntries(Object.keys(entries).map(k => [k, {}])),
      file: (name) => (entries[name] === undefined ? null : { async: async () => entries[name] }),
    }),
  };
}

const docxWith = (...paragraphs) => `
<w:document><w:body>
${paragraphs.join('\n')}
</w:body></w:document>`;

const wp = (...runs) => `<w:p>${runs.map(r => `<w:r><w:t>${r}</w:t></w:r>`).join('')}</w:p>`;

describe('file type support', () => {
  test('accepts the formats that can be read locally', () => {
    for (const ext of SUPPORTED_EXTENSIONS) {
      expect(isSupportedFile(`keynote${ext}`)).toBe(true);
    }
  });

  test('rejects PDF with an actionable message rather than failing obscurely', async () => {
    // There is no local PDF parser, and routing PDFs through Code Interpreter
    // would hand the text to a model before classification.
    await expect(extractFromFile({ name: 'keynote.pdf', content: Buffer.from('x') }))
      .rejects.toThrow(/PDF is not supported/);
  });

  test('is case-insensitive about extensions', () => {
    expect(isSupportedFile('KEYNOTE.DOCX')).toBe(true);
  });

  test('rejects a file with no name', async () => {
    await expect(extractFromFile(null)).rejects.toThrow(/No file provided/);
  });
});

describe('plain text and markdown', () => {
  test('splits prose into paragraphs on blank lines', () => {
    const { units } = extractFromText('First paragraph.\n\nSecond paragraph.\n\nThird.');

    expect(units.map(u => u.text)).toEqual(['First paragraph.', 'Second paragraph.', 'Third.']);
  });

  test('joins wrapped lines into one paragraph', () => {
    // A hard-wrapped script must not become one unit per line.
    const { units } = extractFromText('This sentence is\nwrapped across lines.\n\nNext.');

    expect(units).toHaveLength(2);
    expect(units[0].text).toBe('This sentence is wrapped across lines.');
  });

  test('keeps markdown headings as their own units', () => {
    const { units } = extractFromText('# Title\n\nBody text.\n\n## Chapter 1\n\nMore body.');

    expect(units.map(u => u.kind)).toEqual(['heading', 'paragraph', 'heading', 'paragraph']);
    expect(units[0].text).toBe('Title');
    expect(units[0].level).toBe(1);
    expect(units[2].level).toBe(2);
  });

  test('numbers units contiguously from 1', () => {
    const { units } = extractFromText('One.\n\nTwo.\n\nThree.');
    expect(units.map(u => u.index)).toEqual([1, 2, 3]);
  });

  test('counts words for the UI', () => {
    const { wordCount } = extractFromText('one two three\n\nfour five');
    expect(wordCount).toBe(5);
  });

  test('refuses empty input rather than producing an empty analysis', () => {
    expect(() => extractFromText('   \n\n  ')).toThrow(/No text to analyse/);
  });

  test('preserves the words exactly', () => {
    // Punctuation, casing, numbers and symbols all matter in a keynote.
    const original = 'Gartner says only 17% of organizations "succeeded" — despite 42% planning to.';
    const { units } = extractFromText(original);
    expect(units[0].text).toBe(original);
  });
});

describe('outline handling', () => {
  test('recognises a bulleted block as an outline', () => {
    expect(looksLikeOutline(['- one', '- two', '- three'])).toBe(true);
  });

  test('does not mistake prose for an outline', () => {
    // Misreading prose as an outline would merge unrelated paragraphs, which is
    // worse than leaving an outline ungrouped.
    expect(looksLikeOutline(['A full sentence here.', 'Another full sentence.'])).toBe(false);
  });

  test('needs more than one line to call something an outline', () => {
    expect(looksLikeOutline(['- lonely bullet'])).toBe(false);
  });

  test('collapses a top-level bullet and its children into one unit', () => {
    // Decision 11b: a bullet plus its children is one thing to classify, not four.
    const { units } = extractFromText([
      '- Focusing on the wrong problem',
      '    - Nobody agreed it was worth solving',
      '    - The money was already gone',
      '- Cannot measure whether it works',
    ].join('\n'));

    expect(units).toHaveLength(2);
    expect(units[0].text).toBe('Focusing on the wrong problem');
    expect(units[0].children).toEqual([
      'Nobody agreed it was worth solving',
      'The money was already gone',
    ]);
    expect(units[1].text).toBe('Cannot measure whether it works');
  });

  test('keeps child text verbatim so the reading view can show the nesting', () => {
    const { units } = extractFromText('- Parent\n  - Child with 42% and "quotes"');
    expect(units[0].children[0]).toBe('Child with 42% and "quotes"');
  });

  test('handles numbered and symbol bullets', () => {
    const { units } = extractFromText('1. First\n2. Second\n3. Third');
    expect(units.map(u => u.text)).toEqual(['First', 'Second', 'Third']);
  });

  test('a heading is never absorbed as a bullet child', () => {
    const { units } = extractFromText('- Parent\n  - Child\n\n# New Section\n\n- Another parent');

    const heading = units.find(u => u.kind === 'heading');
    expect(heading.text).toBe('New Section');
    expect(units[0].children).toEqual(['Child']);
  });

  test('handles prose and outline blocks in the same document', () => {
    // A real keynote deck interleaves both.
    const units = unitsFromLines([
      'An opening paragraph of prose.',
      '',
      '- bullet one',
      '- bullet two',
      '',
      'A closing paragraph of prose.',
    ]);

    expect(units.map(u => u.text)).toEqual([
      'An opening paragraph of prose.',
      'bullet one',
      'bullet two',
      'A closing paragraph of prose.',
    ]);
  });
});

describe('.docx extraction', () => {
  test('reads one unit per w:p', async () => {
    const zip = fakeZip({
      'word/document.xml': docxWith(wp('First paragraph.'), wp('Second paragraph.')),
    });

    const { units, format } = await extractFromFile(
      { name: 'keynote.docx', content: Buffer.from('zip') },
      { loadZip: zip },
    );

    expect(format).toBe('docx');
    expect(units.map(u => u.text)).toEqual(['First paragraph.', 'Second paragraph.']);
  });

  test('reassembles a sentence split across formatting runs', async () => {
    // Word splits a run wherever formatting changes, so a single sentence with one
    // bold word arrives in three pieces. Joining them wrongly is how text gets
    // silently mangled.
    const zip = fakeZip({
      'word/document.xml': docxWith(wp('The technology was never the ', 'problem', '. The governance was.')),
    });

    const { units } = await extractFromFile(
      { name: 'k.docx', content: Buffer.from('z') },
      { loadZip: zip },
    );

    expect(units[0].text).toBe('The technology was never the problem. The governance was.');
  });

  test('turns a hard line break into a space rather than gluing words together', async () => {
    const zip = fakeZip({
      'word/document.xml': `<w:p><w:r><w:t>First line</w:t></w:r><w:br/><w:r><w:t>second line</w:t></w:r></w:p>`,
    });

    const { units } = await extractFromFile(
      { name: 'k.docx', content: Buffer.from('z') },
      { loadZip: zip },
    );

    expect(units[0].text).toBe('First line second line');
  });

  test('decodes XML entities', async () => {
    const zip = fakeZip({
      'word/document.xml': docxWith(wp('Profit &amp; loss &lt;critical&gt; &quot;now&quot;')),
    });

    const { units } = await extractFromFile(
      { name: 'k.docx', content: Buffer.from('z') },
      { loadZip: zip },
    );

    expect(units[0].text).toBe('Profit & loss <critical> "now"');
  });

  test('skips empty paragraphs', async () => {
    const zip = fakeZip({
      'word/document.xml': docxWith(wp('Real text.'), '<w:p/>', wp('   '), wp('More text.')),
    });

    const { units } = await extractFromFile(
      { name: 'k.docx', content: Buffer.from('z') },
      { loadZip: zip },
    );

    expect(units.map(u => u.text)).toEqual(['Real text.', 'More text.']);
  });

  test('reports a corrupt docx clearly', async () => {
    await expect(extractFromFile(
      { name: 'k.docx', content: Buffer.from('z') },
      { loadZip: fakeZip({}) },
    )).rejects.toThrow(/no word\/document\.xml/);
  });

  test('ignores revision marks and styling', async () => {
    const zip = fakeZip({
      'word/document.xml':
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Bold heading</w:t></w:r></w:p>',
    });

    const { units } = await extractFromFile(
      { name: 'k.docx', content: Buffer.from('z') },
      { loadZip: zip },
    );

    expect(units[0].text).toBe('Bold heading');
  });
});

describe('.pptx extraction', () => {
  const slide = (...lines) =>
    `<p:sld><p:cSld><p:spTree>${lines
      .map(l => (typeof l === 'string'
        ? `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`
        : `<a:p><a:pPr lvl="${l.lvl}"/><a:r><a:t>${l.text}</a:t></a:r></a:p>`))
      .join('')}</p:spTree></p:cSld></p:sld>`;

  test('reads slides in numeric, not lexical, order', async () => {
    // slide10 must not sort before slide2.
    const entries = {};
    for (let i = 1; i <= 11; i++) entries[`ppt/slides/slide${i}.xml`] = slide(`Slide ${i} text.`);

    const { units } = await extractFromFile(
      { name: 'deck.pptx', content: Buffer.from('z') },
      { loadZip: fakeZip(entries) },
    );

    expect(units.map(u => u.text)).toEqual(
      Array.from({ length: 11 }, (_, i) => `Slide ${i + 1} text.`),
    );
  });

  test('preserves slide bullet nesting as outline structure', async () => {
    const entries = {
      'ppt/slides/slide1.xml': slide(
        { lvl: 0, text: 'Five root causes' },
        { lvl: 1, text: 'Wrong problem' },
        { lvl: 1, text: 'No measurement' },
      ),
    };

    const { units } = await extractFromFile(
      { name: 'deck.pptx', content: Buffer.from('z') },
      { loadZip: fakeZip(entries) },
    );

    expect(units).toHaveLength(1);
    expect(units[0].text).toBe('Five root causes');
    expect(units[0].children).toEqual(['Wrong problem', 'No measurement']);
  });

  test('never groups across a slide boundary', async () => {
    const entries = {
      'ppt/slides/slide1.xml': slide({ lvl: 0, text: 'Slide one parent' }),
      'ppt/slides/slide2.xml': slide({ lvl: 1, text: 'Slide two child-looking line' }),
    };

    const { units } = await extractFromFile(
      { name: 'deck.pptx', content: Buffer.from('z') },
      { loadZip: fakeZip(entries) },
    );

    expect(units).toHaveLength(2);
    expect(units[0].children).toEqual([]);
  });

  test('reports a deck with no slides', async () => {
    await expect(extractFromFile(
      { name: 'deck.pptx', content: Buffer.from('z') },
      { loadZip: fakeZip({ 'ppt/presentation.xml': '<x/>' }) },
    )).rejects.toThrow(/no slides/);
  });
});

describe('helpers', () => {
  test('decodeXmlEntities does not double-decode an escaped entity', () => {
    // &amp;lt; is a literal "&lt;", not a less-than sign.
    expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;');
  });

  test('paragraphsFromDocumentXml tolerates xml with no paragraphs', () => {
    expect(paragraphsFromDocumentXml('<w:document/>')).toEqual([]);
  });

  test('linesFromSlideXml tolerates a slide with no text', () => {
    expect(linesFromSlideXml('<p:sld/>')).toEqual([]);
  });
});
