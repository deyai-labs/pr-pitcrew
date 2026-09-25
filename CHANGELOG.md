# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.1] - 2026-09-09

### Fixed

- **The acceptance test runs again.** Since 1.2.0 it stopped in seconds on every repository,
  including one whose image was the documented default: the official
  `mcr.microsoft.com/playwright` images ship the browsers and delete the driver that speaks to
  them (`rm -rf /ms-playwright-agent`, upstream's last layer, in every version), so
  `actions/check-browser` refused a rig that nothing could satisfy. Before 1.2.0 the agent
  installed the driver itself mid-run, which is what 1.2.0 deliberately removed — and with it,
  unnoticed, the only thing that had been providing one.

  The workflow now installs `playwright-core` itself, before any step that carries a secret and
  at the exact version in the image tag, so driver and baked browsers cannot drift. The preflight
  is unchanged in what it does: it resolves and launches, and it still installs nothing. Consumers
  need no change; an image with its own driver still skips this through
  `PITCREW_PLAYWRIGHT_MODULE`. What it costs is one more fetch into that job — see
  [`docs/threat-model.md`](docs/threat-model.md), "The Playwright driver is installed from npm".
- The preflight's failure message no longer claims that the default image ships a driver. It
  points at the install step instead.

## [1.2.0] - 2026-09-02

### Fixed

- **A cancelled review is no longer treated as done.** The next push reviews from the last
  published report of this agent, not from the last push. Add `checks: read` to the caller
  workflow. See [`examples/bug-review.yml`](examples/bug-review.yml) and
  [`examples/security-review.yml`](examples/security-review.yml). If the lookup fails, the
  whole pull request is reviewed.

## [1.1.0] - 2026-08-27

### Added

- `PITCREW_REQUIRE_FULL_COVERAGE`, default `true`: a review that skipped changed files
  fails the check. The comment names the shortfall either way - `7 of 29 changed files
  opened`. Markdown, lockfiles and deletions are not counted.
- `PITCREW_PLAYWRIGHT_MODULE`: where the acceptance test finds Playwright, for an image
  that keeps it somewhere of its own.

### Changed

- The acceptance test refuses a `pull_request` whose author is not an `OWNER`, `MEMBER`
  or `COLLABORATOR`. Its review-request and `/acceptance` triggers are unaffected.
- On a `pull_request`, the pull request's title, body and comments no longer reach the
  model, and no comment appears until the review is published. Comment-triggered runs
  are unchanged.
- With a GitHub App, **Administration: read** is now only needed for the comment
  triggers.

### Fixed

- **Reviews open the files they report on.** A hunk is three lines of context, and a
  pass built only on hunks is not evidence. The comment says how many files were
  actually opened, and a shortfall gets one extra turn.
- **A run that reviewed nothing is no longer published as `verdict: pass`.** When the
  agent died before OpenCode had a session, the recovery turn used to invent an empty
  "no defects found".
- **A pull request opened by a bot is reviewed instead of refused.** `cursor[bot]` and
  its kind used to end with `permission: none` before the model saw the diff. Forks are
  still refused. [ADR 9](docs/adr/0009-the-pull-request-path-runs-the-cli.md) has the
  reasoning.
- **The acceptance test proves the browser before the model is called.** A missing
  Playwright driver now ends the job in seconds instead of half an hour of an agent
  improvising around a broken rig. Nothing is installed at run time.
- **A walk-through that stops early publishes what it proved.** The report is filed as
  each criterion is settled, and the agent is told when the job ends.
- **One ambiguous selector no longer ends the walk-through.** The recorder offers
  `run.outline()` and `run.pick()`, and each criterion runs in its own `try` / `catch`.
- **A failed precondition says so on the pull request** - a browser that could not be
  proven, a deployment serving somebody else's commit - instead of only in the job log.

### Security

- **Your branch no longer configures the runtime that reviews it**: no `opencode.json`,
  no `AGENTS.md` as system instructions, no tool under `.opencode/` - that last one was
  JavaScript in the process holding your model key. The agents still read your
  `AGENTS.md`; their prompts send them to it.
- The browser preflight no longer looks for its driver in the workspace, where the file
  it loads would have been the reviewed branch's own code.
- The repository token is out of the process that reads the diff, and session sharing is
  refused in the configuration rather than by an input the CLI does not have.
- **Give Pitcrew an ephemeral runner.** Report recovery reads OpenCode's newest session
  in the runner's home directory; on a reused self-hosted runner that can belong to
  another repository. See `docs/threat-model.md` and issue #11.

## [1.0.0] - 2026-08-24

First public release.

### Added

- Three agents for a pull request: **bug review** and **security review**, which read
  the diff, and an **acceptance test**, which drives the deployed application in a
  browser and records the walk-through on video.
- One reusable workflow per agent. Installing an agent is one workflow file in your
  repository; no scripts, prompts or profiles are copied.
- Any OpenAI-compatible endpoint. Endpoint, key and model id are required with no
  defaults, so an unconfigured repository stops with an error instead of billing
  somebody.
- Findings as inline review comments plus a summary comment, with `fail-on` deciding
  which severity fails the check.
- The agent's steps as a transcript in the run summary.
- Permission profiles read from this package at the pinned ref, never from the
  repository under review. Review agents get no shell; writes stay in the run directory.
- Fork pull requests refused, comment triggers included.
- Optional GitHub App identity, so comments carry your own bot name.
- `scripts/release.mjs`, `docs/threat-model.md`, and decision records under `docs/adr/`.

### Names

Every variable and secret starts with `PITCREW_`, and the next segment says what it
configures: `PITCREW_LLM_API_*` the model provider, `PITCREW_ACCEPTANCE_*` the
acceptance test, and anything with neither segment every agent. Two names mean "base
URL" and two mean "credentials", so a repository running only the diff reviews can see
from a name that half the table does not concern it. See
[ADR 1](docs/adr/0001-the-name.md).

### Migrating from the private bundle this grew out of

The invisible markers under this package's comments were renamed from
`opencode-review-summary` / `opencode-review-finding` to `pitcrew:summary` /
`pitcrew:finding`. They are functional - a run recognises its own earlier comments by
them - so **all three old forms are still recognised**, and an upgrade mid-pull-request
neither reposts standing findings nor loses them. The shim is covered by tests and there
is no plan to remove it.

Version `1.0.0` rather than `0.1.0`: the interface is the one that had been running in a
private repository for weeks, and `@v1` is what the documentation references.

[Unreleased]: https://github.com/deyai-labs/pr-pitcrew/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/deyai-labs/pr-pitcrew/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/deyai-labs/pr-pitcrew/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/deyai-labs/pr-pitcrew/releases/tag/v1.0.0
