/**
 * Tests for the python rule pack (rules/python/*.md)
 *
 * Regression coverage for issue #72:
 *  1. coding-style.md must not hardcode black/isort — ruff-only projects have
 *     neither installed, so the rule demanded uninstallable tooling. The same
 *     applies in reverse: a black/isort/flake8 project must not be told to run
 *     ruff, so formatter, import sorter, and linter resolve independently.
 *     Independence is checked against the rule's decision table, because
 *     `ruff` fills all three roles: having it in the dependencies must not
 *     decide the roles the project gave to another tool.
 *  2. fastapi.md path globs must match the common `api/` layout
 *     (api/main.py, api/routers/*.py, api/schemas.py), not just `app/`.
 *
 * The guidance reaches users through several surfaces, so all of them are
 * checked: the canonical pack, its locale mirrors, the Cursor rules (which the
 * Codex sync script re-exports as the python rule pack), and the
 * `python-patterns` skill the rules point at for details.
 *
 * Run with: node tests/rules/python-rule-pack.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RULES_DIR = path.join(REPO_ROOT, 'rules', 'python');
const CURSOR_RULES_DIR = path.join(REPO_ROOT, '.cursor', 'rules');
const CODEX_SYNC_SCRIPT = path.join(REPO_ROOT, 'scripts', 'sync-ecc-to-codex.sh');
const SKILL_FILE = path.join(REPO_ROOT, 'skills', 'python-patterns', 'SKILL.md');

const LOCALES = ['es', 'ja-JP', 'tr', 'zh-CN'];

/** Locale mirrors of rules/python that must not contradict the source pack. */
const LOCALE_RULE_DIRS = LOCALES.map(locale =>
  path.join(REPO_ROOT, 'docs', locale, 'rules', 'python')
);

/** Locale mirrors of the skill the python rules reference. */
const LOCALE_SKILL_FILES = LOCALES.map(locale =>
  path.join(REPO_ROOT, 'docs', locale, 'skills', 'python-patterns', 'SKILL.md')
);

/**
 * Run a single test case, printing pass/fail.
 *
 * @param {string} name - Test description
 * @param {() => void} fn - Test body (throws on failure)
 * @returns {boolean} Whether the test passed
 */
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

/**
 * Read a rule file as UTF-8 text.
 *
 * @param {string} dir - Directory holding the rule file
 * @param {string} name - File name, e.g. 'fastapi.md'
 * @returns {string} File contents
 */
