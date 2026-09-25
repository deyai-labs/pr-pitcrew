<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img
      src="docs/assets/logo.svg"
      alt="PR Pitcrew - bug, security and acceptance review agents for your pull requests"
      width="520">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/deyai-labs/pr-pitcrew/actions/workflows/ci.yml"><img
    src="https://github.com/deyai-labs/pr-pitcrew/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img
    src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
</p>

Three review agents for your pull requests, installed as GitHub Actions workflows and run on your
own LLM endpoint. Open a pull request and it is read for bugs and for security defects, with each
finding written as a comment on the line it is about. Ask for the third one and an agent with a
browser drives your app, walks the linked issue's acceptance criteria, and leaves the
recording behind for you to check.

A real pit crew: several specialists, each with one job, all at once, and the car leaves in better
shape than it arrived.

Three of them ship today:

| Agent | Check | What it does |
| --- | --- | --- |
| `bug-review` | `Pitcrew / Bug Review` | Reads the diff, reports defects it can prove, as comments at the code. Fails the check from a severity you choose. |
| `security-review` | `Pitcrew / Security Review` | The same, for security defects. |
| `acceptance-test` | `Pitcrew / Acceptance Test` | Drives your deployed app in a browser, proves the linked issue's acceptance criteria, and uploads the video. |

