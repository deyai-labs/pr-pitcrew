# Configuration

Every secret, variable and input, what it does, and which agent it applies to. [The
README](../README.md) is where to start if none of this is set up yet; the reasoning behind most of
it lives in [how-it-works.md](how-it-works.md). This page is for looking things up.

Three rules hold throughout:

- **Nothing has a plausible default.** No endpoint, no model, no address of an application under
  test. A run that has not been configured stops with an error naming the variable, rather than
  falling back to something that works and bills.
- **A workflow input beats a repository variable**, and a per-agent variable beats the global one.
- **Variable names are fixed, secret names are yours.** The reusable workflows read variables through
  `vars.PITCREW_*` directly, so those names are part of the interface. Secrets are passed in by the
  caller under the names in your own workflow, so the `PITCREW_*` spellings below are only the
  convention the examples use.

## Repository variables

Settings → Secrets and variables → Actions → Variables.

| Name | Applies to | Required | Default | Effect |
| --- | --- | --- | --- | --- |
| `PITCREW_LLM_API_BASE_URL` | all | yes | none | Base URL of the OpenAI-compatible endpoint, **including the version segment**: `https://api.example.com/v1`. This package names no vendor. |
| `PITCREW_LLM_API_MODEL` | all | yes, unless every agent has its own | none | A model id the endpoint serves, for every agent without one of its own. Passed through as the endpoint spells it, slashes included. |
| `PITCREW_LLM_API_MODEL_BUG_REVIEW` | bug review | no | `PITCREW_LLM_API_MODEL` | Model for that one agent. |
| `PITCREW_LLM_API_MODEL_SECURITY_REVIEW` | security review | no | `PITCREW_LLM_API_MODEL` | Model for that one agent. |
| `PITCREW_LLM_API_MODEL_ACCEPTANCE_TEST` | acceptance test | no | `PITCREW_LLM_API_MODEL` | Model for that one agent. Reading a diff and driving a browser for half an hour are different jobs. |
| `PITCREW_FAIL_ON` | bug and security review | no | `high` | Severity from which findings fail the check: `high`, `medium`, `low`, or `never` to keep the agent advisory. Anything else is refused with a warning and `high` is used. |
| `PITCREW_FAIL_ON_NO_REPORT` | bug and security review | no | `true` | `false` lets a run whose agent produced no usable report stay green. The default fails it, because a diff nobody reviewed is not a diff nobody found anything in. |
| `PITCREW_REQUIRE_FULL_COVERAGE` | bug and security review | no | `true` | `false` lets a run whose agent skipped changed files stay green. The default fails it, because a pass built only on hunks is not evidence that the files were reviewed. The comment names the shortfall either way — `Scope: … · 7 of 29 changed files opened`. Markdown, lockfiles and deletions are not on the list, so a docs-only diff cannot go red for this. |
| `PITCREW_OUTPUT_LANGUAGE` | all | no | `English` | The language the agent writes its own text in - the summary sentence, finding bodies, criteria evidence. The frame around that text is English on every run, which is why English is the default. |
| `PITCREW_APP_ID` | all | no | none | Id of a GitHub App. When set, comments carry that app's name and avatar instead of `github-actions[bot]`. Needs `PITCREW_APP_PRIVATE_KEY` as well. |
| `PITCREW_ACCEPTANCE_TARGET_URL` | acceptance test | yes for that agent | none | The deployed application the agent drives. Without it the run stops with an error rather than pretending to test something. |
| `PITCREW_ACCEPTANCE_TARGET_HEALTH_URL` | acceptance test | no | none | An endpoint whose response names the deployed commit. When set, the run refuses to demonstrate somebody else's deployment. Matched against both the head commit and the test merge commit, because a preview built by a `pull_request` workflow reports the latter. Unset means unverified, not refused. |
| `PITCREW_ACCEPTANCE_REVIEWER` | acceptance test | yes for the review-request trigger | none | GitHub login, or a team name or slug, whose review request starts a run. Without it only `/acceptance` on a comment starts one. Do not put this account in `CODEOWNERS`. |
| `PITCREW_PLAYWRIGHT_MODULE` | acceptance test | no | none | Path to the Playwright package, for an image that puts it somewhere of its own. The preflight uses it and searches nowhere else, so a wrong path fails the run rather than hiding behind a different driver. |
| `PITCREW_ACCEPTANCE_ALLOW_PUBLIC` | acceptance test | no | unset | `true` lets the acceptance test run in a **public** repository. Off by default, and for a reason: see [threat-model.md](threat-model.md). |

