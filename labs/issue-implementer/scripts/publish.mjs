#!/usr/bin/env node
/**
 * The second lane: turns the agent's patch into a commit, pushes it, and opens
 * the pull request or writes the round comment.
 *
 * This job holds the write token and no model key, and it reads two files the
 * agent made: the patch and the summary. It never runs anything from the
 * agent's branch; its scripts come from the default branch. The job that read
 * the issue and ran the shell had no way to push. See ADR 7, "Agents that
 * write".
 *
 * The token is a GitHub App token or a user's token, on purpose. A push or a
 * pull request made with the workflow's own GITHUB_TOKEN starts no workflow, so the review agents
 * would never see the implementer's work and the loop would end after one
 * round.
 *
 * A failure is reported with the workflow's own token (NOTICE_TOKEN) for the
 * same reason the other way round: that comment must not start a run. Made
 * with the app token, it would wake the workflow, which would find the same
 * open feedback, fail the same way and comment again, without end.
 *
 * Environment: GITHUB_TOKEN (the app token), NOTICE_TOKEN, GITHUB_REPOSITORY,
 * GITHUB_SERVER_URL, MODE, ISSUE, PR, BRANCH, BASE_BRANCH, SINCE, TRIGGER,
 * ROUND, PREV_SINCE, RESULT_DIR, IMPLEMENT_RESULT, RUN_URL, and APP_SLUG when the token is
 * an app's.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { client } from './github.mjs';
import {
  commitMessage,
  forbiddenPaths,
  pathsFromPatch,
  pullRequestBody,
  roundComment,
  roundMarker,
  stripMarkers,
} from './lib.mjs';

const env = process.env;
const { api } = client(env.GITHUB_TOKEN, env.GITHUB_REPOSITORY);
const notices = client(env.NOTICE_TOKEN || env.GITHUB_TOKEN, env.GITHUB_REPOSITORY);
const mode = env.MODE;
const round = Number(env.ROUND || 0);
const target = mode === 'issue' ? env.ISSUE : env.PR;
const runUrl = env.RUN_URL;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const read = name => {
  const path = join(env.RESULT_DIR, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
};
const comment = body => api(`/repos/{repo}/issues/${target}/comments`, { method: 'POST', body: { body } });

/** No round marker: the feedback stays open, and the next wake-up tries again. */
async function giveUp(reason) {
  console.error(`::error::${reason}`);
  const retry =
    mode === 'issue'
      ? 'Assign the issue to the implementer again to retry.'
      : 'The feedback stays open. The next comment on this pull request starts a new round.';
  await notices.api(`/repos/{repo}/issues/${target}/comments`, {
    method: 'POST',
    body: { body: `### Issue implementer: nothing pushed\n\n${reason}\n\n${retry} [Run](${runUrl})` },
  });
  process.exit(1);
}

const patch = read('patch.diff');
const status = (read('status') ?? '').trim();
if (env.IMPLEMENT_RESULT !== 'success' || patch === null) {
  await giveUp(`The agent's job ended with "${env.IMPLEMENT_RESULT}" and left no usable result.`);
}

// Model output. HTML comments go: a marker in here would otherwise sit next to
// the real one, and the snapshot decides what is ever handled again.
const summary = stripMarkers(read('summary.md') ?? '');
const stopped = status === 'stopped';

// A feedback round that ran out of time handled only part of its task. Its
// marker repeats the previous snapshot, so that task stays open, and the round
// comment wakes the next round to finish it. An issue round has no feedback to
// keep open; its pull request carries the warning.
const marker =
  stopped && mode === 'feedback'
    ? roundMarker({ round, trigger: 'stopped', since: env.PREV_SINCE || new Date(0).toISOString() })
    : roundMarker({ round, trigger: env.TRIGGER, since: env.SINCE });

const refused = forbiddenPaths(pathsFromPatch(patch));
if (refused.length) {
  await giveUp(`The change touches paths the implementer may not change: ${refused.map(path => `\`${path}\``).join(', ')}.`);
}

if (!patch.trim()) {
  if (mode === 'issue') {
    await comment(`### Issue implementer: no changes\n\nThe agent changed nothing, so there is no pull request.\n\n${summary}\n\n[Run](${runUrl})`);
  } else {
    await comment(roundComment({ round, summary, commitUrl: null, marker, runUrl, stopped }));
  }
  console.log('Empty patch: nothing to push.');
  process.exit(0);
}

// The commit carries the name of whoever pushes it: the app's bot, or the
// account behind push-token. The history then says who wrote it.
const author = env.APP_SLUG
  ? { ...(await api(`/users/${encodeURIComponent(`${env.APP_SLUG}[bot]`)}`)).json, login: `${env.APP_SLUG}[bot]` }
  : (await api('/user')).json;
git('config', 'user.name', author.login);
git('config', 'user.email', `${author.id}+${author.login}@users.noreply.github.com`);

let issue = null;
if (env.ISSUE) issue = (await api(`/repos/{repo}/issues/${env.ISSUE}`)).json;

try {
  execFileSync('git', ['apply', '--index', '--binary', '--whitespace=nowarn', join(env.RESULT_DIR, 'patch.diff')], {
    stdio: 'inherit',
  });
  git('commit', '--quiet', '-m', commitMessage({ mode, issue, round }));
} catch {
  await giveUp('The patch does not apply to the commit the round started from.');
}

try {
  // No force. When somebody pushed to the branch during the round, this fails
  // rather than throwing their commit away.
  execFileSync('git', ['push', 'origin', `HEAD:refs/heads/${env.BRANCH}`], { stdio: 'inherit' });
} catch {
  await giveUp(`Pushing to \`${env.BRANCH}\` failed. Somebody may have pushed to it during the round.`);
}

const sha = git('rev-parse', 'HEAD');
const commitUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/commit/${sha}`;

if (mode === 'issue') {
  const { json: pr } = await api('/repos/{repo}/pulls', {
    method: 'POST',
    body: {
      title: issue.title,
      head: env.BRANCH,
      base: env.BASE_BRANCH,
      body: pullRequestBody({ issue, summary, marker, runUrl, stopped }),
    },
  });
  await comment(`The issue implementer opened ${pr.html_url}.`);
  console.log(`Opened ${pr.html_url}`);
} else {
  await comment(roundComment({ round, summary, commitUrl, marker, runUrl, stopped }));
  console.log(`Pushed ${commitUrl}`);
}