They run on [OpenCode](https://opencode.ai) inside **your** runner, against **your**
OpenAI-compatible endpoint, with **your** key. No third-party service sits in between, and no model
is preselected: which model reads your code is a decision you make with your provider.

## What a pull request looks like with this installed

**You push.** `Pitcrew / Bug Review` and `Pitcrew / Security Review` start on the new commits.
Minutes later the diff carries comments where the defects are, and one summary comment above them:
verdict, counts by severity, what was looked at. From `high` upward (configurable) the check is red, and it stays
red until somebody deals with the finding.

**You push again.** Only the commits since the last published review are reviewed. A cancelled
run is not treated as done: the next push includes those commits. A point one of the agents already
made is not made a second time. What you fixed disappears; what you did not stays red.

**You ask for the acceptance test.** You request a review from the pitcrew account, which is the
gesture a human reviewer gets, and an agent with a browser drives your deployed app: it takes the
acceptance criteria from the linked issue, verbatim, does the steps by hand, and records them. What lands on
the pull request is a table of those criteria, each marked met or not and stamped with the moment it
happens in the recording, above a link to the video and the screenshots in the run's artifacts.

**Whatever a verdict does not tell you** is in the run summary: every tool call the agent made, its
input, and what the agent wrote.

## Quickstart

One file per agent, and that file is the whole of the agent's installation: the scripts, the prompts
and the permission profiles travel with the package instead of into your repository. This is the bug
review:

```yaml
# .github/workflows/pitcrew-bug-review.yml
name: Bug Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: read

concurrency:
  group: bug-review-${{ github.event.pull_request.number || github.event.issue.number }}-${{ github.event.comment.id || 'push' }}
  cancel-in-progress: true

jobs:
  bug-review:
    uses: deyai-labs/pr-pitcrew/.github/workflows/bug-review.yml@v1
    secrets:
      api-key: ${{ secrets.PITCREW_LLM_API_KEY }}
```

Then, once for all three agents, under **Settings → Secrets and variables → Actions**:

| | |
| --- | --- |
| secret `PITCREW_LLM_API_KEY` | the key for your endpoint |
| variable `PITCREW_LLM_API_BASE_URL` | the endpoint, including the version segment: `https://api.example.com/v1` |
| variable `PITCREW_LLM_API_MODEL` | a model id that endpoint serves, e.g. `gpt-4o-mini` |

Open a pull request. There is no fourth step.

The other two are that same file with another name in it. `examples/` has all three, ready to copy:
the security review is installed exactly like this one, and the acceptance test differs in what
starts it and in two variables of its own, which the section below explains. Beyond the endpoint,
the key and the model, they share nothing, so enable one, two or all three.

See [`docs/configuration.md`](docs/configuration.md) for the full configuration options.

## Who this is for

**A team whose review bot bills more than it explains.** A hosted service charges per seat, per
repository or per review, and what was done for that money is not visible from the outside. Here the
bill arrives from your own provider, per token, for a model you picked, and the run summary shows
the work the verdict came from.

**A team that has to answer for where the code goes.** Your runner, your endpoint, your key: the
only outside party that sees the diff is the provider you picked, and the workflow that sends it is
seventeen lines you can read. When that question comes from a customer or an audit, the answer is
yours to give rather than a vendor's.

**A team whose issues carry acceptance criteria.** If the criteria are written down and there is a
deployed environment to point at, the acceptance test is where this pays off most: the manual
walk-through somebody does before every merge becomes a table on the pull request and a video to
check it against.

**A team who wants to skip human review - YOLO!.** Review takes developer's time. You trust AI outputs 
without any fear. Speed matters more than perfection. What should go wrong?!

## Good to know

### Transcript in the run summary

Every run appends its own transcript to the run summary: one line per tool
call, its input behind a fold, and what the agent wrote. The verdict and the work are different
questions.

### Read-only by construction

The two review agents have no shell, no `webfetch`, no `websearch`
and no sub-agents; they may write only inside a git-ignored run directory. That is not a promise 
made to the model in a prompt, it is a permission profile that ships with this package, so a pull 
request cannot grant its own reviewer a shell even by editing every file it can reach. 
See [`docs/threat-model.md`](docs/threat-model.md).

### Updating, and pinning

`@v1` is a moving tag: a fix here reaches you without you touching a file. If you would rather
decide when that happens, pin the commit instead and let Dependabot propose the bumps:

```yaml
uses: deyai-labs/pr-pitcrew/.github/workflows/bug-review.yml@a1b2c3d4...  # v1.0.0
```

Both are supported. `@v1` is the convenient one, a SHA is the deliberate one.

### Your project's rules are the review's rules

The prompts send the agents to your repository's `AGENTS.md` (or `CLAUDE.md`) and tell them that a
rule written there outranks their general expectations about how such code is usually written.
Nothing has to be written down twice, and nothing drifts: it is the same file your own coding agent
reads. They open it with their own read tool, so the run's transcript shows that they did - the
runtime is deliberately not allowed to fold a file from the branch under review into its system
prompt. See [`docs/threat-model.md`](docs/threat-model.md), "The branch under review configures
nothing".

For what belongs to one agent and is not a project rule, append to its prompt rather than forking
it - see [`docs/adding-an-agent.md`](docs/adding-an-agent.md).

### The acceptance test agent

This one costs more than the other two: a container, a browser, up to half an hour, and real
operations against a real environment. So **it does not start itself**. It starts when somebody
requests a review from the account in `PITCREW_ACCEPTANCE_REVIEWER`, which is the same gesture a
human reviewer gets. Removing that reviewer and adding them back is how you ask for a second run.
`/acceptance` in a comment does the same.

It leaves one comment behind: the criteria from the issue, each marked met or not and stamped with
the moment it happens in the recording, and a link to the video and the screenshots, which are
uploaded with the run. The report is written as the walk-through goes, so a run that stops halfway
still publishes what it proved.

Before a model is called, the job starts a browser and proves it works. A rig that cannot drive
anything fails in seconds, with the reason on the pull request, rather than half an hour later with
nothing to show.

It needs `PITCREW_ACCEPTANCE_TARGET_URL` (the deployed app), and takes credentials for it if it has
a login. Everything it needs is named `PITCREW_ACCEPTANCE_*`, so a repository running only the two
diff reviews can see at a glance that none of it applies. It refuses to run in a public repository
unless you switch that off knowingly: it has a shell, and in a public repository anyone can write
the pull request comments that reach it. See
[`examples/acceptance-test.yml`](examples/acceptance-test.yml) and
[`docs/threat-model.md`](docs/threat-model.md).

## Documentation

| | |
| --- | --- |
| [`docs/how-it-works.md`](docs/how-it-works.md) | How a run is put together, and why each part is the way it is. Most of it is a bug somebody paid for. |
| [`docs/configuration.md`](docs/configuration.md) | Every secret, variable and input. |
| [`docs/threat-model.md`](docs/threat-model.md) | What this defends against, what it does not, and where your data goes. |
| [`docs/costs.md`](docs/costs.md) | What a run costs, and the knobs that make it cost less. |
| [`docs/adding-an-agent.md`](docs/adding-an-agent.md) | A fourth agent, from nothing to its first comment. |
| [`docs/adr/`](docs/adr/) | The decisions behind the shape of this package. |

## Requirements

- GitHub Actions, Linux runners. Node 20.10 or newer, which every current runner image and the
  Playwright container both have.
- An OpenAI-compatible endpoint and a key. Any provider: this package names no vendor, no host and
  no model.

## Where this came from

The three agents grew inside a private application repository, as a replacement for a hosted review
service whose model choice and billing were not visible from the outside. Everything project-specific
was removed for this package; the reasoning was kept, translated and rewritten. That repository is
still a consumer of this one.

This project is not affiliated with, endorsed by or connected to OpenCode, Microsoft (whose
Playwright image the acceptance test runs in), or any model provider. It runs on OpenCode; that is
the whole relationship.

## Licence

MIT. See [`LICENSE`](LICENSE). The Dey AI Solutions name and logo are a trademark and are not
covered by it.

---

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/dey-ai-solutions_dark-bg.svg">
    <img src="docs/assets/dey-ai-solutions_light-bg.svg" alt="Dey AI Solutions" width="170">
  </picture>
</p>

## About Dey AI Solutions

Consulting for applied AI. I help teams find the right use cases and ship autonomous agents that
hold up in production, not just in the demo:

- **Use-case analysis** - what's worth building, and what isn't
- **Autonomous agents** - production-grade, with guardrails & observability
- **Robust engineering** - maintainable systems your team can run without us
- **Agentic coding** - getting your codebase and team ready for coding agents

Got an idea for an agent of your own? &rarr; [deyai.solutions](https://deyai.solutions) &middot;
[hello@deyai.solutions](mailto:hello@deyai.solutions)
