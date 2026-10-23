/**
 * Puts the diff the agent should review into a file, and says which diff it is.
 *
 * On the first review of a pull request there is only one sensible answer: the
 * whole thing. On a later push there are two, and the difference decides whether
 * this bundle is worth keeping. Handing over the whole diff again invites the
 * agent to re-litigate code that was already reviewed - and every round it may
 * word an old objection slightly differently, so it reads as a new finding.
 * A pull request then never converges: fix, review, fix, review.
 *
 * So a push is reviewed as the commits since the last *published* review of
 * this agent on this pull request, while the checkout still holds the whole
 * pull request for context. `github.event.before` is the last push, not the
 * last complete review. A new push cancels the run that is not complete, and
 * that cancelled check sits on the old commit. If the new run used `before`
 * as the start of the range, the cancelled commits would never be reviewed.
 * The walk below starts at `before` and moves to the newest parent that
 * published a report. `publish-report.mjs` drops anything that lands on a
 * line somebody has already commented on, as the second line of defence.
 *
 * The range can hold more than this pull request: when the base branch was
 * merged in since the last review, `base...after` carries everything that
 * merge brought along. Other people's code, reviewed in their own pull
 * requests, would be reviewed again here and its findings would fail this
 * one. So the incremental diff is cut down to what the pull request diff
 * itself contains (`own-changes.mjs`). A merge with no work of its own leaves
 * nothing, and the whole pull request is reviewed: that diff only ever holds
 * what the pull request adds to its base branch.
 *
 * Falls back to the full diff whenever the incremental one cannot be trusted:
 * a force-push leaves `before` unreachable, a comment trigger has no `before`
 * at all, the walk finds no published review, and a failed lookup must not
 * guess. `/review` is how a human asks for the whole pull request to be
 * looked at again.
 *
 * The same parse that writes the diff also writes the list of paths the agent
 * has to open. The hunk is three lines of context; the file is what the change
 * means. Without that list, nothing downstream can tell a review that opened
 * the files from one that only read the hunks.
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { changedFilesFromDiff, formatChangedFiles } from './changed-files.mjs';
import { restrictToPullRequest } from './own-changes.mjs';

const api = process.env.GITHUB_API_URL || 'https://api.github.com';
const repository = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const diffFile = process.env.DIFF_FILE;
const token = process.env.GITHUB_TOKEN;

// A diff that does not fit in the model's context is worse than a shortened one
// that says it was shortened.
const LIMIT = 1024 * 1024;
const EMPTY_SHA = '0000000000000000000000000000000000000000';
const MAX_WALK = 100;

async function diff(path) {
  const response = await fetch(`${api}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github.v3.diff',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) return null;
  return await response.text();
}

async function jsonGet(path) {
  const response = await fetch(`${api}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'pr-pitcrew-fetch-diff',
    },
  });
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** True when `name` is this agent's check, with or without a caller prefix. */
export function matchesAgentCheck(name, checkName) {
  const n = String(name ?? '');
  const c = String(checkName ?? '');
  if (!n || !c) return false;
  return n === c || n.endsWith(` / ${c}`);
}

/** The newest check of this agent in a list. None if this agent did not run. */
export function pickAgentCheck(checkRuns, checkName) {
  const matches = (checkRuns ?? []).filter(run => matchesAgentCheck(run.name, checkName));
  if (matches.length === 0) return null;
  return (
    [...matches].sort(
      (a, b) => String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? '')) || Number(b.id) - Number(a.id),
    )[0] ?? null
  );
}

/**
 * Whether this check published a review of the commit.
 *
 * `success` did. `cancelled`, `timed_out` and a missing check did not. A
 * `failure` did only when the gate ran after a report: `publish-report.mjs`
 * writes "Quality gate failed" *after* it posts. A bare `exit code 1` is not
 * enough. Any failed step gets that annotation, including a crash before a
 * report exists. The no-report path also writes "Quality gate failed", then
 * "this diff was not reviewed" and exit 2; that is not a review.
 */
