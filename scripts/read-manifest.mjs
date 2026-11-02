/**
 * Reads one agent manifest and writes what the workflow needs to know about it
 * to `$GITHUB_OUTPUT`.
 *
 * The manifest is the single place an agent is described. Before it existed, an
 * agent was spread over five: a prompt file, a permission block, a workflow, a
 * title in an environment variable and a slash command in a job's `if:`. The
 * two review agents' permission blocks were identical character for character,
 * which is the state a fourth agent copies and a fifth quietly diverges from.
 *
 * Environment: PITCREW_HOME, AGENT. Writes: title, report, wants-diff,
 * wants-issue, wants-target, command, check, diff-scope.
 */

import { appendFileSync } from 'node:fs';
import { readAgent } from './build-config.mjs';

const home = process.env.PITCREW_HOME;
const id = process.env.AGENT;

if (!home || !id) {
  console.error('::error::PITCREW_HOME and AGENT must both be set. The action sets them.');
  process.exit(1);
}

let manifest;
try {
  ({ manifest } = readAgent(home, id));
} catch (error) {
  // Loudly, and never onto a default. A manifest that names an unknown
  // permission profile must not fall back to a permissive one, and an agent
  // that does not exist must not quietly become the runtime's built-in
  // everything-allowed agent - which is exactly what used to happen.
  console.error(`::error::${error.message}`);
  process.exit(1);
}

const inputs = new Set(manifest.inputs ?? []);
const out = {
  title: manifest.title,
  check: manifest.check ?? manifest.title,
  command: manifest.command ?? '',
  report: manifest.report,
  'wants-diff': String(inputs.has('diff')),
  'wants-issue': String(inputs.has('issue')),
  'wants-target': String(inputs.has('target')),
  // `pull-request` for an agent that describes the whole pull request on every
  // run, such as the review guide; `incremental` (the default) for a review.
  'diff-scope': manifest.diffScope ?? 'incremental',
};

for (const [key, value] of Object.entries(out)) console.log(`${key}: ${value}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(out)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
  );
}
