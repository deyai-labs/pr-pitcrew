#!/usr/bin/env node
/**
 * Turns an agent's report into the three things a reviewer actually reads: one
 * summary comment on the pull request, inline comments at the code, and the same
 * report again in the run summary.
 *
 * The split matters. What the inline comments add is anchoring: a finding
 * sitting next to the line it is about gets fixed, the same finding in a long
 * comment gets skimmed. What the summary comment adds is a fixed shape - and,
 * for a run that produced criteria rather than findings, the criteria table and
 * a link to the artifact holding the recording, so that the outcome is readable
 * without leaving the pull request.
 *
 * A finding whose line is not part of the diff cannot be anchored - GitHub
 * answers 422 - so it is moved into the review body rather than dropped. A
 * finding that disappears because of an API rule is worse than an ugly one.
 *
 * Report format (all fields optional, unknown fields ignored):
 *
 *   { "verdict": "pass" | "attention" | "fail",
 *     "summary": "markdown",
 *     "findings": [{ "file", "line", "severity", "title", "body" }],
 *     "criteria": [{ "title", "status", "at", "evidence" }] }
 *
 * Publishing comes first and the exit code last, always: a gate that failed a
 * run before its findings were on the pull request would hide exactly the
 * information the red check is about.
 *
 * An agent with `report: "guide"` is handed to publish-guide.mjs before any of
 * this: the review guide has no findings and no gate.
 *
 * Exit codes, because a red check has to say which kind of red it is:
 *
 *   0  the quality gate holds
 *   1  findings at or above the threshold - this run's, or earlier ones nobody
 *      has fixed or dismissed
 *   2  no usable report: the agent wrote none, or wrote something that is not
 *      JSON. Nothing was reviewed, which is not the same as nothing was found.
 *   3  the report exists but could not be published
 *
 * Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, REVIEW_TITLE,
 * optionally REPORT_FILE, RUN_URL, ARTIFACT_NAME, ARTIFACT_LABEL, DRY_RUN,
 * PITCREW_FAIL_ON, PITCREW_FAIL_ON_NO_REPORT, PITCREW_REQUIRE_FULL_COVERAGE,
 * COVERAGE_FILE.
 */

import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { shapeReport } from './report.mjs';
import {
  belongsToRun,
  findingMarker,
  isOurFinding,
  isOurSummary,
  pickSummaryTarget,
  summaryMarker,
} from './review-comments.mjs';
import { applyCoverageGate, coverageCaption, parseCoverageFile, unreadLine } from './coverage.mjs';

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const title = process.env.REVIEW_TITLE ?? 'Pitcrew review';
const runUrl = process.env.RUN_URL ?? '';
const dryRun = process.env.DRY_RUN === '1';

/**
 * The artifact this run uploads, if it uploads one. Naming it here turns it
 * into a download link in the summary comment - which is as close to the video
 * as a comment can get, GitHub playing nothing that was not uploaded through
 * its own web interface. Unset in a workflow that uploads nothing, and then
 * there is simply no link.
 */
const artifactName = (process.env.ARTIFACT_NAME ?? '').trim();
const artifactLabel = (process.env.ARTIFACT_LABEL ?? '').trim() || artifactName;

/** Agreed with actions/agent/action.yml, which hands the same path to the agent. */
const reportFile = process.env.REPORT_FILE ?? join(process.env.GITHUB_WORKSPACE ?? '.', '.pitcrew-run', 'report.json');

/** From the agent's manifest: `findings`, `criteria`, `guide`, or unset. See shapeReport. */
const reportKind = (process.env.REPORT_KIND ?? 'unknown').trim() || 'unknown';

// The review guide is published differently: one comment updated in place, no
// comments at the code, no quality gate. Handed over here, so the action keeps
// one publish step for every agent. See publish-guide.mjs and ADR 10.
if (reportKind === 'guide') {
  const { publishGuide } = await import('./publish-guide.mjs');
  process.exit(await publishGuide());
}

// Invisible in the rendered comment, and the only way a later run can tell its
// own findings from a human's remark or another reviewer's. Written and
// recognised in review-comments.mjs, which also still reads the pre-1.0 name.
const MARKER = findingMarker;

// The same idea for the summary comment. It carries the review name because
// under the orchestrator three reviews share one run id, and a marker that
// does not name the review cannot tell their comments apart. See
// review-comments.mjs.
const SUMMARY_MARKER = summaryMarker(title);

// The same three words in the same place on every run, so the shape of a
// comment says what happened before anybody reads it.
const VERDICT_LABEL = { pass: 'no objections', attention: 'worth a look', fail: 'needs changes' };

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
const STATUS_LABEL = {
  met: 'met',
  unmet: 'not met',
  'not-demonstrable': 'not demonstrable',
};

/**
 * A severity is a word, and a word in a list of words is read at the same speed
 * as every other word. These are what let somebody see how bad it is before
 * reading anything - which is the whole point of a summary comment on a long
 * pull request.
 *
 * Six symbols, one meaning each, and each used in that meaning only: three dots
 * for how severe a finding is, and ✅ / ⚠️ / ❌ / ➖ for how something turned out.
 * The word stays next to the symbol in every place - a colour alone tells a
 * screen reader nothing, and nobody has to learn a legend.
 */
