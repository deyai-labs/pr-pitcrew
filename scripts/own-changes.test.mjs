/**
 * The cut that keeps a merge of the base branch out of an incremental review.
 *
 * The bug this covers: a pull request was reviewed green, then the base branch
 * was merged into it. The next run compared the last reviewed commit with the
 * merge, reviewed everything the merge brought in, and failed the pull request
 * on findings in code other pull requests wrote.
 *
 * The fixtures are real `git diff` output. Each scenario has the incremental
 * diff (last reviewed commit to the new head) and the pull request diff
 * (merge base with the base branch to the same head).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseDiff, restrictToPullRequest } from './own-changes.mjs';

const changes = text => text.split('\n').filter(line => /^[-+](?![-+]{2} )/.test(line));

// The pull request edits line 5 and adds prfile.txt. Then main edits line 30,
// appends to mainonly.txt, deletes gone.txt and adds mainnew.txt, and is
// merged in. Then the pull request deletes line 8, edits line 20 and appends
// to prfile.txt.
const MERGE_INCREMENTAL = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index de98044..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,3 +0,0 @@
-a
-b
-c
diff --git a/mainnew.txt b/mainnew.txt
new file mode 100644
index 0000000..3e75765
--- /dev/null
+++ b/mainnew.txt
@@ -0,0 +1 @@
+new
diff --git a/mainonly.txt b/mainonly.txt
index f00c965..6b63d0f 100644
--- a/mainonly.txt
+++ b/mainonly.txt
@@ -8,3 +8,4 @@
 8
 9
 10
+m
diff --git a/prfile.txt b/prfile.txt
index 3c83d47..8280e5b 100644
--- a/prfile.txt
+++ b/prfile.txt
@@ -1 +1,2 @@
 pr1
+pr2
diff --git a/shared.txt b/shared.txt
index f451006..938878a 100644
--- a/shared.txt
+++ b/shared.txt
@@ -5,7 +5,6 @@
 five-pr
 6
 7
-8
 9
 10
 11
@@ -17,7 +16,7 @@ five-pr
 17
 18
 19
-20
+twenty-pr
 21
 22
 23
@@ -27,7 +26,7 @@ five-pr
 27
 28
 29
-30
+thirty-main
 31
 32
 33
`;

const MERGE_PULL = `diff --git a/prfile.txt b/prfile.txt
new file mode 100644
index 0000000..8280e5b
--- /dev/null
+++ b/prfile.txt
@@ -0,0 +1,2 @@
+pr1
+pr2
diff --git a/shared.txt b/shared.txt
index 1edc72d..938878a 100644
--- a/shared.txt
+++ b/shared.txt
@@ -2,10 +2,9 @@
 2
 3
 4
-5
+five-pr
 6
 7
-8
 9
 10
 11
@@ -17,7 +16,7 @@
 17
 18
 19
-20
+twenty-pr
 21
 22
 23
`;

// The base branch's changes sit in the same hunk as the pull request's: main
// replaces 22 with two lines, deletes 25 and appends a line with no newline;
// the pull request then edits 20 and 23 and deletes 27.
const INTERLEAVED_INCREMENTAL = `diff --git a/s.txt b/s.txt
index f451006..a86ff28 100644
--- a/s.txt
+++ b/s.txt
@@ -17,14 +17,13 @@ five-pr
 17
 18
 19
-20
+twenty-pr
 21
-22
-23
+22-main
+22b-main
+23-pr
 24
-25
 26
-27
 28
 29
 30
@@ -38,3 +37,4 @@ five-pr
 38
 39
 40
+no-eol
\\ No newline at end of file
`;

const INTERLEAVED_PULL = `diff --git a/s.txt b/s.txt
index 4ca0d40..a86ff28 100644
--- a/s.txt
+++ b/s.txt
@@ -2,7 +2,7 @@
 2
 3
 4
-5
+five-pr
 6
 7
 8
@@ -17,14 +17,13 @@
 17
 18
 19
-20
+twenty-pr
 21
 22-main
 22b-main
-23
+23-pr
 24
 26
-27
 28
 29
 30
`;

// main rewrites notes.txt and is merged in; the pull request then deletes the
// file. The two diffs remove different text, and the deletion is still the
// pull request's own.
const REWRITTEN_DELETE_INCREMENTAL = `diff --git a/notes.txt b/notes.txt
deleted file mode 100644
index 85c3040..0000000
--- a/notes.txt
+++ /dev/null
@@ -1,3 +0,0 @@
-alpha
-beta
-gamma
`;

const REWRITTEN_DELETE_PULL = `diff --git a/notes.txt b/notes.txt
deleted file mode 100644
index 94ebaf9..0000000
--- a/notes.txt
+++ /dev/null
@@ -1,4 +0,0 @@
-1
-2
-3
-4
diff --git a/other.txt b/other.txt
index 8a1218a..0e75782 100644
--- a/other.txt
+++ b/other.txt
@@ -3,3 +3,4 @@
 3
 4
 5
+pr
`;

// main moves Z two lines down and is merged in; the pull request then deletes
// Z. The two diffs remove it at different places, and the text is what agrees.
const MOVED_DELETE_INCREMENTAL = `diff --git a/f.txt b/f.txt
index 99396fe..531e93d 100644
--- a/f.txt
+++ b/f.txt
@@ -1,4 +1,3 @@
 A
-Z
 C
 B
`;

const MOVED_DELETE_PULL = `diff --git a/f.txt b/f.txt
index 3dcdbbb..531e93d 100644
--- a/f.txt
+++ b/f.txt
@@ -1,4 +1,3 @@
 A
 C
-Z
 B
diff --git a/p.txt b/p.txt
new file mode 100644
index 0000000..1a9cc2b
--- /dev/null
+++ b/p.txt
@@ -0,0 +1 @@
+p
`;

// notes.txt ends without a newline. main deletes its last line and is merged
// in; the pull request then edits the line before it.
const NO_EOL_INCREMENTAL = `diff --git a/notes.txt b/notes.txt
index 3328991..7061c57 100644
--- a/notes.txt
+++ b/notes.txt
@@ -1,3 +1,2 @@
 x
-y
-b
\\ No newline at end of file
+Y
`;

const NO_EOL_PULL = `diff --git a/notes.txt b/notes.txt
index b77b4eb..7061c57 100644
--- a/notes.txt
+++ b/notes.txt
@@ -1,2 +1,2 @@
 x
-y
+Y
diff --git a/p.txt b/p.txt
new file mode 100644
index 0000000..1a9cc2b
--- /dev/null
+++ b/p.txt
@@ -0,0 +1 @@
+p
`;

// main edits line 15 and is merged in; the pull request adds nothing after.
const PURE_MERGE_INCREMENTAL = `diff --git a/s.txt b/s.txt
index d1810ac..34689b6 100644
--- a/s.txt
+++ b/s.txt
@@ -12,7 +12,7 @@ three
 12
 13
 14
-15
+fifteen
 16
 17
 18
`;

const PURE_MERGE_PULL = `diff --git a/s.txt b/s.txt
index 8ac2d19..34689b6 100644
--- a/s.txt
+++ b/s.txt
@@ -1,6 +1,6 @@
 1
 2
-3
+three
 4
 5
 6
`;

describe('restrictToPullRequest', () => {
  it('leaves out files only the base branch changed', () => {
    const { text, leftOut } = restrictToPullRequest(MERGE_INCREMENTAL, MERGE_PULL);
    assert.equal(leftOut, true);
    assert.deepEqual(parseDiff(text).map(file => file.key), ['prfile.txt', 'shared.txt']);
    assert.doesNotMatch(text, /gone\.txt|mainnew\.txt|mainonly\.txt/);
  });

  it("keeps the pull request's own changes and drops the base branch's in a shared file", () => {
    const { text } = restrictToPullRequest(MERGE_INCREMENTAL, MERGE_PULL);
    assert.deepEqual(changes(text), ['+pr2', '-8', '-20', '+twenty-pr']);
    assert.doesNotMatch(text, /thirty-main/);
  });

  it("turns the base branch's lines into context when they share a hunk", () => {
    const { text, leftOut } = restrictToPullRequest(INTERLEAVED_INCREMENTAL, INTERLEAVED_PULL);
    assert.equal(leftOut, true);
    // -22 is the base branch's, shown because it sits in the same run as the
    // pull request's -23: a removal goes by place, and errs towards being shown.
    assert.deepEqual(changes(text), ['-20', '+twenty-pr', '-22', '-23', '+23-pr', '-27']);
    assert.match(text, /^ 22-main$/m);
    assert.match(text, /^ 22b-main$/m);
    assert.doesNotMatch(text, /^-25$/m);
    assert.doesNotMatch(text, /no-eol|No newline/);
  });

  it('keeps a deletion of the pull request when the base branch rewrote the deleted lines', () => {
    const { text } = restrictToPullRequest(REWRITTEN_DELETE_INCREMENTAL, REWRITTEN_DELETE_PULL);
    assert.deepEqual(parseDiff(text).map(file => file.key), ['notes.txt']);
    assert.deepEqual(changes(text), ['-alpha', '-beta', '-gamma']);
  });

  it('keeps a deletion of the pull request when the base branch moved the deleted line', () => {
    const { text } = restrictToPullRequest(MOVED_DELETE_INCREMENTAL, MOVED_DELETE_PULL);
    assert.deepEqual(changes(text), ['-Z']);
  });

  it('keeps a no-newline marker with the line it belongs to', () => {
    const { text } = restrictToPullRequest(NO_EOL_INCREMENTAL, NO_EOL_PULL);
    const lines = text.split('\n');
    const marker = lines.indexOf('\\ No newline at end of file');
    assert.equal(lines[marker - 1], '-b');
    assert.deepEqual(changes(text), ['-y', '-b', '+Y']);
  });

  it('writes hunk headers whose counts match their lines', () => {
    for (const [incremental, pull] of [
      [MERGE_INCREMENTAL, MERGE_PULL],
      [INTERLEAVED_INCREMENTAL, INTERLEAVED_PULL],
      [NO_EOL_INCREMENTAL, NO_EOL_PULL],
    ]) {
      for (const file of parseDiff(restrictToPullRequest(incremental, pull).text)) {
        for (const hunk of file.hunks) {
          const lines = hunk.lines.filter(line => !line.startsWith('\\'));
          assert.equal(lines.filter(line => line[0] !== '+').length, hunk.oldCount);
          assert.equal(lines.filter(line => line[0] !== '-').length, hunk.newCount);
        }
      }
    }
  });

  it('keeps the right-hand line numbers, which is what review comments point at', () => {
    const { text } = restrictToPullRequest(INTERLEAVED_INCREMENTAL, INTERLEAVED_PULL);
    const [hunk] = parseDiff(text)[0].hunks;
    assert.equal(hunk.newStart, 17);
  });

  it('leaves nothing for a merge with no work of the pull request\'s own', () => {
    assert.deepEqual(restrictToPullRequest(PURE_MERGE_INCREMENTAL, PURE_MERGE_PULL), { text: '', leftOut: true });
  });

  it('returns the incremental diff unchanged when every change is the pull request\'s', () => {
    const incremental = MERGE_PULL;
    assert.deepEqual(restrictToPullRequest(incremental, MERGE_PULL), { text: incremental, leftOut: false });
  });

  it('keeps a file without hunks when the pull request touches it', () => {
    const modeOnly = 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n';
    assert.deepEqual(restrictToPullRequest(modeOnly, modeOnly), { text: modeOnly, leftOut: false });
    assert.deepEqual(restrictToPullRequest(modeOnly, MERGE_PULL), { text: '', leftOut: true });
  });
});
