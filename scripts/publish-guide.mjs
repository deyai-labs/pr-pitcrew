/**
 * Publishes the review guide: one comment per pull request, updated in place on
 * every run, and the full rating in the run summary.
 *
 * The guide is a living document (docs/concepts/review-guide.md, 6.2). It
 * describes the whole pull request, so a new run replaces the old text rather
 * than adding a comment below it. The comment keeps its place near the top of
 * the conversation, right under the description. Ticks a reviewer set on a
 * check survive the update when the check and the code under it are the same.
 *
 * Unlike a review, the guide has no inline comments and no quality gate. Its
 * check is red only when no guide came out of the run (6.14).
 *
 * publish-report.mjs hands over to this module for an agent whose manifest
 * says `report: "guide"`, so the action has one publish step for every agent.
 *
 * Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, REVIEW_TITLE,
 * REPORT_FILE, FULL_DIFF_FILE, DIFF_FILE, GUIDE_HEAD_SHA, GUIDE_BASE_SHA,
 * GUIDE_BASE_REF, GUIDE_FLOORS, GUIDE_RATING_FILE, COVERAGE_FILE, RUN_URL,
 * GITHUB_WORKSPACE, PITCREW_FAIL_ON_NO_REPORT, DRY_RUN.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { shapeReport } from './report.mjs';
import { parseDiff, sideOf } from './guide-diff.mjs';
import {
  assessGuide,
  code,
  defuse,
  markOutdated,
  parseTicks,
  ratingJson,
  ratingSummary,
  renderGuide,
  renderMissing,
  resolveFloors,
} from './guide.mjs';
import { belongsToRun, isAnySummaryFrame, isOurSummary, isWorkingPlaceholder, summaryMarker } from './review-comments.mjs';
import { coverageCaption, parseCoverageFile } from './coverage.mjs';

const short = sha => String(sha ?? '').slice(0, 7);

/**
 * Which comment the guide goes into, and which comments go away.
 *
 * `existing` is the oldest guide comment of this bundle (Bot author and the
 * marker that names this agent), because the oldest sits highest in the
 * conversation. Without one, the raw reply the OpenCode action posted for this
 * run is claimed, if it is the only one; a second one may belong to a sibling
 * agent of the same run. `leftover` is that raw reply when the guide went
 * elsewhere, and `superseded` are guide comments beyond the first.
 */
export function pickGuideTarget(comments, { title, runId }) {
  const bots = comments.filter(comment => comment?.body && comment.user?.type === 'Bot');
  const ours = bots
    .filter(comment => isOurSummary(comment.body, title))
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || Number(a.id) - Number(b.id));
  const claimable = bots.filter(
    comment => belongsToRun(comment.body, runId) && !isAnySummaryFrame(comment.body) && !isWorkingPlaceholder(comment.body),
  );
  const raw = claimable.length === 1 ? claimable[0] : null;
  const existing = ours[0] ?? raw;
  return {
    existing,
    ours: Boolean(ours[0]),
    superseded: ours.slice(1),
    leftover: raw && raw !== existing ? raw : null,
  };
}

/** The short SHA a guide says it describes, from its footer. */
export function describedCommit(body) {
  // The footer is the last `<sub>` line. Free text of the model comes before
  // it and may hold the same words; it never starts a line with `<sub>`.
  const footer = String(body ?? '')
    .split('\n')
    .filter(line => line.startsWith('<sub>'))
    .at(-1);
  return /Describes `([0-9a-f]{7,40})`/.exec(footer ?? '')?.[1] ?? '';
}

export function outdatedSentence(described, current) {
  return `This guide describes ${code(short(described))}. The pull request has moved on to ${code(short(current))}. Comment \`/guide\` for a new one.`;
}

/** The agent's own reply, fit to stand in a frame: no run link, no heading, no marker. */
function borrowable(text) {
  const cleaned = defuse(String(text ?? ''))
    .replace(/\[github run\]\([^)]*\)/gi, '')
    .replace(/^#{1,6} .*$/gm, '')
    .trim();
  return cleaned.length <= 4000 ? cleaned : `${cleaned.slice(0, 4000)}…`;
}

