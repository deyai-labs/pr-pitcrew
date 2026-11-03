import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig, normaliseModel, fillPrompt } from '../../../scripts/build-config.mjs';
import { implementerConfig, PLACEHOLDERS } from './config.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'));
const build = extra => implementerConfig({ buildConfig, normaliseModel, profile, model: 'qwen/qwen3.8-27b', ...extra });

describe('the implementer configuration', () => {
  it('asks the endpoint for the reasoning effort', () => {
    const config = build({ reasoningEffort: 'high' });
    assert.deepEqual(config.provider.llm.models['qwen/qwen3.8-27b'].options, { reasoningEffort: 'high' });
    assert.equal(config.provider.llm.models['qwen/qwen3.8-27b'].reasoning, true);
    assert.equal(config.default_agent, 'issue-implementer');
    assert.equal(config.share, 'disabled');
  });

  it('leaves the effort to the endpoint when none is given', () => {
    assert.equal(build({}).provider.llm.models['qwen/qwen3.8-27b'].options, undefined);
  });

  it('tells OpenCode the context window, so it can compact', () => {
    assert.deepEqual(build({ contextLimit: '65536' }).provider.llm.models['qwen/qwen3.8-27b'].limit, { context: 65536, output: 16384 });
    assert.deepEqual(build({ contextLimit: '65536', outputLimit: '8000' }).provider.llm.models['qwen/qwen3.8-27b'].limit, {
      context: 65536,
      output: 8000,
    });
    assert.equal(build({ contextLimit: '' }).provider.llm.models['qwen/qwen3.8-27b'].limit, undefined);
  });
});

describe('the implementer profile', () => {
  // OpenCode applies the last matching rule, so each deny has to come after
  // the allow it narrows.
  const last = (rules, key) => Object.keys(rules).indexOf(key) > Object.keys(rules).indexOf('*');

  it('cannot commit, push or touch workflows', () => {
    assert.equal(profile.bash['git commit*'], 'deny');
    assert.equal(profile.bash['git push*'], 'deny');
    assert.ok(last(profile.bash, 'git push*'));
    assert.equal(profile.edit['.github/workflows/**'], 'deny');
    assert.ok(last(profile.edit, '.github/workflows/**'));
  });

  it('never waits for an answer nobody gives in CI', () => {
    for (const key of ['question', 'doom_loop', 'external_directory']) assert.equal(profile[key], 'deny', key);
  });

  it('keeps the process environment out of the read tool', () => {
    assert.equal(profile.read['/proc/**'], 'deny');
    assert.equal(profile.webfetch, 'deny');
  });
});

describe('the implementer prompt', () => {
  it('names only placeholders the harness fills in', () => {
    const text = readFileSync(join(dir, 'prompt.md'), 'utf8');
    const named = new Set([...text.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})\}?/g)].map(match => match[1]));
    assert.deepEqual([...named].filter(name => !PLACEHOLDERS.includes(name)), []);
    const env = Object.fromEntries(PLACEHOLDERS.map(name => [name, `<${name}>`]));
    assert.deepEqual(fillPrompt(text, env, PLACEHOLDERS).filled.sort(), [...PLACEHOLDERS].sort());
  });
});
