/**
 * Cuts an incremental diff down to what the pull request itself adds to its
 * base branch.
 *
 * The incremental diff is `last-reviewed...after`. When the base branch was
 * merged into the pull request in between, that range holds every change the
 * merge brought in: other people's work, already reviewed in their own pull
 * requests. Handed to the agent, it gets reviewed again here, the findings land
 * on this pull request, and the gate turns red on code this pull request never
 * wrote.
 *
 * The pull request diff (`merge-base(base, head)...head`) is exactly what the
 * pull request adds. Both diffs end at the same commit, so their right-hand
 * sides are the same file contents with the same line numbers. A change line of
 * the incremental diff stays a change only when the pull request diff makes the
 * same change:
 *
 *  * an added line, when the pull request diff adds the line with that number;
 *  * a removed line, when the pull request diff changes anything at the place
 *    of the run of changes the line belongs to.
 *
 * Removed lines cannot be matched by text. The pull request diff removes the
 * base branch's version of a line, the incremental diff the version before the
 * merge, and when the base branch rewrote what the pull request deletes, the
 * two never agree. So a removal goes by place, and errs towards being shown:
 * a line too many in the review costs little, a dropped change of the pull
 * request is one nobody reviews.
 *
 * Everything else the merge brought in becomes context (an added line) or goes
 * (a removed line), and a hunk with no change left is dropped. The left-hand
 * side of the result is therefore no real revision, only a consistent one; the
 * right-hand side, which is what review comments point at, is untouched.
 */

import { parseDiffGitLine } from './changed-files.mjs';

const CONTEXT = 3;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Files of a unified diff: the lines before the first hunk, and the hunks. */
export function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { key: parseDiffGitLine(line).newPath, head: [line], hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    const header = HUNK_HEADER.exec(line);
    if (header) {
      const oldCount = header[2] === undefined ? 1 : Number(header[2]);
      const newCount = header[4] === undefined ? 1 : Number(header[4]);
      hunk = {
        oldStart: Number(header[1]),
        oldCount,
        newStart: Number(header[3]),
        newCount,
        heading: header[5],
        lines: [],
      };
      file.hunks.push(hunk);
      oldLeft = oldCount;
      newLeft = newCount;
      continue;
    }

    if (!hunk) {
      file.head.push(line);
      continue;
    }
    if (line.startsWith('\\')) {
      hunk.lines.push(line);
      continue;
    }
    // The counts in the header say where a hunk ends. A line past that is the
    // trailing newline of the text, never content.
    if (oldLeft <= 0 && newLeft <= 0) continue;
    const kind = line[0] ?? ' ';
    if (kind === '+') newLeft -= 1;
    else if (kind === '-') oldLeft -= 1;
    else {
      oldLeft -= 1;
      newLeft -= 1;
    }
    hunk.lines.push(line === '' ? ' ' : line);
  }
  return files;
}

/**
 * The first right-hand line number a hunk's lines sit at. A side with no lines
 * names the line *before* the hunk, so the cursor starts one further on.
 */
function firstNew(hunk) {
  return hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
}

function firstOld(hunk) {
  return hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
}

/**
 * The changes of one file: the right-hand numbers of the lines it adds, and
 * every right-hand place at which it adds or removes something.
 */
function indexChanges(file) {
  const added = new Set();
  const changedAt = new Set();
  for (const hunk of file.hunks) {
    let newNo = firstNew(hunk);
    for (const line of hunk.lines) {
      const kind = line[0];
      if (kind === '\\') continue;
      if (kind === '+') added.add(newNo);
      if (kind === '+' || kind === '-') changedAt.add(newNo);
      if (kind !== '-') newNo += 1;
    }
  }
  return { added, changedAt };
}

/**
 * For each line of a hunk, the right-hand span of the run of changes it
 * belongs to: from where the run starts to where the next unchanged line sits.
 */
function changeRuns(hunk) {
  const spans = [];
  let newNo = firstNew(hunk);
  let run = null;
  for (const line of hunk.lines) {
    const kind = line[0];
    if (kind === '\\') {
      spans.push(null);
      continue;
    }
    if (kind === ' ') {
      run = null;
      spans.push(null);
      newNo += 1;
      continue;
    }
    if (!run) run = { low: newNo, high: newNo };
    spans.push(run);
    if (kind === '+') newNo += 1;
    run.high = newNo;
  }
  return spans;
}

