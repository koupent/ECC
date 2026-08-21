/**
 * Tests for the python rule pack (rules/python/*.md)
 *
 * Regression coverage for issue #72:
 *  1. coding-style.md must not hardcode black/isort — ruff-only projects have
 *     neither installed, so the rule demanded uninstallable tooling.
 *  2. fastapi.md path globs must match the common `api/` layout
 *     (api/main.py, api/routers/*.py, api/schemas.py), not just `app/`.
 *
 * Run with: node tests/rules/python-rule-pack.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RULES_DIR = path.resolve(__dirname, '..', '..', 'rules', 'python');

/** Locale mirrors of rules/python that must not contradict the source pack. */
const LOCALE_RULE_DIRS = ['es', 'ja-JP', 'tr', 'zh-CN'].map(locale =>
  path.resolve(__dirname, '..', '..', 'docs', locale, 'rules', 'python')
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
 * Extract the tool-resolution steps from coding-style.md's Formatting section.
 *
 * The section holds two ordered lists (formatter, then import sorter); this
 * returns one entry per numbered step, excluding the introductory prose.
 *
 * @param {string} source - coding-style.md contents
 * @returns {string[]} The numbered steps, in file order
 */
function parseFormattingSteps(source) {
  const start = source.indexOf('## Formatting');
  assert.notStrictEqual(start, -1, 'coding-style.md must have a Formatting section');

  const end = source.indexOf('Use **ruff** for linting', start);
  assert.notStrictEqual(end, -1, 'Formatting section must end with the linting rule');

  // Drop the leading chunk: prose before the first numbered step.
  return source.slice(start, end).split(/^\d+\.\s/m).slice(1);
}

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

  run('coding-style.md resolves formatter and import sorter independently', () => {
    const source = readRule(RULES_DIR, 'coding-style.md');
    assert.ok(
      /^Formatter:\s*$/m.test(source),
      'Formatting must resolve the formatter in its own list'
    );
    assert.ok(
      /^Import sorting:\s*$/m.test(source),
      'Formatting must resolve the import sorter in its own list'
    );

    // A step naming both tools would tell a black-only (or isort-only) project
    // to run a tool it does not depend on — the issue #72 regression.
    for (const step of parseFormattingSteps(source)) {
      assert.ok(
        !(/black/.test(step) && /isort/.test(step)),
        `no resolution step may require black and isort together: ${step.trim()}`
      );
    }
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

  // ── Summary ───────────────────────────────────────────────────

  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
