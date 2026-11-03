/**
 * The tests for the file that decides what the agent is allowed to do.
 *
 * Two things are load-bearing here and neither is obvious from reading the
 * output: `default_agent` is what actually selects the agent (drop it and every
 * run becomes the runtime's built-in everything-allowed one), and nothing
 * falls back quietly - an unknown agent, an unknown profile, a missing prompt
 * each end the run with a message naming the fix. A default would be somebody's
 * bill, or somebody's shell.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildConfig, fillPrompt, normaliseModel, readAgent, PLACEHOLDERS } from './build-config.mjs';

// Resolved from this file, not from the cwd: `node --test` may be started from
// anywhere, and the package sits above the script.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shipped = readdirSync(join(root, 'agents'), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name);

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

/**
 * A throwaway package laid out like the real one: `agents/<id>/agent.json`,
 * `agents/<id>/prompt.md`, `profiles/<name>.json`. The failures worth testing
 * are all malformed packages, and a malformed package cannot be committed.
 */
const makeHome = ({ agents = {}, profiles = { basic: { bash: 'deny' } } } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'build-config-'));
  dirs.push(home);

  for (const [name, body] of Object.entries(profiles)) {
    mkdirSync(join(home, 'profiles'), { recursive: true });
    writeFileSync(join(home, 'profiles', `${name}.json`), JSON.stringify(body));
  }
  for (const [id, { manifest, prompt }] of Object.entries(agents)) {
    const dir = join(home, 'agents', id);
    mkdirSync(dir, { recursive: true });
    if (manifest !== undefined) writeFileSync(join(dir, 'agent.json'), JSON.stringify(manifest));
    if (prompt !== undefined) writeFileSync(join(dir, 'prompt.md'), prompt);
  }
  return home;
};

const manifestFor = (id, extra = {}) => ({
  id,
  title: 'A review',
  profile: 'basic',
  report: 'findings',
  ...extra,
});

describe('readAgent on the agents this package ships', () => {
  for (const id of shipped) {
    it(`${id} answers with a manifest, a profile and a prompt`, () => {
      const { manifest, profile, promptPath, promptText } = readAgent(root, id);

      assert.equal(manifest.id, id, 'the manifest calls itself something else');
      assert.ok(manifest.title.length > 0);
      assert.ok(promptPath.endsWith(join('agents', id, 'prompt.md')));
      assert.ok(promptText.trim().length > 0, 'the prompt is empty');

      assert.ok(Object.keys(profile).length > 0, 'the profile is empty');
      // The profile is copied verbatim into the configuration the runtime
      // reads, and `$comment` is documentation for us, not a permission.
      assert.equal('$comment' in profile, false, '$comment reached the configuration');
    });
  }
});

