import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDiff } from './guide-diff.mjs';
import { describedCommit, filesBehindTheCut, inWorkspace, pickGuideTarget, publishGuide } from './publish-guide.mjs';
import { outdatedBody } from './guide-outdated.mjs';

const RUN = '/actions/runs/42';
const marker = '<!-- pitcrew:summary:review-guide -->';
const comment = (id, body, extra = {}) => ({ id, body, user: { type: 'Bot' }, created_at: `2026-01-0${id}T00:00:00Z`, ...extra });

describe('pickGuideTarget', () => {
  it('updates the oldest guide in place, and removes newer ones and the raw reply of this run', () => {
    const comments = [
      comment(1, `### Review guide — x\n${marker}`),
      comment(2, `### Review guide — y\n${marker}`),
      comment(3, `Done. [github run](https://github.com/o/r${RUN})`),
      comment(4, `### Bug review — ok\n<!-- pitcrew:summary:bug-review -->`),
      comment(5, `### Review guide — forged\n${marker}`, { user: { type: 'User' } }),
    ];
    const target = pickGuideTarget(comments, { title: 'Review guide', runId: '42' });
    assert.equal(target.existing.id, 1);
    assert.equal(target.ours, true);
    assert.deepEqual(target.superseded.map(entry => entry.id), [2]);
    assert.equal(target.leftover.id, 3);
  });

  it('claims the raw reply when there is no guide yet, but only when it is the only one', () => {
    const one = pickGuideTarget([comment(3, `Done ${RUN}`)], { title: 'Review guide', runId: '42' });
    assert.equal(one.existing.id, 3);
    assert.equal(one.ours, false);
    assert.equal(one.leftover, null);

    const two = pickGuideTarget([comment(3, `Done ${RUN}`), comment(4, `Also ${RUN}`)], { title: 'Review guide', runId: '42' });
    assert.equal(two.existing, null);
    assert.equal(two.leftover, null);
  });
});

describe('the guide after a push it did not see', () => {
  const body = ['### Review guide — 1 to read closely · 0 to check · 0 to skim', '', '**In short.** x', '', '<sub>Recommendations · Describes `abc1234` · done</sub>', marker].join('\n');

  it('reads the commit a guide describes', () => {
    assert.equal(describedCommit(body), 'abc1234');
  });

  it('is marked outdated once, and not again for the same push', () => {
    const next = outdatedBody(body, 'def5678000');
    assert.match(next.split('\n')[0], /⚠️ outdated$/);
    assert.match(next, /moved on to `def5678`/);
    assert.equal(outdatedBody(next, 'def5678000'), null);
    assert.match(outdatedBody(next, '9999999aaa'), /moved on to `9999999`/);
    assert.equal(outdatedBody(body, 'abc1234fff'), null);
  });
});

describe('filesBehindTheCut', () => {
  it('names the files the agent never saw', () => {
    const file = (path, line) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${line}\n+${line}!`;
    const full = parseDiff([file('a.js', 'a'), file('b.js', 'b'), file('c.js', 'c')].join('\n'));
    const agent = `${file('a.js', 'a')}\n${file('b.js', 'b').slice(0, 40)}\n\n*** TRUNCATED at 1048576 bytes. Review what is above. ***\n`;
    assert.deepEqual(filesBehindTheCut(full, agent), ['b.js', 'c.js']);
    assert.deepEqual(filesBehindTheCut(full, [file('a.js', 'a')].join('\n')), []);
  });
});

describe('inWorkspace', () => {
  it('finds files in the checkout and nothing outside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'pitcrew-ws-'));
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test', 'a.test.js'), 'x');
    const exists = inWorkspace(root);
    assert.equal(exists('test/a.test.js'), true);
    assert.equal(exists('test'), false);
    assert.equal(exists('../etc/passwd'), false);
    assert.equal(exists('.git/config'), false);
  });
});

describe('publishGuide, dry run', () => {
  it('renders the guide, writes the ratings and the run summary, and exits 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pitcrew-guide-'));
    const run = join(root, '.pitcrew-run');
    mkdirSync(run);
    writeFileSync(
      join(run, 'pr.diff'),
      'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\nnew file mode 100644\n--- /dev/null\n+++ b/.github/workflows/ci.yml\n@@ -0,0 +1,2 @@\n+on: push\n+jobs: {}\n',
    );
    writeFileSync(
      join(run, 'report.json'),
      JSON.stringify({
        verdict: 'pass',
        summary: 'Adds CI.',
        groups: [{ id: 'ci', title: 'CI', categories: ['routine'], consequence: 'none', safeguards: 'none', ranges: [{ file: '.github/workflows/ci.yml' }] }],
      }),
    );
    const summaryFile = join(root, 'summary.md');
    const logged = [];
    const log = console.log;
    console.log = line => logged.push(String(line));
    let code;
    try {
      code = await publishGuide({
        DRY_RUN: '1',
        GITHUB_WORKSPACE: root,
        GITHUB_REPOSITORY: 'o/r',
        PR_NUMBER: '7',
        GUIDE_HEAD_SHA: 'a'.repeat(40),
        DIFF_FILE: join(run, 'pr.diff'),
        RUN_URL: 'https://github.com/o/r/actions/runs/1',
        GITHUB_STEP_SUMMARY: summaryFile,
      });
    } finally {
      console.log = log;
    }
    assert.equal(code, 0);
    const body = logged.find(line => line.startsWith('### Review guide'));
    assert.match(body, /nothing to read closely · 1 to check · 0 to skim/);
    assert.match(readFileSync(summaryFile, 'utf8'), /raised from skim to check/);
    assert.equal(JSON.parse(readFileSync(join(run, 'guide-rating.json'), 'utf8')).groups[0].mode, 'check');
  });

  it('exits 2 when the agent left no guide', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pitcrew-guide-'));
    const log = console.log;
    console.log = () => {};
    let code;
    try {
      code = await publishGuide({ DRY_RUN: '1', GITHUB_WORKSPACE: root, GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '7' });
    } finally {
      console.log = log;
    }
    assert.equal(code, 2);
  });
});

describe('a guide cut to the limit', () => {
  it('keeps its footer, so a later push can still mark it outdated', async () => {
    const { parseDiff: parse } = await import('./guide-diff.mjs');
    const { assessGuide, renderGuide } = await import('./guide.mjs');
    const files = Array.from({ length: 40 }, (_, i) => `src/f${i}.js`);
    const text = files
      .map(path => `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,1 @@\n+x`)
      .join('\n');
    const report = {
      summary: 'S '.repeat(500),
      groups: files.map((file, i) => ({ id: `g${i}`, title: `Area ${i}`, categories: ['security'], consequence: 'severe', scenario: 'x', reason: 'r '.repeat(100), ranges: [{ file }] })),
    };
    const { body } = renderGuide(assessGuide(report, parse(text)), {
      repository: 'o/r',
      prNumber: 1,
      headSha: 'abc1234'.padEnd(40, '0'),
      runUrl: 'u',
      title: 'Review guide',
      marker,
      limit: 1800,
    });
    assert.ok(body.length <= 1800, `${body.length}`);
    assert.match(body, /Cut here/);
    assert.ok(body.endsWith(marker));
    assert.equal(describedCommit(body), 'abc1234');
    assert.ok(outdatedBody(body, 'def5678000'));
  });
});