const SEVERITY_MARK = { high: '🔴', medium: '🟠', low: '⚪' };
const VERDICT_MARK = { pass: '✅', attention: '⚠️', fail: '❌' };
const STATUS_MARK = { met: '✅', unmet: '❌', 'not-demonstrable': '➖' };

/**
 * The symbol for a value, or nothing for one nobody mapped.
 *
 * Nothing rather than a default: severity is a free-text field in a report a
 * model wrote, and marking an unexpected value `medium` (or worse, `high`)
 * would be this script inventing a fact the agent never stated.
 */
const mark = (marks, value) => {
  // hasOwn, not a plain lookup: a report is model output, and a severity of
  // "constructor" would otherwise reach into the prototype and print a function.
  const key = String(value ?? '').toLowerCase();
  return Object.hasOwn(marks, key) ? marks[key] : '';
};

/** `🔴 high`, or just `high` when the value is not one we know. */
const marked = (marks, value, label = value) => `${mark(marks, value)} ${label}`.trim();

/**
 * The quality gate: the severity from which a review stops being advisory.
 *
 * A check that is green whatever the agent found is a check that gets merged
 * past, and a `high` finding then differs from "nothing found" only in how
 * carefully somebody read the comments. `high` is the default because that is
 * the severity the prompts reserve for a defect they can demonstrate rather
 * than argue about.
 *
 * A repository variable and not a constant, because a bundle that is copied
 * into other repositories may not judge for them where the line sits. `never`
 * switches the gate off; the acceptance test sets it, having criteria rather
 * than findings and therefore no severity to threshold.
 */
const THRESHOLD = { high: 3, medium: 2, low: 1, never: Number.POSITIVE_INFINITY };
const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

const failOn = (() => {
  const configured = (process.env.PITCREW_FAIL_ON ?? '').trim().toLowerCase();
  if (!configured) return 'high';
  if (Object.hasOwn(THRESHOLD, configured)) return configured;
  // Deliberately not `never`: a typo in a repository variable must not be the
  // quietest way there is to switch the gate off.
  console.log(
    `::warning::PITCREW_FAIL_ON is "${configured}", which is none of high, medium, low, never. Falling back to high.`,
  );
  return 'high';
})();

/**
 * Whether a run that produced no usable report ends red.
 *
 * Yes by default, and that is the whole point of criterion 4: an agent that
 * wrote nothing has reviewed nothing, and reading that as "no findings" makes
 * the gate blind precisely when it matters. The two states stay
 * distinguishable - a different exit code, a different heading, a different
 * sentence - so nobody has to guess which happened.
 */
const failOnNoReport = (process.env.PITCREW_FAIL_ON_NO_REPORT ?? 'true').trim().toLowerCase() !== 'false';

/**
 * Whether a measured shortfall — files the agent was handed and did not open —
 * fails the check.
 *
 * Yes by default, in the same shape as `PITCREW_FAIL_ON_NO_REPORT`: a pass
 * built only on hunks is not evidence that the files were reviewed, and
 * reading that as "no findings" makes the gate blind in exactly the case this
 * floor exists for. `false` keeps the number on the comment and the check
 * green, for a repository that would rather have the check than the floor.
 */
const requireFullCoverage = (process.env.PITCREW_REQUIRE_FULL_COVERAGE ?? 'true').trim().toLowerCase() !== 'false';

const coverageFile =
  (process.env.COVERAGE_FILE ?? '').trim() || join(process.env.GITHUB_WORKSPACE ?? '.', '.pitcrew-run', 'coverage.json');
const coverage = parseCoverageFile(coverageFile);

/**
 * A severity as a number. An absent or unrecognised one counts as `medium`,
 * which is the same default `renderFinding` prints it with - the gate and the
 * comment must not disagree about what a finding is.
 */
const severityRank = severity => SEVERITY_RANK[String(severity ?? '').toLowerCase()] ?? SEVERITY_RANK.medium;

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
  console.log(markdown);
}

/** GHES and the test harness both need this to point elsewhere; Actions sets it. */
const apiBase = process.env.GITHUB_API_URL ?? 'https://api.github.com';

async function api(path, init = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'pr-pitcrew-publish-report',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text, json: text ? safeParse(text) : null };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readReport() {
  if (!existsSync(reportFile)) return { missing: true };
  const raw = readFileSync(reportFile, 'utf8').trim();
  if (!raw) return { missing: true };

  const parsed = safeParse(raw);
  if (!parsed || typeof parsed !== 'object') return { invalid: raw.slice(0, 400) };

  const report = shapeReport(parsed, reportKind);
  for (const what of report.dropped) {
    console.log(`::warning::The report carried ${what}, which a "${reportKind}" agent does not report. Dropped.`);
  }
  return report;
}


/**
 * The browser download URL of this run's artifact, or '' when there is none.
 *
 * The id is only knowable after the upload step has run, and only through the
 * Actions API - which is why the workflow needs `actions: read`. Every failure
 * here is a warning rather than an error: a comment without the link is worth
 * far more than no comment.
 */