describe('readAgent refuses rather than falls back', () => {
  it('names the agents that do exist when asked for one that does not', () => {
    // The important one. A default agent here is the everything-allowed agent,
    // running against a pull request that may have written the diff it reads.
    assert.throws(() => readAgent(root, 'no-such-agent'), error => {
      assert.match(error.message, /no-such-agent/);
      for (const id of shipped) assert.match(error.message, new RegExp(id));
      return true;
    });
  });

  it('lists the agents of the package it was pointed at, not of this one', () => {
    const home = makeHome({
      agents: {
        alpha: { manifest: manifestFor('alpha'), prompt: 'Ask alpha.' },
        beta: { manifest: manifestFor('beta'), prompt: 'Ask beta.' },
      },
    });
    assert.throws(() => readAgent(home, 'gamma'), /It ships: alpha, beta\./);
  });

  it('says so plainly when the package ships no agent at all', () => {
    assert.throws(() => readAgent(makeHome(), 'alpha'), /It ships: \(none\)\./);
  });

  it('refuses a manifest that names a permission profile the package does not define', () => {
    const home = makeHome({
      agents: {
        alpha: { manifest: manifestFor('alpha', { profile: 'wide-open' }), prompt: 'Ask alpha.' },
      },
    });
    assert.throws(() => readAgent(home, 'alpha'), error => {
      assert.match(error.message, /wide-open/, 'the message does not name the missing profile');
      assert.match(error.message, /alpha/);
      return true;
    });
  });

  it('refuses a directory that has a manifest but no prompt', () => {
    const home = makeHome({ agents: { alpha: { manifest: manifestFor('alpha') } } });
    assert.throws(() => readAgent(home, 'alpha'), /prompt\.md is missing/);
  });

  it('refuses a report kind it has no reader for', () => {
    const home = makeHome({
      agents: {
        alpha: { manifest: manifestFor('alpha', { report: 'notes' }), prompt: 'Ask alpha.' },
      },
    });
    assert.throws(() => readAgent(home, 'alpha'), error => {
      assert.match(error.message, /"notes"/, 'the message does not name the unknown kind');
      assert.match(error.message, /findings.*criteria/s);
      return true;
    });
  });

  it('reads the guide kind and a diff scope, and refuses a scope it does not know', () => {
    const home = makeHome({
      agents: {
        alpha: { manifest: manifestFor('alpha', { report: 'guide', diffScope: 'pull-request' }), prompt: 'Ask alpha.' },
        beta: { manifest: manifestFor('beta', { diffScope: 'everything' }), prompt: 'Ask beta.' },
      },
    });
    assert.equal(readAgent(home, 'alpha').manifest.report, 'guide');
    assert.throws(() => readAgent(home, 'beta'), /diffScope "everything"/);
  });

  it('refuses a manifest whose id disagrees with the directory it lives in', () => {
    // Otherwise the id in the configuration and the directory the prompt came
    // from are two different agents wearing one name.
    const home = makeHome({
      agents: { alpha: { manifest: manifestFor('beta'), prompt: 'Ask alpha.' } },
    });
    assert.throws(() => readAgent(home, 'alpha'), error => {
      assert.match(error.message, /"beta"/);
      assert.match(error.message, /agents\/alpha/);
      return true;
    });
  });

  it('refuses a manifest missing a field it cannot be run without', () => {
    const home = makeHome({
      agents: { alpha: { manifest: { id: 'alpha', profile: 'basic', report: 'findings' }, prompt: 'x' } },
    });
    assert.throws(() => readAgent(home, 'alpha'), /has no "title"/);
  });
});

describe('normaliseModel', () => {
  it('strips the leading provider prefix', () => {
    assert.equal(normaliseModel('llm/gpt-4o-mini'), 'gpt-4o-mini');
  });

  it('leaves a model id that carries its own slash alone', () => {
    // The runtime splits on the *first* slash, so only a leading `llm/` is a
    // provider; `deepseek-ai/` is part of the model's name.
    assert.equal(normaliseModel('deepseek-ai/DeepSeek-V3'), 'deepseek-ai/DeepSeek-V3');
    assert.equal(normaliseModel('llm/deepseek-ai/DeepSeek-V3'), 'deepseek-ai/DeepSeek-V3');
  });

  it('trims, because a repository variable is typed by hand', () => {
    assert.equal(normaliseModel('  llm/gpt-4o-mini  '), 'gpt-4o-mini');
    assert.equal(normaliseModel('\tdeepseek-ai/DeepSeek-V3\n'), 'deepseek-ai/DeepSeek-V3');
  });

  it('turns nothing into nothing rather than into a guess', () => {
    assert.equal(normaliseModel(''), '');
    assert.equal(normaliseModel('   '), '');
    assert.equal(normaliseModel(undefined), '');
    assert.equal(normaliseModel(null), '');
  });

  it('does not mistake a model called llmsomething for a prefixed one', () => {
    assert.equal(normaliseModel('llmodel-3'), 'llmodel-3');
  });
});

