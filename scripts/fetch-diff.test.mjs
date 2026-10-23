/**
 * The walk that decides which diff a push reviews, and the fallbacks when that
 * walk cannot be trusted.
 *
 * The bug this covers: a new push cancels the review that is not complete, then
 * the new run used `github.event.before` as if that commit had been reviewed.
 * It had not. The cancelled commits never reached an agent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  baseChangedSince,
  checkPublishedReport,
  matchesAgentCheck,
  pickAgentCheck,
  walkToPublishedReview,
} from './fetch-diff.mjs';

const sha = n => n.padEnd(40, '0');
const A = sha('a');
const B = sha('b');
const C = sha('c');
const D = sha('d');

const statusMap = map => shaValue => map[shaValue] ?? 'unpublished';

describe('matchesAgentCheck', () => {
  const check = 'Pitcrew / Bug Review';

  it('matches the job name with no caller prefix', () => {
    assert.equal(matchesAgentCheck('Pitcrew / Bug Review', check), true);
  });

  it('matches a caller prefix', () => {
    assert.equal(matchesAgentCheck('bug-review / Pitcrew / Bug Review', check), true);
    assert.equal(matchesAgentCheck('bug / Pitcrew / Bug Review', check), true);
  });

  it('does not match a different agent', () => {
    assert.equal(matchesAgentCheck('Pitcrew / Security Review', check), false);
    assert.equal(matchesAgentCheck('security / Pitcrew / Security Review', check), false);
    assert.equal(matchesAgentCheck('bug / Pitcrew / Security Review', check), false);
  });

  it('does not match a name that only starts with the check', () => {
    assert.equal(matchesAgentCheck('Pitcrew / Bug Review Extra', check), false);
  });

  it('does not match an empty name', () => {
    assert.equal(matchesAgentCheck('', check), false);
    assert.equal(matchesAgentCheck('Pitcrew / Bug Review', ''), false);
  });
});

describe('pickAgentCheck', () => {
  it('returns the newest matching check and ignores a sibling agent', () => {
    const runs = [
      { id: 1, name: 'security / Pitcrew / Security Review', completed_at: '2026-09-01T10:00:00Z' },
      { id: 2, name: 'bug / Pitcrew / Bug Review', completed_at: '2026-09-01T10:01:00Z' },
      { id: 3, name: 'bug / Pitcrew / Bug Review', completed_at: '2026-09-01T10:02:00Z' },
    ];
    assert.equal(pickAgentCheck(runs, 'Pitcrew / Bug Review').id, 3);
    assert.equal(pickAgentCheck(runs, 'Pitcrew / Security Review').id, 1);
  });

  it('returns null when this agent has no check', () => {
    assert.equal(pickAgentCheck([{ id: 1, name: 'Tests' }], 'Pitcrew / Bug Review'), null);
    assert.equal(pickAgentCheck([], 'Pitcrew / Bug Review'), null);
  });
});

describe('checkPublishedReport', () => {
  it('counts success as a published report', () => {
    assert.equal(checkPublishedReport({ conclusion: 'success' }), true);
  });

  it('does not count cancelled, timed_out, skipped or a missing check', () => {
    assert.equal(checkPublishedReport({ conclusion: 'cancelled' }), false);
    assert.equal(checkPublishedReport({ conclusion: 'timed_out' }), false);
    assert.equal(checkPublishedReport({ conclusion: 'skipped' }), false);
    assert.equal(checkPublishedReport({ conclusion: null }), false);
    assert.equal(checkPublishedReport(null), false);
  });

  it('counts a gate failure as published', () => {
    assert.equal(
      checkPublishedReport({ conclusion: 'failure' }, [
        { message: 'Quality gate failed. 1 finding in this run at or above `high`.' },
        { message: 'Process completed with exit code 1.' },
      ]),
      true,
    );
  });

  it('does not count a bare exit code 1 as published', () => {
    // Any failed step gets this annotation, including a crash before a report.
    assert.equal(
      checkPublishedReport({ conclusion: 'failure' }, [{ message: 'Process completed with exit code 1.' }]),
      false,
    );
  });

  it('does not count a failure with no report (exit 2)', () => {
    assert.equal(
      checkPublishedReport({ conclusion: 'failure' }, [
        { message: 'Process completed with exit code 1.' },
        { message: 'The agent left no report, so this diff was not reviewed. A run that reviewed nothing is not a run that found nothing.' },
        { message: 'Process completed with exit code 2.' },
      ]),
      false,
    );
  });

  it('does not count a failure with no annotations as published', () => {
    assert.equal(checkPublishedReport({ conclusion: 'failure' }, []), false);
  });
});

describe('walkToPublishedReview', () => {
  const commits = [A, B, C];

  it('uses before when that check published a report', async () => {
    const called = [];
    const result = await walkToPublishedReview(C, commits, shaValue => {
      called.push(shaValue);
      return statusMap({ [C]: 'published', [B]: 'unpublished', [A]: 'published' })(shaValue);
    });
    assert.deepEqual(result, { base: C, reason: 'last-push' });
    assert.deepEqual(called, [C]);
  });

  it('walks to the newest parent that published a report', async () => {
    const result = await walkToPublishedReview(
      C,
      commits,
      statusMap({ [C]: 'unpublished', [B]: 'unpublished', [A]: 'published' }),
    );
    assert.deepEqual(result, { base: A, reason: 'ancestor' });
  });

  it('covers two cancelled runs, then a third push', async () => {
    const result = await walkToPublishedReview(
      D,
      [A, B, C, D],
      statusMap({ [D]: 'unpublished', [C]: 'unpublished', [B]: 'unpublished', [A]: 'published' }),
    );
    assert.deepEqual(result, { base: A, reason: 'ancestor' });
  });

  it('falls back when no commit published a report', async () => {
    const result = await walkToPublishedReview(
      C,
      commits,
      statusMap({ [C]: 'unpublished', [B]: 'unpublished', [A]: 'unpublished' }),
    );
    assert.deepEqual(result, { base: null, reason: 'none' });
  });

  it('falls back when the lookup fails, and does not keep walking', async () => {
    const called = [];
    const result = await walkToPublishedReview(C, commits, shaValue => {
      called.push(shaValue);
      return 'failed';
    });
    assert.deepEqual(result, { base: null, reason: 'lookup-failed' });
    assert.deepEqual(called, [C]);
  });

  it('falls back when a parent lookup fails', async () => {
    const result = await walkToPublishedReview(
      C,
      commits,
      statusMap({ [C]: 'unpublished', [B]: 'failed', [A]: 'published' }),
    );
    assert.deepEqual(result, { base: null, reason: 'lookup-failed' });
  });

  it('does not walk past the pull request when before is the first commit', async () => {
    const called = [];
    const result = await walkToPublishedReview(A, commits, shaValue => {
      called.push(shaValue);
      return 'unpublished';
    });
    assert.deepEqual(result, { base: null, reason: 'none' });
    assert.deepEqual(called, [A]);
  });

  it('only inspects before when that SHA is not in the pull request', async () => {
    const extra = sha('e');
    const called = [];
    const result = await walkToPublishedReview(extra, commits, shaValue => {
      called.push(shaValue);
      return 'unpublished';
    });
    assert.deepEqual(result, { base: null, reason: 'none' });
    assert.deepEqual(called, [extra]);
  });
});

describe('baseChangedSince', () => {
  const since = '2026-10-23T06:00:00Z';
  const changed = at => ({ event: 'base_ref_changed', created_at: at });

  it('is false when the base never changed', () => {
    assert.equal(baseChangedSince([{ event: 'labeled', created_at: '2026-10-23T07:00:00Z' }], since), false);
    assert.equal(baseChangedSince([], since), false);
  });

  it('ignores a change before the review started', () => {
    assert.equal(baseChangedSince([changed('2026-10-23T05:59:59Z')], since), false);
  });

  it('counts a change at or after the review started', () => {
    assert.equal(baseChangedSince([changed('2026-10-23T06:00:00Z')], since), true);
    assert.equal(baseChangedSince([changed('2026-10-23T08:00:00Z')], since), true);
  });

  it('counts a review with no start time as changed', () => {
    assert.equal(baseChangedSince([], ''), true);
    assert.equal(baseChangedSince([], undefined), true);
  });
});