export function checkPublishedReport(check, annotations = []) {
  if (!check) return false;
  if (check.conclusion === 'success') return true;
  if (check.conclusion !== 'failure') return false;

  const text = (annotations ?? []).map(entry => String(entry?.message ?? '')).join('\n');
  if (/\bexit code 2\b/i.test(text) || /this diff was not reviewed/i.test(text) || /left no report/i.test(text)) {
    return false;
  }
  return /Quality gate failed/i.test(text);
}

/**
 * Walk from `before` back through the pull request until a published review.
 *
 * `commitsOldestFirst` is the pull request's commits. `statusOf(sha)` answers
 * `published`, `unpublished` or `failed`. A failed lookup stops the walk: the
 * caller must not use `before...after`.
 */
export async function walkToPublishedReview(before, commitsOldestFirst, statusOf) {
  if (!before) return { base: null, reason: 'none' };

  const history = [before];
  const index = (commitsOldestFirst ?? []).indexOf(before);
  if (index > 0) {
    for (let i = index - 1; i >= 0 && history.length < MAX_WALK; i--) {
      history.push(commitsOldestFirst[i]);
    }
  }

  for (const sha of history) {
    const status = await statusOf(sha);
    if (status === 'failed') return { base: null, reason: 'lookup-failed' };
    if (status === 'published') {
      return { base: sha, reason: sha === before ? 'last-push' : 'ancestor' };
    }
  }
  return { base: null, reason: 'none' };
}

function incrementalScope(from, to, mergedBase) {
  const scope = `the ${from.slice(0, 7)}..${to.slice(0, 7)} push - the commits added since the last review. Earlier commits in this pull request have already been reviewed.`;
  return mergedBase ? `${scope} Changes that came in from the base branch are left out; they are not part of this pull request.` : scope;
}

/**
 * The pull request diff, but only while the pull request still ends at
 * `after`. Restricting the incremental diff compares right-hand line numbers,
 * and those only agree when both diffs end at the same commit.
 */
async function pullDiffAt(after) {
  const pull = await jsonGet(`/repos/${repository}/pulls/${prNumber}`);
  if (pull?.head?.sha !== after) return null;
  return await diff(`/repos/${repository}/pulls/${prNumber}`);
}

async function listCheckRuns(sha) {
  const runs = [];
  for (let page = 1; page <= 10; page++) {
    const body = await jsonGet(`/repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}&filter=latest`);
    if (body === null) return null;
    const batch = body.check_runs ?? [];
    runs.push(...batch);
    if (batch.length < 100) break;
  }
  return runs;
}

async function listAnnotations(checkRunId) {
  const body = await jsonGet(`/repos/${repository}/check-runs/${checkRunId}/annotations?per_page=100`);
  if (body === null) return null;
  return Array.isArray(body) ? body : [];
}

async function listPullCommits() {
  const commits = [];
  for (let page = 1; page <= 10; page++) {
    const body = await jsonGet(`/repos/${repository}/pulls/${prNumber}/commits?per_page=100&page=${page}`);
    if (body === null || !Array.isArray(body)) return null;
    commits.push(...body.map(entry => entry.sha));
    if (body.length < 100) break;
  }
  return commits;
}

async function statusOfCommit(sha, checkName) {
  const runs = await listCheckRuns(sha);
  if (runs === null) return 'failed';
  const check = pickAgentCheck(runs, checkName);
  if (!check) return 'unpublished';
  if (check.conclusion === 'success') return 'published';
  if (check.conclusion !== 'failure') return 'unpublished';
  const annotations = await listAnnotations(check.id);
  if (annotations === null) return 'failed';
  return checkPublishedReport(check, annotations) ? 'published' : 'unpublished';
}

/**
 * The SHA that the incremental diff should start from, or null for the whole
 * pull request. Null also covers a lookup that failed: `before...after` is
 * then the wrong guess.
 */
