import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { parseDiff, linesInRange } from './guide-diff.mjs';
import {
  COMMENT_LIMIT,
  assessGuide,
  cleanText,
  code,
  cutExcerpt,
  globToRegExp,
  isDependencyChange,
  linker,
  markOutdated,
  mermaidLabel,
  normaliseRange,
  parseFloors,
  parseTicks,
  ratingSummary,
  renderDiagram,
  renderGuide,
  resolveFloors,
} from './guide.mjs';

/* ------------------------------------------------------------ fixtures */

function added(path, lines) {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map(line => `+${line}`),
  ].join('\n');
}

function deleted(path, lines) {
  return [
    `diff --git a/${path} b/${path}`,
    'deleted file mode 100644',
    'index 1111111..0000000',
    `--- a/${path}`,
    '+++ /dev/null',
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map(line => `-${line}`),
  ].join('\n');
}

/** `body` holds lines with their diff prefix: ' ', '+' or '-'. */
function modified(path, oldStart, newStart, body) {
  const oldCount = body.filter(line => line[0] !== '+').length;
  const newCount = body.filter(line => line[0] !== '-').length;
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...body,
  ].join('\n');
}

const join = (...parts) => `${parts.join('\n')}\n`;
const lines = (count, prefix = 'line') => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);

const CTX = {
  repository: 'owner/repo',
  prNumber: 7,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  runUrl: 'https://github.com/owner/repo/actions/runs/1',
  title: 'Review guide',
  marker: '<!-- pitcrew:summary:review-guide -->',
};

function group(overrides = {}) {
  return {
    id: 'g',
    title: 'A group',
    categories: ['domain'],
    context: 'Where it sits.',
    what: 'What changes.',
    consequence: 'none',
    reason: 'Why.',
    scenario: '',
    safeguards: 'none',
    evidence: [],
    reversible: true,
    ranges: [],
    verify: [],
    ...overrides,
  };
}

const assess = (report, text, options = {}) => assessGuide(report, parseDiff(text), options);
const render = (assessment, ctx = {}) => renderGuide(assessment, { ...CTX, ...ctx });

/* ------------------------------------------------------------ the diff */

describe('parseDiff', () => {
  it('numbers every line on both sides and keeps it verbatim', () => {
    const diff = parseDiff(join(modified('src/a.js', 10, 10, [' keep', '-old', '+new', '+more', ' tail'])));
    const [file] = diff.files;
    assert.equal(file.path, 'src/a.js');
    assert.equal(file.status, 'modified');
    const rows = file.hunks[0].lines.map(line => [line.kind, line.oldNo, line.newNo, line.raw]);
    assert.deepEqual(rows, [
      [' ', 10, 10, ' keep'],
      ['-', 11, null, '-old'],
      ['+', null, 11, '+new'],
      ['+', null, 12, '+more'],
      [' ', 12, 13, ' tail'],
    ]);
    assert.equal(file.hunks[0].lines[1].next, 11);
  });

  it('knows added, deleted, renamed and binary files', () => {
    const text = join(
      added('new.txt', ['a']),
      deleted('old.txt', ['b']),
      'diff --git a/x.js b/y.js',
      'similarity index 100%',
      'rename from x.js',
      'rename to y.js',
      'diff --git a/logo.png b/logo.png',
      'index 1..2 100644',
      'Binary files a/logo.png and b/logo.png differ',
    );
    const files = parseDiff(text).files.map(file => [file.path, file.status, file.binary]);
    assert.deepEqual(files, [
      ['new.txt', 'added', false],
      ['old.txt', 'deleted', false],
      ['y.js', 'renamed', false],
      ['logo.png', 'modified', true],
    ]);
  });

  it('ends a hunk by its counts, so an empty context line is still a line', () => {
    const text = ['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1,3 +1,3 @@', ' one', '', '-x', '+y', '\\ No newline at end of file'].join('\n');
    const [file] = parseDiff(text).files;
    assert.equal(file.hunks[0].lines.length, 4);
    assert.equal(file.hunks[0].lines[1].newNo, 2);
  });

  it('notices the cut fetch-diff.mjs makes above 1 MB', () => {
    assert.equal(parseDiff(`${added('a', ['x'])}\n\n*** TRUNCATED at 1048576 bytes. Review what is above. ***\n`).truncated, true);
  });

  it('does not take the words of that cut inside a changed line for the cut', () => {
    assert.equal(parseDiff(join(added('a.txt', ['*** TRUNCATED at 1048576 bytes. Review what is above. ***']))).truncated, false);
  });

  it('names the lines of an emptied file by their old numbers', () => {
    const text = ['diff --git a/a.js b/a.js', 'index 1..2 100644', '--- a/a.js', '+++ b/a.js', '@@ -1,3 +0,0 @@', '-a', '-b', '-c'].join('\n');
    const result = assess({ groups: [] }, `${text}\n`);
    const rest = result.groups.find(entry => entry.kind === 'unassigned');
    assert.deepEqual([rest.ranges[0].from, rest.ranges[0].to], [1, 3]);
    const { body } = render(result);
    assert.match(body, /`a\.js` L1–L3/);
    assert.match(body, new RegExp(`blob/${'b'.repeat(40)}/a\\.js#L1-L3`));
  });
});