function readRule(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

/**
 * Extract the `paths:` list from a rule file's YAML frontmatter.
 *
 * The frontmatter is intentionally minimal (a single `paths:` sequence of
 * quoted scalars), so a full YAML parser is not needed here.
 *
 * @param {string} source - Rule file contents
 * @returns {string[]} The declared path globs, in file order
 */
function parsePathGlobs(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  assert.ok(match, 'rule file must start with YAML frontmatter');

  const globs = [];
  let inPaths = false;
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (/^paths:\s*$/.test(rawLine)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;

    const item = /^\s+-\s+(.*)$/.exec(rawLine);
    if (!item) break; // end of the paths sequence
    globs.push(item[1].trim().replace(/^["']|["']$/g, ''));
  }
  return globs;
}

/**
 * Convert a rule path glob to a RegExp.
 *
 * Supports the subset the rule files use: `**` (any number of path segments),
 * `*` (any run of characters within a single segment) and literal text.
 * `path.matchesGlob` is not used because it requires Node 22.5+, while this
 * repo targets Node >=18.
 *
 * @param {string} glob - Glob such as `**\/api\/**\/*.py`
 * @returns {RegExp} Anchored matcher for POSIX-style relative paths
 */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more leading segments; bare `**` matches the rest.
        if (glob[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    out += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * Whether any of the globs matches the given path.
 *
 * @param {string[]} globs - Path globs from a rule file
 * @param {string} filePath - POSIX-style relative path
 * @returns {boolean} True when at least one glob matches
 */
function matchesAny(globs, filePath) {
  return globs.some(glob => globToRegExp(glob).test(filePath));
}

/**
 * Extract the inline `globs:` array from a Cursor rule's frontmatter.
 *
 * @param {string} source - Cursor rule file contents
 * @returns {string[]} The declared globs, in file order
 */
function parseCursorGlobs(source) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  assert.ok(frontmatter, 'cursor rule must start with YAML frontmatter');

  const globsLine = /^globs:\s*\[(.*)\]\s*$/m.exec(frontmatter[1]);
  assert.ok(globsLine, 'cursor rule must declare an inline globs array');

  return globsLine[1]
    .split(',')
    .map(entry => entry.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * Extract the tool-resolution lists from a Formatting section.
 *
 * The section holds one ordered list per tool role (formatter, import sorter,
 * linter). Wrapped continuation lines are folded back into their step so each
 * entry can be matched as a single condition/command pair.
 *
 * @param {string} source - Contents of a coding-style rule file
 * @returns {Record<string, string[]>} Steps keyed by the role heading
 */
function parseResolutionLists(source) {
  const start = source.indexOf('## Formatting');
  assert.notStrictEqual(start, -1, 'coding-style rule must have a Formatting section');

  const end = source.indexOf('When a rule here disagrees', start);
  assert.notStrictEqual(end, -1, 'Formatting section must end with the project-wins note');

  const lists = {};
  let current = null;

  for (const rawLine of source.slice(start, end).split(/\r?\n/)) {
    const heading = /^(Formatter|Import sorting|Linting):\s*$/.exec(rawLine);
    if (heading) {
      current = heading[1];
      lists[current] = [];
      continue;
    }
    if (!current) continue;

    const step = /^\d+\.\s+(.*)$/.exec(rawLine);
    if (step) {
      lists[current].push(step[1].trim());
      continue;
    }

    const continuation = /^\s{2,}(\S.*)$/.exec(rawLine);
    if (continuation && lists[current].length > 0) {
      lists[current][lists[current].length - 1] += ` ${continuation[1].trim()}`;
    }
  }

  return lists;
}

/**
 * Extract the worked-examples decision table from a Formatting section.
 *
 * The header row is dropped: only the data rows carry the resolution. Locale
 * mirrors translate the section heading, so they are scanned from the top of
 * the file — the worked examples are the only table these rules contain.
 *
 * @param {string} source - Contents of a coding-style rule file
 * @param {{requireSection?: boolean}} [options] - `requireSection: false` for mirrors
 * @returns {string[][]} Rows of trimmed cells, project column first
 */
function parseDecisionTable(source, { requireSection = true } = {}) {
  const start = source.indexOf('## Formatting');
  if (requireSection) {
    assert.notStrictEqual(start, -1, 'coding-style rule must have a Formatting section');
  }

  const rows = [];
  for (const rawLine of source.slice(Math.max(start, 0)).split(/\r?\n/)) {
    if (!rawLine.trimStart().startsWith('|')) {
      if (rows.length > 0) break; // the table ended
      continue;
    }

    const cells = rawLine.trim().split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.every(cell => /^-+$/.test(cell))) continue; // alignment row
    rows.push(cells);
  }

  assert.ok(rows.length > 1, 'Formatting section must document a decision table');
  return rows.slice(1);
}

/**
 * The resolution each documented project shape must reach, in table order:
 * `[formatter, import sorter, linter]`.
 *
 * The mixed rows are the issue #72 regression: `ruff` in the dependencies must
 * not drag every role over to ruff (`ruff format` leaves linting to `flake8`,
 * a ruff lint config leaves formatting to `black`), and the last row must stay
 * ruff-free for a project that never installed it.
 */
const DECISION_TABLE = [
  ['`ruff format`', '`ruff check --select I --fix`', '`ruff check`'],
  ['`ruff format`', '`ruff check --select I --fix`', '`flake8`'],
  ['`black`', '`ruff check --select I --fix`', '`ruff check`'],
  ['`black`', '`isort`', '`flake8`']
];

function runTests() {
  console.log('\n=== Testing python rule pack ===\n');

  let passed = 0;
  let failed = 0;

  function run(name, fn) {
    if (test(name, fn)) passed++;
    else failed++;
  }

  // ── glob helper sanity checks ─────────────────────────────────

  run('globToRegExp: **/ matches zero or more leading segments', () => {
    assert.ok(matchesAny(['**/api/**/*.py'], 'api/main.py'));
    assert.ok(matchesAny(['**/api/**/*.py'], 'services/api/main.py'));
  });

  run('globToRegExp: * does not cross segment boundaries', () => {
    assert.ok(!matchesAny(['**/*_api.py'], 'api/routers/users.py'));
    assert.ok(matchesAny(['**/*_api.py'], 'src/users_api.py'));
  });

  // ── issue #72 (1): formatter must follow the project ──────────

  run('coding-style.md does not mandate black/isort unconditionally', () => {
    const source = readRule(RULES_DIR, 'coding-style.md');
    const start = source.indexOf('## Formatting');
    assert.notStrictEqual(start, -1, 'coding-style.md must have a Formatting section');
    const formatting = source.slice(start);

    assert.ok(
      !/^-\s+\*\*black\*\* for code formatting$/m.test(formatting),
      'Formatting must not hardcode black as the formatter'
    );
    assert.ok(
      !/^-\s+\*\*isort\*\* for import sorting$/m.test(formatting),
      'Formatting must not hardcode isort as the import sorter'
    );
  });

  run('coding-style.md points ruff-configured projects at ruff format', () => {
    const formatting = readRule(RULES_DIR, 'coding-style.md');
    assert.ok(
      formatting.includes('[tool.ruff.format]'),
      'Formatting must key off pyproject.toml [tool.ruff.format]'
    );
    assert.ok(
      /ruff format/.test(formatting),
      'Formatting must name `ruff format` for ruff-configured projects'
    );
    assert.ok(
      /ruff check --select I/.test(formatting),
      'Formatting must name ruff import sorting for ruff-configured projects'
    );
  });

  run('coding-style.md still allows black/isort when the project uses them', () => {
    const formatting = readRule(RULES_DIR, 'coding-style.md');
    assert.ok(/black/.test(formatting) && /isort/.test(formatting));
  });

  run('coding-style.md resolves formatter, import sorter, and linter separately', () => {
    const lists = parseResolutionLists(readRule(RULES_DIR, 'coding-style.md'));

    assert.deepStrictEqual(
      Object.keys(lists),
      ['Formatter', 'Import sorting', 'Linting'],
      'Formatting must resolve each tool role in its own list'
    );

    for (const [role, steps] of Object.entries(lists)) {
      assert.ok(steps.length >= 3, `${role} must document a full resolution order`);

      // A step naming both tools would tell a black-only (or isort-only)
      // project to run a tool it does not depend on — the issue #72 regression.
      for (const step of steps) {
        assert.ok(
          !(/black/.test(step) && /isort/.test(step)),
          `no resolution step may require black and isort together: ${step}`
        );
      }
    }
  });

  run('coding-style.md never forces ruff on a black/isort/flake8 project', () => {
    const source = readRule(RULES_DIR, 'coding-style.md');
    const lists = parseResolutionLists(source);

    // Issue #72 in reverse: the project from the report has ruff only, but a
    // project with black + isort + flake8 must keep every role, so each list
    // has to offer that project's tool and the table has to land on it.
    assert.ok(
      lists.Formatter.some(step => /`black`/.test(step)),
      'Formatter must offer black to projects that use it'
    );
    assert.ok(
      lists['Import sorting'].some(step => /`isort`/.test(step)),
      'Import sorting must offer isort to projects that use it'
    );
    assert.ok(
      lists.Linting.some(step => /`flake8`|`pylint`/.test(step)),
      'Linting must offer a non-ruff linter'
    );

    const noRuffRow = parseDecisionTable(source).at(-1);
    assert.deepStrictEqual(
      noRuffRow.slice(1),
      ['`black`', '`isort`', '`flake8`'],
      'a project without ruff must resolve to its own tools for all three roles'
    );

    assert.ok(
      !/Use \*\*ruff\*\* for linting/.test(source),
      'Formatting must not mandate ruff linting unconditionally'
    );
  });

  run('coding-style.md decision table keeps each tool role independent', () => {
    const rows = parseDecisionTable(readRule(RULES_DIR, 'coding-style.md'));

    assert.deepStrictEqual(
      rows.map(row => row.slice(1)),
      DECISION_TABLE,
      'the worked examples must resolve every role from its own evidence'
    );

    // Bind each row to the project shape it is meant to answer, so the table
    // cannot keep passing while the scenarios drift.
    const [ruffOnly, ruffFlake8, ruffBlack, noRuff] = rows.map(row => row[0]);
    assert.ok(
      /`ruff`/.test(ruffOnly) && !/`black`|`isort`|`flake8`/.test(ruffOnly),
      `row 1 must describe a ruff-only project: ${ruffOnly}`
    );
    assert.ok(
      /`ruff`/.test(ruffFlake8) && /`flake8`/.test(ruffFlake8),
      `row 2 must describe a ruff + flake8 project: ${ruffFlake8}`
    );
    assert.ok(
      /`ruff`/.test(ruffBlack) && /`black`/.test(ruffBlack),
      `row 3 must describe a ruff + black project: ${ruffBlack}`
    );
    assert.ok(
      /`black`/.test(noRuff) && /`isort`/.test(noRuff) && /`flake8`/.test(noRuff),
      `row 4 must describe a black + isort + flake8 project: ${noRuff}`
    );
  });

  run('coding-style.md does not resolve a role from a bare ruff dependency', () => {
    const source = readRule(RULES_DIR, 'coding-style.md');
    const lists = parseResolutionLists(source);

    // The regression this test guards: `ruff` covers formatting, imports, and
    // linting, so "ruff is a dependency" as a standalone condition hands it
    // every role and silently overrides the tool the project configured.
    for (const [role, steps] of Object.entries(lists)) {
      for (const step of steps) {
        assert.ok(
          !/`ruff` is a dependency/.test(step),
          `${role} must not pick a tool from the bare ruff dependency: ${step}`
        );
      }
    }

    assert.ok(
      /`ruff` can fill all three roles/.test(source),
      'Formatting must say that ruff covers all three roles'
    );
    assert.ok(
      /single-purpose tool wins/.test(source),
      'Formatting must give single-purpose tools precedence over ruff per role'
    );
  });

  run('coding-style.md treats adding a tool as a dependency change', () => {
    const source = readRule(RULES_DIR, 'coding-style.md');
    const lists = parseResolutionLists(source);

    for (const [role, steps] of Object.entries(lists)) {
      const last = steps[steps.length - 1];
      assert.ok(
        /propose/.test(last),
        `${role}'s fallback must propose the new dependency instead of assuming it: ${last}`
      );
    }

    assert.ok(
      /changes the project's dependencies/.test(source),
      'Formatting must state that adding a tool is a dependency change'
    );
  });

  run('hooks.md does not prescribe a fixed python formatter', () => {
    const source = readRule(RULES_DIR, 'hooks.md');
    assert.ok(
      !/\*\*black\/ruff\*\*/.test(source),
      'hooks.md must defer to the project formatter instead of naming black/ruff'
    );
  });

  // ── issue #72 (2): fastapi globs must reach api/ layouts ──────

  run('fastapi.md globs match the api/ layout', () => {
    const globs = parsePathGlobs(readRule(RULES_DIR, 'fastapi.md'));
    for (const file of ['api/main.py', 'api/routers/users.py', 'api/schemas.py']) {
      assert.ok(matchesAny(globs, file), `${file} must match a fastapi.md glob`);
    }
  });

  run('fastapi.md globs still match the app/ layout', () => {
    const globs = parsePathGlobs(readRule(RULES_DIR, 'fastapi.md'));
    for (const file of ['app/main.py', 'app/routers/items.py', 'src/app/deps.py']) {
      assert.ok(matchesAny(globs, file), `${file} must match a fastapi.md glob`);
    }
  });

  run('fastapi.md globs match top-level routers/ and routes/', () => {
    const globs = parsePathGlobs(readRule(RULES_DIR, 'fastapi.md'));
    assert.ok(matchesAny(globs, 'routers/users.py'));
    assert.ok(matchesAny(globs, 'routes/health.py'));
  });

  run('fastapi.md globs stay scoped to python files', () => {
    const globs = parsePathGlobs(readRule(RULES_DIR, 'fastapi.md'));
    assert.ok(!matchesAny(globs, 'api/openapi.json'));
    assert.ok(!matchesAny(globs, 'tests/test_models.py'));
  });

  // ── locale mirrors must not contradict the source pack ───────

  run('locale coding-style mirrors do not hardcode black/isort', () => {
    for (const dir of LOCALE_RULE_DIRS) {
      const file = path.join(dir, 'coding-style.md');
      if (!fs.existsSync(file)) continue;

      const formatting = fs.readFileSync(file, 'utf8');
      assert.ok(
        formatting.includes('[tool.ruff.format]'),
        `${file} must key off pyproject.toml [tool.ruff.format]`
      );
      // Command strings survive translation, so they are safe to assert on.
      assert.ok(
        formatting.includes('ruff format'),
        `${file} must name \`ruff format\` for ruff-configured projects`
      );
      assert.ok(
        formatting.includes('ruff check --select I'),
        `${file} must name ruff import sorting for ruff-configured projects`
      );
      assert.ok(
        formatting.includes('flake8') || formatting.includes('pylint'),
        `${file} must offer a non-ruff linter for projects without ruff`
      );
    }
  });

  run('locale coding-style mirrors resolve tool roles like the source pack', () => {
    for (const dir of LOCALE_RULE_DIRS) {
      const file = path.join(dir, 'coding-style.md');
      if (!fs.existsSync(file)) continue;

      // Only the command columns are compared: the project column is prose and
      // gets translated, while the commands stay identical in every locale.
      assert.deepStrictEqual(
        parseDecisionTable(fs.readFileSync(file, 'utf8'), { requireSection: false })
          .map(row => row.slice(1)),
        DECISION_TABLE,
        `${file} must reach the same tool per role as rules/python/coding-style.md`
      );
    }
  });

  run('locale hooks mirrors do not prescribe a fixed formatter', () => {
    for (const dir of LOCALE_RULE_DIRS) {
      const file = path.join(dir, 'hooks.md');
      if (!fs.existsSync(file)) continue;

      const source = fs.readFileSync(file, 'utf8');
      assert.ok(
        !/\*\*black\/ruff\*\*/.test(source),
        `${file} must defer to the project formatter instead of naming black/ruff`
      );
    }
  });

  run('locale fastapi mirrors declare the same globs as the source pack', () => {
    const expected = parsePathGlobs(readRule(RULES_DIR, 'fastapi.md'));
    for (const dir of LOCALE_RULE_DIRS) {
      const file = path.join(dir, 'fastapi.md');
      if (!fs.existsSync(file)) continue;

      assert.deepStrictEqual(
        parsePathGlobs(fs.readFileSync(file, 'utf8')),
        expected,
        `${file} must declare the same path globs as rules/python/fastapi.md`
      );
    }
  });

  // ── referenced skill must not re-introduce fixed tooling ──────

  run('python-patterns skill defers tool choice to the project', () => {
    for (const file of [SKILL_FILE, ...LOCALE_SKILL_FILES]) {
      if (!fs.existsSync(file)) continue;

      const source = fs.readFileSync(file, 'utf8');
      assert.ok(
        source.includes('rules/python/coding-style.md'),
        `${file} must point at the coding-style resolution order`
      );
      // Every tool stays available; none of them is the unconditional default.
      for (const command of ['ruff format .', 'ruff check --select I --fix .', 'black .', 'isort .']) {
        assert.ok(
          source.includes(command),
          `${file} must keep ${command} available as a documented option`
        );
      }
    }
  });

  run('skills the changed rules reference do not hardcode black/isort', () => {
    // The rules are the always-on layer and the skills are their detail layer,
    // so a skill that still demands black/isort reproduces issue #72 for anyone
    // who follows the reference.
    const referencedSkills = { 'coding-style.md': 'python-patterns', 'fastapi.md': 'fastapi-patterns' };

    for (const [rule, skill] of Object.entries(referencedSkills)) {
      assert.ok(
        readRule(RULES_DIR, rule).includes(`See skill: \`${skill}\``),
        `rules/python/${rule} must reference the ${skill} skill`
      );

      const files = [
        path.join(REPO_ROOT, 'skills', skill, 'SKILL.md'),
        ...LOCALES.map(locale => path.join(REPO_ROOT, 'docs', locale, 'skills', skill, 'SKILL.md'))
      ];

      for (const file of files) {
        if (!fs.existsSync(file)) continue;

        const source = fs.readFileSync(file, 'utf8');
        assert.ok(
          !/pip install (?:black|isort)/.test(source),
          `${file} must not tell every project to install black/isort`
        );
        // Bare commands at the start of a line are unconditional instructions.
        assert.ok(
          !/^(?:black|isort) \.$/m.test(source),
          `${file} must not list black/isort as unconditional commands`
        );
        assert.ok(
          !/^\[tool\.black\]$/m.test(source),
          `${file} must not configure a second formatter alongside ruff`
        );
      }
    }
  });

  // ── Cursor / Codex surfaces must carry the same pack ──────────

  run('every python rule has a Cursor counterpart', () => {
    for (const file of fs.readdirSync(RULES_DIR)) {
      if (!file.endsWith('.md')) continue;

      const counterpart = path.join(CURSOR_RULES_DIR, `python-${file}`);
      assert.ok(
        fs.existsSync(counterpart),
        `rules/python/${file} must ship a Cursor rule at ${counterpart}`
      );
    }
  });

  run('Cursor python-coding-style.md matches the source resolution lists', () => {
    assert.deepStrictEqual(
      parseResolutionLists(readRule(CURSOR_RULES_DIR, 'python-coding-style.md')),
      parseResolutionLists(readRule(RULES_DIR, 'coding-style.md')),
      '.cursor/rules/python-coding-style.md must resolve tools like rules/python/coding-style.md'
    );
  });

  run('Cursor python-coding-style.md matches the source decision table', () => {
    assert.deepStrictEqual(
      parseDecisionTable(readRule(CURSOR_RULES_DIR, 'python-coding-style.md')),
      parseDecisionTable(readRule(RULES_DIR, 'coding-style.md')),
      '.cursor/rules/python-coding-style.md must document the same worked examples'
    );
  });

  run('Cursor python-hooks.md does not prescribe a fixed formatter', () => {
    assert.ok(
      !/\*\*black\/ruff\*\*/.test(readRule(CURSOR_RULES_DIR, 'python-hooks.md')),
      'Cursor hooks rule must defer to the project formatter'
    );
  });

  run('Cursor python-fastapi.md declares the source globs', () => {
    assert.deepStrictEqual(
      parseCursorGlobs(readRule(CURSOR_RULES_DIR, 'python-fastapi.md')),
      parsePathGlobs(readRule(RULES_DIR, 'fastapi.md')),
      '.cursor/rules/python-fastapi.md must match rules/python/fastapi.md globs'
    );
  });

  run('Codex python rule pack references every Cursor python rule', () => {
    const script = fs.readFileSync(CODEX_SYNC_SCRIPT, 'utf8');
    const cursorPythonRules = fs
      .readdirSync(CURSOR_RULES_DIR)
      .filter(file => file.startsWith('python-') && file.endsWith('.md'));

    assert.ok(cursorPythonRules.length > 0, 'expected Cursor python rules to exist');
    for (const file of cursorPythonRules) {
      assert.ok(
        script.includes(`$CURSOR_RULES_DIR/${file}`),
        `sync-ecc-to-codex.sh must list ${file} in the python rule pack`
      );
    }
  });

  // ── Summary ───────────────────────────────────────────────────

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
