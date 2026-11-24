import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  belongsToRun,
  findingMarker,
  hasUnnamedFindingMarker,
  isAnySummaryFrame,
  isOurFinding,
  isOurSummary,
  isWorkingPlaceholder,
  pickSummaryTarget,
  reviewSlug,
  summaryMarker,
} from './review-comments.mjs';

const bot = body => ({ id: body.id, user: { type: 'Bot' }, ...body });
const person = body => ({ id: body.id, user: { type: 'User' }, ...body });

describe('review-comments', () => {
  it('slugs the review title the marker is keyed on', () => {
    assert.equal(reviewSlug('Bug review'), 'bug-review');
    assert.equal(reviewSlug('Security review'), 'security-review');
    assert.equal(summaryMarker('Bug review'), '<!-- pitcrew:summary:bug-review -->');
  });

  it('does not treat a longer run id as a match for a shorter one', () => {
    const body = '[github run](/acme/widgets/actions/runs/12345)';
    assert.equal(belongsToRun(body, '12345'), true);
    assert.equal(belongsToRun(body, '123'), false);
    assert.equal(belongsToRun(body, '1234'), false);
  });

  it('recognises OpenCode\'s working placeholder and nothing wider', () => {
    assert.equal(isWorkingPlaceholder('[Working...](/org/repo/actions/runs/1)'), true);
    assert.equal(isWorkingPlaceholder('The agent answered\n\n[github run](/org/repo/actions/runs/1)'), false);
  });

  it('treats a legacy frame with this heading as ours, and a sibling\'s as not', () => {
    const bug = '### Bug review — ✅ no objections\n\n<!-- opencode-review-summary -->';
    const security = '### Security review — ✅ no objections\n\n<!-- opencode-review-summary -->';
    assert.equal(isAnySummaryFrame(bug), true);
    assert.equal(isOurSummary(bug, 'Bug review'), true);
    assert.equal(isOurSummary(security, 'Bug review'), false);
    assert.equal(isOurSummary(security, 'Security review'), true);
  });

  it('does not let a named marker match the legacy tag by prefix', () => {
    const named = '### Security review\n\n<!-- opencode-review-summary:security-review -->';
    assert.equal(isOurSummary(named, 'Security review'), true);
    assert.equal(isOurSummary(named, 'Bug review'), false);
  });

  it('recognises the marker it writes today, keyed on the review name', () => {
    const named = `### Security review\n\n${summaryMarker('Security review')}`;
    assert.equal(isAnySummaryFrame(named), true);
    assert.equal(isOurSummary(named, 'Security review'), true);
    assert.equal(isOurSummary(named, 'Bug review'), false);
  });

  it('does not mistake unmarked prose for a summary frame', () => {
    assert.equal(isAnySummaryFrame('### Bug review — ✅ no objections'), false);
    assert.equal(isOurSummary('### Bug review — ✅ no objections', 'Bug review'), false);
  });
});

describe('finding marker', () => {
  it('writes a marker that names the review', () => {
    assert.equal(findingMarker('Bug review'), '<!-- pitcrew:finding:bug-review -->');
    assert.equal(findingMarker('Design review'), '<!-- pitcrew:finding:design-review -->');
  });

  it('recognises its own named marker, and no sibling review\'s', () => {
    const bug = `A null slips through here.\n\n${findingMarker('Bug review')}`;
    assert.ok(isOurFinding(bug, 'Bug review'));
    // The coupling this prevents: an open bug-review finding failed the gate
    // of the design review and the security review too.
    assert.ok(!isOurFinding(bug, 'Design review'));
    assert.ok(!isOurFinding(bug, 'Security review'));
    // The review body does not override a named marker.
    assert.ok(!isOurFinding(bug, 'Design review', '## Design review\n\nSummary.'));
  });

  it('attributes an unnamed marker by the review it was posted in', () => {
    // A repository that upgrades mid-pull-request must not repost every
    // standing finding, nor count it for every review.
    for (const marker of ['<!-- pitcrew:finding -->', '<!-- opencode-review-finding -->']) {
      const body = `A null slips through here.\n\n${marker}`;
      assert.ok(isOurFinding(body, 'Bug review', '## Bug review\n\nOne finding.'));
      assert.ok(isOurFinding(body, 'Bug review', '## Bug review'));
      assert.ok(!isOurFinding(body, 'Design review', '## Bug review\n\nOne finding.'));
      assert.ok(!isOurFinding(body, 'Bug review', '## Bug reviewer\n\nOne finding.'));
      // Without the review, it belongs to no review.
      assert.ok(!isOurFinding(body, 'Bug review'));
      assert.ok(!isOurFinding(body, 'Bug review', ''));
      assert.ok(hasUnnamedFindingMarker(body));
    }
    assert.ok(!hasUnnamedFindingMarker(`x\n\n${findingMarker('Bug review')}`));
  });

  it('recognises nothing without a marker', () => {
    for (const body of ['A null slips through here.', '', null, undefined]) {
      assert.ok(!isOurFinding(body, 'Bug review', '## Bug review'));
      assert.ok(!hasUnnamedFindingMarker(body));
    }
  });
});

