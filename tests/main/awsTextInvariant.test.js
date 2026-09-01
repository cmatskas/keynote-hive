/**
 * Enforces the AWS free-text rule across the source, rather than against copies
 * of it.
 *
 * Background. A brand-new install could not create the Web Search Gateway because
 * the IAM role's `Description` contained an em dash:
 *
 *   ValidationError: Value at 'description' failed to satisfy constraint:
 *   Member must satisfy regular expression pattern: [\p{L}\p{M}\p{Z}\p{S}\p{N}\p{P}]*
 *
 * awsText.js fixed the mechanism, and awsText.test.js covers the transliteration
 * itself. But those tests assert against string literals *pasted into the test*,
 * so they verify a duplicate of the shipped text. Someone adding a third AWS
 * resource with a prose description — the natural thing to write, since em dashes
 * and curly quotes come free from any editor — would sail past a green suite,
 * exactly as the original did.
 *
 * So this file checks the source itself. Two rules:
 *
 *   1. Every free-text field inside an AWS SDK command construction must be
 *      wrapped in toAwsText(), which makes the failure impossible by construction
 *      rather than relying on whoever writes the next one to remember.
 *   2. The literals actually in the source — read from the source, not restated
 *      here — must survive that wrapping and come out AWS-safe.
 *
 * Deliberately scoped to `new *Command({ ... })` blocks. The codebase has a dozen
 * other `description:` fields, all tool schemas and pipeline templates that go to
 * a model rather than to AWS, where unicode is entirely fine and mangling it
 * would be a regression.
 */

const fs = require('fs');
const path = require('path');

const { toAwsText, isAwsSafeText } = require('../../src/main/awsText');

const SRC = path.join(__dirname, '..', '..', 'src', 'main');

/** Every .js file under src/main. */
function sourceFiles(dir = SRC, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

/**
 * Free-text fields inside `new SomethingCommand({ ... })` constructions.
 *
 * Brace-matched from the opening `({` rather than regex-scanned across the file,
 * so a `description:` belonging to a tool schema fifty lines below a command
 * cannot be mistaken for part of it.
 *
 * @returns {Array<{file, command, field, value, line}>}
 */
function awsTextFields() {
  const FIELDS = /^(Description|description|Name|name)$/;
  const found = [];

  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    const rel = path.relative(path.join(__dirname, '..', '..'), file);

    for (const match of source.matchAll(/new\s+(\w*Command)\s*\(\s*\{/g)) {
      const command = match[1];
      // Walk to the matching close brace.
      let depth = 0;
      let i = match.index + match[0].length - 1;
      const start = i;
      for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      const body = source.slice(start, i);

      for (const field of body.matchAll(/(\w+)\s*:\s*([^,\n]+)/g)) {
        const [, key, rawValue] = field;
        if (!FIELDS.test(key)) continue;
        found.push({
          file: rel,
          command,
          field: key,
          value: rawValue.trim(),
          line: source.slice(0, start + field.index).split('\n').length,
        });
      }
    }
  }
  return found;
}

describe('AWS free-text fields', () => {
  const fields = awsTextFields();

  test('the scan finds the known AWS command fields', () => {
    // A guard on the guard: if the scan silently matched nothing — a refactor,
    // a renamed command, a syntax it does not understand — every assertion below
    // would pass by vacuity and this file would be decoration.
    expect(fields.length).toBeGreaterThan(0);

    const commands = [...new Set(fields.map(f => f.command))];
    expect(commands).toContain('CreateRoleCommand');
    expect(commands).toContain('CreateMemoryCommand');
  });

  test('every free-text field is either wrapped or provably clean', () => {
    // The rule that makes the em-dash class impossible rather than merely fixed.
    // Constants and identifiers are accepted — a name pinned to a constant is not
    // prose someone will later reword. Note this covers `name` as well as
    // `Description`: AWS applies the same character constraint to both, and the
    // scan turned up two generated session names that had never been considered.
    const offenders = fields.filter(f => {
      if (f.value.startsWith('toAwsText(')) return false;
      // A bare identifier or member expression, e.g. WEB_SEARCH_ROLE_NAME.
      if (/^[A-Za-z_$][\w$.]*$/.test(f.value)) return false;
      // A JSON.stringify of a policy document is not free text.
      if (f.value.startsWith('JSON.stringify(')) return false;
      // A template literal whose own text is clean, e.g. `hive-${Date.now()}`.
      // Requiring toAwsText() around a generated session name would be noise, but
      // the static parts still have to hold: `Hive session — ${id}` must fail,
      // because that em dash reaches AWS exactly as the original one did.
      if (f.value.startsWith('`')) {
        const staticText = f.value.replace(/\$\{[^}]*\}/g, '').replace(/`/g, '');
        if (isAwsSafeText(staticText)) return false;
      }
      return true;
    });

    expect(offenders.map(o => `${o.file}:${o.line} ${o.command}.${o.field} = ${o.value}`)).toEqual([]);
  });

  test('the literals in the source survive toAwsText() as AWS-safe', () => {
    // Read out of the source rather than restated here. Restating them is what
    // made the existing coverage test a copy of the code instead of the code.
    const literals = fields
      .map(f => f.value.match(/^toAwsText\(\s*(['"])(.*)\1\s*\)$/))
      .filter(Boolean)
      .map(m => m[2]);

    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(isAwsSafeText(toAwsText(literal))).toBe(true);
    }
  });

  test('the shipped literals are already clean, so nothing is silently mangled', () => {
    // toAwsText is lossy by design — it drops what it cannot transliterate. That
    // is the right trade at runtime, but it means a description could be quietly
    // losing characters and still "pass". Ours should need no rescuing at all.
    const literals = fields
      .map(f => f.value.match(/^toAwsText\(\s*(['"])(.*)\1\s*\)$/))
      .filter(Boolean)
      .map(m => m[2]);

    for (const literal of literals) {
      expect(toAwsText(literal)).toBe(literal);
    }
  });
});