describe('buildConfig', () => {
  const profile = { bash: 'deny', read: { '*': 'allow', '/proc/**': 'deny' }, task: 'deny' };
  const config = () =>
    buildConfig({
      agent: 'bug-review',
      profile,
      model: 'llm/deepseek-ai/DeepSeek-V3',
      temperature: 0.1,
      description: 'Reads a diff.',
    });

  it('selects the agent through default_agent', () => {
    // The action's own `agent` input is ignored by the runtime, which then
    // falls back to `build` - an agent that allows everything. This one field
    // is the difference between the permission profile applying and it sitting
    // in the configuration doing nothing.
    assert.equal(config().default_agent, 'bug-review');
  });

  it('puts the same model string at the top level and on the agent', () => {
    const built = config();
    assert.equal(built.model, 'llm/deepseek-ai/DeepSeek-V3');
    assert.equal(built.agent['bug-review'].model, 'llm/deepseek-ai/DeepSeek-V3');
  });

  it('registers the bare model id under the provider', () => {
    const built = config();
    assert.deepEqual(Object.keys(built.provider.llm.models), ['deepseek-ai/DeepSeek-V3']);
    assert.deepEqual(built.provider.llm.models['deepseek-ai/DeepSeek-V3'], { name: 'deepseek-ai/DeepSeek-V3' });
  });

  it('copies the permission profile onto the agent verbatim', () => {
    assert.deepEqual(config().agent['bug-review'].permission, profile);
  });

  it('carries the agent description and temperature the manifest gave it', () => {
    const agent = config().agent['bug-review'];
    assert.equal(agent.description, 'Reads a diff.');
    assert.equal(agent.temperature, 0.1);
    assert.equal(agent.mode, 'primary');
  });

  it('refers to the endpoint and the key rather than embedding them', () => {
    const { options } = config().provider.llm;
    assert.equal(options.baseURL, '{env:PITCREW_LLM_API_BASE_URL}');
    assert.equal(options.apiKey, '{env:PITCREW_LLM_API_KEY}');
  });

  it('cannot carry a secret into the file, because it never reads one', () => {
    // The configuration is written to disk in a job that holds the model key,
    // and a step output or an uploaded artefact would take it along. The
    // substitution happens in the runtime, from its own environment.
    const key = 'sk-test-000111222333444555666777888999';
    const baseUrl = 'https://models.example.invalid/v1';
    const before = { PITCREW_LLM_API_KEY: process.env.PITCREW_LLM_API_KEY, PITCREW_LLM_API_BASE_URL: process.env.PITCREW_LLM_API_BASE_URL };
    process.env.PITCREW_LLM_API_KEY = key;
    process.env.PITCREW_LLM_API_BASE_URL = baseUrl;
    try {
      const json = JSON.stringify(config());
      assert.equal(json.includes(key), false, 'the key reached the configuration file');
      assert.equal(json.includes(baseUrl), false, 'the endpoint reached the configuration file');
      assert.equal(json.includes('models.example.invalid'), false);
      assert.doesNotMatch(json, /sk-[A-Za-z0-9-]{8,}/, 'something key-shaped reached the configuration file');
      assert.ok(json.includes('{env:PITCREW_LLM_API_KEY}') && json.includes('{env:PITCREW_LLM_API_BASE_URL}'));
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('denies the external directory whatever the profile says', () => {
    const built = buildConfig({ agent: 'a', profile: {}, model: 'm', temperature: 0, description: 'd' });
    assert.equal(built.permission.external_directory, 'deny');
  });

  it('refuses session sharing in the configuration, not only in an action input', () => {
    // `share: 'false'` is an input of the OpenCode action, and the comment
    // trigger still passes it. The CLI has no such input: on the
    // `pull_request` path this field is the only thing standing between
    // somebody's diff and opencode.ai.
    const built = buildConfig({ agent: 'a', profile: {}, model: 'm', temperature: 0, description: 'd' });
    assert.equal(built.share, 'disabled');
  });
});

describe('fillPrompt', () => {
  const env = { DIFF_FILE: '/run/diff.patch', REPORT_FILE: '/run/report.json' };

  it('fills both $NAME and ${NAME}', () => {
    // The review agents have no shell, so they cannot resolve an environment
    // variable themselves: whatever is not substituted here reaches the model
    // as those literal characters.
    const { text } = fillPrompt('Read $DIFF_FILE, write ${REPORT_FILE}.', env);
    assert.equal(text, 'Read /run/diff.patch, write /run/report.json.');
  });

  it('reports which names it filled', () => {
    const { filled } = fillPrompt('$DIFF_FILE and ${REPORT_FILE}', env);
    assert.deepEqual(filled, ['DIFF_FILE', 'REPORT_FILE']);
  });

  it('stops at a word boundary, so a longer name is not a prefix match', () => {
    const { text, filled } = fillPrompt('$DIFF_FILEX stays, $DIFF_FILE goes.', env);
    assert.equal(text, '$DIFF_FILEX stays, /run/diff.patch goes.');
    assert.deepEqual(filled, ['DIFF_FILE']);
  });

  it('inserts a value containing $ literally', () => {
    // `replace` with a string argument expands `$&`, "$`", `$'`, `$$` and
    // `$1`-`$9` in the replacement. These values are repository variables
    // somebody typed, so one containing a dollar sign used to arrive at the
    // agent as a different, plausible-looking path.
    for (const value of ['/run/$&report.json', "/run/$'report.json", '/run/$$report.json', '/run/$1report.json']) {
      const { text } = fillPrompt('Write $REPORT_FILE.', { REPORT_FILE: value });
      assert.equal(text, `Write ${value}.`);
    }
    assert.equal(fillPrompt('Write $REPORT_FILE.', { REPORT_FILE: '/run/$`report.json' }).text, 'Write /run/$`report.json.');
  });

  it('leaves a placeholder with no value written as it is', () => {
    // A literal `$WORK_DIR` is a puzzle somebody can solve; an empty string is
    // a path that looks real and is not.
    const { text, filled } = fillPrompt('Work in $WORK_DIR.', {});
    assert.equal(text, 'Work in $WORK_DIR.');
    assert.deepEqual(filled, []);

    const empty = fillPrompt('Work in $WORK_DIR.', { WORK_DIR: '' });
    assert.equal(empty.text, 'Work in $WORK_DIR.');
    assert.deepEqual(empty.filled, []);
  });

  it('substitutes nothing that is not on the allowlist, however the environment looks', () => {
    // The prompt is echoed into the run log, and this process holds the model
    // key and - in the acceptance job - the credentials of the environment
    // under test. An agent that needs those has a shell and reads them itself.
    const hostile = {
      PITCREW_LLM_API_KEY: 'sk-test-000111222333',
      GITHUB_TOKEN: 'ghs-test-000111222333',
      HOME: '/home/runner',
      DIFF_FILE: '/run/diff.patch',
    };
    const { text, filled } = fillPrompt('$PITCREW_LLM_API_KEY ${GITHUB_TOKEN} $HOME $DIFF_FILE', hostile);

    assert.equal(text, '$PITCREW_LLM_API_KEY ${GITHUB_TOKEN} $HOME /run/diff.patch');
    assert.deepEqual(filled, ['DIFF_FILE']);
    assert.equal(text.includes('sk-test'), false, 'the model key was substituted into the prompt');
    assert.equal(text.includes('ghs-test'), false, 'the repository token was substituted into the prompt');
  });

  it('defaults its allowlist to the placeholders the package documents', () => {
    assert.equal(PLACEHOLDERS.includes('DIFF_FILE'), true);
    assert.equal(PLACEHOLDERS.includes('CHANGED_FILES'), true);
    assert.equal(PLACEHOLDERS.includes('PITCREW_LLM_API_KEY'), false);
    assert.equal(PLACEHOLDERS.includes('GITHUB_TOKEN'), false);
  });

  it('replaces every occurrence, not only the first', () => {
    const { text } = fillPrompt('$DIFF_FILE, again $DIFF_FILE, and ${DIFF_FILE}', env);
    assert.equal(text, '/run/diff.patch, again /run/diff.patch, and /run/diff.patch');
  });

  it('survives a prompt that names nothing', () => {
    const { text, filled } = fillPrompt('Read the diff and report.', env);
    assert.equal(text, 'Read the diff and report.');
    assert.deepEqual(filled, []);
  });
});