describe('pickSummaryTarget', () => {
  const runId = '32453335456';
  const runLink = `/actions/runs/${runId}`;
  const titled = {
    title: 'Bug review',
    runId,
  };

  it('leaves a sibling frame standing and claims only this review\'s raw reply', () => {
    const security = bot({
      id: 1,
      updated_at: '2026-08-21T06:11:11Z',
      body: `### Security review — ✅ no objections\n\n<sub>[Workflow run](https://github.com/org/repo${runLink})</sub>\n${summaryMarker('Security review')}`,
    });
    const bugReply = bot({
      id: 2,
      updated_at: '2026-08-21T06:11:16Z',
      body: `Looks fine.\n\n[github run](https://github.com/org/repo${runLink})`,
    });

    const { existing, superseded } = pickSummaryTarget([security, bugReply], titled);
    assert.equal(existing?.id, 2);
    assert.deepEqual(superseded, []);
  });

  it('does not claim another job\'s Working placeholder', () => {
    const ours = bot({
      id: 1,
      updated_at: '2026-08-21T06:11:10Z',
      body: `Done.\n\n[github run](/org/repo${runLink})`,
    });
    const theirs = bot({
      id: 2,
      updated_at: '2026-08-21T06:11:11Z',
      body: `[Working...](/org/repo${runLink})`,
    });

    const { existing, superseded } = pickSummaryTarget([ours, theirs], titled);
    assert.equal(existing?.id, 1);
    assert.deepEqual(superseded, []);
  });

  it('on a re-run, rewrites the fresh reply and drops this review\'s old frame', () => {
    const oldFrame = bot({
      id: 1,
      updated_at: '2026-08-21T06:11:16Z',
      body: `### Bug review — ✅ no objections\n\n<sub>[Workflow run](https://github.com/org/repo${runLink})</sub>\n${summaryMarker('Bug review')}`,
    });
    const fresh = bot({
      id: 2,
      updated_at: '2026-08-21T06:20:00Z',
      body: `Again.\n\n[github run](/org/repo${runLink})`,
    });

    const { existing, superseded } = pickSummaryTarget([oldFrame, fresh], titled);
    assert.equal(existing?.id, 2);
    assert.deepEqual(
      superseded.map(comment => comment.id),
      [1],
    );
  });

  // The same re-run, on a repository that was upgraded mid-pull-request: the
  // standing frame still carries the pre-1.0 marker and must still be dropped.
  it('on a re-run, drops this review\'s old frame under the pre-1.0 marker too', () => {
    const oldFrame = bot({
      id: 1,
      updated_at: '2026-08-21T06:11:16Z',
      body: `### Bug review — ✅ no objections\n\n<sub>[Workflow run](https://github.com/org/repo${runLink})</sub>\n<!-- opencode-review-summary:bug-review -->`,
    });
    const fresh = bot({
      id: 2,
      updated_at: '2026-08-21T06:20:00Z',
      body: `Again.\n\n[github run](/org/repo${runLink})`,
    });

    const { existing, superseded } = pickSummaryTarget([oldFrame, fresh], titled);
    assert.equal(existing?.id, 2);
    assert.deepEqual(
      superseded.map(comment => comment.id),
      [1],
    );
  });

  it('does not claim a raw reply when more than one is unmatched', () => {
    const securityReply = bot({
      id: 1,
      updated_at: '2026-08-21T06:11:11Z',
      body: `No findings.\n\n[github run](/org/repo${runLink})`,
    });
    const bugReply = bot({
      id: 2,
      updated_at: '2026-08-21T06:11:16Z',
      body: `Looks fine.\n\n[github run](/org/repo${runLink})`,
    });

    const { existing, superseded } = pickSummaryTarget([securityReply, bugReply], titled);
    assert.equal(existing, null);
    assert.deepEqual(superseded, []);
  });

  // The ordinary case on the `pull_request` path: the CLI posts nothing, so
  // there is no reply to rewrite and publish-report.mjs has to fall through to
  // creating the comment itself. Nothing to claim, nothing to delete.
  it('claims nothing when the run left no comment behind', () => {
    const { existing, superseded } = pickSummaryTarget([], titled);
    assert.equal(existing, null);
    assert.deepEqual(superseded, []);
  });

  it('does not rewrite a human comment that quotes the run link', () => {
    const ours = bot({
      id: 1,
      updated_at: '2026-08-21T06:11:16Z',
      body: `### Bug review — ✅ no objections\n\n${summaryMarker('Bug review')}`,
    });
    const question = person({
      id: 2,
      updated_at: '2026-08-21T06:12:00Z',
      body: `What about this [run](https://github.com/org/repo${runLink})?`,
    });

    const { existing, superseded } = pickSummaryTarget([ours, question], titled);
    assert.equal(existing?.id, 1);
    assert.deepEqual(superseded, []);
  });
});
