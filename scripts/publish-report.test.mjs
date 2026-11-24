import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const script = fileURLToPath(new URL('./publish-report.mjs', import.meta.url));
const run = promisify(execFile);

const bot = { type: 'Bot', login: 'github-actions[bot]' };
const patch = '@@ -1,0 +1,20 @@\n' + Array.from({ length: 20 }, (_, i) => `+line ${i + 1}`).join('\n');

/**
 * Three reviews have commented on the same pull request. The design review
 * publishes now. Only its own findings may reach its gate and its repeat check.
 */
const thread = (body, reviewBody, line) => ({
  isResolved: false,
  isOutdated: false,
  path: 'app.js',
  line,
  comments: { nodes: [{ body, url: `https://example.test/t/${line}`, author: { __typename: 'Bot' }, pullRequestReview: { body: reviewBody } }] },
});

const threads = [
  thread('🔴 **Bug finding, named** (high)\n\nx\n\n<!-- pitcrew:finding:bug-review -->', '## Bug review', 3),
  thread('🔴 **Bug finding, unnamed** (high)\n\nx\n\n<!-- pitcrew:finding -->', '## Bug review\n\nOne.', 4),
  thread('🔴 **Security finding, named** (high)\n\nx\n\n<!-- pitcrew:finding:security-review -->', '## Security review', 5),
  thread('🔴 **Design finding, unnamed** (high)\n\nx\n\n<!-- pitcrew:finding -->', '## Design review\n\nOne.', 6),
];

const restComments = [
  // Same line and same point as this run's finding, but the bug review's.
  { id: 1, user: bot, path: 'app.js', line: 10, pull_request_review_id: 11, body: '🔴 **Color token bypassed in button** (high)\n\nx\n\n<!-- pitcrew:finding:bug-review -->' },
  // Unnamed marker, posted in a design review: this review's own, held back.
  { id: 2, user: bot, path: 'app.js', line: 15, pull_request_review_id: 12, body: '🟡 **Spacing off the scale** (medium)\n\nx\n\n<!-- pitcrew:finding -->' },
];

const reviews = [
  { id: 11, body: '## Bug review\n\nOne.' },
  { id: 12, body: '## Design review\n\nOne.' },
];

let server;
let base;
const posted = [];

before(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const reply = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (url.pathname === '/graphql') {
        return reply(200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads } } } } });
      }
      if (req.method === 'GET' && url.pathname.endsWith('/pulls/7/files')) return reply(200, [{ filename: 'app.js', status: 'modified', patch }]);
      if (req.method === 'GET' && url.pathname.endsWith('/pulls/7/comments')) return reply(200, restComments);
      if (req.method === 'GET' && url.pathname.endsWith('/pulls/7/reviews')) return reply(200, reviews);
      if (req.method === 'POST' && url.pathname.endsWith('/pulls/7/reviews')) {
        posted.push(JSON.parse(data));
        return reply(200, { id: 99 });
      }
      if (req.method === 'GET') return reply(200, []);
      return reply(200, { id: 100, body: data ? JSON.parse(data).body : '' });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

// Keep-alive connections from the child would hold the server open otherwise.
after(() => {
  server.closeAllConnections();
  server.close();
});

describe('publish-report with sibling reviews on the pull request', () => {
  it('gates and dedups on this review\'s findings only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'publish-report-'));
    try {
      const reportFile = join(dir, 'report.json');
      writeFileSync(
        reportFile,
        JSON.stringify({
          verdict: 'attention',
          summary: 'Two points.',
          findings: [
            { severity: 'medium', file: 'app.js', line: 10, title: 'Color token bypassed in button', body: 'Use the token.' },
            { severity: 'medium', file: 'app.js', line: 15, title: 'Spacing off the scale', body: 'Use the scale.' },
          ],
        }),
      );

      const result = await run(process.execPath, [script], {
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          GITHUB_TOKEN: 'test',
          GITHUB_REPOSITORY: 'org/repo',
          GITHUB_API_URL: base,
          GITHUB_GRAPHQL_URL: `${base}/graphql`,
          PR_NUMBER: '7',
          REVIEW_TITLE: 'Design review',
          REPORT_KIND: 'findings',
          REPORT_FILE: reportFile,
        },
      }).catch(error => error);

      const output = `${result.stdout}${result.stderr}`;
      assert.doesNotMatch(output, /ReferenceError/);

      // The gate: one standing finding, the design review's own unnamed one.
      assert.equal(result.code, 1, output);
      assert.match(output, /Design finding, unnamed/);
      assert.doesNotMatch(output, /Bug finding/);
      assert.doesNotMatch(output, /Security finding/);

      // The repeat check: the bug review's comment on line 10 holds nothing
      // back; this review's own comment on line 15 does.
      assert.equal(posted.length, 1);
      assert.deepEqual(
        posted[0].comments.map(comment => comment.line),
        [10],
      );
      assert.match(posted[0].comments[0].body, /<!-- pitcrew:finding:design-review -->/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
