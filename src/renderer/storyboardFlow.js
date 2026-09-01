/**
 * Turns a classified script into the sequence of runs the flow ribbon draws.
 *
 * Shared by the StoryBrand tab and the standalone HTML export, which each have
 * their own rendering but must agree on the shape of the story. Pure — no DOM, no
 * IPC — so it can be tested directly and reused by the export, which has no
 * access to the main process at all.
 *
 * Why runs rather than one segment per paragraph: a real keynote is 70+
 * paragraphs, which would draw 70 hairline slivers and read as noise. Grouping
 * consecutive paragraphs that share an element produces the chapters a reader
 * actually experiences, and makes the arc legible at a glance.
 *
 * Why width by word count rather than paragraph count: for a script, words are
 * roughly stage time. A 400-word Problem section and a 20-word one are both "one
 * paragraph", and showing them the same size would misrepresent the talk.
 */
(() => {
  'use strict';

  /** Words in a unit, including any outline children. */
  function unitWords(unit) {
    const parts = [unit.text || '', ...(unit.children || [])];
    return parts.join(' ').split(/\s+/).filter(Boolean).length;
  }

  /**
   * @param {Array}  units           - extractor units, in document order
   * @param {object} classifications - unit index (1-based) → element key
   * @returns {Array} runs, in document order. Each:
   *   { key, startIndex, endIndex, paragraphs, words, share }
   *   `key` is null for a unit with no classification. Those are kept rather than
   *   dropped: skipping them would leave the widths not summing to the whole and
   *   silently shift every later run's position, which is worse than showing a
   *   neutral gap honestly.
   */
  function buildFlow(units, classifications) {
    if (!Array.isArray(units) || units.length === 0) return [];
    const byIndex = classifications || {};

    const runs = [];
    for (const unit of units) {
      const key = byIndex[unit.index] || byIndex[String(unit.index)] || null;
      const words = unitWords(unit);
      const last = runs[runs.length - 1];

      if (last && last.key === key) {
        last.endIndex = unit.index;
        last.paragraphs += 1;
        last.words += words;
      } else {
        runs.push({
          key,
          startIndex: unit.index,
          endIndex: unit.index,
          paragraphs: 1,
          words,
        });
      }
    }

    // Share is of total words, so the ribbon's widths are meaningful. Falls back
    // to paragraph share when a script somehow has no words at all, rather than
    // dividing by zero and rendering nothing.
    const totalWords = runs.reduce((sum, r) => sum + r.words, 0);
    const totalParas = runs.reduce((sum, r) => sum + r.paragraphs, 0);
    for (const run of runs) {
      run.share = totalWords > 0 ? run.words / totalWords : run.paragraphs / totalParas;
    }
    return runs;
  }

  /**
   * Which run contains a given unit index — used to highlight the segment being
   * read as the user scrolls.
   *
   * @returns {number} index into `runs`, or -1
   */
  function runIndexForUnit(runs, unitIndex) {
    if (!Array.isArray(runs)) return -1;
    return runs.findIndex(r => unitIndex >= r.startIndex && unitIndex <= r.endIndex);
  }

  const api = { buildFlow, runIndexForUnit, unitWords };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.StoryboardFlow = api;
})();
