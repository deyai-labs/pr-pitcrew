/**
 * Turns an agent directory into the configuration OpenCode is run with, and
 * fills in the prompt's placeholders.
 *
 * Everything here comes from *this package* at the ref the consumer pinned:
 * the agent manifest, its permission profile, the prompt. Nothing comes from
 * the repository under review. That is the whole point of the file. In the
 * bundle this grew out of, the configuration was a file in the reviewed
 * repository, and a pull request that edited it could grant its own reviewer a
 * shell. It could not quite, because the action read the file early and passed
 * it inline - but the defence was a matter of timing, and timing is a thing
 * that gets refactored away. Now the reviewed repository has no vote.
 *
 * Two invariants are worth stating out loud, because both were once bugs:
 *
 *  * **`default_agent` is what selects the agent.** The OpenCode GitHub action
 *    ignores its own `agent` input (`github.handler.ts` omits the agent when it
 *    prompts the session and falls back to `build`, which allows everything).
 *    For months every run of the original bundle was that `build` agent, while
 *    a carefully written permission block sat in the repository doing nothing.
 *    A permission that never applies looks exactly like one that does.
 *  * **Nothing falls back quietly.** An unknown agent, an unknown profile, a
 *    missing prompt, no model, no endpoint: each ends the run with a message
 *    naming the fix. A default here would be somebody's bill.
 *
 * CLI: `node build-config.mjs`, with PITCREW_HOME, AGENT, MODEL, BASE_URL and
 * the placeholder values in the environment; writes CONFIG_OUT, MODEL_OUT and
 * PROMPT_OUT.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The provider id inside the generated configuration. Local to this file. */
const PROVIDER = 'llm';

/**
 * The prompt refers to its inputs by name and this is where those names get
 * values - before the agent ever sees the text.
 *
 * It has to happen here. **An agent without a shell cannot resolve an
 * environment variable**, and the two review agents are exactly that. Until
 * this existed, `$DIFF_FILE` reached them as those eleven characters and every
 * review rested on the model guessing the path. In the run log it looked like
 * this: the agent read the project's AGENTS.md, ran `glob **\/DIFF_FILE*`,
 * found nothing and replied that it could not start - with the diff sitting
 * next to it the whole time.
 *
 * An allowlist, not the whole environment. This process holds the model key
 * and, in the acceptance job, the credentials of the environment under test; a
 * prompt is echoed into the run log, and a credential has no business in one.
 * The agent that needs those has a shell and reads them from its own
 * environment, which is why the acceptance prompt names them without a `$`.
 */
export const PLACEHOLDERS = [
  'DIFF_FILE',
  'DIFF_SCOPE',
  'CHANGED_FILES',
  'ISSUE_FILE',
  'DESCRIPTION_FILE',
  'REPORT_FILE',
  'RUN_URL',
  'WORK_DIR',
  'ARTIFACT_DIR',
  'RECORDER',
  'TARGET_URL',
  'OUTPUT_LANGUAGE',
  'DEADLINE',
];

class ConfigError extends Error {}

const fail = message => {
  throw new ConfigError(message);
};

export function readAgent(home, id) {
  const dir = join(home, 'agents', id);
  const manifestPath = join(dir, 'agent.json');
  if (!existsSync(manifestPath)) {
    const known = existsSync(join(home, 'agents'))
      ? readdirSync(join(home, 'agents'), { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => entry.name)
      : [];
    fail(`No agent named "${id}" in this package. It ships: ${known.join(', ') || '(none)'}.`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`${manifestPath} is not valid JSON: ${error.message}`);
  }

  for (const field of ['id', 'title', 'profile', 'report']) {
    if (!manifest[field]) fail(`${manifestPath} has no "${field}". A manifest without one cannot be run.`);
  }
  if (manifest.id !== id) fail(`${manifestPath} calls itself "${manifest.id}" but lives in agents/${id}/.`);
  if (!['findings', 'criteria', 'guide'].includes(manifest.report)) {
    fail(`${manifestPath} declares report "${manifest.report}"; known kinds are "findings", "criteria" and "guide".`);
  }
  if (manifest.diffScope !== undefined && !['incremental', 'pull-request'].includes(manifest.diffScope)) {
    fail(`${manifestPath} declares diffScope "${manifest.diffScope}"; known scopes are "incremental" and "pull-request".`);
  }

  const promptPath = join(dir, 'prompt.md');
  if (!existsSync(promptPath)) fail(`${promptPath} is missing, so there is nothing to ask the agent.`);

  const profilePath = join(home, 'profiles', `${manifest.profile}.json`);
  if (!existsSync(profilePath)) fail(`Agent "${id}" wants the permission profile "${manifest.profile}", which this package does not define.`);

  let profile;
  try {
    profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  } catch (error) {
    fail(`${profilePath} is not valid JSON: ${error.message}`);
  }
  delete profile.$comment;

  return { manifest, profile, promptPath, promptText: readFileSync(promptPath, 'utf8') };
}

/**
 * A model id may contain a slash of its own (`deepseek-ai/DeepSeek-V3`), and
 * OpenCode splits the model string on its *first* slash. So only a leading
 * `<provider>/` is stripped, and the rest is passed on verbatim.
 */
export function normaliseModel(configured, provider = PROVIDER) {
  const value = String(configured ?? '').trim();
  return value.startsWith(`${provider}/`) ? value.slice(provider.length + 1) : value;
}

export function buildConfig({ agent, profile, model, temperature, description }) {
  const bare = normaliseModel(model);
  return {
    $schema: 'https://opencode.ai/config.json',
    // The endpoint and the key arrive as environment variables, which is
    // OpenCode's own `{env:...}` substitution: the key is never written into a
    // file or a step output on its way in.
    provider: {
      [PROVIDER]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'LLM provider',
        options: { baseURL: '{env:PITCREW_LLM_API_BASE_URL}', apiKey: '{env:PITCREW_LLM_API_KEY}' },
        // Written here rather than listed in the package: which models an
        // endpoint serves is the endpoint's business, not a second list for
        // somebody to keep current.
        models: { [bare]: { name: bare } },
      },
    },
    // Sharing uploads the session transcript - somebody's diff - to
    // opencode.ai. The wrapper action takes `share: 'false'` as an input; the
    // CLI has no such input and would go by configuration, so the refusal is
    // written here, where both paths read it. See docs/threat-model.md.
    share: 'disabled',
    permission: { external_directory: 'deny', write_report: 'allow' },
    // This, not the action's `agent` input, is what picks the agent.
    default_agent: agent,
    model: `${PROVIDER}/${bare}`,
    agent: {
      [agent]: {
        mode: 'primary',
        description,
        temperature,
        // Both the top-level model and the agent's: the first is what the run
        // reports and falls back to, the second is what makes "a different
        // model per agent" a property of the configuration rather than of
        // whichever workflow happened to start.
        model: `${PROVIDER}/${bare}`,
        permission: profile,
      },
    },
  };
}

