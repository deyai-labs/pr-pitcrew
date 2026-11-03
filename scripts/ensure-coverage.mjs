#!/usr/bin/env node
/**
 * Makes sure the agent opened every file the diff said it had to, without
 * paying for a second review.
 *
 * A hunk is three lines of context. The prompt asks the agent to open the
 * files; this script is what notices when it did not. Order, and the order is
 * the point:
 *
 *   1. There is nothing to open (no list, or an empty one). Write that down.
 *      Done.
 *   2. Read the session. Measure which of the listed files a `read` actually
 *      opened. Full coverage: write the number down. Done.
 *   3. A shortfall, and a session to continue: ask the same session to open
 *      the missing files and call `write_report` again. The second report is
 *      the one that gets published. Measure once more.
 *
 * An unreadable export is a warning and an unknown measurement, never a silent
 * `N of N`. The number is what makes a shallow run and a thorough one look
 * different on the pull request; inventing `N of N` from a transcript we could
 * not read would put the hole back.
 *
 * Nothing here may fail the job. A shortfall that survives the extra turn is
 * published, named, and — unless the repository set
 * `PITCREW_REQUIRE_FULL_COVERAGE=false` — failed by `publish-report.mjs`, after
 * the findings are on the pull request.
 *
 * Environment: CHANGED_FILES, COVERAGE_FILE, GITHUB_WORKSPACE, MODEL,
 * PITCREW_LLM_API_KEY, PITCREW_LLM_API_BASE_URL, OPENCODE_CONFIG_CONTENT
 * (the last four only for the continue turn). SESSION_EXPORT skips the CLI
 * listing. ENSURE_COVERAGE_CONTINUE=0 skips the extra turn.
 */

import { existsSync, readFileSync, writeFileSync, openSync, closeSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  coverageCaption,
  measureCoverage,
  openedPathsFromSession,
  readChangedFiles,
  unknownCoverage,
} from './coverage.mjs';

const changedFile = (process.env.CHANGED_FILES ?? '').trim();
const exportFile = (process.env.SESSION_EXPORT ?? '').trim();
const skipContinue = process.env.ENSURE_COVERAGE_CONTINUE === '0';
const workspace = (process.env.GITHUB_WORKSPACE ?? '').trim() || process.cwd();
const coverageFile =
  (process.env.COVERAGE_FILE ?? '').trim() ||
  join(process.env.GITHUB_WORKSPACE || '.', '.pitcrew-run', 'coverage.json');

const installed = join(homedir(), '.opencode', 'bin', 'opencode');
const bin = process.env.OPENCODE_BIN ?? (existsSync(installed) ? installed : 'opencode');

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
 * `{ id, session }`, same split as ensure-report.mjs: the id is what makes
 * `--continue` a continuation, the session is what we can measure. An export
 * that failed leaves a continuable session we cannot score — unknown, not
 * `N of N`.
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
    console.log('::warning::OpenCode left no session behind, so file coverage cannot be measured.');
    return { id: null, session: null };
  }

  const newest = [...sessions].sort((a, b) => (b?.updated ?? 0) - (a?.updated ?? 0))[0];
  if (!newest?.id) {
    console.log('::warning::The session list carries no id.');
    return { id: null, session: null };
  }

  const target = join(process.env.RUNNER_TEMP || tmpdir(), 'pitcrew-coverage-session.json');
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

  console.log(`Exported session ${newest.id} (${statSync(target).size} bytes) to measure file coverage.`);
  return { id: newest.id, session: parseJson(readFileSync(target, 'utf8'), `the export of ${newest.id}`) };
}