async function artifactLink() {
  const runId = process.env.GITHUB_RUN_ID;
  if (!artifactName || !runId || !repository || dryRun) return '';

  const { ok, json, status, text } = await api(
    `/repos/${repository}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(artifactName)}`,
  );
  if (!ok) {
    console.log(`::warning::Could not look up the "${artifactName}" artifact (${status} ${text}); the comment gets no download link.`);
    return '';
  }

  // Newest first: a re-run of the same workflow run adds a second artifact under
  // the same name, and linking the previous attempt's recording would be worse
  // than linking none - it looks current and shows something else.
  const artifact = (json?.artifacts ?? [])
    .filter(entry => entry.name === artifactName && !entry.expired)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0];
  if (!artifact) {
    console.log(`::warning::This run has no artifact named "${artifactName}"; the comment gets no download link.`);
    return '';
  }

  // Not `archive_download_url`: that one is the API endpoint and needs a token.
  // This is the page a person lands on when they click "download" in the run.
  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  return `${server}/${repository}/actions/runs/${runId}/artifacts/${artifact.id}`;
}

/**
 * The lines of each file that a review comment may point at: everything the
 * diff shows on the right-hand side, added and unchanged alike. Anything else
 * is rejected by the API.
 */
async function addressableLines() {
  const perFile = new Map();

  for (let page = 1; ; page++) {
    const { ok, json, status, text } = await api(`/repos/${repository}/pulls/${prNumber}/files?per_page=100&page=${page}`);
    if (!ok) throw new Error(`Listing changed files failed: ${status} ${text}`);

    for (const file of json) {
      if (!file.patch || file.status === 'removed') continue;

      const lines = new Set();
      let cursor = 0;

      for (const line of file.patch.split('\n')) {
        const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (header) {
          cursor = Number(header[1]);
          continue;
        }
        if (line.startsWith('-')) continue;
        if (line.startsWith('+') || line.startsWith(' ')) {
          lines.add(cursor);
          cursor += 1;
        }
      }

      perFile.set(file.filename, lines);
    }

    if (json.length < 100) break;
  }

  return perFile;
}

/**
 * What this bundle has already said, per file: the line each of its review
 * comments sits on, and the point it made there.
 *
 * Without this, every push re-reviews and a point that was made, answered and
 * consciously left alone comes back - reworded just enough to look new. That is
 * how an assistant that finds real defects turns into one people mute. The
 * agent is asked in its prompt not to repeat itself; this is the part that does
 * not depend on it noticing.
 *
 * Only this bundle's own comments count. Two conditions, and both are needed:
 * the marker every rendered finding carries, and an author GitHub reports as a
 * Bot. The marker alone is not evidence of anything - it is an HTML comment,
 * and anyone who can review this pull request could paste it into a comment of
 * their own, pick a title that matches whatever they would rather not hear
 * about, and switch the finding off. Silently, which is the part that matters.
 * A person cannot post as a Bot, so the pair closes that.
 *
 * A human's objection is theirs to repeat or drop, and another reviewer's - a
 * second bot, say - is a second opinion worth hearing rather than a reason to
 * fall silent; neither carries this marker.
 */
async function commentedLines() {
  const perFile = new Map();

  for (let page = 1; page <= 5; page++) {
    const { ok, json } = await api(`/repos/${repository}/pulls/${prNumber}/comments?per_page=100&page=${page}`);
    // Not fatal: a missing history means findings get repeated, which is worse
    // than it looks but far better than posting nothing.
    if (!ok) {
      console.log('::warning::Could not read the existing review comments, so nothing can be recognised as already said.');
      return perFile;
    }

    for (const comment of json) {
      if (comment.user?.type !== 'Bot' || !isOurFinding(comment.body)) continue;
      const line = comment.line ?? comment.original_line;
      if (!comment.path || !Number.isInteger(line)) continue;
      // renderFinding writes the title as the first line, in bold - since the
      // severity marks it is preceded by a symbol, and comments from before that
      // start with the bold run itself. `[^*]*` covers both, and stops at the
      // first asterisk so it cannot skip past an empty title into a later line.
      const title = /^[^*]*\*\*(.+?)\*\*/.exec(comment.body)?.[1] ?? '';
      if (!perFile.has(comment.path)) perFile.set(comment.path, []);
      perFile.get(comment.path).push({ line, title });
    }

    if (json.length < 100) break;
  }

  return perFile;
}

/** GHES answers GraphQL elsewhere than REST; Actions sets this. */
const graphqlUrl = process.env.GITHUB_GRAPHQL_URL ?? 'https://api.github.com/graphql';

