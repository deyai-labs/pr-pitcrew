/**
 * The pull request diff as the review guide's harness needs it: files, hunks
 * and every line with its number on both sides.
 *
 * The guide rests on one rule (docs/concepts/review-guide.md, P2): the model
 * gives structure, the code gives facts. Every number, link and excerpt in the
 * comment comes from this parse, never from the model. So this is the one
 * place that decides which lines a range covers, and the same answer serves
 * the coverage count, the `+`/`−` per group and the excerpt.
 *
 * A range names lines on the new side of a file (`R` in a diff link). A file
 * the pull request deletes has no new side, so its ranges name old lines (`L`).
 * A removed line in a changed file has no new number; it sits between two new
 * lines and belongs to a range that holds either of them.
 */

import { createHash } from 'node:crypto';
import { parseDiffGitLine, unescapeGitPath } from './changed-files.mjs';

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(path) {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

function headerPath(line) {
  const rest = line.slice(4).split('\t')[0].trim();
  if (!rest || rest === '/dev/null') return null;
  return stripPrefix(rest.startsWith('"') ? unescapeGitPath(rest) : rest);
}

/**
 * `{ files, truncated }`. Each file: `{ path, oldPath, status, binary, hunks }`,
 * where `status` is `added`, `deleted`, `renamed` or `modified`, and each hunk
 * line is `{ kind, raw, oldNo, newNo, next }`. `kind` is `+`, `-` or a space;
 * `raw` is the line exactly as the diff has it; `next` is, for a removed line,
 * the new-side number of the line that follows it.
 *
 * The hunk header's counts decide where a hunk ends, not the first line that
 * looks unfamiliar: an empty context line that lost its space is still a line.
 */
export function parseDiff(text) {
  const source = String(text ?? '');
  const files = [];
  let file = null;
  let hunk = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;

  const lines = source.split('\n');
  // A trailing newline leaves one empty string behind; it is not a line.
  if (lines.at(-1) === '') lines.pop();

  for (const line of lines) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const kind = line[0] ?? ' ';
      if (kind === '\\') continue;
      if (kind === '+') {
        hunk.lines.push({ kind: '+', raw: line, oldNo: null, newNo, next: null });
        newNo += 1;
        newLeft -= 1;
        continue;
      }
      if (kind === '-') {
        hunk.lines.push({ kind: '-', raw: line, oldNo, newNo: null, next: newNo });
        oldNo += 1;
        oldLeft -= 1;
        continue;
      }
      if (kind === ' ' || line === '') {
        hunk.lines.push({ kind: ' ', raw: line, oldNo, newNo, next: null });
        oldNo += 1;
        newNo += 1;
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
      // Anything else ends the hunk early: a cut diff, or a header.
      hunk = null;
    }

    if (line.startsWith('diff --git ')) {
      const { oldPath, newPath } = parseDiffGitLine(line);
      file = { path: newPath, oldPath, status: 'modified', binary: false, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (line.startsWith('\\')) continue;
    const header = HUNK.exec(line);
    if (header) {
      oldNo = Number(header[1]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newNo = Number(header[3]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      file.status = 'renamed';
      file.oldPath = unescapeGitPath(line.slice('rename from '.length).trim());
    } else if (line.startsWith('rename to ')) {
      file.status = 'renamed';
      file.path = unescapeGitPath(line.slice('rename to '.length).trim());
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true;
    else if (line.startsWith('--- ')) {
      const path = headerPath(line);
      if (path) file.oldPath = path;
    } else if (line.startsWith('+++ ')) {
      const path = headerPath(line);
      if (path === null) file.status = 'deleted';
      else file.path = path;
    }
  }

  for (const entry of files) {
    if (entry.status === 'deleted') entry.path = entry.oldPath || entry.path;
  }

  return { files, truncated: /\*\*\* TRUNCATED at \d+ bytes/.test(source) };
}

/** Old-side numbers for a deleted file, new-side numbers for every other. */
export const sideOf = file => (file?.status === 'deleted' ? 'old' : 'new');

/**
 * Whether a diff line falls in `[from, to]`. Without `from`, the whole file.
 */
export function lineInRange(file, line, from, to) {
  if (from === undefined || from === null) return true;
  if (sideOf(file) === 'old') return line.oldNo !== null && line.oldNo >= from && line.oldNo <= to;
  if (line.kind !== '-') return line.newNo >= from && line.newNo <= to;
  return (line.next >= from && line.next <= to) || (line.next - 1 >= from && line.next - 1 <= to);
}

/** Every diff line of a range, in diff order, with its hunk and its place in it. */
export function linesInRange(file, from, to) {
  const out = [];
  file.hunks.forEach((hunk, index) => {
    hunk.lines.forEach((line, at) => {
      if (lineInRange(file, line, from, to)) out.push({ ...line, hunk: index, at });
    });
  });
  return out;
}

/** A stable key per changed line, for coverage. */
export const lineKey = (path, line) => `${path}\0${line.kind}${line.kind === '-' ? line.oldNo : line.newNo}`;

export function changedLines(file) {
  const out = [];
  for (const hunk of file.hunks) for (const line of hunk.lines) if (line.kind !== ' ') out.push(line);
  return out;
}

/** Whether `[from, to]` touches any line a hunk of the file shows. */
export function overlapsHunk(file, from, to) {
  if (from === undefined || from === null) return true;
  return file.hunks.some(hunk => hunk.lines.some(line => lineInRange(file, line, from, to)));
}

/** GitHub's anchor for a file in the "Files changed" view. */
export const pathHash = path => createHash('sha256').update(String(path)).digest('hex');

export const countLines = lines => ({
  plus: lines.filter(line => line.kind === '+').length,
  minus: lines.filter(line => line.kind === '-').length,
});