function save(coverage) {
  writeFileSync(coverageFile, `${JSON.stringify(coverage, null, 2)}\n`);
  const caption = coverageCaption(coverage);
  if (coverage.status === 'unknown') {
    console.log(
      `::warning::File coverage could not be measured${coverage.reason ? ` (${coverage.reason})` : ''}. The comment will not claim a number.`,
    );
  } else if (caption) {
    const unread = coverage.missing.length
      ? `; not opened: ${coverage.missing.join(', ')}`
      : '';
    console.log(`File coverage: ${caption}${unread}.`);
  } else {
    console.log('File coverage: nothing on the list to open.');
  }
}

function continueForFiles(missing) {
  const list = missing.map(path => `- ${path}`).join('\n');
  const args = ['run', '--continue'];
  if ((process.env.MODEL ?? '').trim()) args.push('--model', process.env.MODEL.trim());
  args.push(
    [
      'You ended your turn without opening every file this run requires. A hunk is three lines of context; the file is what the change means. A file you have not opened is one you cannot report on and one you cannot clear.',
      (process.env.REPORT_KIND ?? '').trim() === 'guide'
        ? 'Open each of these files at the head revision now, then call write_report again with the whole guide you then have: summary, intent, groups, order, diagrams. Do not skip a file because its hunk looked benign.'
        : 'Open each of these files at the head revision now, then call write_report with the verdict, summary and findings you then have. Empty findings are valid. Do not skip a file because its hunk looked benign.',
      '',
      'Files not yet opened:',
      list,
    ].join('\n'),
  );

  try {
    execFileSync(bin, args, {
      encoding: 'utf8',
      stdio: 'inherit',
      env: process.env,
    });
  } catch {
    console.log('::warning::The file-coverage retry did not finish cleanly.');
  }
}

function score(session, required) {
  return measureCoverage(required, openedPathsFromSession(session), workspace);
}

try {
  if (!changedFile) {
    save({ status: 'empty', required: [], opened: [], missing: [] });
    process.exit(0);
  }

  const required = readChangedFiles(changedFile);
  if (required.length === 0) {
    save(measureCoverage([], [], workspace));
    process.exit(0);
  }

  const { id: sessionId, session } = loadSession();
  if (session) {
    const first = score(session, required);
    if (first.missing.length === 0) {
      save(first);
      process.exit(0);
    }

    if (skipContinue) {
      console.log(
        `::warning::Opened ${first.opened.length} of ${first.required.length} changed files, and the continue turn is switched off.`,
      );
      save(first);
      process.exit(0);
    }

    if (!sessionId) {
      console.log('::warning::A shortfall was measured but there is no session to continue.');
      save(first);
      process.exit(0);
    }

    console.log(
      `::warning::Opened ${first.opened.length} of ${first.required.length} changed files. Asking the same session to open the rest.`,
    );
    continueForFiles(first.missing);

    const { session: after } = loadSession();
    if (!after) {
      console.log('::warning::Could not re-read the session after the coverage turn; keeping the first measurement.');
      save(first);
      process.exit(0);
    }
    save(score(after, required));
    process.exit(0);
  }

  // No readable session. A session id with a failed export is still a session,
  // and asking it to open the listed files is the recovery that remains; we
  // still cannot print a number until an export works. Without an id there is
  // nothing to continue, and inventing `N of N` from that would put the hole
  // back.
  if (!sessionId) {
    save(unknownCoverage('OpenCode left no session behind.'));
    process.exit(0);
  }

  if (skipContinue) {
    save(unknownCoverage('the session export could not be read.'));
    process.exit(0);
  }

  console.log(
    `::warning::The session export could not be read, so coverage cannot be scored yet. Asking the same session to open the ${required.length} listed files.`,
  );
  continueForFiles(required);

  const { session: after } = loadSession();
  if (!after) {
    save(unknownCoverage('the session export could not be read.'));
    process.exit(0);
  }
  save(score(after, required));
} catch (error) {
  console.log(`::warning::ensure-coverage failed: ${error.shortMessage ?? error.message}`);
  try {
    save(unknownCoverage(error.shortMessage ?? error.message));
  } catch {
    /* the warning is the record */
  }
  process.exit(0);
}