/** Files the agent's diff did not hold, because fetch-diff.mjs cut it at 1 MB. */
export function filesBehindTheCut(fullDiff, agentText) {
  const agent = parseDiff(agentText);
  if (!agent.truncated) return [];
  const seen = new Set(agent.files.map(file => file.path));
  const cut = fullDiff.files.filter(file => !seen.has(file.path)).map(file => file.path);
  const last = agent.files.at(-1)?.path;
  return last ? [last, ...cut] : cut;
}

/** Whether an evidence path is a file in the checkout, and only there. */
export function inWorkspace(workspace) {
  const root = resolve(workspace);
  return path => {
    if (/^(?:\.git|\.pitcrew-run)(?:\/|$)/.test(path)) return false;
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${root}${sep}`)) return false;
    try {
      return existsSync(absolute) && statSync(absolute).isFile();
    } catch {
      return false;
    }
  };
}

/** A small GitHub client. A body that is not JSON, such as a proxy's error page, gives `json: null`. */
export function client(env) {
  const base = env.GITHUB_API_URL ?? 'https://api.github.com';
  return async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'pr-pitcrew-publish-guide',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, text, json };
  };
}

export async function listComments(api, repository, prNumber) {
  const found = [];
  for (let page = 1; page <= 20; page++) {
    const { ok, json } = await api(`/repos/${repository}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    if (!ok || !Array.isArray(json)) break;
    found.push(...json);
    if (json.length < 100) break;
  }
  return found;
}

/** The commit the old side of the diff is: the merge base, as GitHub computes the diff. */
async function mergeBase(api, env) {
  const fallback = (env.GUIDE_BASE_SHA ?? '').trim();
  const ref = (env.GUIDE_BASE_REF ?? '').trim();
  const head = (env.GUIDE_HEAD_SHA ?? '').trim();
  if (!ref || !head) return fallback;
  const { ok, json } = await api(`/repos/${env.GITHUB_REPOSITORY}/compare/${encodeURIComponent(ref)}...${head}?per_page=1`);
  return (ok && json?.merge_base_commit?.sha) || fallback;
}

function readReport(file) {
  if (!file || !existsSync(file)) return { missing: true };
  const raw = readFileSync(file, 'utf8').trim();
  if (!raw) return { missing: true };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { invalid: true };
    return shapeReport(parsed, 'guide');
  } catch {
    return { invalid: true };
  }
}

/**
 * The whole publish step. Returns the exit code: 0 published, 2 no guide came
 * out of the run, 3 the guide exists but could not be published.
 */