## Secrets

Settings → Secrets and variables → Actions → Secrets. The names on the left are what the examples
use; what matters is which workflow input you pass them to.

| Convention | Workflow input | Applies to | Required | Effect |
| --- | --- | --- | --- | --- |
| `PITCREW_LLM_API_KEY` | `api-key` | all | yes | Key for the OpenAI-compatible endpoint. Reaches OpenCode as an environment variable and never passes through a step output. |
| `PITCREW_APP_PRIVATE_KEY` | `app-private-key` | all | no | Private key of the GitHub App in `PITCREW_APP_ID`. |
| `PITCREW_ACCEPTANCE_TARGET_USERNAME` | `target-username` | acceptance test | no | Username or e-mail for the application under test. When empty, the agent demonstrates what is reachable without an account and records the rest as `not-demonstrable`, with the reason. |
| `PITCREW_ACCEPTANCE_TARGET_PASSWORD` | `target-password` | acceptance test | no | Password for the application under test. |

The two target credentials reach the agent as `PITCREW_ACCEPTANCE_TARGET_USERNAME` and
`PITCREW_ACCEPTANCE_TARGET_PASSWORD` in its own environment. They are deliberately not substituted into the
prompt, because a prompt is echoed into the run log. The agent that needs them has a shell and reads
them itself.

### Commenting under your own name

With the runner's built-in `GITHUB_TOKEN`, comments are posted by `github-actions[bot]`, and that
name cannot be changed. To use your own:

1. Create a GitHub App with the permissions **Contents: read**, **Pull requests: write**, **Issues:
   write** and **Metadata: read**. Add **Administration: read** if you use the comment triggers:
   there OpenCode checks whether the commenter may write to the repository, and that check reads
   collaborator permissions. A `pull_request` run does not go through it - see
   [threat-model.md](threat-model.md), "Who may trigger a run".
2. Install it on the repository and generate a private key.
3. Set `PITCREW_APP_ID` and pass the key as `app-private-key`.

The action then mints an installation token and hands it to OpenCode. No third-party service is
involved either way: this is your app talking to your repository.

## The reusable workflows

Three, one per agent. Each is called with `uses:` and takes its inputs and secrets as shown.

```yaml
jobs:
  bug-review:
    uses: deyai-labs/pr-pitcrew/.github/workflows/bug-review.yml@v1
    with:
      fail-on: medium
    secrets:
      api-key: ${{ secrets.PITCREW_LLM_API_KEY }}
```

`@v1` is a tag that moves, so a fix arrives without touching a file. Pin a SHA instead if you would
rather decide when that happens.

### `bug-review.yml` and `security-review.yml`

Identical apart from the agent they run, the check name, and the slash command they listen for.

| Input | Type | Default | Effect |
| --- | --- | --- | --- |
| `model` | string | `PITCREW_LLM_API_MODEL_BUG_REVIEW` / `PITCREW_LLM_API_MODEL_SECURITY_REVIEW`, then `PITCREW_LLM_API_MODEL` | Model id. |
| `api-base-url` | string | `PITCREW_LLM_API_BASE_URL` | OpenAI-compatible endpoint. |
| `fail-on` | string | `PITCREW_FAIL_ON`, then `high` | Severity from which the check fails. |
| `output-language` | string | `PITCREW_OUTPUT_LANGUAGE`, then `English` | Language the agent writes in. |
| `timeout-minutes` | number | `20` | Job timeout. |

| Secret | Required | Effect |
| --- | --- | --- |
| `api-key` | yes | Key for the endpoint. |
| `app-private-key` | no | Private key of your GitHub App. |

Triggers: a `pull_request` event on a non-draft pull request, or an `issue_comment` containing
`/review` (bug) or `/security` (security) written by an `OWNER`, `MEMBER` or `COLLABORATOR` who is
not a bot.

Check name: `Pitcrew / Bug Review`, `Pitcrew / Security Review`. Called, each gains the caller's job
id in front.

Job permissions: `contents: read`, `pull-requests: write`, `issues: write`, `checks: read`. The last
is so the next push can see if this agent's check on the previous commit published a report. Without
it, a cancelled review is skipped. `issues: write` rather than `read` because the runtime marks the
trigger with a reaction, and reactions on a pull request are governed by the issues permission.