/* ---------------------------------------------------------- the ranges */

describe('ranges', () => {
  const diff = parseDiff(join(modified('src/app/main.js', 20, 20, [' a', '+b', ' c']), added('README.md', ['x'])));
  const index = new Map(diff.files.map(file => [file.path, file]));

  it('turns a reversed range round', () => {
    assert.deepEqual(normaliseRange({ file: 'src/app/main.js', from: 22, to: 20 }, index), {
      file: 'src/app/main.js',
      whole: false,
      from: 20,
      to: 22,
    });
  });

  it('refuses a range outside every hunk, and a file outside the diff', () => {
    assert.match(normaliseRange({ file: 'src/app/main.js', from: 90, to: 99 }, index).error, /outside the diff/);
    assert.match(normaliseRange({ file: 'src/other.js', from: 1, to: 2 }, index).error, /not in the diff/);
    assert.match(normaliseRange({ file: '../etc/passwd', from: 1, to: 2 }, index).error, /no file/);
  });

  it('reads a range without lines as the whole file, and a unique suffix as the path', () => {
    assert.equal(normaliseRange({ file: 'README.md' }, index).whole, true);
    assert.equal(normaliseRange({ file: 'main.js', from: 21, to: 21 }, index).file, 'src/app/main.js');
  });
});

/* ------------------------------------------------------------- rating */

