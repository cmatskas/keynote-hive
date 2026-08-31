/**
 * storybrandElements.js — the canonical StoryBrand SB7 element definitions.
 *
 * WHY THIS LIVES IN SOURCE RATHER THAN IN THE SKILL
 * -------------------------------------------------
 * `skills/storybrand/SKILL.md` describes the same seven elements in prose, and
 * the obvious move is to keep the machine-readable copy beside it as JSON. That
 * does not survive contact with how skills are actually loaded:
 *
 *   - `SkillsManager._seedBundledSkills()` copies a bundled skill's directory
 *     into userData only when that skill's SKILL.md is *absent* there. Every
 *     existing Hive install already has `userData/skills/storybrand/SKILL.md`, so
 *     a newly added sibling file would never be copied for them — the tab would
 *     work on a fresh install and be broken on an upgrade.
 *   - Skills are user-editable from Settings. These values are load-bearing for
 *     rendering (they must agree with the CSS colour classes), so a user editing
 *     their copy of a skill should not be able to break the StoryBrand tab.
 *
 * So this module is the single source of truth for anything mechanical: element
 * keys, colours, and the copy shown in the explanation rail. SKILL.md remains the
 * human- and agent-facing guidance for Work/Chat audits and points here for the
 * canonical list.
 *
 * COLOURS
 * -------
 * The light hexes come from the reference design's palette. Gold is #C98A00
 * rather than the reference implementation's #F9A825 — the darker gold is what
 * the design spec specifies and it holds contrast on a light surface.
 *
 * Success is new. The reference implements six elements and notes Success as
 * "not in current color map"; teal was chosen because it is the only remaining
 * hue that reads as distinct from all six at a glance.
 *
 * Each element also carries a dark-theme hex. The light palette is tuned for
 * white and several entries (notably blue #1565C0 and purple #6A1B9A) fail
 * contrast on Hive's dark background, so the reading view swaps to lightened
 * variants under [data-theme="dark"] rather than dimming the whole surface.
 */

/**
 * Ordered as the story is told: a CHARACTER has a PROBLEM and meets a GUIDE who
 * gives them a PLAN and calls them to ACTION that helps them avoid FAILURE and
 * ends in SUCCESS.
 *
 * `key`   — the identifier the model returns, and the persisted value. Never
 *           change one without a migration; saved analyses store these.
 * `slug`  — the CSS colour class suffix (`sb-c-blue`), kept separate from `key`
 *           so a colour can be re-themed without rewriting stored data.
 */
const ELEMENTS = [
  {
    key: 'character',
    slug: 'blue',
    hex: '#1565C0',
    hexDark: '#64B5F6',
    label: 'Character',
    title: 'The Hero',
    tagline: 'The customer is always the hero, never your brand.',
    points: [
      'Identify who the hero is (your target audience).',
      'Define what they want — one clear, survival-related desire.',
      'Keep it simple: one desire per story. Multiple desires dilute the message.',
      'Tie the want to survival: money, time, status, relationships, health, security.',
    ],
  },
  {
    key: 'problem',
    slug: 'red',
    hex: '#D32F2F',
    hexDark: '#E57373',
    label: 'Problem',
    title: 'The Hook',
    tagline: 'The hook that opens the story gap. No problem, no story.',
    points: [
      'External problem — the tangible, surface-level challenge.',
      'Internal problem — how it makes them feel. This drives buying decisions.',
      'Philosophical problem — why it is just plain wrong this exists.',
      'Name a villain — a force or condition that is the root cause.',
    ],
  },
  {
    key: 'guide',
    slug: 'green',
    hex: '#2E7D32',
    hexDark: '#81C784',
    label: 'Guide',
    title: 'The Mentor',
    tagline: 'The brand enters as the mentor — Yoda, not Luke.',
    points: [
      'Empathy — show you understand how the problem feels.',
      'Authority — prove you can help: results, experience, social proof.',
      'Empathy first, authority second. Authority without empathy is arrogance.',
      'Keep it brief: just enough to earn trust, then move on.',
    ],
  },
  {
    key: 'plan',
    slug: 'gold',
    hex: '#C98A00',
    hexDark: '#FFD54F',
    label: 'Plan',
    title: 'The Path Forward',
    tagline: 'People don\u2019t buy what they don\u2019t understand.',
    points: [
      '3–4 steps maximum — simple enough to repeat from memory.',
      'Name the steps (e.g. Schedule → Get a plan → Launch).',
      'Removes confusion and perceived risk.',
      'Can be a process plan or an agreement plan that reduces fear.',
    ],
  },
  {
    key: 'cta',
    slug: 'orange',
    hex: '#E65100',
    hexDark: '#FFB74D',
    label: 'Call to Action',
    title: 'The Ask',
    tagline: 'Ask clearly. If you don\u2019t ask, they won\u2019t act.',
    points: [
      'Direct CTA — the primary ask, bold, obvious, repeated.',
      'Transitional CTA — a lower-commitment step that deepens the relationship.',
      'Direct CTAs should appear repeatedly — don\u2019t be shy.',
      'Clarity over cleverness — make the ask impossible to miss.',
    ],
  },
  {
    key: 'failure',
    slug: 'purple',
    hex: '#6A1B9A',
    hexDark: '#CE93D8',
    label: 'Stakes',
    title: 'Failure',
    tagline: 'What does the hero lose if they don\u2019t act? Without stakes, no urgency.',
    points: [
      'Paint what life looks like if they do nothing.',
      'Be specific: lost revenue, wasted investment, falling behind.',
      'Don\u2019t overdo fear — show the monster, don\u2019t dwell in the cave.',
      'This is what gives the plan its weight.',
    ],
  },
  {
    key: 'success',
    slug: 'teal',
    hex: '#00796B',
    hexDark: '#4DB6AC',
    label: 'Success',
    title: 'Transformation',
    tagline: 'People buy into a vision. Show them life on the other side.',
    points: [
      'Show the end result — what does the hero\u2019s world look like now?',
      'Show the identity shift — who does the hero become?',
      'Be vivid and specific — vague success doesn\u2019t motivate.',
      'Close the loop: the original desire is fulfilled, the problem resolved.',
    ],
  },
];

/** Valid element keys, for validating whatever the model returns. */
const ELEMENT_KEYS = ELEMENTS.map(e => e.key);

const BY_KEY = new Map(ELEMENTS.map(e => [e.key, e]));

/** Look up one element, or undefined for an unknown key. */
function elementByKey(key) {
  return BY_KEY.get(key);
}

/** Is this one of the seven? Used to reject unknown classifications. */
function isValidElementKey(key) {
  return typeof key === 'string' && BY_KEY.has(key);
}

/**
 * The compact element list handed to the model.
 *
 * Deliberately terse: the model needs the key, the name and a one-line meaning
 * to classify against. The full bullet points are for the reader, not the
 * classifier, and including them would bloat every request for no gain.
 */
function promptElementSummary() {
  return ELEMENTS
    .map(e => `- ${e.key} (${e.label}): ${e.tagline}`)
    .join('\n');
}

module.exports = {
  ELEMENTS,
  ELEMENT_KEYS,
  elementByKey,
  isValidElementKey,
  promptElementSummary,
};
