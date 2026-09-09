#!/usr/bin/env node
/**
 * Proves the browser stack before the run spends anything.
 *
 * The image brings the browsers, and the recorder needs the *driver* - the
 * `playwright-core` package that speaks to them. Those are two different things
 * and one run had the first without the second. Nothing checked, so the agent
 * met the gap itself, half an hour into a job that held the model key: it
 * fetched from the npm registry, looked for a writable directory, and reasoned
 * about spawning `npm` through `child_process` because that is not a tool the
 * permissions cover. The verdict the run was started for was never written.
 *
 * So the driver is resolved and launched here, in seconds, before the model is
 * called. A `stat` would not do: a package that resolves but cannot start
 * Chromium fails at exactly the same point in the run as no package at all.
 *
 * There is no install fallback here, and that is a decision rather than an
 * omission: this step runs beside the model key and the credentials of the
 * environment under test, and it must not react to what it finds. Provisioning
 * is the workflow's job and happens in a step before this one, at the image's
 * own version, where no secret is in scope. This step only proves.
 *
 * Environment: PLAYWRIGHT_MODULE (an override; when set it must work),
 * PLAYWRIGHT_IMAGE (named in the failure message), GITHUB_ENV, GITHUB_OUTPUT,
 * HARNESS_FAILURE_FILE (where the failure sentence goes for the step that
 * publishes it), LAUNCH_TIMEOUT_MS.
 */

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

/** The package names a driver goes by, best first. */
const NAMES = ['playwright-core', 'playwright'];

/** Where the official images and the common installs put it. */
const ROOTS = ['/ms-playwright-agent/node_modules', '/usr/lib/node_modules', '/usr/local/lib/node_modules'];

/**
 * Where to look, in the order the failure message states.
 *
 * An override comes first and alone: a consumer who names a path has answered
 * this question, and searching past a wrong answer would hide it.
 *
 * **The workspace is not on this list**, and every entry below is chosen to
 * stay out of it. `prove()` calls `require()`, and the workspace is the branch
 * under review - a candidate there would be that branch's code running in this
 * job, before the fork refusal in `actions/agent` has said a word. It is the
 * rule the whole package rests on: the repository under review contributes
 * configuration, instructions and code to nothing. A driver it shipped itself
 * would be no different from an `.opencode/tool/*.js`.
 *
 * The bare specifier is safe for the same reason: `createRequire` resolves it
 * from this package's checkout and walks up from there, which never descends
 * into the workspace. `search()` names its roots and none of them is one
 * either.
 */
export function candidates(env = process.env) {
  const override = (env.PLAYWRIGHT_MODULE ?? '').trim();
  if (override) return [{ how: 'PLAYWRIGHT_MODULE', path: override }];

  const found = [];
  const add = (how, path) => {
    if (path && !found.some(entry => entry.path === path)) found.push({ how, path });
  };

  for (const root of ROOTS) for (const name of NAMES) add('a known location', join(root, name));
  // Bare specifiers honour NODE_PATH, which is how the image is meant to work.
  for (const name of NAMES) add('the module path', name);

  for (const name of NAMES) add('npm root -g', globalRoot() && join(globalRoot(), name));
  for (const path of search()) add('a bounded search', path);

  return found;
}

let globalRootCache;
function globalRoot() {
  if (globalRootCache === undefined) globalRootCache = run('npm', ['root', '-g']) || '';
  return globalRootCache;
}

/**
 * The last resort, and bounded on purpose: a depth-limited `find` over the few
 * directories a driver plausibly lives in. An unbounded walk of the filesystem
 * is what the agent did, and it took longer than the run had.
 */
function search() {
  // Named roots, never `/` and never the workspace: see candidates().
  const roots = ['/ms-playwright-agent', '/usr/lib', '/usr/local/lib', '/opt'].filter(root => existsSync(root));
  if (roots.length === 0) return [];

  const out = run('find', [
    ...roots,
    '-maxdepth',
    '6',
    '-type',
    'd',
    '-name',
    'playwright-core',
  ]);
  return out ? out.split('\n').filter(Boolean).slice(0, 5) : [];
}

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Loads a candidate and starts a browser with it. Returns the resolved path. */
async function prove(candidate) {
  const playwright = require(candidate.path);
  if (!playwright?.chromium) throw new Error('the package exports no `chromium`');

  const browser = await playwright.chromium.launch({
    headless: true,
    // The container runs as root, where Chromium's sandbox refuses to start.
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    timeout: Number(process.env.LAUNCH_TIMEOUT_MS) || 60_000,
  });
  try {
    const version = browser.version();
    const page = await browser.newPage();
    await page.close();
    // The directory when that is what was named, so the value handed on is the
    // package rather than its entry file; the resolved path for a bare specifier.
    const path = candidate.path.startsWith('/') ? candidate.path : require.resolve(candidate.path);
    return { path, version };
  } finally {
    await browser.close();
  }
}

/** One sentence for the log, the pull request and the person reading either. */
function failureSentence(image, override) {
  const where = image ? `\`${image}\`` : 'this runner';
  if (override) {
    return (
      `\`PLAYWRIGHT_MODULE\` names \`${override}\`, and no browser could be started from it in ${where}. ` +
      'That path is the answer this run goes by, so nothing else was tried: correct it, or unset it and use an ' +
      'image that ships the driver next to the browsers. Nothing is installed at run time.'
    );
  }
  return (
    `No Playwright driver in ${where}: the browsers may be there, but no \`playwright-core\` package could be ` +
    'loaded and started, so nothing can be demonstrated. The official `mcr.microsoft.com/playwright` images ship ' +
    'the browsers and delete the driver, so the workflow installs it in the step before this one, at the version ' +
    'in the image tag - check whether that step ran and what it said. Pin the image to a version tag so a version ' +
    'can be read from it, or set `PLAYWRIGHT_MODULE` to a driver your own image already carries. This step ' +
    'installs nothing: it runs beside the model key and the credentials of the environment under test.'
  );
}

function announce(name, value) {
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name.toLowerCase().replace(/_/g, '-')}=${value}\n`);
}

async function main() {
  const image = (process.env.PLAYWRIGHT_IMAGE ?? '').trim();
  const tried = [];

  for (const candidate of candidates()) {
    if (candidate.path.startsWith('/') && !existsSync(candidate.path)) {
      tried.push(`${candidate.path} (${candidate.how}): not there`);
      continue;
    }
    try {
      const proved = await prove(candidate);
      console.log(`The browser is proven: ${proved.path} (${candidate.how}) started ${proved.version}.`);
      announce('PLAYWRIGHT_MODULE', proved.path);
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `The browser was proven before the run: ${proved.version}.\n`);
      }
      return 0;
    } catch (error) {
      tried.push(`${candidate.path} (${candidate.how}): ${String(error.message).split('\n')[0]}`);
    }
  }

  const sentence = failureSentence(image, (process.env.PLAYWRIGHT_MODULE ?? '').trim());
  console.log(`Tried, in order:\n  ${tried.join('\n  ')}`);
  console.log(`::error::${sentence}`);
  // For the step that puts this on the pull request; see report-harness-failure.mjs.
  const target = (process.env.HARNESS_FAILURE_FILE ?? '').trim();
  if (target) writeFileSync(target, `${sentence}\n`, 'utf8');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}