/**
 * Both `$NAME` and `${NAME}`, on a word boundary, so a `$DIFF_FILEX` stays
 * what it is. A name with no value stays written as it is: a literal
 * `$WORK_DIR` in a prompt is a puzzle somebody can solve, an empty string is a
 * path that looks real and is not.
 */
export function fillPrompt(text, env = process.env, names = PLACEHOLDERS) {
  const filled = [];
  const out = names.reduce((current, name) => {
    const value = env[name];
    if (!value) return current;
    // A function, not the string: as a replacement argument, `$&`, `` $` ``,
    // `$'`, `$$` and `$1`-`$9` are expanded rather than inserted. These values
    // are repository variables somebody typed - a URL, a path, a language - and
    // a `$&` in one would arrive at the agent as a plausible-looking path that
    // is not the one anybody configured. A function replacement is literal.
    const next = current.replace(new RegExp(`\\$\\{${name}\\}|\\$${name}\\b`, 'g'), () => value);
    if (next !== current) filled.push(name);
    return next;
  }, String(text));
  return { text: out, filled };
}

function main() {
  const home = process.env.PITCREW_HOME || fail('PITCREW_HOME is not set; the action sets it to the package root.');
  const id = process.env.AGENT || fail('AGENT is not set.');

  // No default, on purpose. A package that quietly picked a model would bill
  // somebody for a choice they never made, and the run log would be the only
  // place that choice was ever visible.
  const model = (process.env.MODEL ?? '').trim();
  if (!model) {
    fail(
      'No model is configured. Set the repository variable PITCREW_LLM_API_MODEL (or the per-agent one this workflow reads) to a model id your endpoint serves.',
    );
  }
  const baseUrl = (process.env.BASE_URL ?? '').trim();
  if (!baseUrl) {
    fail(
      'No endpoint is configured. Set the repository variable PITCREW_LLM_API_BASE_URL to the base URL of your OpenAI-compatible provider, e.g. https://api.example.com/v1.',
    );
  }

  const { manifest, profile, promptText } = readAgent(home, id);
  const config = buildConfig({
    agent: manifest.id,
    profile,
    model,
    temperature: manifest.temperature ?? 0.1,
    description: manifest.description ?? manifest.title,
  });

  const { text, filled } = fillPrompt(promptText);
  console.log(`Agent:    ${manifest.id} (${manifest.title})`);
  console.log(`Profile:  ${manifest.profile}`);
  console.log(`Report:   ${manifest.report}`);
  console.log(`Model:    ${config.model}`);
  console.log(`Endpoint: ${baseUrl}`);
  console.log(filled.length ? `Filled in: ${filled.join(', ')}` : 'The prompt names no known placeholder.');

  writeFileSync(process.env.CONFIG_OUT || fail('CONFIG_OUT is not set.'), JSON.stringify(config));
  writeFileSync(process.env.MODEL_OUT || fail('MODEL_OUT is not set.'), config.model);
  writeFileSync(process.env.PROMPT_OUT || fail('PROMPT_OUT is not set.'), text);
  writeFileSync(process.env.TITLE_OUT || fail('TITLE_OUT is not set.'), manifest.title);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`::error::${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
