/**
 * Puts the issue a pull request closes into a file, so the agent does not have
 * to go and get it.
 *
 * The acceptance agent used to be told to run `gh issue view <number>`. Two
 * things were wrong with that. `gh` is not in every runner image - it is not in
 * the Playwright one this agent runs in - so on a bad day the instruction was a
 * no-op and the agent invented criteria from the pull request title. And an
 * agent that has to fetch things needs the rights to fetch things; one that is
 * handed a file needs none.
 *
 * Not finding an issue is not a failure. Plenty of pull requests close nothing,
 * and the prompt says what to do then: derive what the change claims from its
 * title, body and diff, and say in the report that you did.
 *
 * With DESCRIPTION_FILE set, the pull request's own title and body go into
 * that file too. On the `pull_request` path the runtime assembles no pull
 * request context into the prompt (ADR 9), and the review guide compares the
 * changes with what the description says (P11). An agent without a shell
 * cannot fetch it.
 *
 * Environment: GITHUB_REPOSITORY, PR_NUMBER, ISSUE_FILE, GITHUB_TOKEN,
 * optionally DESCRIPTION_FILE.
 */

import { appendFileSync, writeFileSync } from 'node:fs';

/**
 * GitHub's own closing keywords, and only in the pull request body - the same
 * text GitHub itself reads to link an issue. A bare `#12` is not enough: pull
 * request bodies mention neighbouring issues all the time, and testing against
 * the wrong criteria is worse than testing against none.
 *
 * A full URL is accepted because that is what a paste produces, but only when
 * it points at this repository. An agent that followed a link to a stranger's
 * issue would be reading text nobody in this repository wrote.
 */
export function findIssueNumber(body, repo) {
  const text = String(body ?? '');
  const keywords = 'close[sd]?|fix(e[sd])?|resolve[sd]?';
  const patterns = [
    new RegExp(`\\b(?:${keywords})\\b[:\\s]+#(\\d+)`, 'i'),
    new RegExp(`\\b(?:${keywords})\\b[:\\s]+https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/issues/(\\d+)`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return Number(match.at(-1));
  }
  return null;
}

/** The pull request's title and body as the agent reads them. */
export function describePullRequest(title, body) {
  const text = String(body ?? '').trim();
  return `# ${String(title ?? '').trim()}\n\n${text || '(The pull request has no description.)'}\n`;
}

async function main() {
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const repository = process.env.GITHUB_REPOSITORY;
  const prNumber = process.env.PR_NUMBER;
  const issueFile = process.env.ISSUE_FILE;
  const token = process.env.GITHUB_TOKEN;

  if (!repository || !prNumber || !issueFile || !token) {
    console.error('::error::fetch-issue.mjs needs GITHUB_REPOSITORY, PR_NUMBER, ISSUE_FILE and GITHUB_TOKEN.');
    process.exit(1);
  }

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'pr-pitcrew-fetch-issue',
  };

  // The path is exported whatever happens, including when the file ends up
  // empty. The agent has no shell and cannot resolve a variable, so the prompt's
  // `$ISSUE_FILE` is substituted from this - and a run that skipped the export
  // would hand the agent those eleven characters and a puzzle. An empty file is
  // an answer; a literal placeholder is not.
  const descriptionFile = (process.env.DESCRIPTION_FILE ?? '').trim();
  const announce = () => {
    if (!process.env.GITHUB_ENV) return;
    appendFileSync(process.env.GITHUB_ENV, `ISSUE_FILE=${issueFile}\n${descriptionFile ? `DESCRIPTION_FILE=${descriptionFile}\n` : ''}`);
  };
  if (descriptionFile) writeFileSync(descriptionFile, '');

  const nothingToRead = reason => {
    console.log(reason);
    writeFileSync(issueFile, '');
    announce();
    process.exit(0);
  };

  const pull = await fetch(`${api}/repos/${repository}/pulls/${prNumber}`, { headers });
  if (!pull.ok) nothingToRead(`::warning::Could not read pull request #${prNumber}, so its linked issue could not be looked up.`);

  const { body, title: prTitle } = await pull.json();
  if (descriptionFile) {
    writeFileSync(descriptionFile, describePullRequest(prTitle, body));
    console.log(`Description of #${prNumber}: ${String(body ?? '').length} characters.`);
  }
  const number = findIssueNumber(body, repository);
  if (!number) nothingToRead('This pull request closes no issue that its body names. The agent works from the pull request itself.');

  const issue = await fetch(`${api}/repos/${repository}/issues/${number}`, { headers });
  if (!issue.ok) nothingToRead(`::warning::Pull request #${prNumber} closes #${number}, but that issue could not be read (${issue.status}).`);

  const { title, body: issueBody, html_url: url } = await issue.json();
  const text = `# ${title}\n\n${url}\n\n${issueBody ?? ''}\n`;
  writeFileSync(issueFile, text);
  console.log(`Issue #${number}: ${title} (${text.length} bytes)`);
  announce();
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
