#!/usr/bin/env node
/**
 * The OpenCode configuration and the prompt for the issue implementer.
 *
 * Built on the package's own `buildConfig`, so the provider block, the refusal
 * to share and the agent selection are the same as for the review agents. Three
 * things are added, all for a local model:
 *
 *  - `reasoningEffort`. OpenCode passes it to an OpenAI-compatible endpoint as
 *    `reasoning_effort`. LM Studio runs `qwen/qwen3.8-27b` at `low` unless a
 *    request asks for more, and a whole issue is not a `low` job.
 *  - `limit.context` and `limit.output`, when set. Without a context limit
 *    OpenCode does not know when to compact the session, and a long task
 *    overflows the window the endpoint has loaded.
 *  - The profile, which lets this agent edit the checkout and run a shell.
 *    It lives here and not in `profiles/`, because every profile there
 *    promises that an agent writes nothing outside `.pitcrew-run/`.
 *
 * Environment: HARNESS (the default-branch checkout of this repository), MODEL,
 * REASONING_EFFORT, CONTEXT_LIMIT, OUTPUT_LIMIT, CONFIG_OUT, MODEL_OUT,
 * PROMPT_OUT, and the prompt's placeholders.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENT = 'issue-implementer';
export const PLACEHOLDERS = ['TASK_FILE', 'SUMMARY_FILE', 'DEADLINE', 'OUTPUT_LANGUAGE'];

export function implementerConfig({ buildConfig, normaliseModel, profile, model, reasoningEffort, contextLimit, outputLimit }) {
  const config = buildConfig({
    agent: AGENT,
    profile,
    model,
    temperature: 0.2,
    description: 'Implements a GitHub issue, or addresses review feedback on its pull request, in the checkout.',
  });
  const entry = config.provider.llm.models[normaliseModel(model)];
  // `reasoning: true` marks the model as one that thinks, which is what
  // OpenCode's reasoning handling keys on.
  if (reasoningEffort) Object.assign(entry, { reasoning: true, options: { ...entry.options, reasoningEffort } });
  const context = Number.parseInt(contextLimit ?? '', 10);
  if (context > 0) {
    const output = Number.parseInt(outputLimit ?? '', 10);
    entry.limit = { context, output: output > 0 ? output : Math.min(32768, Math.floor(context / 4)) };
  }
  return config;
}

async function main() {
  const fail = message => {
    console.error(`::error::${message}`);
    process.exit(1);
  };
  const home = process.env.HARNESS || fail('HARNESS is not set.');
  const model = (process.env.MODEL ?? '').trim() || fail('No model. Set PITCREW_IMPLEMENTER_MODEL.');

  const { buildConfig, normaliseModel, fillPrompt } = await import(join(home, 'scripts', 'build-config.mjs'));
  const dir = join(home, 'labs', AGENT);
  const profile = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'));
  delete profile.$comment;

  const config = implementerConfig({
    buildConfig,
    normaliseModel,
    profile,
    model,
    reasoningEffort: (process.env.REASONING_EFFORT ?? '').trim(),
    contextLimit: process.env.CONTEXT_LIMIT,
    outputLimit: process.env.OUTPUT_LIMIT,
  });
  const { text, filled } = fillPrompt(readFileSync(join(dir, 'prompt.md'), 'utf8'), process.env, PLACEHOLDERS);

  const entry = config.provider.llm.models[normaliseModel(model)];
  console.log(`Model:     ${config.model}`);
  console.log(`Effort:    ${entry.options?.reasoningEffort ?? '(endpoint default)'}`);
  console.log(`Limits:    ${entry.limit ? `context ${entry.limit.context}, output ${entry.limit.output}` : '(unknown to OpenCode)'}`);
  console.log(`Filled in: ${filled.join(', ') || '(none)'}`);

  writeFileSync(process.env.CONFIG_OUT || fail('CONFIG_OUT is not set.'), JSON.stringify(config));
  writeFileSync(process.env.MODEL_OUT || fail('MODEL_OUT is not set.'), config.model);
  writeFileSync(process.env.PROMPT_OUT || fail('PROMPT_OUT is not set.'), text);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