### `acceptance-test.yml`

| Input | Type | Default | Effect |
| --- | --- | --- | --- |
| `model` | string | `PITCREW_LLM_API_MODEL_ACCEPTANCE_TEST`, then `PITCREW_LLM_API_MODEL` | Model id. |
| `api-base-url` | string | `PITCREW_LLM_API_BASE_URL` | OpenAI-compatible endpoint. |
| `target-url` | string | `PITCREW_ACCEPTANCE_TARGET_URL` | The deployed application to drive. |
| `target-health-url` | string | `PITCREW_ACCEPTANCE_TARGET_HEALTH_URL` | Endpoint naming the deployed commit. |
| `output-language` | string | `PITCREW_OUTPUT_LANGUAGE`, then `English` | Language the agent writes in. |
| `playwright-image` | string | `mcr.microsoft.com/playwright:v1.62.1-noble` | Container image with browsers, their libraries and the video encoder. |
| `timeout-minutes` | number | `30` | Job timeout. |

| Secret | Required | Effect |
| --- | --- | --- |
| `api-key` | yes | Key for the endpoint. |
| `target-username` | no | Account for the application under test. |
| `target-password` | no | Password for it. |
| `app-private-key` | no | Private key of your GitHub App. |

There is no `fail-on` input. This agent reports criteria rather than findings, so there is no
severity to hold against a threshold, and the workflow sets `fail-on: never` for itself.

Triggers: `review_requested` naming the account or team in `PITCREW_ACCEPTANCE_REVIEWER`; an
`issue_comment` containing `/acceptance` from an `OWNER`, `MEMBER` or `COLLABORATOR`; or, when the
workflow is called from an orchestrator on an ordinary `pull_request` event, that event - provided
the pull request is not a draft and its author's association is `OWNER`, `MEMBER` or `COLLABORATOR`.
That last condition is only on that trigger, because the other two are a gesture by somebody the
repository already trusts; see [threat-model.md](threat-model.md), "What the acceptance agent may
do".

Job permissions: `contents: read`, `pull-requests: write`, `issues: write`, and `actions: read` -
the last so the summary comment can carry a download link to the artifact this run uploads, whose id
only exists after the upload and only through the Actions API.

The job runs in a container, as `--user root`, with `shell: bash` as the default. A container job
otherwise defaults to `sh`, and the first `set -o pipefail` ends a step with "Illegal option".

Uploads the artifact `acceptance-proof`, labelled "Video and screenshots" in the comment.

## `actions/agent`

For a workflow that bypasses the reusable ones and calls the engine directly. It expects a checkout
in the workspace that has kept its credentials and was made with `fetch-depth: 0`.

| Input | Required | Default | Effect |
| --- | --- | --- | --- |
| `agent` | yes | | Id of the agent to run: a directory under `agents/` in this package. |
| `api-key` | yes | | Key for the OpenAI-compatible endpoint. |
| `api-base-url` | yes | | Base URL of that endpoint, including the version segment. |
| `model` | yes | | Model id as the endpoint spells it. |
| `github-token` | yes | | Token used when no GitHub App is configured. Comments then appear as `github-actions[bot]`. |
| `pr-number` | no | the one in the triggering event | Pull request to work on. |
| `app-id` | no | `''` | GitHub App id. When set, an installation token is minted and comments carry that app's name. |
| `app-private-key` | no | `''` | Private key belonging to `app-id`. |
| `fail-on` | no | `''` (means `high`) | Severity from which findings fail the check. |
| `fail-on-no-report` | no | `''` (means `true`) | `false` lets a run without a usable report stay green. |
| `require-full-coverage` | no | `''` (means `true`) | `false` lets a run whose agent skipped changed files stay green. |
| `target-url` | no | `''` | The deployed application an agent with a browser should drive. Required when the agent's manifest lists the `target` input. |
| `target-username` | no | `''` | Account for the application under test. |
| `target-password` | no | `''` | Password for it. |
| `artifact-name` | no | `''` | When set, everything under `$ARTIFACT_DIR` is uploaded under this name and the summary comment carries a download link. |
| `artifact-label` | no | the artifact name | What that download link says. |
| `artifact-retention-days` | no | `30` | How long the artifact is kept. |
| `output-language` | no | `English` | Language the agent writes its own text in. |
| `opencode-version` | no | `1.18.18` | Version of the OpenCode runtime to install. Pinned on purpose; see [threat-model.md](threat-model.md). |

