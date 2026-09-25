/**
 * The tests for the rewrite a release is made of.
 *
 * A reusable workflow cannot reference its own repository's action relatively -
 * `uses: ./actions/agent` inside a called workflow resolves against the
 * *caller's* workspace - so every self-reference is fully qualified and carries
 * a literal ref. Which means a tag whose workflows still said `@main` would
 * quietly run the newest code inside a version somebody pinned on purpose, and
 * a rewrite that caught a third-party action would repoint somebody else's
 * pinned sha. Both mistakes are invisible until the day they matter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { retarget, selfReferences } from './release.mjs';

// What .github/workflows/bug-review.yml looks like on main: this package's own
// action at @main, third-party actions pinned to a sha, and one relative use.
const workflow = `name: Bug review

on:
  workflow_call:
    inputs:
      agent:
        type: string

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          fetch-depth: 0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
      - uses: deyai-labs/pr-pitcrew/actions/agent@main
        with:
          agent: bug-review
      - uses: deyai-labs/pr-pitcrew/actions/recorder@main
      - uses: ./actions/agent
      - uses: docker://alpine@sha256:1234
`;

describe('selfReferences', () => {
  it('finds an action of this package and reports its path and ref', () => {
    assert.deepEqual(selfReferences('uses: deyai-labs/pr-pitcrew/actions/agent@main'), [
      { path: 'deyai-labs/pr-pitcrew/actions/agent', ref: 'main' },
    ]);
  });

  it('finds a reusable workflow of this package, dots and all', () => {
    assert.deepEqual(selfReferences('uses: deyai-labs/pr-pitcrew/.github/workflows/bug-review.yml@v1'), [
      { path: 'deyai-labs/pr-pitcrew/.github/workflows/bug-review.yml', ref: 'v1' },
    ]);
  });

  it('ignores a third-party action, whatever it is pinned to', () => {
    // Rewriting one of these would repoint somebody else's code at a ref that
    // does not exist in their repository - or, worse, at one that does.
    assert.deepEqual(selfReferences('uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683'), []);
    assert.deepEqual(selfReferences('uses: actions/setup-node@v4'), []);
    assert.deepEqual(selfReferences('uses: someoneelse/pr-pitcrew-fork/actions/agent@main'), []);
  });

  it('ignores a relative reference, which carries no ref to rewrite', () => {
    assert.deepEqual(selfReferences('uses: ./.github/workflows/bug-review.yml'), []);
    assert.deepEqual(selfReferences('uses: ./actions/agent'), []);
  });

  it('finds every self-reference in a realistic workflow and nothing else', () => {
    assert.deepEqual(selfReferences(workflow), [
      { path: 'deyai-labs/pr-pitcrew/actions/agent', ref: 'main' },
      { path: 'deyai-labs/pr-pitcrew/actions/recorder', ref: 'main' },
    ]);
  });

  it('finds nothing in text that has none', () => {
    assert.deepEqual(selfReferences(''), []);
    assert.deepEqual(selfReferences('name: Bug review\n'), []);
  });
});

describe('retarget', () => {
  it('rewrites every self-reference to the given ref', () => {
    const tagged = retarget(workflow, 'v1.2.0');
    assert.deepEqual(selfReferences(tagged), [
      { path: 'deyai-labs/pr-pitcrew/actions/agent', ref: 'v1.2.0' },
      { path: 'deyai-labs/pr-pitcrew/actions/recorder', ref: 'v1.2.0' },
    ]);
    assert.ok(tagged.includes('uses: deyai-labs/pr-pitcrew/actions/agent@v1.2.0'));
  });

  it('leaves third-party references exactly as they were', () => {
    const tagged = retarget(workflow, 'v1.2.0');
    assert.ok(tagged.includes('actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683'));
    assert.ok(tagged.includes('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'));
    assert.ok(tagged.includes('uses: ./actions/agent\n'), 'the relative reference was touched');
    assert.ok(tagged.includes('docker://alpine@sha256:1234'));
  });

  it('changes nothing else about the file', () => {
    const tagged = retarget(workflow, 'v1.2.0');
    assert.equal(tagged.split('\n').length, workflow.split('\n').length);
    assert.equal(
      tagged.replaceAll('@v1.2.0', '@main'),
      workflow,
      'the rewrite touched something other than the refs',
    );
  });

  it('round-trips, so a release commit is exactly the ref and nothing more', () => {
    // `main` keeps `@main`; the release is a separate commit on a throwaway
    // branch. If the way back were lossy, that commit would be carrying an
    // edit nobody made.
    assert.equal(retarget(retarget(workflow, 'v1.2.0'), 'main'), workflow);
    assert.equal(retarget(retarget(workflow, 'v1'), 'main'), workflow);
  });

  it('is a no-op when the ref is already the wanted one', () => {
    assert.equal(retarget(workflow, 'main'), workflow);
  });

  it('rewrites a reference that already carries a version', () => {
    assert.equal(
      retarget('uses: deyai-labs/pr-pitcrew/.github/workflows/bug-review.yml@v1', 'v1.2.0'),
      'uses: deyai-labs/pr-pitcrew/.github/workflows/bug-review.yml@v1.2.0',
    );
  });
});
