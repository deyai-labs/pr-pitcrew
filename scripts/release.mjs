#!/usr/bin/env node
/**
 * Cuts a release, in one command, because the alternative is a checklist and a
 * day somebody forgets an item on it.
 *
 * The item that gets forgotten is this: a reusable workflow cannot reference
 * its own repository's action relatively. `uses: ./actions/agent` inside a
 * called workflow resolves against the *caller's* workspace, not against the
 * package - so the reference has to be fully qualified, `deyai-labs/pr-pitcrew/
 * actions/agent@<ref>`, and a ref cannot be an expression. Which means the
 * workflows carry a literal ref, and a tag whose workflows still say `@main`
 * would quietly run the newest code inside a version somebody pinned on
 * purpose.
 *
 * So `main` keeps `@main`, which is what makes this repository able to review
 * its own pull requests, and a release is a *separate commit*, made on a
 * throwaway branch, in which every self-reference is rewritten to the tag. That
 * commit is what the tag points at. Nothing on `main` changes.
 *
 *   node scripts/release.mjs 1.2.0     cut v1.2.0 and move v1 to it
 *   node scripts/release.mjs --verify  check that main says `@main` (CI runs this)
 *   node scripts/release.mjs 1.2.0 --dry-run
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = /(\bdeyai-labs\/pr-pitcrew\/[A-Za-z0-9._\/-]+)@([A-Za-z0-9._-]+)/g;

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

const workflowFiles = () =>
  readdirSync(join(root, '.github/workflows'))
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map(name => join(root, '.github/workflows', name));

const exampleFiles = () =>
  readdirSync(join(root, 'examples'))
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map(name => join(root, 'examples', name));

/** Every self-reference in a file, as `{ path, ref }`. */
export function selfReferences(text) {
  return [...String(text).matchAll(SELF)].map(match => ({ path: match[1], ref: match[2] }));
}

export function retarget(text, ref) {
  return String(text).replace(SELF, (_, path) => `${path}@${ref}`);
}

function verify() {
  let bad = 0;
  const expect = (files, want, why) => {
    for (const file of files) {
      for (const { path, ref } of selfReferences(readFileSync(file, 'utf8'))) {
        if (ref !== want) {
          console.error(`${file}: ${path}@${ref} should be @${want} — ${why}`);
          bad++;
        }
      }
    }
  };

  expect(
    workflowFiles(),
    'main',
    'on main the workflows run the code beside them; scripts/release.mjs rewrites them for the tag',
  );
  expect(exampleFiles(), 'v1', 'the examples are what a reader copies, and they should get the moving major tag');

  if (bad) process.exit(1);
  console.log('Self-references are as they should be.');
}

function release(version, { dryRun }) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error(`"${version}" is not a semantic version. Try 1.2.0.`);
    process.exit(1);
  }
  const tag = `v${version}`;
  const major = `v${version.split('.')[0]}`;

  if (git('status', '--porcelain')) {
    console.error('The working tree is dirty. Commit or stash first: a release commit is made from what is here.');
    process.exit(1);
  }

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const restore = () => git('checkout', branch);
  const scratch = `release/${tag}`;

  git('checkout', '-b', scratch);
  try {
    for (const file of workflowFiles()) {
      const before = readFileSync(file, 'utf8');
      const after = retarget(before, tag);
      if (after !== before) {
        writeFileSync(file, after);
        console.log(`${file}: self-references → @${tag}`);
      }
    }

    if (dryRun) {
      console.log(git('diff', '--stat'));
      console.log(`\nDry run: would tag ${tag} and move ${major}.`);
      git('checkout', '--', '.');
      return;
    }

    git('commit', '-a', '-m', `Release ${tag}`);
    git('tag', '-a', tag, '-m', `Release ${tag}`);
    // The moving major tag. Force, because moving it is the whole idea: a
    // repository that pinned `@v1` gets a fix without touching a file.
    git('tag', '-f', '-a', major, '-m', `Release ${tag}`);
    console.log(`\nTagged ${tag} and moved ${major}. Push them:\n\n  git push origin ${tag} && git push -f origin ${major}\n`);
  } finally {
    restore();
    // The release commit lives on the tag, not on a branch. Leaving the branch
    // behind would invite somebody to merge it back into main and freeze every
    // self-reference at that version.
    try {
      git('branch', '-D', scratch);
    } catch {
      console.error(`Could not delete the scratch branch ${scratch}. Delete it by hand.`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--verify')) verify();
  else if (args[0]) release(args[0], { dryRun: args.includes('--dry-run') });
  else {
    console.error('Usage: node scripts/release.mjs <version> [--dry-run] | --verify');
    process.exit(1);
  }
}