const THREADS_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved
            isOutdated
            path
            line
            comments(first: 1) { nodes { body url author { __typename } } }
          }
        }
      }
    }
  }`;

/**
 * What this bundle has already reported and nobody has dealt with: its own
 * review threads that are neither resolved nor outdated.
 *
 * This is what keeps the second run from going green while the first run's
 * findings still stand. A review reads the *new* commits, so a push that does
 * not touch the flagged line reports nothing - and without this the check would
 * turn green and read as "fixed", which is the one reading nobody may get.
 *
 * Two ways out, and both are somebody deciding rather than something lapsing:
 * change the line, and GitHub marks the thread outdated by itself; or resolve
 * the thread, which is a person saying they looked. Neither happens by
 * accident, and both are visible on the pull request.
 *
 * GraphQL rather than REST, because whether a thread is resolved is a property
 * of the thread and the REST review-comment API does not carry it. The same two
 * conditions as everywhere else decide what counts as this bundle's own: the
 * marker in the body *and* an author GitHub reports as a Bot.
 *
 * Read before anything is posted, so this run's own comments are history rather
 * than part of it.
 */
async function unresolvedFindings() {
  const [owner, name] = String(repository).split('/');
  const findings = [];
  let cursor = null;

  for (let page = 1; page <= 5; page++) {
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'pr-pitcrew-publish-report',
      },
      body: JSON.stringify({ query: THREADS_QUERY, variables: { owner, name, number: Number(prNumber), cursor } }),
    });

    const text = await response.text();
    const threads = safeParse(text)?.data?.repository?.pullRequest?.reviewThreads;

    // A warning rather than an error, and it says what the gate is missing:
    // losing the history means this run is judged on its own findings, which is
    // the behaviour before this existed. Refusing to publish would cost more.
    if (!response.ok || !threads) {
      console.log(
        `::warning::Could not read the review threads (${response.status} ${text.slice(0, 300)}). Findings from earlier runs are not counted; the gate sees this run only.`,
      );
      return findings;
    }

    for (const thread of threads.nodes ?? []) {
      if (thread.isResolved || thread.isOutdated) continue;
      const comment = thread.comments?.nodes?.[0];
      if (comment?.author?.__typename !== 'Bot' || !isOurFinding(comment.body)) continue;

      // The shape renderFinding writes: `🔴 **Title** (high)`. The first match
      // is the title line, whatever the body says further down.
      const parsed = /\*\*(.+?)\*\*\s*\(([^)]*)\)/.exec(comment.body);
      findings.push({
        title: parsed?.[1] ?? '(untitled)',
        severity: parsed?.[2] ?? '',
        file: thread.path ?? '',
        line: thread.line ?? null,
        url: comment.url ?? '',
      });
    }

    if (!threads.pageInfo?.hasNextPage) break;
    cursor = threads.pageInfo.endCursor;
  }

  return findings;
}

/**
 * The verdict of the quality gate: whether this run may end green, and the one
 * sentence that says why.
 *
 * Three outcomes, and keeping them apart is the point. A run below the
 * threshold passes and its findings are still published. A run at or above it
 * fails, counting both what it found now and what earlier runs found and nobody
 * closed. A run without a usable report fails *differently*: nothing was
 * reviewed, which must not read like nothing was found - nor the other way
 * round.
 */
function evaluateGate(report, unresolved) {
  const threshold = THRESHOLD[failOn];
  const broken = report.missing || report.invalid;

  if (!Number.isFinite(threshold)) {
    return { failed: false, mark: '➖', label: 'off', reason: 'The quality gate is switched off (`PITCREW_FAIL_ON=never`).', standing: [] };
  }

  const standing = unresolved.filter(finding => severityRank(finding.severity) >= threshold);
  const fresh = (report.findings ?? []).filter(finding => severityRank(finding.severity) >= threshold);
  const stillOpen = standing.length > 0 ? ` ${plural(standing.length, 'finding')} from an earlier run ${standing.length === 1 ? 'is' : 'are'} still open.` : '';

  if (broken) {
    const what = report.missing
      ? 'The agent left no report, so this diff was not reviewed.'
      : 'The report is not valid JSON, so this diff was not reviewed.';

    if (failOnNoReport) {
      return { failed: true, kind: 'no-report', mark: '❌', label: 'failed', reason: `${what} A run that reviewed nothing is not a run that found nothing.${stillOpen}`, standing };
    }
    if (standing.length > 0) {
      return { failed: true, kind: 'findings', mark: '❌', label: 'failed', reason: `${what}${stillOpen}`, standing };
    }
    return { failed: false, mark: '➖', label: 'not evaluated', reason: `${what} \`PITCREW_FAIL_ON_NO_REPORT\` is false, so the check stays green anyway.`, standing };
  }

  const below = (report.findings ?? []).length - fresh.length;
  if (fresh.length + standing.length === 0) {
    return {
      failed: false,
      mark: '✅',
      label: 'passed',
      reason: below > 0
        ? `Nothing reaches \`${failOn}\`; ${plural(below, 'finding')} below it.`
        : `Nothing at or above \`${failOn}\`.`,
      standing,
    };
  }

  const parts = [];
  if (fresh.length > 0) parts.push(`${plural(fresh.length, 'finding')} in this run`);
  if (standing.length > 0) parts.push(`${plural(standing.length, 'finding')} still open from an earlier run`);

  return {
    failed: true,
    kind: 'findings',
    mark: '❌',
    label: 'failed',
    reason: `${parts.join(', ')} at or above \`${failOn}\`.`,
    standing,
  };
}

