/**
 * awsText.js — make text safe for AWS resource metadata fields.
 *
 * Several AWS APIs constrain free-text fields (IAM role `Description`, AgentCore
 * `description`, and others) to this pattern:
 *
 *   [\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF]*
 *
 * That is: tab, newline, carriage return, printable ASCII, and the Latin-1
 * supplement. Notably **excluded** is everything in the U+2000 block — em and en
 * dashes, curly quotes, the ellipsis character, arrows — exactly the typography
 * that makes prose read well, and exactly what you get from writing a sentence
 * naturally.
 *
 * This shipped as a real failure: a brand-new install could not create the Web
 * Search Gateway role because its description contained an em dash, and AWS
 * rejected the whole CreateRole call with an opaque regex complaint. A second,
 * unhit instance was waiting in the AgentCore Memory description.
 *
 * Fixing the two strings was not enough on its own — the next person to write a
 * description will reach for an em dash again. Sanitising at the point of use
 * means the class of bug is closed rather than the instance.
 */

/** Characters AWS accepts in these fields. */
const AWS_TEXT_PATTERN = /^[\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF]*$/;

/**
 * Typography worth transliterating rather than deleting, so the text still reads
 * correctly after sanitising instead of losing punctuation entirely.
 */
const TRANSLITERATIONS = [
  [/[\u2010-\u2015]/g, '-'],      // hyphens, en dash, em dash, horizontal bar
  [/[\u2018\u2019\u201A\u201B]/g, "'"],
  [/[\u201C\u201D\u201E\u201F]/g, '"'],
  [/\u2026/g, '...'],
  [/[\u2192\u21D2]/g, '->'],
  [/[\u2190\u21D0]/g, '<-'],
  [/\u2022/g, '*'],
  [/\u00A0/g, ' '],               // non-breaking space: allowed by Latin-1 but a trap
  [/[\u2028\u2029]/g, '\n'],
];

/** Does this string already satisfy the AWS text constraint? */
function isAwsSafeText(value) {
  return typeof value === 'string' && AWS_TEXT_PATTERN.test(value);
}

/**
 * Convert text for an AWS metadata field: transliterate common typography, then
 * drop anything still outside the accepted range.
 *
 * Deliberately lossy rather than throwing. A description is cosmetic — failing a
 * resource creation over its punctuation is far worse than losing an emoji from
 * it, which is precisely the trade the original bug got backwards.
 *
 * @param {string} value
 * @returns {string}
 */
function toAwsText(value) {
  if (typeof value !== 'string') return '';
  let out = value;
  for (const [pattern, replacement] of TRANSLITERATIONS) {
    out = out.replace(pattern, replacement);
  }
  // Anything left outside the allowed set (emoji, CJK, control characters) goes.
  return out.replace(/[^\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF]/g, '');
}

module.exports = { toAwsText, isAwsSafeText, AWS_TEXT_PATTERN };