export async function publishGuide(env = process.env) {
  const title = env.REVIEW_TITLE ?? 'Review guide';
  const marker = summaryMarker(title);
  const repository = env.GITHUB_REPOSITORY;
  const prNumber = env.PR_NUMBER;
  const runUrl = env.RUN_URL ?? '';
  const dryRun = env.DRY_RUN === '1';
  const workspace = env.GITHUB_WORKSPACE ?? '.';
  const run = join(workspace, '.pitcrew-run');
  const reportFile = env.REPORT_FILE ?? join(run, 'report.json');
  const ratingFile = (env.GUIDE_RATING_FILE ?? '').trim() || join(run, 'guide-rating.json');
  const headSha = (env.GUIDE_HEAD_SHA ?? '').trim();
  const failOnNoReport = (env.PITCREW_FAIL_ON_NO_REPORT ?? 'true').trim().toLowerCase() !== 'false';
  const summary = markdown => {
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    console.log(markdown);
  };

  if (!dryRun && (!env.GITHUB_TOKEN || !repository || !prNumber)) {
    console.error('::error::GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER are needed to publish the guide.');
    return 3;
  }

  const api = client(env);
  const comments = dryRun ? [] : await listComments(api, repository, prNumber);
  const target = pickGuideTarget(comments, { title, runId: env.GITHUB_RUN_ID ?? '' });

  const write = async body => {
    if (dryRun) {
      console.log(body);
      return true;
    }
    const result = target.existing
      ? await api(`/repos/${repository}/issues/comments/${target.existing.id}`, { method: 'PATCH', body: JSON.stringify({ body }) })
      : await api(`/repos/${repository}/issues/${prNumber}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
    if (!result.ok) {
      console.log(`::warning::Could not publish the guide: ${result.status} ${result.text}`);
      return false;
    }
    console.log(target.existing ? `Updated the guide in comment ${target.existing.id}.` : 'Posted the guide.');
    for (const comment of [...target.superseded, ...(target.leftover ? [target.leftover] : [])]) {
      const removed = await api(`/repos/${repository}/issues/comments/${comment.id}`, { method: 'DELETE' });
      console.log(removed.ok ? `Removed comment ${comment.id}, which the guide replaces.` : `::warning::Could not remove comment ${comment.id}: ${removed.status}`);
    }
    return true;
  };

  const report = readReport(reportFile);
  if (report.missing || report.invalid) {
    const reason = report.missing
      ? 'The agent left no guide, so this run describes nothing. What happened is in the workflow run.'
      : 'The agent wrote a guide that is not valid JSON, so this run describes nothing.';
    summary(`## ${title}\n\n${reason}`);
    let body;
    if (target.ours) {
      body = markOutdated(target.existing.body, `The run for ${code(short(headSha) || 'the latest commit')} produced no guide. This one describes ${code(describedCommit(target.existing.body) || 'an earlier commit')}.`);
    } else {
      const reply = target.existing ? borrowable(target.existing.body) : '';
      body = renderMissing({ title, marker, runUrl }, reply ? `${reason}\n\n${reply}` : reason);
    }
    if (!(await write(body))) return 3;
    if (failOnNoReport) {
      console.log(`::error::No guide. ${reason}`);
      return 2;
    }
    return 0;
  }
  for (const what of report.dropped) console.log(`::warning::The guide carried ${what}, which a guide does not report. Dropped.`);

  const fullFile = (env.FULL_DIFF_FILE ?? '').trim();
  const agentFile = (env.DIFF_FILE ?? '').trim();
  const source = fullFile && existsSync(fullFile) ? fullFile : agentFile;
  if (!source || !existsSync(source)) {
    console.error('::error::There is no diff to check the guide against: FULL_DIFF_FILE and DIFF_FILE are both missing.');
    return 3;
  }
  const diff = parseDiff(readFileSync(source, 'utf8'));
  const cutFiles = agentFile && existsSync(agentFile) && source !== agentFile ? filesBehindTheCut(diff, readFileSync(agentFile, 'utf8')) : [];

  const floors = resolveFloors(env.GUIDE_FLOORS);
  for (const warning of floors.warnings) console.log(`::warning::${warning}`);

  const assessment = assessGuide({ summary: report.summary, ...report.guide }, diff, {
    exists: inWorkspace(workspace),
    floors: floors.rules,
    cutFiles,
  });

  const needsBase = diff.files.some(file => sideOf(file) === 'old');
  const baseSha = needsBase && !dryRun ? await mergeBase(api, env) : (env.GUIDE_BASE_SHA ?? '').trim();

  let outdated = '';
  if (!dryRun && headSha) {
    const { ok, json } = await api(`/repos/${repository}/pulls/${prNumber}`);
    const now = ok ? json?.head?.sha : '';
    if (now && now !== headSha) outdated = outdatedSentence(headSha, now);
  }

  const coverage = parseCoverageFile((env.COVERAGE_FILE ?? '').trim() || join(run, 'coverage.json'));
  const rendered = renderGuide(assessment, {
    server: env.GITHUB_SERVER_URL ?? 'https://github.com',
    repository,
    prNumber,
    headSha,
    baseSha,
    runUrl,
    title,
    marker,
    coverageCaption: coverageCaption(coverage),
    ticks: target.ours ? parseTicks(target.existing.body) : new Set(),
    outdated,
  });

  summary(ratingSummary(assessment, { title, floorsSource: floors.source, warnings: [...floors.warnings, ...rendered.excerptNotes] }));
  if (rendered.shortened.length) summary(`## ${title}: the full guide\n\nThe comment was shortened (${rendered.shortened.join(', ')}). This is the guide in full.\n\n${rendered.full}\n`);

  try {
    mkdirSync(dirname(ratingFile), { recursive: true });
    writeFileSync(ratingFile, `${JSON.stringify(ratingJson(assessment), null, 2)}\n`);
  } catch (error) {
    console.log(`::warning::Could not write ${ratingFile}: ${error.message}`);
  }

  return (await write(rendered.body)) ? 0 : 3;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await publishGuide());