/**
 * The last thing this script does, and deliberately the last: everything the
 * run has to say is on the pull request by now, so the exit code can only
 * change the colour of the check, never what is readable.
 */
function finish(gate) {
  if (!gate.failed) {
    console.log(`Quality gate ${gate.label}: ${gate.reason}`);
    process.exit(0);
  }
  console.log(`::error::Quality gate failed. ${gate.reason}`);
  process.exit(gate.kind === 'no-report' ? 2 : 1);
}

/**
 * The comment every run leaves on the pull request, in one shape that never
 * varies: heading, verdict, counts, the agent's own sentence, scope, link.
 *
 * Built here rather than written by the agent on purpose. A model asked for
 * "three to six lines" produces six different shapes across six runs, and
 * somebody scrolling a long pull request has to read each one to find out what
 * it is. A fixed frame is placed once and recognised from then on. What stays
 * the agent's is the part only it can write: the one sentence a reviewer needs
 * if they read nothing else.
 */
function summaryComment(report, scope, agentText, artifactUrl, gate) {
  // A run that left no report still gets the frame. Without it the only thing
  // on the pull request is the agent's free-form reply - which is the shape
  // this frame exists to replace, and which reads at a glance like a run that
  // went fine.
  const broken = report.missing || report.invalid;
  const verdict = String(report.verdict ?? 'attention').toLowerCase();
  const label = broken ? 'no report' : (VERDICT_LABEL[verdict] ?? verdict);
  // A run without a report is not a verdict, so it gets the "look at this" mark
  // rather than one of the three that mean something about the code.
  const badge = broken ? '⚠️' : mark(VERDICT_MARK, verdict);

  const lines = [`### ${title} — ${`${badge} ${label}`.trim()}`, ''];

  // On a broken run the agent's own words are the only content there is, so
  // they are kept rather than overwritten.
  //
  // Rendered as ordinary Markdown, not as a quote. A quote says "somebody else
  // said this, elsewhere", and reads as an aside to be skipped - while this is
  // the one paragraph most readers will read. It also flattened whatever
  // structure the agent gave it: a list inside a blockquote is a list nobody
  // wants to read. Its line breaks are kept for the same reason.
  const sentence = broken ? borrowable(agentText) : String(report.summary ?? '').trim();
  if (sentence) lines.push(sentence, '');

  lines.push(
    broken
      ? sentence
        ? '**No structured report**, so there are no counts and nothing could be placed at the code.'
        : '**This run produced neither a report nor a reply.** What went wrong is in the workflow run.'
      : countLine(report),
    '',
  );

  // The reason a check is red belongs where the check is looked at. In the job
  // log it is found by whoever already suspects it.
  if (gate) {
    lines.push(
      `**Quality gate: ${`${gate.mark} ${gate.label}`.trim()}** — ${gate.reason}`,
      '',
    );
    if (gate.standing.length > 0) lines.push(...standingList(gate), '');
  }

  // Named on the comment even when the gate stays green: that is what makes a
  // shallow run and a thorough one look different. When the gate already
  // failed for coverage, the reason named the files and repeating them is
  // noise.
  const unread = unreadLine(coverage);
  if (unread && gate?.kind !== 'coverage') lines.push(unread, '');

  const trailer = [
    scope && `Scope: ${scope}`,
    coverageCaption(coverage),
    runUrl && `[Workflow run](${runUrl})`,
    artifactUrl && `[${artifactLabel}](${artifactUrl})`,
  ].filter(Boolean);
  const foot = trailer.length ? [`<sub>${trailer.join(' · ')}</sub>`, SUMMARY_MARKER] : [SUMMARY_MARKER];

  // The table belongs where the criteria are read, and that is here. It used to
  // live only in the run summary, one click away behind a green check nobody
  // opens - so the pull request showed a verdict and a sentence, while which
  // criterion actually failed was somewhere else. The run summary keeps its
  // copy: that is the page the recording is attached to.
  const table = criteriaTable(report);
  const body = [...lines, ...(table.length > 0 ? [...table, ''] : []), ...foot].join('\n');
  if (table.length === 0 || body.length <= COMMENT_LIMIT) return body;

  // A criterion's evidence is written by a model and has no length its prompt
  // can guarantee. Rather than let the API reject the whole comment, the table
  // is the part that goes: it exists in full in the run summary, while the
  // verdict, the count and the agent's own sentence exist nowhere else.
  console.log('::warning::The summary comment would exceed the comment size limit, so the criteria table was left to the run summary.');
  return [
    ...lines,
    `The criteria table did not fit into a comment; it is in the [run summary](${runUrl}).`,
    '',
    ...foot,
  ].join('\n');
}

/**
 * The findings from earlier runs that keep this check red, as links.
 *
 * Named rather than counted, because "1 finding is still open" is a sentence
 * somebody has to go looking for the answer to, and the answer is three clicks
 * up the pull request.
 */
function standingList(gate) {
  const lines = ['Still open from an earlier run:'];
  for (const finding of gate.standing) {
    const where = finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ''}\` - ` : '';
    const label = `${where}${finding.title}`;
    lines.push(`- ${marked(SEVERITY_MARK, finding.severity)} ${finding.url ? `[${label}](${finding.url})` : label}`);
  }
  return lines;
}

