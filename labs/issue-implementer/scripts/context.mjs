#!/usr/bin/env node
/**
 * Decides whether the implementer has work, and writes the task for it.
 *
 * Runs on a hosted runner, before the laptop runner is asked for anything: most
 * events that reach the workflow (the implementer's own comments, comments on
 * unrelated pull requests, a review run that found nothing) end here in
 * seconds, and the laptop stays free.
 *
 * Two modes:
 *
 *  - `issue`: an issue was assigned to PITCREW_IMPLEMENTER_ASSIGNEE. The task
 *    is the issue. The work starts from the default branch.
 *  - `feedback`: anything happened on a pull request whose head branch starts
 *    with `pitcrew/issue-`. The task is the feedback no round has handled yet
 *    (see lib.mjs). The work starts from the head of that pull request.
 *
 * Rounds that only the review bots asked for are capped at MAX_AUTO_ROUNDS in a
 * row. Without a cap, an agent and a reviewer that disagree would trade commits
 * until somebody noticed the bill. A comment by a person starts a new count.
 *
 * ASSIGNEE is also the implementer's own account. When it pushes with a
 * personal token, it is a plain user, and only its login tells its round
 * comments apart from a person's.
 *
 * Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME,
 * GITHUB_EVENT_PATH, GITHUB_OUTPUT, GITHUB_SHA, TASK_FILE, RUN_URL, ASSIGNEE,
 * MAX_AUTO_ROUNDS.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { client } from './github.mjs';
import {
  BRANCH_PREFIX,
  openFeedback,
  renderFeedbackTask,
  renderIssueTask,
  roundMarker,
  roundsOf,
  trailingBotRounds,
} from './lib.mjs';

const env = process.env;
const repository = env.GITHUB_REPOSITORY;
const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const { api, all, reviewThreads } = client(env.GITHUB_TOKEN, repository);
const maxAutoRounds = Number.parseInt(env.MAX_AUTO_ROUNDS || '3', 10);

// Taken before anything is read. Feedback written from here on belongs to the
// next round, even if it arrives while this one is still fetching.
const since = new Date().toISOString();

function output(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

function skip(reason) {
  console.log(`Nothing to do: ${reason}`);
  output({ mode: 'none' });
  process.exit(0);
}

async function fromIssue() {
  const assignee = String(env.ASSIGNEE ?? '').trim().toLowerCase();
  if (!assignee) skip('PITCREW_IMPLEMENTER_ASSIGNEE is not set.');
  if (event.action !== 'assigned') skip(`issue event "${event.action}"`);
  if (String(event.assignee?.login ?? '').toLowerCase() !== assignee) skip(`assigned to ${event.assignee?.login}`);
  const issue = event.issue;
  if (issue.pull_request) skip('this is a pull request');
  if (issue.state !== 'open') skip('the issue is closed');

  const branch = `${BRANCH_PREFIX}${issue.number}`;
  const existing = await api(`/repos/{repo}/git/ref/heads/${branch}`, { allow: [404] });
  if (existing.status === 200) {
    await api(`/repos/{repo}/issues/${issue.number}/comments`, {
      method: 'POST',
      body: {
        body:
          `The branch \`${branch}\` already exists, so the issue implementer did not start again. ` +
          'Comment on its pull request to ask for changes, or delete the branch to start over.',
      },
    });
    skip(`${branch} exists`);
  }

  const comments = await all(`/repos/{repo}/issues/${issue.number}/comments`);
  writeFileSync(env.TASK_FILE, renderIssueTask({ issue, comments }));

  await api(`/repos/{repo}/issues/${issue.number}/comments`, {
    method: 'POST',
    body: { body: `The issue implementer started on this issue. It opens a pull request when it is done. [Run](${env.RUN_URL})` },
  });

  output({
    mode: 'issue',
    issue: issue.number,
    pr: '',
    branch,
    'base-sha': env.GITHUB_SHA,
    since,
    trigger: 'issue',
    round: 0,
  });
}

function pullRequestNumber() {
  switch (env.GITHUB_EVENT_NAME) {
    case 'issue_comment':
      return event.issue?.pull_request ? event.issue.number : null;
    case 'pull_request_review':
      return event.pull_request?.number ?? null;
    case 'workflow_run':
      return event.workflow_run?.pull_requests?.[0]?.number ?? null;
    default:
      return null;
  }
}

async function fromPullRequest() {
  let number = pullRequestNumber();
  if (!number && env.GITHUB_EVENT_NAME === 'workflow_run') {
    // `pull_requests` is empty for some runs; the head branch still names it.
    const owner = repository.split('/')[0];
    const branch = event.workflow_run?.head_branch ?? '';
    const { json } = await api(`/repos/{repo}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`);
    number = json?.[0]?.number ?? null;
  }
  if (!number) skip('no pull request in this event');

  const { json: pr } = await api(`/repos/{repo}/pulls/${number}`);
  if (pr.state !== 'open') skip(`#${number} is ${pr.state}`);
  if (!pr.head.ref.startsWith(BRANCH_PREFIX)) skip(`#${number} is not an implementer branch (${pr.head.ref})`);
  if (pr.head.repo?.full_name !== repository) skip(`#${number} comes from another repository`);

  const issueNumber = Number.parseInt(pr.head.ref.slice(BRANCH_PREFIX.length), 10);
  const [comments, reviews, threads] = await Promise.all([
    all(`/repos/{repo}/issues/${number}/comments`),
    all(`/repos/{repo}/pulls/${number}/reviews`),
    reviewThreads(number),
  ]);

  const self = env.ASSIGNEE;
  const rounds = roundsOf(pr, comments, { self });
  const last = rounds.at(-1);
  const items = openFeedback({ comments, reviews, threads, since: last?.since, self });
  if (!items.length) skip(`no open feedback on #${number} since ${last?.since ?? 'the start'}`);

  const human = items.some(item => item.human);
  // A round that ran out of time leaves its feedback open and wakes the next
  // one. Feedback from a person is then still open, so it cannot be what
  // stops the count; otherwise a task too big for the time budget would run
  // round after round.
  const automatic = !human || last?.trigger === 'stopped';
  if (automatic && trailingBotRounds(rounds) >= maxAutoRounds) {
    // Said once, as a round of its own. Its snapshot covers the findings it
    // declined, so the next wake-up does not say it again.
    if (last?.trigger !== 'limit') {
      await api(`/repos/{repo}/issues/${number}/comments`, {
        method: 'POST',
        body: {
          body: [
            `### Issue implementer paused`,
            '',
            `${maxAutoRounds} rounds in a row ran without a person asking (review findings, or rounds that ran out of`,
            'time). The implementer stops here, so that it does not trade commits without end. Comment on this pull',
            'request to start the next round, and repeat there what is still open.',
            '',
            roundMarker({ round: (last?.round ?? 0) + 1, trigger: 'limit', since }),
          ].join('\n'),
        },
      });
    }
    skip(`${maxAutoRounds} rounds in a row asked for by bots only`);
  }

  let issue = null;
  if (Number.isInteger(issueNumber)) {
    const found = await api(`/repos/{repo}/issues/${issueNumber}`, { allow: [404] });
    if (found.status === 200) issue = found.json;
  }

  writeFileSync(env.TASK_FILE, renderFeedbackTask({ pr, issue, items }));
  console.log(`${items.length} open item(s) on #${number}, ${human ? 'at least one from a person' : 'all from review bots'}.`);

  output({
    mode: 'feedback',
    issue: issue?.number ?? '',
    pr: number,
    branch: pr.head.ref,
    'base-sha': pr.head.sha,
    since,
    // The snapshot this round started from. A round that runs out of time
    // writes it again, so the feedback it did not finish stays open.
    'prev-since': last?.since ?? '',
    trigger: human ? 'human' : 'bot',
    round: (last?.round ?? 0) + 1,
  });
}

if (env.GITHUB_EVENT_NAME === 'issues') await fromIssue();
else await fromPullRequest();