## `actions/check-deployment`

Refuses to demonstrate an environment that is serving somebody else's commit. Used by the acceptance
workflow before the agent starts.

| Input | Required | Default | Effect |
| --- | --- | --- | --- |
| `health-url` | no | `''` | An endpoint whose response contains the deployed commit sha. Empty makes the whole action a no-op that says so in the run summary. |
| `github-token` | yes | | Token used to look the pull request's commits up. |
| `pr-number` | yes | | The pull request whose commits should be on the deployment. |
| `attempts` | no | `3` | How many times to ask before giving up. |
| `interval-seconds` | no | `20` | How long to wait between attempts. |

The commits are looked up rather than read from the event, because an `/acceptance` comment carries
neither: an `issue_comment` knows the issue, not the branch behind it. A short sha match against the
response body is enough. If neither commit can be read, the run continues unverified - failing it
would publish no report and name a cause that never happened.

## What the agent sees

These are set for the agent's process and substituted into its prompt where the prompt names them.
Prompts refer to them by these names; nothing else is filled in.

| | |
| --- | --- |
| `DIFF_FILE` | `.pitcrew-run/pr.diff`, present when the manifest lists the `diff` input |
| `DIFF_SCOPE` | one sentence saying which diff it is: the commits since the last published review, or the whole pull request |
| `CHANGED_FILES` | `.pitcrew-run/changed-files.txt`, the paths from that same diff the agent has to open. Empty when the diff is Markdown, lockfiles or deletions only |
| `ISSUE_FILE` | `.pitcrew-run/issue.md`, present when the manifest lists the `issue` input. Empty when the pull request closes no issue |
| `REPORT_FILE` | `.pitcrew-run/report.json` |
| `WORK_DIR` | `.pitcrew-run/scenario` - scratch space, git-ignored |
| `ARTIFACT_DIR` | `.pitcrew-run/proof` - uploaded with the run |
| `RECORDER` | path to `scripts/recorder.mjs` |
| `RUN_URL` | this workflow run |
| `TARGET_URL` | the deployed application, when the manifest lists the `target` input |
| `OUTPUT_LANGUAGE` | the language for the agent's own text |
| `PITCREW_ACCEPTANCE_TARGET_USERNAME`, `PITCREW_ACCEPTANCE_TARGET_PASSWORD` | credentials for that application, read by the agent itself and never substituted into a prompt |
| `PLAYWRIGHT_MODULE` | where `recorder.mjs` finds Playwright inside the image |

## Variables the scripts read, for running one by hand

Useful when working on the package rather than using it. See [../CONTRIBUTING.md](../CONTRIBUTING.md).

| | |
| --- | --- |
| `DRY_RUN=1` | `publish-report.mjs` prints what it would post and touches no API |
| `SESSION_EXPORT=<file>` | `publish-transcript.mjs`, `ensure-report.mjs` and `ensure-coverage.mjs` read that file instead of calling the OpenCode CLI. In this mode the transcript prints to stdout and never writes to the run summary, even inside a job |
| `TRANSCRIPT_TITLE` | the heading of the transcript section |
| `TRANSCRIPT_REDACT` | extra environment variable names whose values are replaced by `[redacted]`. Names containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` are recognised without this |
| `OPENCODE_BIN` | path to the OpenCode binary, when it is not on the PATH |
| `ENSURE_REPORT_CONTINUE=0` | skips the one extra turn that asks the agent for `write_report` |
| `ENSURE_COVERAGE_CONTINUE=0` | skips the one extra turn that asks the agent to open the files it skipped |
| `REVIEW_TITLE`, `REPORT_KIND` | what `publish-report.mjs` would otherwise get from the agent manifest |

## Running the package's own checks

```
node --test                       # the unit tests, including scripts/package.test.mjs
node scripts/check-syntax.mjs     # every script parses
node scripts/release.mjs --verify # self-references point where they should
```

No install step, because there are no dependencies. A composite action gets no install step either,
so every dependency would have to be vendored or fetched at run time in a job holding the model key.
Node's own test runner and `fetch` are enough.