/** GitHub rejects an issue comment above this; the margin is for the trailer. */
const COMMENT_LIMIT = 60000;

/**
 * The agent's own comment, made fit to reuse: without the run link the
 * infrastructure adds anyway, and without a heading that would compete with
 * the one above it.
 *
 * Long replies are cut, but never silently. On this path the agent's words are
 * the only content a reader gets - there is no report and there are no comments
 * at the code - so a cut that looks like an ending would hide the sentence that
 * mattered. The limit is generous for that reason; what does not fit is still
 * in the job log, and the marker says where to look.
 */
const REPLY_LIMIT = 4000;

function borrowable(text) {
  const cleaned = String(text ?? '')
    .replace(/\[github run\]\([^)]*\)/g, '')
    .replace(/^#{1,6} .*$/gm, '')
    .trim();

  if (cleaned.length <= REPLY_LIMIT) return cleaned;
  return `${cleaned.slice(0, REPLY_LIMIT)}…\n\n*(Cut here. The agent's full reply is in the job log.)*`;
}

/** One line saying how much was found, in the units this run deals in. */
function countLine(report) {
  if (report.criteria.length > 0) {
    const met = report.criteria.filter(c => String(c.status).toLowerCase() === 'met').length;
    const counted = report.criteria.length;
    const rest = report.criteria.length - met;
    return `**${met}/${counted} criteria met**${rest > 0 ? ` · ⚠️ ${rest} not demonstrated or unmet` : ''}`;
  }

  // A run that deals in criteria and has none demonstrated nothing, which is
  // not the same as finding nothing. This is what a harness failure reads as.
  if (reportKind === 'criteria') return '**No criterion was demonstrated.**';

  if (report.findings.length === 0) return '**No findings.**';

  const bySeverity = ['high', 'medium', 'low']
    .map(level => [level, report.findings.filter(f => String(f.severity).toLowerCase() === level).length])
    .filter(([, count]) => count > 0)
    .map(([level, count]) => marked(SEVERITY_MARK, level, `${count} ${level}`));

  const total = report.findings.length;
  return `**${total} finding${total === 1 ? '' : 's'}** — ${bySeverity.join(', ')}`;
}

/**
 * Bot comments that carry this run's link. The run id is shared by every
 * review the orchestrator called, so this is a pool, not an identity; which
 * of them this job may touch is pickSummaryTarget's decision.
 */