async function resolveCompareBase(before, checkName) {
  if (!checkName) {
    console.log('CHECK_NAME is not set; reviewing the whole pull request.');
    return null;
  }

  const first = await statusOfCommit(before, checkName);
  if (first === 'failed') {
    console.log(`Could not look up this agent's check on ${before.slice(0, 7)}; reviewing the whole pull request.`);
    return null;
  }
  if (first === 'published') return before;

  const commits = await listPullCommits();
  if (commits === null) {
    console.log('Could not list the commits of this pull request; reviewing the whole pull request.');
    return null;
  }

  const cache = new Map([[before, first]]);
  const result = await walkToPublishedReview(before, commits, async sha => {
    if (cache.has(sha)) return cache.get(sha);
    const status = await statusOfCommit(sha, checkName);
    cache.set(sha, status);
    return status;
  });

  if (result.reason === 'lookup-failed') {
    console.log("Could not look up this agent's earlier checks; reviewing the whole pull request.");
    return null;
  }
  if (!result.base) {
    console.log('No published review of this agent on this pull request; reviewing the whole pull request.');
    return null;
  }

  console.log(`The check on ${before.slice(0, 7)} did not publish a report; reviewing from ${result.base.slice(0, 7)}.`);
  return result.base;
}

async function main() {
  if (!repository || !prNumber || !diffFile || !token) {
    console.error('::error::fetch-diff.mjs needs GITHUB_REPOSITORY, PR_NUMBER, DIFF_FILE and GITHUB_TOKEN.');
    process.exit(1);
  }

  const before = process.env.BEFORE_SHA || '';
  const after = process.env.AFTER_SHA || '';
  const checkName = (process.env.CHECK_NAME ?? '').trim();

  let text = null;
  let scope = '';
  let pullText = null;

  if (before && after && before !== after && before !== EMPTY_SHA) {
    const base = await resolveCompareBase(before, checkName);
    if (base) {
      text = await diff(`/repos/${repository}/compare/${base}...${after}`);
      if (text === null) {
        // Force-pushed, or the commit was garbage collected: `before` no longer
        // describes anything this repository can reach.
        console.log(`No comparison between ${base.slice(0, 7)} and ${after.slice(0, 7)}; reviewing the whole pull request.`);
      } else if (text.trim() === '') {
        // A push that changed nothing under review.
        console.log('The new commits change no files; reviewing the whole pull request.');
        text = null;
      } else {
        pullText = await pullDiffAt(after);
        if (pullText === null) {
          // Without the pull request diff nothing can tell this pull request's
          // changes from the ones a merge of the base branch brought in.
          console.log(`Pull request #${prNumber} no longer ends at ${after.slice(0, 7)}, or its diff could not be fetched; reviewing the whole pull request.`);
          text = null;
        } else {
          const own = restrictToPullRequest(text, pullText);
          if (own.text.trim() === '') {
            console.log("The new commits add nothing of this pull request's own (a merge of the base branch); reviewing the whole pull request.");
            text = null;
          } else {
            if (own.leftOut) console.log('Left out the changes that came in from the base branch.');
            text = own.text;
            scope = incrementalScope(base, after, own.leftOut);
          }
        }
      }
    }
  }

  if (text === null) {
    text = pullText ?? (await diff(`/repos/${repository}/pulls/${prNumber}`));
    if (text === null) {
      console.error(`::error::Could not fetch the diff of pull request #${prNumber}.`);
      process.exit(1);
    }
    scope = 'the whole pull request.';
  }

  if (text.length > LIMIT) {
    text = `${text.slice(0, LIMIT)}\n\n*** TRUNCATED at ${LIMIT} bytes. Review what is above and say in the report that the diff was cut. ***\n`;
  }

  writeFileSync(diffFile, text);
  console.log(`Diff: ${text.split('\n').length} lines, ${text.length} bytes - ${scope}`);

  const changedFile =
    (process.env.CHANGED_FILES ?? '').trim() || join(dirname(diffFile), 'changed-files.txt');
  const changed = changedFilesFromDiff(text);
  writeFileSync(changedFile, formatChangedFiles(changed));
  console.log(`Changed files to open: ${changed.length} (${changedFile})`);

  if (process.env.GITHUB_ENV) {
    appendFileSync(
      process.env.GITHUB_ENV,
      `DIFF_FILE=${diffFile}\nDIFF_SCOPE=${scope}\nCHANGED_FILES=${changedFile}\n`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
