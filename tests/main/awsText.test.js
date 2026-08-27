/**
 * Tests for awsText.js.
 *
 * Written after a real field failure: a brand-new install could not create the
 * Web Search Gateway role because its IAM `Description` contained an em dash, and
 * AWS rejected the entire CreateRole call with
 *
 *   Value at 'description' failed to satisfy constraint: Member must satisfy
 *   regular expression pattern: [\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF]*
 *
 * A second instance was waiting unhit in the AgentCore Memory description. The
 * pattern permits tab, newline, carriage return, printable ASCII and Latin-1 —
 * and excludes the whole U+2000 block, which is where em dashes, curly quotes and
 * ellipses live. In other words, writing a description in natural prose is enough
 * to break it.
 */

const { toAwsText, isAwsSafeText, AWS_TEXT_PATTERN } = require('../../src/main/awsText');

describe('the constraint itself', () => {
  test('matches the pattern AWS reported in the error', () => {
    expect(AWS_TEXT_PATTERN.source).toBe('^[\\u0009\\u000A\\u000D\\u0020-\\u007E\\u00A1-\\u00FF]*$');
  });

  test('accepts printable ASCII, tab and newlines', () => {
    expect(isAwsSafeText('Created by Hive Setup Check - plain ASCII 123 !?')).toBe(true);
    expect(isAwsSafeText('line one\nline two\tindented\r')).toBe(true);
  });

  test('accepts the Latin-1 supplement', () => {
    expect(isAwsSafeText('café £ ± é ÿ')).toBe(true);
  });

  test('rejects exactly what broke the install', () => {
    expect(isAwsSafeText('Created by Hive Setup Check — allows AgentCore Gateway')).toBe(false);
  });

  test('rejects the rest of the typography that reads well in prose', () => {
    for (const s of ['en–dash', 'curly ‘quotes’', 'curly “quotes”', 'ellipsis…', 'arrow →', 'bullet •']) {
      expect(isAwsSafeText(s)).toBe(false);
    }
  });

  test('is false for anything that is not a string', () => {
    expect(isAwsSafeText(undefined)).toBe(false);
    expect(isAwsSafeText(null)).toBe(false);
    expect(isAwsSafeText(42)).toBe(false);
  });
});

describe('toAwsText', () => {
  test('makes the exact failing description acceptable', () => {
    const original = 'Created by Hive Setup Check — allows AgentCore Gateway to run the Web Search Tool target';
    const safe = toAwsText(original);

    expect(isAwsSafeText(safe)).toBe(true);
    expect(safe).toBe('Created by Hive Setup Check - allows AgentCore Gateway to run the Web Search Tool target');
  });

  test('makes the memory description acceptable too', () => {
    const safe = toAwsText('Hive agent memory — stores conversation context and user preferences');
    expect(isAwsSafeText(safe)).toBe(true);
    expect(safe).toBe('Hive agent memory - stores conversation context and user preferences');
  });

  test('transliterates rather than deleting, so the text still reads', () => {
    // Stripping punctuation outright would leave "Setup Checkallows".
    expect(toAwsText('a—b')).toBe('a-b');
    expect(toAwsText('a–b')).toBe('a-b');
    expect(toAwsText('‘q’')).toBe("'q'");
    expect(toAwsText('“q”')).toBe('"q"');
    expect(toAwsText('wait…')).toBe('wait...');
    expect(toAwsText('a → b')).toBe('a -> b');
    expect(toAwsText('a ← b')).toBe('a <- b');
    expect(toAwsText('• item')).toBe('* item');
  });

  test('normalises a non-breaking space', () => {
    // Latin-1 permits it, but it is invisible and a common copy-paste trap.
    expect(toAwsText('a\u00A0b')).toBe('a b');
  });

  test('drops what cannot be transliterated', () => {
    expect(toAwsText('done ✅ really')).toBe('done  really');
    expect(toAwsText('日本語 text')).toBe(' text');
    expect(isAwsSafeText(toAwsText('⚠️ warning'))).toBe(true);
  });

  test('leaves already-safe text untouched', () => {
    const plain = 'Created by Hive Setup Check - allows AgentCore Gateway';
    expect(toAwsText(plain)).toBe(plain);
  });

  test('preserves permitted whitespace', () => {
    expect(toAwsText('one\ntwo\tthree')).toBe('one\ntwo\tthree');
  });

  test('returns an empty string for non-strings rather than throwing', () => {
    // A description is cosmetic; failing a resource creation over it would repeat
    // the original mistake.
    expect(toAwsText(undefined)).toBe('');
    expect(toAwsText(null)).toBe('');
    expect(toAwsText(123)).toBe('');
  });

  test('output always satisfies the constraint, whatever goes in', () => {
    for (const s of [
      'Created by Hive Setup Check — allows AgentCore Gateway',
      '🎵 transcription — done ✅',
      'ünïcödé ✓ mixed — 日本語 …',
      '\u0000\u0007control chars',
      '',
    ]) {
      expect(isAwsSafeText(toAwsText(s))).toBe(true);
    }
  });
});