async function runComments() {
  const runId = process.env.GITHUB_RUN_ID;
  const found = [];
  if (!runId || dryRun) return found;

  for (let page = 1; page <= 5; page++) {
    const { ok, json } = await api(`/repos/${repository}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    if (!ok) break;
    for (const comment of json) {
      if (comment.user?.type !== 'Bot') continue;
      if (!belongsToRun(comment.body, runId)) continue;
      found.push(comment);
    }
    if (json.length < 100) break;
  }

  return found;
}

/**
 * Replaces the comment OpenCode posted with the agent's raw reply, and makes
 * sure exactly one comment *per review* is left standing.
 *
 * OpenCode comments on its own, before this script runs, and there is no switch
 * to stop it - so the choice is between two comments per review and rewriting
 * the one that exists. The run link used to be enough to find it, when each
 * review had its own workflow run. Under the orchestrator it is not: three
 * jobs write the same link, and treating them as one run is how a security
 * report vanished under a bug report. Ownership is the marker that names this
 * review; a sibling's comment is never rewritten or deleted.
 *
 * A **re-run** keeps the run id and starts over: OpenCode posts a fresh reply
 * while the frame the first attempt wrote is still there. The fresh reply is
 * claimed only when it is the only unmatched one - otherwise it might belong
 * to a sibling that has not framed yet. Found nothing at all? Post. A
 * duplicate beats a silent run.
 */
async function publishSummary(report, scope, gate) {
  const candidates = await runComments();
  const { existing, superseded } = pickSummaryTarget(candidates, {
    title,
    runId: process.env.GITHUB_RUN_ID ?? '',
  });

  // Only the agent's own words may be borrowed for a broken run. A frame this
  // script wrote earlier would otherwise be folded into the next frame, one
  // attempt quoting the last.
  const agentText = existing && !isOurSummary(existing.body, title) ? existing.body : '';

  const body = summaryComment(report, scope, agentText, await artifactLink(), gate);

  if (dryRun) {
    console.log(body);
    return;
  }

  let published = false;
  let rewrote = false;

  if (existing) {
    const result = await api(`/repos/${repository}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
    if (result.ok) {
      const check = await api(`/repos/${repository}/issues/comments/${existing.id}`);
      if (check.ok && isOurSummary(check.json?.body ?? '', title)) {
        console.log("Rewrote this review's comment into the standard summary.");
        published = true;
        rewrote = true;
      } else {
        console.log('Another review claimed that comment; posting a new one.');
      }
    } else {
      console.log(`::warning::Could not rewrite comment ${existing.id}: ${result.status} ${result.text}`);
    }
  }

  if (!published) {
    const result = await api(`/repos/${repository}/issues/${prNumber}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
    if (!result.ok) {
      console.log(`::warning::Could not publish the summary comment: ${result.status} ${result.text}`);
      return;
    }
    console.log('Posted the summary comment.');
    published = true;
  }

  // After a successful write: deleting first would leave nothing if the write
  // failed, and a sibling's comment is never in this list. If we posted a new
  // comment because rewriting our own frame failed, that frame is superseded too.
  const stale = [...superseded, ...(!rewrote && existing && isOurSummary(existing.body, title) ? [existing] : [])];
  for (const comment of stale) {
    const removed = await api(`/repos/${repository}/issues/comments/${comment.id}`, { method: 'DELETE' });
    console.log(
      removed.ok
        ? `Removed a superseded comment from an earlier attempt of this review (${comment.id}).`
        : `::warning::Could not remove the superseded comment ${comment.id}: ${removed.status} ${removed.text}`,
    );
  }
}

/**
 * A finding is "already said" when this bundle has a comment within two lines
 * of it, in the same file, making the same point.
 *
 * All three conditions, and the last one is why: a second, unrelated defect
 * right next to an old comment is rare but real, and suppressing it would be
 * invisible - the finding would simply never appear. A duplicate is noise a
 * reader can see and dismiss; a swallowed finding is not. When in doubt, this
 * posts.
 *
 * The line window is small because GitHub does the hard part: it tracks a
 * comment's position across pushes, so `line` is where the comment sits *now*.
 * The two lines of slack cover a comment that has just gone stale.
 */
const samePoint = (a, b) => {
  const normalise = text =>
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const one = normalise(a);
  const other = normalise(b);
  if (!one || !other) return false;
  if (one === other) return true;

  // Containment covers the same point reworded slightly - "Null check missing"
  // against "Null check missing in the loader". It is deliberately not applied
  // to short strings: a two-character title is a substring of almost every
  // sentence, so without a floor one comment could match, and silence,
  // everything.
  const [shorter, longer] = one.length <= other.length ? [one, other] : [other, one];
  return shorter.length >= 12 && longer.includes(shorter);
};

function alreadySaid(finding, commented) {
  const previous = finding.file ? commented.get(finding.file) : undefined;
  const line = Number(finding.line);
  if (!previous || !Number.isInteger(line)) return false;

  return previous.some(comment => Math.abs(comment.line - line) <= 2 && samePoint(comment.title, finding.title));
}

function renderFinding(finding) {
  const severity = String(finding.severity ?? 'medium').toLowerCase();
  // The mark goes in front, where the eye lands first in a list of comments.
  // What follows it is the title in bold, unchanged: commentedLines() reads the
  // title back out of this shape on the next run.
  return `${`${mark(SEVERITY_MARK, severity)} **${finding.title}**`.trim()} (${severity})\n\n${finding.body}\n\n${MARKER}`;
}

function buildBody(report, orphans) {
  const parts = [`## ${title}`];

  if (report.summary) parts.push(report.summary);

  if (orphans.length > 0) {
    parts.push(
      orphans.length === 1
        ? 'One finding could not be anchored in the diff and is reproduced here:'
        : `${orphans.length} findings could not be anchored in the diff and are reproduced here:`,
    );
    for (const finding of orphans) {
      const where = finding.file ? `\`${finding.file}\`${finding.line ? `:${finding.line}` : ''} - ` : '';
      parts.push(`- ${where}${renderFinding(finding).replace(/\n/g, '\n  ')}`);
    }
  }

  if (runUrl) parts.push(`[Workflow run](${runUrl})`);

  return parts.join('\n\n');
}

/**
 * The criteria as a table, or nothing at all. One builder, two places: the run
 * summary and the pull request comment show the same rows, because two renderings
 * of one report is a difference somebody eventually has to explain.
 */
function criteriaTable(report) {
  // Optional chaining, because a missing or malformed report has no fields at
  // all and still gets a comment - that case is exactly what the frame is for.
  if (!report.criteria?.length) return [];

  const lines = ['| Acceptance criterion | Result | In the video | Evidence |', '| --- | --- | --- | --- |'];
  for (const criterion of report.criteria) {
    const status = STATUS_LABEL[criterion.status] ?? criterion.status ?? 'unknown';
    lines.push(
      `| ${cell(criterion.title)} | ${cell(marked(STATUS_MARK, criterion.status, status))} | ${cell(criterion.at ?? '')} | ${cell(criterion.evidence ?? '')} |`,
    );
  }
  return lines;
}

function writeSummary(report, gate) {
  const lines = [`## ${title}`, '', `Verdict: ${marked(VERDICT_MARK, report.verdict, `**${report.verdict}**`)}`, ''];

  if (gate) {
    lines.push(
      `Quality gate: ${`${gate.mark} **${gate.label}**`.trim()} — ${gate.reason}`,
      '',
    );
    if (gate.standing.length > 0) lines.push(...standingList(gate), '');
  }

  const caption = coverageCaption(coverage);
  if (caption) {
    lines.push(`Coverage: ${caption}`, '');
    const unread = unreadLine(coverage);
    if (unread) lines.push(unread, '');
  }

  if (report.summary) lines.push(report.summary, '');

  const table = criteriaTable(report);
  if (table.length > 0) lines.push(...table, '');

  if (report.findings.length > 0) {
    lines.push('| Severity | Where | Finding |', '| --- | --- | --- |');
    for (const finding of report.findings) {
      const where = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : '-';
      lines.push(`| ${cell(marked(SEVERITY_MARK, finding.severity ?? 'medium'))} | ${cell(where)} | ${cell(finding.title)} |`);
    }
    lines.push('');
  }

  summary(lines.join('\n'));
}

/** Markdown tables have no way to escape a newline or a pipe; both have to go. */
const cell = value => String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

const report = readReport();

// Before a single comment is written, so what this run posts cannot be mistaken
// for what earlier runs left behind. Skipped when the gate is off, when there
// is nothing to ask with, and in a dry run - none of them can act on the answer.
const carriedOver =
  Number.isFinite(THRESHOLD[failOn]) && token && repository && prNumber && !dryRun ? await unresolvedFindings() : [];

const gate = applyCoverageGate(evaluateGate(report, carriedOver), coverage, requireFullCoverage);

if (report.missing || report.invalid) {
  summary(
    [
      report.missing
        ? `## ${title}\n\nThe agent left no report at \`${reportFile}\`, so there is nothing to anchor at the code. Its reply on the pull request is all there is for this run.`
        : `## ${title}\n\nThe agent's report is not valid JSON and was ignored:\n\n\`\`\`\n${report.invalid}\n\`\`\``,
      '',
      `Quality gate: ${`${gate.mark} **${gate.label}**`.trim()} — ${gate.reason}`,
      ...(gate.standing.length > 0 ? ['', ...standingList(gate)] : []),
    ].join('\n'),
  );

  // The frame goes up even here - especially here. A run whose agent skipped
  // the report is exactly the one that must not look like an ordinary pass.
  if (token && repository && prNumber) await publishSummary(report, process.env.DIFF_SCOPE ?? '', gate);
  finish(gate);
}

report.findings.sort(
  (a, b) =>
    (SEVERITY_ORDER[String(a.severity).toLowerCase()] ?? 1) - (SEVERITY_ORDER[String(b.severity).toLowerCase()] ?? 1),
);

writeSummary(report, gate);

if (!token || !repository || !prNumber) {
  console.error('::error::GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER are needed to post a review.');
  process.exit(3);
}

// Before the findings, and whatever they turn out to be: every run leaves the
// same summary behind, so a reader scrolling the pull request can place it
// without reading it.
await publishSummary(report, process.env.DIFF_SCOPE ?? '', gate);

if (report.findings.length === 0) {
  console.log('No findings, so no review is posted.');
  finish(gate);
}

const addressable = await addressableLines();
const commented = await commentedLines();
const comments = [];
const orphans = [];
const repeats = [];

for (const finding of report.findings) {
  if (alreadySaid(finding, commented)) {
    repeats.push(finding);
    continue;
  }

  const lines = finding.file ? addressable.get(finding.file) : undefined;
  const line = Number(finding.line);

  if (lines && Number.isInteger(line) && lines.has(line)) {
    comments.push({ path: finding.file, line, side: 'RIGHT', body: renderFinding(finding) });
  } else {
    orphans.push(finding);
  }
}

if (repeats.length > 0) {
  // In the log rather than on the pull request: suppressing a repetition is
  // only an improvement as long as it does not produce a comment of its own.
  console.log(
    `Held back ${repeats.length} finding${repeats.length === 1 ? '' : 's'} already commented on: ` +
      repeats.map(finding => `${finding.file}:${finding.line}`).join(', '),
  );
}

if (comments.length === 0 && orphans.length === 0) {
  console.log('Everything found this round has already been said. No review posted.');
  finish(gate);
}

const body = buildBody(report, orphans);

if (dryRun) {
  console.log(JSON.stringify({ event: 'COMMENT', body, comments }, null, 2));
  finish(gate);
}

let result = await api(`/repos/${repository}/pulls/${prNumber}/reviews`, {
  method: 'POST',
  body: JSON.stringify({ event: 'COMMENT', body, comments }),
});

// 422 means at least one anchor was rejected after all - a file renamed under
// us, a line the diff no longer shows. Post the same content without anchors
// rather than lose it.
if (!result.ok && result.status === 422 && comments.length > 0) {
  console.log(`::warning::Anchoring the findings failed (${result.text}). Posting them in the review body instead.`);
  result = await api(`/repos/${repository}/pulls/${prNumber}/reviews`, {
    method: 'POST',
    body: JSON.stringify({ event: 'COMMENT', body: buildBody(report, report.findings) }),
  });
}

if (!result.ok) {
  console.error(`::error::Posting the review failed: ${result.status} ${result.text}`);
  process.exit(3);
}

console.log(`Posted ${comments.length} inline comment(s) and ${orphans.length} in the review body.`);

// Last, and only now: everything this run has to say is on the pull request, so
// the exit code decides the colour of the check and nothing else.
finish(gate);
