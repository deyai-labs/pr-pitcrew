/**
 * Marks the review guide as outdated after a push, when the repository turned
 * the guide's push trigger off (`PITCREW_GUIDE_ON_PUSH=false`).
 *
 * Without a new run the guide keeps pointing at old lines and old code. It
 * cannot know that by itself: it was written before the push. So the reusable
 * workflow runs this small job instead of the agent. It spends no model call,
 * and it changes two lines: the heading says "outdated", and one sentence says
 * which commit the guide describes and where the pull request is now
 * (docs/concepts/review-guide.md, 6.14).
 *
 * Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, AFTER_SHA,
 * REVIEW_TITLE.
 */

import { markOutdated } from './guide.mjs';
import { describedCommit, listComments, outdatedSentence, pickGuideTarget } from './publish-guide.mjs';

/** The new body, or null when there is nothing to change. */
export function outdatedBody(body, after) {
  const described = describedCommit(body);
  if (!described || !after || after.startsWith(described)) return null;
  const next = markOutdated(body, outdatedSentence(described, after));
  return next === body ? null : next;
}

async function main() {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, PR_NUMBER: prNumber } = process.env;
  const after = (process.env.AFTER_SHA ?? '').trim();
  const title = process.env.REVIEW_TITLE ?? 'Review guide';
  if (!token || !repository || !prNumber) {
    console.error('::error::GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER are needed.');
    process.exit(1);
  }

  const api = async (path, init = {}) => {
    const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'pr-pitcrew-guide-outdated',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text, json: text ? JSON.parse(text) : null };
  };

  const { existing, ours } = pickGuideTarget(await listComments(api, repository, prNumber), { title, runId: '' });
  if (!ours) {
    console.log('This pull request has no guide yet; nothing to mark.');
    return;
  }
  const body = outdatedBody(existing.body, after);
  if (!body) {
    console.log('The guide already says where the pull request is.');
    return;
  }
  const result = await api(`/repos/${repository}/issues/comments/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ body }) });
  if (!result.ok) {
    console.log(`::warning::Could not mark the guide as outdated: ${result.status} ${result.text}`);
    return;
  }
  console.log(`Marked the guide in comment ${existing.id} as outdated.`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
