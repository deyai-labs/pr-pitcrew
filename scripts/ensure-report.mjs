#!/usr/bin/env node
/**
 * Makes sure REPORT_FILE exists after the agent has finished, without paying
 * for a second review.
 *
 * Order, and the order is the point:
 *
 *   1. The file is already there. Done.
 *   2. The session already contains a usable report (the `write_report` tool,
 *      a write of the file, or JSON in the last reply that is not an echo of
 *      the prompt, the diff, or a tool output). Write it out. No model call.
 *   3. Ask the same session to call `write_report`. One turn, not a new review.
 *
 * Step 3 needs a session, and needs it proven rather than assumed. `opencode run
 * --continue` with nothing to continue does not fail - it opens a *new* session
 * whose only instruction is to call `write_report`, and a model answering that
 * from an empty context writes an empty pass. That report is indistinguishable
 * from a real one by the time it reaches the pull request, so a run whose agent
 * died before it started would publish "no defects found" for a diff nobody
 * read. The id from `session list` is the evidence, and without it this script
 * stops: a run that reviewed nothing is published as one that reviewed nothing.
 *
 * Nothing here may fail the job. A rescue that fails leaves the state
 * publish-report.mjs already knows how to describe.
 *
 * Environment: REPORT_FILE, MODEL, PITCREW_LLM_API_KEY, PITCREW_LLM_API_BASE_URL,
 * OPENCODE_CONFIG_CONTENT (the last four only for the continue turn).
 * SESSION_EXPORT skips the CLI listing and reads that file instead — the
 * try-it-out path, same as publish-transcript.mjs.
 */

import { existsSync, readFileSync, openSync, closeSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isUsableReport, recoverReport, writeReportFile } from './recover-report.mjs';

const reportFile = (process.env.REPORT_FILE ?? '').trim();
const exportFile = (process.env.SESSION_EXPORT ?? '').trim();
const skipContinue = process.env.ENSURE_REPORT_CONTINUE === '0';

const installed = join(homedir(), '.opencode', 'bin', 'opencode');
const bin = process.env.OPENCODE_BIN ?? (existsSync(installed) ? installed : 'opencode');

function alreadyWritten() {
  if (!reportFile || !existsSync(reportFile)) return false;
  try {
    const parsed = JSON.parse(readFileSync(reportFile, 'utf8'));
    return isUsableReport(parsed);
  } catch {
    return false;
  }
}

function parseJson(raw, what) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    console.log(`::warning::Could not read ${what} as JSON (${text.length} characters).`);
    return null;
  }
}

/**
 * `{ id, session }`, and the two are not the same question.
 *
 * `id` answers "did OpenCode leave a session behind": it is what makes
 * `--continue` a continuation. `session` is that session's content, and it may
 * be null while `id` is set - an export that failed or came back as something
 * other than JSON leaves the session itself perfectly continuable, just
 * unreadable from here. Nothing to recover from, still something to continue.
 *
 * Both null is the case that matters: no evidence of a session at all.
 */