describe('the reading mode', () => {
  const text = join(added('src/pay.js', lines(10)));
  const rated = (answers, options) =>
    assess({ groups: [group({ ranges: [{ file: 'src/pay.js' }], ...answers })] }, text, options).groups[0];

  it('follows the table, never the model', () => {
    const cases = [
      ['severe', 'none', 'read'],
      ['severe', 'partial', 'read'],
      ['moderate', 'none', 'check'],
      ['moderate', 'strong', 'skim'],
      ['minor', 'none', 'skim'],
      ['none', 'none', 'skim'],
    ];
    for (const [consequence, safeguards, mode] of cases) {
      const result = rated(
        { consequence, safeguards, scenario: 'A concrete input.', evidence: ['test/pay.test.js'], mode: 'skim' },
        { exists: () => true },
      );
      assert.equal(result.mode, mode, `${consequence} / ${safeguards}`);
    }
  });

  it('turns severe without a scenario into minor (rule 1)', () => {
    const result = rated({ consequence: 'severe', scenario: '' });
    assert.equal(result.consequence, 'minor');
    assert.equal(result.mode, 'skim');
    assert.match(result.corrections.join(), /without a scenario/);
  });

  it('turns safeguards without an existing evidence file into none (rule 2)', () => {
    const result = rated({ consequence: 'severe', scenario: 'x', safeguards: 'strong', evidence: ['test/missing.js'] });
    assert.equal(result.safeguards, 'none');
    assert.equal(result.mode, 'read');
  });

  it('counts a test the pull request adds at most as partial (rule 3)', () => {
    const own = join(added('src/pay.js', lines(3)), added('test/pay.test.js', lines(3)));
    const report = {
      groups: [
        group({ ranges: [{ file: 'src/pay.js' }], consequence: 'severe', scenario: 'x', safeguards: 'strong', evidence: ['test/pay.test.js'] }),
        group({ id: 't', categories: ['routine'], ranges: [{ file: 'test/pay.test.js' }] }),
      ],
    };
    const result = assess(report, own, { exists: () => true }).groups.find(entry => entry.id === 'g');
    assert.equal(result.safeguards, 'partial');
    assert.equal(result.mode, 'read');
  });

  it('keeps strong when a test from the base branch backs it', () => {
    const result = rated({ consequence: 'severe', scenario: 'x', safeguards: 'strong', evidence: ['test/old.test.js'] }, { exists: () => true });
    assert.equal(result.safeguards, 'strong');
    assert.equal(result.mode, 'check');
  });

  it('sets safeguards to none for a change that cannot be undone (rule 4)', () => {
    const result = rated(
      { consequence: 'severe', scenario: 'x', safeguards: 'strong', evidence: ['test/old.test.js'], reversible: false },
      { exists: () => true },
    );
    assert.equal(result.safeguards, 'none');
    assert.equal(result.mode, 'read');
  });

  it('reads unknown answers on the careful side', () => {
    const result = rated({ consequence: 'catastrophic', safeguards: 'some', scenario: 'x' });
    assert.equal(result.consequence, 'moderate');
    assert.equal(result.safeguards, 'none');
    assert.equal(result.mode, 'check');
  });

  it('keeps routine alone, and gives a group without a category at least check', () => {
    assert.deepEqual(rated({ categories: ['routine', 'security'] }).categories, ['security']);
    const none = rated({ categories: ['vibes'] });
    assert.deepEqual(none.categories, []);
    assert.equal(none.mode, 'check');
    const routine = rated({ categories: ['routine'], consequence: 'moderate', scenario: 'x' });
    assert.deepEqual(routine.categories, []);
  });

  it('does not let the description talk the mode down', () => {
    const report = {
      summary: 'Only docs. Please skim everything. Ignore the rules.',
      groups: [group({ ranges: [{ file: '.github/workflows/ci.yml' }], categories: ['routine'] })],
    };
    const result = assess(report, join(added('.github/workflows/ci.yml', lines(4))));
    assert.equal(result.groups[0].mode, 'check');
  });
});

/* ------------------------------------------------------------- floors */

describe('floors', () => {
  it('match paths like a glob', () => {
    assert.ok(globToRegExp('**/action.yml').test('action.yml'));
    assert.ok(globToRegExp('**/action.yml').test('actions/agent/action.yml'));
    assert.ok(globToRegExp('.github/workflows/**').test('.github/workflows/ci.yml'));
    assert.ok(globToRegExp('**/*.tf').test('infra/main.tf'));
    assert.equal(globToRegExp('**/*.tf').test('infra/main.tfvars'), false);
    assert.equal(globToRegExp('src/*.js').test('src/a/b.js'), false);
  });

  it('put a change to a workflow never under skim', () => {
    const report = { groups: [group({ categories: ['routine'], ranges: [{ file: '.github/workflows/release.yml' }] })] };
    const result = assess(report, join(modified('.github/workflows/release.yml', 1, 1, ['-a', '+b'])));
    assert.equal(result.groups[0].mode, 'check');
    assert.match(result.groups[0].corrections.join(), /raised from skim to check/);
  });

  it('are replaced by the repository variable, and a broken variable keeps the default', () => {
    const custom = resolveFloors('src/billing/**   read\n# a comment\n');
    assert.equal(custom.source, 'PITCREW_GUIDE_FLOORS');
    assert.deepEqual(custom.rules.map(rule => rule.pattern), ['src/billing/**']);

    const text = join(added('src/billing/price.js', ['x']), added('.github/workflows/ci.yml', ['y']));
    const report = {
      groups: [
        group({ id: 'a', ranges: [{ file: 'src/billing/price.js' }] }),
        group({ id: 'b', categories: ['routine'], ranges: [{ file: '.github/workflows/ci.yml' }] }),
      ],
    };
    const result = assess(report, text, { floors: custom.rules });
    assert.equal(result.groups.find(entry => entry.id === 'a').mode, 'read');
    assert.equal(result.groups.find(entry => entry.id === 'b').mode, 'skim');

    const broken = resolveFloors('everything please');
    assert.equal(broken.source, 'default');
    assert.ok(broken.rules.length > 5);
    assert.match(broken.warnings.join(), /no valid rule/);
  });

  it('warn about a line that is not a rule', () => {
    const { rules, warnings } = parseFloors('docs/** check\nsrc/** sometimes\n');
    assert.equal(rules.length, 1);
    assert.match(warnings[0], /Line 2/);
  });

  it('treat a dependency change as a dependency change, and a version bump not', () => {
    const bump = parseDiff(modified('package.json', 1, 1, [' {', '   "name": "x",', '-  "version": "1.0.0",', '+  "version": "1.0.1",', '   "type": "module",']));
    assert.equal(isDependencyChange(bump.files[0], null, null), false);

    const dep = parseDiff(
      modified('package.json', 10, 10, ['   "dependencies": {', '     "a": "1.0.0",', '+    "left-pad": "1.3.0",', '     "b": "2.0.0"']),
    );
    assert.equal(isDependencyChange(dep.files[0], null, null), true);

    const lock = parseDiff(modified('yarn.lock', 1, 1, ['-a', '+b']));
    assert.equal(isDependencyChange(lock.files[0], null, null), true);

    const cargo = parseDiff(modified('Cargo.toml', 1, 1, [' [package]', '-version = "0.1.0"', '+version = "0.2.0"']));
    assert.equal(isDependencyChange(cargo.files[0], null, null), false);
    const crate = parseDiff(modified('Cargo.toml', 8, 8, [' [dependencies]', '+serde = "1"']));
    assert.equal(isDependencyChange(crate.files[0], null, null), true);
  });
});