function changedWithin(owned, span) {
  for (let at = span.low; at <= span.high; at++) if (owned.changedAt.has(at)) return true;
  return false;
}

/**
 * One hunk with every change the pull request does not make turned into
 * context or dropped. `state.shift` carries how far the left-hand numbering has
 * moved through the hunks before this one; `state.leftOut` counts the changes
 * that were not the pull request's.
 */
function keepOwned(hunk, owned, state) {
  const rows = [];
  let oldNo = firstOld(hunk) + state.shift;
  let newNo = firstNew(hunk);
  const spans = changeRuns(hunk);
  let last = null;

  for (const [index, line] of hunk.lines.entries()) {
    const kind = line[0];
    const text = line.slice(1);
    if (kind === '\\') {
      if (last) last.noEol = line;
      continue;
    }
    last = null;
    if (kind === '+') {
      if (owned.added.has(newNo)) {
        last = { kind: '+', text, oldNo, newNo };
      } else {
        last = { kind: ' ', text, oldNo, newNo };
        oldNo += 1;
        state.shift += 1;
        state.leftOut += 1;
      }
      newNo += 1;
    } else if (kind === '-') {
      if (changedWithin(owned, spans[index])) {
        last = { kind: '-', text, oldNo, newNo };
        oldNo += 1;
      } else {
        state.shift -= 1;
        state.leftOut += 1;
      }
    } else {
      last = { kind: ' ', text, oldNo, newNo };
      oldNo += 1;
      newNo += 1;
    }
    if (last) rows.push(last);
  }
  return rows;
}

/** Rows cut into hunks of changes with three lines of context around each. */
function rehunk(rows, heading) {
  const ranges = [];
  rows.forEach((row, index) => {
    if (row.kind === ' ') return;
    const start = Math.max(0, index - CONTEXT);
    const end = Math.min(rows.length - 1, index + CONTEXT);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  });

  return ranges.map(({ start, end }) => {
    const slice = rows.slice(start, end + 1);
    const oldCount = slice.filter(row => row.kind !== '+').length;
    const newCount = slice.filter(row => row.kind !== '-').length;
    const oldStart = oldCount === 0 ? slice[0].oldNo - 1 : slice[0].oldNo;
    const newStart = newCount === 0 ? slice[0].newNo - 1 : slice[0].newNo;
    const lines = [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${heading}`];
    for (const row of slice) {
      lines.push(`${row.kind}${row.text}`);
      if (row.noEol) lines.push(row.noEol);
    }
    return lines;
  });
}

/**
 * `incrementalText` restricted to the changes `pullText` also makes. Both have
 * to end at the same commit.
 *
 * `leftOut` is false when every change was the pull request's own; `text` is
 * then `incrementalText` as it came. An empty `text` is what a merge of the
 * base branch with no work of the pull request's own looks like.
 */
export function restrictToPullRequest(incrementalText, pullText) {
  const pull = new Map(parseDiff(pullText).map(file => [file.key, file]));
  const out = [];
  let leftOut = false;

  for (const file of parseDiff(incrementalText)) {
    const mine = pull.get(file.key);
    if (!mine) {
      leftOut = true;
      continue;
    }

    // A mode change, a pure rename or a binary file: nothing to compare line by
    // line, so the pull request touching the file is what decides.
    if (file.hunks.length === 0) {
      out.push(...file.head);
      continue;
    }

    const owned = indexChanges(mine);
    const state = { shift: 0, leftOut: 0 };
    const hunks = file.hunks.flatMap(hunk => rehunk(keepOwned(hunk, owned, state), hunk.heading));
    if (state.leftOut > 0) leftOut = true;
    if (hunks.length === 0) continue;
    out.push(...file.head, ...hunks.flat());
  }

  if (!leftOut) return { text: incrementalText, leftOut };
  return { text: out.length ? `${out.join('\n')}\n` : '', leftOut };
}