function loadSession() {
  if (exportFile) {
    if (!existsSync(exportFile)) {
      console.log(`::warning::SESSION_EXPORT points at ${exportFile}, which does not exist.`);
      return { id: null, session: null };
    }
    return { id: exportFile, session: parseJson(readFileSync(exportFile, 'utf8'), exportFile) };
  }

  let listed;
  try {
    listed = execFileSync(bin, ['session', 'list', '--format', 'json', '-n', '5'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    console.log(`::warning::Could not list OpenCode sessions: ${error.shortMessage ?? error.message}`);
    return { id: null, session: null };
  }

  const sessions = parseJson(listed, 'the session list');
  if (!Array.isArray(sessions) || sessions.length === 0) {
    console.log('::warning::OpenCode left no session behind, so there is nothing to recover a report from.');
    return { id: null, session: null };
  }

  const newest = [...sessions].sort((a, b) => (b?.updated ?? 0) - (a?.updated ?? 0))[0];
  if (!newest?.id) {
    console.log('::warning::The session list carries no id.');
    return { id: null, session: null };
  }

  const target = join(process.env.RUNNER_TEMP || tmpdir(), 'pitcrew-report-session.json');
  const handle = openSync(target, 'w');
  try {
    execFileSync(bin, ['export', newest.id], {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', handle, 'pipe'],
    });
  } catch (error) {
    console.log(`::warning::Could not export session ${newest.id}: ${error.shortMessage ?? error.message}`);
    return { id: newest.id, session: null };
  } finally {
    closeSync(handle);
  }

  console.log(`Exported session ${newest.id} (${statSync(target).size} bytes) to look for a report.`);
  return { id: newest.id, session: parseJson(readFileSync(target, 'utf8'), `the export of ${newest.id}`) };
}

function extraUntrusted() {
  const diff = (process.env.DIFF_FILE ?? '').trim();
  if (!diff || !existsSync(diff)) return '';
  try {
    return readFileSync(diff, 'utf8');
  } catch {
    return '';
  }
}

function saveRecovered(found) {
  writeReportFile(reportFile, found.report);
  console.log(`Recovered the report from the session (${found.source}) and wrote ${reportFile}.`);
}

function continueForTool() {
  const args = ['run', '--continue'];
  if ((process.env.MODEL ?? '').trim()) args.push('--model', process.env.MODEL.trim());
  args.push(
    (process.env.REPORT_KIND ?? '').trim() === 'guide'
      ? 'You ended your turn without calling write_report. That tool is the only place this run reads its result from: without it there is no guide on the pull request. Call write_report now with the summary, intent, groups, order and diagrams you already have. Do not read the diff again. Reply with one word after the tool succeeds.'
      : 'You ended your turn without calling write_report. That tool is the only place this run reads its result from: without it there is no comment at the code and nothing you found survives. Call write_report now with the verdict, summary and findings or criteria you already have. An empty findings or criteria list is valid. Do not review the diff again. Reply with one word after the tool succeeds.',
  );

  try {
    execFileSync(bin, args, {
      encoding: 'utf8',
      stdio: 'inherit',
      env: process.env,
    });
  } catch {
    console.log('::warning::The write_report retry did not finish cleanly.');
  }
}

try {
  if (!reportFile) {
    console.log('::warning::REPORT_FILE is not set; there is nowhere to put a recovered report.');
    process.exit(0);
  }

  if (alreadyWritten()) process.exit(0);

  const { id: sessionId, session } = loadSession();
  const recovered = session ? recoverReport(session, reportFile, extraUntrusted()) : null;
  if (recovered) {
    saveRecovered(recovered);
    process.exit(0);
  }

  // The one place where doing nothing is the whole feature. `--continue` does
  // not object to having nothing to continue: it starts a fresh session, and a
  // model asked for a report with no diff in front of it produces a confident
  // empty pass. So the turn is spent on evidence of a session, never on the
  // absence of evidence - the listing failing is as unproven as the listing
  // being empty. What is upstream of that is anything at all: a permission
  // abort, a failed install, a wrong model id, a dropped connection.
  if (!sessionId) {
    console.log(
      '::warning::No session from this run, so there is nothing to continue and no review to ask for. This run is published as one that reviewed nothing.',
    );
    process.exit(0);
  }

  if (skipContinue) {
    console.log('::warning::No usable report in the session, and the continue turn is switched off.');
    process.exit(0);
  }

  console.log(
    `::warning::The agent ended its turn without writing ${reportFile}, and the session has no structured report to recover. Asking the same session to call write_report.`,
  );
  continueForTool();

  if (alreadyWritten()) {
    console.log('The retry wrote the report.');
    process.exit(0);
  }

  const { session: after } = loadSession();
  const recoveredAfter = after ? recoverReport(after, reportFile, extraUntrusted()) : null;
  if (recoveredAfter) {
    saveRecovered(recoveredAfter);
    process.exit(0);
  }

  console.log('::warning::Still no report. This run is published as one that reviewed nothing.');
} catch (error) {
  console.log(`::warning::ensure-report failed: ${error.shortMessage ?? error.message}`);
  process.exit(0);
}