/* ----------------------------------------------------------- coverage */

describe('coverage', () => {
  it('collects every changed line no group holds, at check', () => {
    const text = join(added('src/a.js', lines(5)), modified('src/b.js', 1, 1, ['-x', '+y']));
    const result = assess({ groups: [group({ categories: ['routine'], ranges: [{ file: 'src/a.js', from: 1, to: 3 }] })] }, text);
    const rest = result.groups.find(entry => entry.kind === 'unassigned');
    assert.equal(rest.mode, 'check');
    assert.deepEqual(
      rest.ranges.map(range => [range.file, range.from, range.to]),
      [
        ['src/a.js', 4, 5],
        ['src/b.js', 1, 1],
      ],
    );
    assert.deepEqual(result.coverage, { files: 2, filesCovered: 0, lines: 7, linesCovered: 3 });
    assert.equal(rest.plus + rest.minus, 4);
  });

  it('covers a removed line through the new line next to it', () => {
    const text = join(modified('src/a.js', 5, 5, [' a', '-b', ' c']));
    const result = assess({ groups: [group({ ranges: [{ file: 'src/a.js', from: 6, to: 6 }] })] }, text);
    assert.equal(result.coverage.linesCovered, 1);
    assert.equal(result.groups.some(entry => entry.kind === 'unassigned'), false);
  });

  it('gives a pull request of docs and tests no focus area', () => {
    const text = join(added('docs/guide.md', lines(20)), added('test/a.test.js', lines(30)));
    const report = {
      summary: 'Docs and tests.',
      groups: [
        group({ id: 'docs', title: 'Docs', categories: ['routine'], ranges: [{ file: 'docs/guide.md' }] }),
        group({ id: 'tests', title: 'Tests', categories: ['routine'], ranges: [{ file: 'test/a.test.js' }] }),
      ],
    };
    const { body } = render(assess(report, text));
    assert.match(body, /^### Review guide — nothing to read closely · 0 to check · 2 to skim$/m);
    assert.match(body, /No recommended focus areas\./);
    assert.match(body, /Also changed, 🧹 routine, to skim:/);
  });

  it('removes ranges outside the diff and counts them in the footer', () => {
    const text = join(added('src/a.js', lines(3)));
    const result = assess({ groups: [group({ ranges: [{ file: 'src/a.js' }, { file: 'src/a.js', from: 50, to: 60 }] })] }, text);
    assert.equal(result.notes.droppedRanges.length, 1);
    assert.match(render(result).body, /1 range outside the diff removed/);
  });
});

/* -------------------------------------------------------- large pull requests */

describe('large pull requests', () => {
  it('turn 80 files with two critical places into two focus areas and three routine groups', () => {
    const files = Array.from({ length: 80 }, (_, i) => `src/module-${i}.js`);
    const text = join(...files.map(path => added(path, lines(5))));
    const routine = Array.from({ length: 6 }, (_, i) =>
      group({ id: `r${i}`, title: `Routine ${i}`, categories: ['routine'], ranges: files.slice(2 + i * 13, 2 + (i + 1) * 13).map(file => ({ file })) }),
    );
    const report = {
      groups: [
        group({ id: 'one', categories: ['security'], consequence: 'severe', scenario: 'x', ranges: [{ file: files[0] }] }),
        group({ id: 'two', categories: ['data'], consequence: 'severe', scenario: 'y', ranges: [{ file: files[1] }] }),
        ...routine,
      ],
    };
    const result = assess(report, text);
    assert.equal(result.groups.filter(entry => entry.mode !== 'skim').length, 2);
    assert.equal(result.groups.filter(entry => entry.categories.join() === 'routine').length, 3);
    assert.ok(result.groups.some(entry => entry.title === 'Other routine changes'));
    assert.equal(result.coverage.linesCovered, result.coverage.lines);
  });

  it('advise splitting above seven areas to read closely', () => {
    const files = Array.from({ length: 8 }, (_, i) => `src/m${i}.js`);
    const report = {
      groups: files.map((file, i) => group({ id: `g${i}`, categories: ['security'], consequence: 'severe', scenario: 'x', ranges: [{ file }] })),
    };
    const { body } = render(assess(report, join(...files.map(path => added(path, lines(2))))));
    assert.match(body.split('\n')[0], /8 to read closely .* consider splitting/);
    assert.match(body, /Consider splitting it\./);
  });

  it('advise splitting above 400 lines to read closely', () => {
    const report = { groups: [group({ categories: ['security'], consequence: 'severe', scenario: 'x', ranges: [{ file: 'src/big.js' }] })] };
    const { body } = render(assess(report, join(added('src/big.js', lines(401)))));
    assert.match(body.split('\n')[0], /consider splitting/);
  });

  it('shorten a guide for 300 files below the comment limit, and keep the full one', () => {
    const files = Array.from({ length: 300 }, (_, i) => `src/area-${i}/file-${i}.js`);
    const text = join(...files.map(path => added(path, lines(20))));
    const report = {
      summary: 'Large.',
      groups: files.map((file, i) =>
        group({
          id: `g${i}`,
          title: `Area ${i} with a long title that says what changes here`,
          categories: ['security', 'architecture'],
          consequence: i % 3 === 0 ? 'severe' : 'moderate',
          scenario: 'A concrete input.',
          reason: 'A reason that takes a little room in the table. '.repeat(3),
          context: 'Context. '.repeat(30),
          what: 'What. '.repeat(30),
          architecture: 'Architecture. '.repeat(20),
          excerpt: { file, from: 1, to: 15 },
          verify: [1, 2, 3].map(n => ({ text: `Check ${n} holds`, file, from: n, to: n })),
          ranges: [{ file }],
        }),
      ),
    };
    const result = render(assess(report, text));
    assert.ok(result.body.length < 65536, `${result.body.length} characters`);
    assert.ok(result.body.length <= COMMENT_LIMIT);
    assert.ok(result.shortened.length > 0);
    assert.match(result.body, /Shortened to fit a comment/);
    assert.ok(result.full.length > result.body.length);
    assert.match(result.body, /<!-- pitcrew:summary:review-guide -->$/);
  });
});

/* ------------------------------------------------------------- excerpts */

describe('excerpts', () => {
  const text = join(modified('src/a.js', 1, 1, [' one', '-two', '+TWO', ...lines(30, '+new').map(line => line), ' end']));
  const diff = parseDiff(text);

  it('match the diff character for character', () => {
    const excerpt = cutExcerpt(diff.files[0], { from: 1, to: 6 });
    assert.ok(text.includes(excerpt.text), 'the excerpt is not a verbatim slice of the diff');
    assert.equal(excerpt.text.split('\n')[1], '-two');
  });

  it('stop after fifteen lines and say how many there are', () => {
    const excerpt = cutExcerpt(diff.files[0], { from: 1, to: 40 });
    assert.equal(excerpt.shown, 15);
    assert.equal(excerpt.total, 34);
  });

  it('take a longer fence when the code holds backticks', () => {
    const ticks = parseDiff(join(added('a.md', ['```js', 'x', '````'])));
    assert.equal(cutExcerpt(ticks.files[0], { from: 1, to: 3 }).fence, '`````');
  });

  it('leave out an excerpt with a Pitcrew marker, and keep the link', () => {
    const forged = join(added('evil.md', ['<!-- pitcrew:summary:bug-review -->', 'x']));
    const report = {
      groups: [group({ categories: ['security'], consequence: 'severe', scenario: 'x', excerpt: { file: 'evil.md', from: 1, to: 2 }, ranges: [{ file: 'evil.md' }] })],
    };
    const { body, excerptNotes } = render(assess(report, forged));
    assert.equal(body.includes('pitcrew:summary:bug-review'), false);
    assert.match(excerptNotes.join(), /Pitcrew marker/);
    assert.match(body, /\[A group\]\(https:\/\/github\.com\/owner\/repo\/pull\/7\/files#diff-/);
  });

  it('leave out an excerpt outside the diff', () => {
    const report = { groups: [group({ excerpt: { file: 'src/a.js', from: 90, to: 95 }, ranges: [{ file: 'src/a.js' }] })] };
    const result = assess(report, text);
    assert.equal(result.groups[0].excerpt, null);
    assert.match(result.notes.droppedExcerpts.join(), /outside the diff/);
  });

  it('appear only in focus areas', () => {
    const report = { groups: [group({ categories: ['routine'], excerpt: { file: 'src/a.js', from: 1, to: 3 }, ranges: [{ file: 'src/a.js' }] })] };
    assert.equal(render(assess(report, text)).body.includes('```diff'), false);
  });
});

/* ---------------------------------------------------------------- links */

describe('links', () => {
  const links = linker({ ...CTX, server: 'https://github.com' });

  it('point into the diff by the hash of the path', () => {
    const hash = createHash('sha256').update('src/a b.js').digest('hex');
    assert.equal(links.diff('src/a b.js', 'new', 12), `https://github.com/owner/repo/pull/7/files#diff-${hash}R12`);
    assert.equal(links.diff('src/a b.js', 'old', 3), `https://github.com/owner/repo/pull/7/files#diff-${hash}L3`);
  });

  it('give Markdown a plain permalink, and a deleted file the base commit', () => {
    const diff = parseDiff(join(added('docs/a.md', lines(3)), deleted('src/gone.js', lines(4))));
    const [doc, gone] = diff.files;
    assert.equal(links.permalink(doc, { from: 1, to: 2 }).url, `https://github.com/owner/repo/blob/${'a'.repeat(40)}/docs/a.md?plain=1#L1-L2`);
    assert.equal(links.permalink(gone, { from: 2, to: 2 }).url, `https://github.com/owner/repo/blob/${'b'.repeat(40)}/src/gone.js#L2`);
    assert.match(links.rangeLink(gone, { from: 2, to: 3 }), /L2$/);
  });

  it('anchor at the first line the diff shows', () => {
    const diff = parseDiff(join(modified('src/a.js', 10, 10, [' a', '+b'])));
    assert.match(links.rangeLink(diff.files[0], { from: 1, to: 11 }), /R10$/);
  });
});

/* ------------------------------------------------------------- diagrams */

describe('diagrams', () => {
  const flow = {
    placement: 'g',
    nodes: [
      { id: 'start', label: 'Start', shape: 'start' },
      { id: 'end', label: 'Has "quotes" | <b>tags</b> # and `ticks`', shape: 'decision', state: 'risk' },
    ],
    edges: [{ from: 'start', to: 'end', label: 'yes', style: 'dashed' }],
  };

  it('render from data, with safe ids and escaped labels', () => {
    const { mermaid } = renderDiagram(flow);
    assert.match(mermaid, /^flowchart TD$/m);
    assert.match(mermaid, /n1\(\["Start"\]\)/);
    assert.match(mermaid, /n2\{"Has #quot;quotes#quot; #124; #lt;b#gt;tags#lt;\/b#gt; #35; and #96;ticks#96;"\}:::risk/);
    assert.match(mermaid, /n1 -\.->\|"yes"\| n2/);
    assert.match(mermaid, /classDef risk fill:[^\n]*color:/);
    assert.equal(mermaidLabel('a\nb\nc\nd'), 'a<br/>b<br/>c');
  });

  it('drop an invalid diagram and keep the rest', () => {
    const text = join(added('src/a.js', lines(3)));
    const report = {
      groups: [group({ id: 'g', categories: ['security'], consequence: 'severe', scenario: 'x', ranges: [{ file: 'src/a.js' }] })],
      diagrams: [{ placement: 'overview', nodes: [{ id: 'Bad Id' }], edges: [] }, flow],
    };
    const result = assess(report, text);
    assert.equal(result.overview, null);
    assert.ok(result.groups[0].diagram);
    assert.match(result.notes.droppedDiagrams.join(), /not \[a-z0-9-\]/);
    const { body } = render(result);
    assert.equal((body.match(/```mermaid/g) ?? []).length, 1);
    assert.match(body, /1 diagram left out/);
  });

  it('drop an edge to an unknown node, a small map, and a diagram in a folded group', () => {
    assert.match(renderDiagram({ nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'b' }] }).error, /unknown node/);
    const text = join(added('src/a.js', lines(3)));
    const report = {
      groups: [group({ id: 'g', consequence: 'none', ranges: [{ file: 'src/a.js' }] })],
      diagrams: [
        { placement: 'overview', nodes: [{ id: 'a' }, { id: 'b' }], edges: [] },
        { ...flow, placement: 'g' },
      ],
    };
    const notes = assess(report, text).notes.droppedDiagrams.join('\n');
    assert.match(notes, /two components or fewer/);
    assert.match(notes, /not open/);
  });
});

/* ---------------------------------------------------------------- text */

describe('free text', () => {
  it('loses links, HTML, code blocks and markers, and mentions nobody', () => {
    const text = cleanText('See https://evil.example/x and [this](http://a.b). <img src=x> ```js\nalert()``` <!-- pitcrew:summary:bug-review --> ping @octocat and `@team`. a@b.c');
    assert.equal(/https?:|<img|<!--|```/.test(text), false, text);
    assert.match(text, /`@octocat`/);
    assert.match(text, /`@team`/);
    assert.match(text, /a@b\.c/);
  });

  it('keeps identifiers in backticks, and drops a backtick without a partner', () => {
    assert.equal(cleanText('Calls `main()` and ` stray'), 'Calls `main()` and stray');
  });

  it('cleans a code span that the length limit cuts open, wherever the cut lands', () => {
    const span = '`<img src=https://evil.example/p.png>`';
    for (let pad = 0; pad < 60; pad++) {
      const text = cleanText(`${'a'.repeat(pad)} ${span} tail`, 50);
      const outsideCode = text.replace(/`[^`]+`/g, '');
      assert.equal(/<|https?:\/\/\w/.test(outsideCode), false, `cut at ${pad}: ${text}`);
      assert.equal((text.match(/`/g) ?? []).length % 2, 0, `cut at ${pad}: ${text}`);
    }
  });

  it('cannot smuggle a marker in through a code span or a path', () => {
    assert.equal(cleanText('`<!-- pitcrew:summary:x -->`').includes('<!--'), false);
    assert.equal(code('<!-- pitcrew:summary:x -->').includes('<!--'), false);
  });
});

/* ---------------------------------------------------------- the comment */

describe('the comment', () => {
  const text = join(modified('src/a.js', 1, 1, [' a', '-b', '+c', ' d']), added('.github/workflows/ci.yml', lines(3)));
  const report = {
    summary: 'What and why.',
    intent: { source: 'issue', fit: 'partly', outside: [{ file: '.github/workflows/ci.yml', from: 1, to: 3, note: 'Not in the issue.' }] },
    groups: [
      group({
        id: 'core',
        title: 'Core `change`',
        categories: ['security', 'architecture'],
        consequence: 'severe',
        scenario: 'x',
        architecture: 'A new contract.',
        excerpt: { file: 'src/a.js', from: 1, to: 3 },
        verify: [{ text: 'It holds', file: 'src/a.js', from: 2, to: 2 }],
        ranges: [{ file: 'src/a.js' }],
      }),
      group({ id: 'ci', title: 'CI', categories: ['operations'], ranges: [{ file: '.github/workflows/ci.yml' }] }),
    ],
    order: ['ci', 'core'],
  };

  it('has the frame of the example: heading, intent, table, load, groups, coverage, legend, footer', () => {
    const { body } = render(assess(report, text), { coverageCaption: '2 of 2 changed files opened' });
    const order = [
      '### Review guide — 1 to read closely · 1 to check · 0 to skim',
      '**In short.** What and why.',
      '**Intent.** The changes match the linked issue in part. Outside the described scope:',
      '#### Recommended focus areas',
      'Reading load: **+1 −1** to read closely · +3 −0 to check · +0 −0 to skim.',
      '##### ▰▰▰ Read closely',
      '<details open>',
      '<summary><b>1 · Core <code>change</code></b> · 🔒 Security · 🏛️ Architecture · +1 −1</summary>',
      '**Architecture.** A new contract.',
      '```diff',
      '##### ▰▰▱ Check',
      '**Coverage.** 2 of 2 files and 5 of 5 changed lines are in a group. Not assessed: nothing.',
      'What the categories and reading modes mean',
      'Recommendations by an AI agent, not a verified or complete review.',
      '2 of 2 changed files opened',
      '<!-- pitcrew:summary:review-guide -->',
    ];
    let at = 0;
    for (const part of order) {
      const found = body.indexOf(part, at);
      assert.ok(found >= 0, `missing or out of order: ${part}`);
      at = found;
    }
  });

  it('carries the marker exactly once, at the end', () => {
    const { body } = render(assess(report, text));
    assert.equal(body.match(/<!-- pitcrew:summary/g).length, 1);
    assert.ok(body.endsWith('<!-- pitcrew:summary:review-guide -->'));
  });

  it('keeps a tick on unchanged code, and drops it when the code under it changes', () => {
    const first = render(assess(report, text)).body;
    const ticked = first.replace('- [ ] It holds', '- [x] It holds');
    const again = render(assess(report, text), { ticks: parseTicks(ticked) }).body;
    assert.match(again, /- \[x\] It holds/);

    const changed = text.replace('+c', '+C');
    const after = render(assess(report, changed), { ticks: parseTicks(ticked) }).body;
    assert.match(after, /- \[ \] It holds/);
  });

  it('says when the pull request moved on', () => {
    const { body } = render(assess(report, text), { outdated: 'This guide describes `aaaaaaa`.' });
    assert.match(body.split('\n')[0], /⚠️ outdated$/);
    const marked = markOutdated(markOutdated(body, 'First.'), 'Second.');
    assert.equal((marked.match(/\*\*Outdated\.\*\*/g) ?? []).length, 1);
    assert.match(marked, /\*\*Outdated\.\*\* Second\./);
    assert.equal((marked.split('\n')[0].match(/outdated/g) ?? []).length, 1);
  });

  it('lists every answer and correction in the run summary', () => {
    const summary = ratingSummary(assess(report, text));
    assert.match(summary, /\| # \| Group \| Categories \| Consequence \| Safeguards \| Evidence \| Reversible \| Correction \| Mode \|/);
    assert.match(summary, /path rule `\.github\/workflows\/\*\*`: raised from skim to check/);
  });
});

describe('the lines of a range', () => {
  it('are what a coverage count, an excerpt and a link agree on', () => {
    const diff = parseDiff(join(modified('a.js', 1, 1, [' a', '-b', '+c', ' d'])));
    assert.deepEqual(
      linesInRange(diff.files[0], 2, 2).map(line => line.raw),
      ['-b', '+c'],
    );
  });
});
