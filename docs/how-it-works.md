# How a run works

This is the long document, and it exists so that nobody has to trust the package on its word. Every
rule below is here because something went wrong once, and the story is written next to the rule.

For what the three agents are and how to install them, see [the README](../README.md). For the names
of the variables, see [configuration.md](configuration.md). For a fourth agent, see
[adding-an-agent.md](adding-an-agent.md). For what an agent could do if the text it reads turned
hostile, see [threat-model.md](threat-model.md). For what a run costs, see [costs.md](costs.md).

## What a consumer actually installs

A workflow of about seventeen lines, and nothing else:

```yaml
jobs:
  bug-review:
    uses: RobYed/pr-pitcrew/.github/workflows/bug-review.yml@v1
    secrets:
      api-key: ${{ secrets.PITCREW_LLM_API_KEY }}
```

That calls a reusable workflow in this repository, which decides *when* a run happens and what the
job may touch. The reusable workflow calls one composite action, `actions/agent`, which is the
engine: it does everything from the fork check to the comment on the pull request. The prompts, the
permission profiles, the report tool and the scripts travel with that action, at the ref the
consumer pinned.

Nothing is copied into the consumer's repository. That is not only convenience - see "The
configuration comes from this package" below, which is the property the whole design rests on.

## How a run is put together

The composite action runs these steps, in this order, and the order carries decisions.

**Locate the package.** `github.action_path` is where GitHub put its checkout of this repository, at
the pinned ref. Two levels up from `actions/agent/` is the package root, and that path becomes
`PITCREW_HOME`. Everything below reads manifests, profiles, prompts and scripts from there. Nothing
reads any of them from the workspace.

**Read the agent manifest.** `scripts/read-manifest.mjs` turns `agents/<id>/agent.json` into step
outputs: the title, the report kind, and which inputs this agent wants. An unknown agent or an
unknown profile ends the run here, with a message. It never falls back onto a default, because the
runtime's default is an agent that allows everything.

**Prepare the workspace.** `.pitcrew-run/` is created inside the checkout, with `proof/` for
anything that should be uploaded and `scenario/` for the agent's scratch files.

It has to be *inside* the checkout. A path outside needs OpenCode's `external_directory` permission,
and an unanswered permission prompt in CI does not fail, it waits - two runs of the original bundle
hung fifteen minutes on that line until the job timeout killed them, with
`asking { permission: "external_directory" }` as the last thing in the log and nothing after it.

It also has to be *ignored*, because the OpenCode action commits and pushes whatever
`git status --porcelain` reports, and ignored files are not in that list. The line goes into
`.git/info/exclude` rather than the consumer's `.gitignore`: repo-local, never committed, and one
fewer installation step to forget. A forgotten one used to turn a review into a commit.

Two more things happen here. `git config --global --add safe.directory` is set, because git refuses
to work in a directory owned by another user, which is what a container job looks like from the
inside. And `scripts/write_report.js` is copied to `~/.config/opencode/tools/` - not into the
checkout, because OpenCode fetches the pull request branch *after* this step, so a copy under the
workspace would come from the head branch, and a comment-triggered run would then be reviewing a
stranger with a tool that stranger wrote.

**Refuse forks.** First, before anything reads a diff. The `pull_request` trigger withholds
repository secrets from a fork's pull request by itself, and that is the boundary the design leans
on. The comment triggers punch a hole in it: an `issue_comment` event always runs in the base
repository, on its default branch, with secrets, whatever pull request it names. A maintainer typing
`/review` under a fork's pull request would hand a stranger's diff to an agent holding the model
key. This cannot be a workflow `if:`, because the `issue_comment` payload carries no `head.repo`, so
it is `scripts/assert-same-repo.mjs` and it is the first step that touches the API.

**Fetch what the agent asked for.** An agent whose manifest lists `diff` gets `.pitcrew-run/pr.diff`
from `scripts/fetch-diff.mjs`, and `.pitcrew-run/changed-files.txt` from the same parse: the paths
in that diff the agent has to open. Markdown, lockfiles and deletions are left off; everything else
is on the list. One that lists `issue` gets `.pitcrew-run/issue.md` from
`scripts/fetch-issue.mjs`. One that lists `target` gets the address of the deployed application, and
the run stops with an error if none is configured rather than pretending to test something.

The diff comes from the API rather than from `git diff`, because in a comment-triggered run the
checkout is still the default branch at this point and that diff would come out empty.

The issue is handed over as a file for two reasons. The acceptance agent used to be told to run
`gh issue view`, and `gh` is not in every runner image - it is not in the Playwright one that agent
runs in - so on a bad day the instruction was a no-op and the agent invented criteria from the pull
request title. And an agent that has to fetch things needs the rights to fetch things; one that is
handed a file needs none. Only GitHub's own closing keywords in the pull request body count
(`closes #12`, `fixes`, `resolves`, or the full URL of an issue in this repository). A bare `#12` is
not enough: pull request bodies mention neighbouring issues all the time, and testing against the
wrong criteria is worse than testing against none. Closing no issue is not a failure - the file is
empty and the prompt says what to do then.

**Hand the agent its inputs**, through `GITHUB_ENV` rather than a step's `env:`. They have to
survive one more level of nesting: the OpenCode action is itself a composite action, and the agent's
shell is a process inside it. The two credentials of the environment under test are written with a
heredoc delimiter of their own, so a stray newline in a secret cannot forge a variable assignment.

**Build the configuration and the prompt** with `scripts/build-config.mjs`. See the next two
sections.

**Run the agent**, through one of two doors. See "Two ways into the runtime" below.

**Recover the report**, if the agent did not write one. See "A run that reviewed nothing".

**Open the files the agent skipped**, if the diff named any. See "A review that never opened the files".

**Upload the artifact**, if the workflow named one. Under `always()`: a run that went wrong is
exactly when the video and the logs are worth having.

**Publish the report** with `scripts/publish-report.mjs`, then **publish the transcript** with
`scripts/publish-transcript.mjs`. Both under `!cancelled()` rather than `always()`.

Two properties of the checkout that precedes all this are worth stating, because both look like
mistakes:

- **No `persist-credentials: false`.** On a comment-triggered run OpenCode fetches the pull request
  branch itself and, with `use_github_token`, installs none of its own credentials; in a private
  repository that fetch needs the ones checkout leaves behind. They cannot push, because the job runs
  with `contents: read`.
- **`fetch-depth: 0`.** The agent reads around the diff, and a shallow clone does not have the base
  branch to read.

## Two ways into the runtime

A `pull_request` runs the **OpenCode CLI**. Everything else - in practice the `/review`, `/security`
and `/acceptance` comments - runs the **OpenCode GitHub action**. The event decides, never the actor.

The reason is a failure that had no workaround on the consumer's side.
`opencode github run` refuses to start unless the *triggering actor* has write access to the
repository, and GitHub's collaborator API answers `none` for every GitHub App bot, because a bot is
not a collaborator:

```
Asserting permissions for user cursor[bot]...
  permission: none
User cursor[bot] does not have write permissions
```

A pull request opened or pushed by `cursor[bot]`, `github-actions[bot]` or any other app was
therefore never reviewed: the check went red before the model saw the diff. On the `pull_request`
path that check was not what carried the weight anyway - a fork gets no secrets and is refused by
`assert-same-repo.mjs`, so the head branch lives in this repository and somebody with write access
pushed it. [ADR 9](adr/0009-the-pull-request-path-runs-the-cli.md) is the whole argument, including
what it costs.

On the CLI path the action's four jobs are answered like this:

- **The checkout is what the agent sees.** `actions/checkout` has already put `refs/pull/N/merge` in
  the workspace - the change as it would land on the base branch, rather than the head commit.
- **The prompt is only what this package put in it**: the diff, and for the acceptance test the
  linked issue. The pull request's title, body and comments are not assembled into it; on the comment
  path they still are.
- **`OPENCODE_DISABLE_PROJECT_CONFIG` is set**, on both paths, so the branch under review contributes
  no `opencode.json`, no `AGENTS.md` as system instructions and no `.opencode/tool/*.js`. See
  [threat-model.md](threat-model.md).
- **Sharing is refused in the configuration** (`"share": "disabled"`) rather than through an action
  input the CLI does not have. Sharing would upload the session transcript to opencode.ai, and
  somebody else's diff has no business leaving the runner.

Two smaller differences. The runtime is installed by a step of this action on that path, with the
same installer and the same pinned `VERSION` the wrapper action would use. And the repository token
is not in the environment of the process that reads the diff: the CLI talks to no GitHub API, and
everything on the pull request is published by the steps after it.

The prompt reaches the CLI on **stdin**, not as an argument: `opencode run` re-quotes any argument
that contains a space, so a prompt passed on the command line would arrive at the model wrapped in
quotation marks with its own escaped.

## The configuration comes from this package, never from the repository under review

There is no `opencode.json` in the consumer's repository. `scripts/build-config.mjs` generates the
whole configuration from two files that ship here: `agents/<id>/agent.json` and the permission
profile it names in `profiles/`.

**A pull request has no say at all in the permissions of the agent that reviews it.** In the bundle
this grew out of, the configuration was a file in the reviewed repository, and a pull request that
edited it could grant its own reviewer a shell. It could not quite, because the action read the file
early, from the branch the run started on, and passed it inline - but the defence was a matter of
timing, and timing is the kind of thing that gets refactored away by somebody who does not know it
was load-bearing. Now the reviewed repository has no vote.

What is generated looks like this:

```json
{
  "provider": {
    "llm": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "{env:PITCREW_LLM_API_BASE_URL}", "apiKey": "{env:PITCREW_LLM_API_KEY}" },
      "models": { "<the model>": { "name": "<the model>" } }
    }
  },
  "share": "disabled",
  "default_agent": "<the agent>",
  "model": "llm/<the model>",
  "agent": { "<the agent>": { "mode": "primary", "temperature": 0.1, "permission": { … } } }
}
```

`{env:...}` is OpenCode's own substitution, so the endpoint and the key reach it as environment
variables and the key never passes through a step output on its way in. `models` holds exactly the
one model that was configured: which models an endpoint serves is the endpoint's business, not a
second list for somebody here to keep current.

**No model is preselected, and that is the point.** A package that quietly picked one would bill
somebody for a decision they never made, and the run log would be the only place that decision was
ever visible. With no model configured the run stops and says which variable to set. The same goes
for the endpoint.

Model ids are passed through as the endpoint spells them, slashes included, so
`deepseek-ai/DeepSeek-V3` works. Only a leading `llm/` is stripped, because OpenCode splits a model
string on its *first* slash and that prefix is the provider id this file invented.

**Nothing falls back quietly.** An unknown agent, an unknown profile, a missing prompt, an unknown
report kind, no model, no endpoint: each ends the run with a message naming the fix.

## Choosing the agent, and why `default_agent` is load-bearing

The OpenCode action has an `agent` input. It looks like the way to pick an agent, and in the pinned
version it is not. `github.handler.ts` omits the agent when it prompts the session, with the comment
*"agent is omitted - server will use default_agent from config or fall back to `build`"*. Passing the
input alone gets you `build`, whose defaults allow everything.

For months every run of the original bundle was that `build` agent, while a carefully written
permission block sat in the repository doing nothing. It surfaced only because an acceptance run
executed `pnpm lint` - something the configured permissions forbade - and the dirty working tree
that produced made the action commit. Without that side effect the gap would have stayed invisible.

So the agent is selected by `OPENCODE_CONFIG_CONTENT`, which the composite action sets to the
generated configuration with `default_agent` in it. Configurations are merged rather than replaced,
and this inline one outranks anything the runtime would otherwise read from the checked-out branch.
The `agent` input is still passed, for the day it starts working again.

On the `pull_request` path there is a second belt: the CLI honours `--agent`, and the action names
the agent there explicitly. `default_agent` stays in the configuration, so if the runtime ever
declined the flag the fallback would be the same agent rather than `build`.

The lesson is more general than the bug: **a permission that never applies looks exactly like one
that does.** If a run behaves as though no permission applied, check the job log - it prints
`agent: "..."` on every `stream` line.

## The prompt's placeholders are filled in before the agent sees them

A prompt refers to its inputs by name - `$DIFF_FILE`, `$DIFF_SCOPE`, `$CHANGED_FILES`, `$REPORT_FILE` - and
`build-config.mjs` replaces those names with their values before the text is handed over.

It has to. **An agent without a shell cannot resolve an environment variable**, and both review
agents are exactly that. Until this was fixed, `$DIFF_FILE` reached them as those eleven characters
and every review rested on the model guessing the path. One run gave up after twelve seconds: the
agent read the project's rule file, ran `glob **/DIFF_FILE*`, found nothing and replied that it
could not start - with the diff sitting next to it the whole time.

The names that get filled in are:

| | |
| --- | --- |
| `DIFF_FILE` | the diff to review |
| `DIFF_SCOPE` | one sentence saying which diff it is: since the last published review, or the whole pull request |
| `CHANGED_FILES` | the paths from that diff the agent has to open |
| `ISSUE_FILE` | the issue the pull request closes |
| `REPORT_FILE` | where the report goes |
| `RUN_URL` | this workflow run |
| `WORK_DIR` | scratch space inside the checkout, git-ignored |
| `ARTIFACT_DIR` | anything written here is uploaded |
| `RECORDER` | path to the recording helper |
| `TARGET_URL` | the deployed application under test |
| `OUTPUT_LANGUAGE` | the language the agent writes its own text in |

Both `$NAME` and `${NAME}`, on a word boundary, so a `$DIFF_FILEX` stays what it is.

**An allowlist, not the whole environment.** That process holds the model key and, in the acceptance
job, the credentials of the environment under test; a prompt is echoed into the run log, and a
credential has no business in one. The agent that needs those has a shell and reads them from its
own environment, which is why the acceptance prompt names `PITCREW_ACCEPTANCE_TARGET_USERNAME` and
`PITCREW_ACCEPTANCE_TARGET_PASSWORD` without a `$`.

A name that has no value stays written as it is. A literal `$WORK_DIR` in a prompt is a puzzle
somebody can solve; an empty string is a path that looks real and is not.

`scripts/package.test.mjs` fails if a prompt names anything outside that list, so the puzzle never
ships.

## Reviewing the same pull request twice

The most expensive property of an automated review is not a wrong finding, it is a repeated one. An
agent handed the whole pull request on every push re-judges what was discussed last round and
consciously left alone, worded slightly differently each time, so it reads as a new point every
time. The result is a loop of review and rework that does not converge, and at the end a tool
somebody mutes.

Two defences, one before the model and one after it.

**Before the model:** `scripts/fetch-diff.mjs` hands over the diff of the commits since the last
*published* review of this agent when a push triggers the run, not the whole pull request, and the
list of files to open is taken from that same text. `github.event.before` is the last push, not the
last complete review. A new push cancels the run that is not complete (`cancel-in-progress: true`).
The new run looks up this agent's check on `before`. If that check published a report, the range is
`before...after`. If it did not — cancelled, timed out, missing, or a failure with no report — the
script walks to the newest parent that did publish, and compares that commit to `after`. If there is
no such commit, or the lookup fails, the whole pull request is the subject. The checkout still holds
everything, so context is not lost - only the subject narrows. The whole diff also comes back when
the incremental one cannot be trusted for the older reasons: a force-push leaves `before`
unreachable, a merge of the base branch changes nothing under review, and a comment trigger has no
`before` at all, which is what makes `/review` the way to ask for a full re-read. A diff over a
megabyte is cut, with a line saying so, because a diff that does not fit the context window is worse
than a shortened one that admits it.

**After the model:** `scripts/publish-report.mjs` drops a finding when one of its own earlier
comments already made the same point in the same place. Three conditions have to hold together:

1. **The same file.**
2. **Within two lines.** The window is small because GitHub does the hard part: it tracks a comment's
   position across pushes, so the line reported is where the comment sits *now*. The two lines of
   slack cover one that has just gone stale.
3. **The same point.** Titles are compared after being lowercased and stripped to letters, digits
   and single spaces. Equality counts, and so does containment - "Null check missing" against "Null
   check missing in the loader" - but containment only from twelve characters up. A two-character
   title is a substring of almost every sentence, and without that floor one comment could silence
   everything.

All three, deliberately: a second, unrelated defect right next to an old comment is rare but real,
and suppressing it would be invisible. A duplicate is noise a reader can see and dismiss; a
swallowed finding is not. In doubt it posts. Whatever it held back is named in the job log and
nowhere else - suppressing a repetition is only an improvement as long as it does not produce a
comment of its own.

**What counts as its own comment** is two things at once: the marker `<!-- pitcrew:finding -->` in
the body, *and* an author GitHub reports as a Bot. Both are needed. The marker is an HTML comment,
so anybody who can review the pull request could paste it into a comment of their own, pick a
matching title, and switch a finding off without leaving a trace. A person cannot post as a Bot, so
the pair closes that. A human's objection is theirs to repeat or drop, and a second bot's is the
second opinion one runs a second tool for; neither carries this marker.

Neither defence is retroactive. Comments written before a repository installed this carry no marker,
and the first run after that may repeat itself once. The pre-1.0 markers `opencode-review-finding`
and `opencode-review-summary` are still recognised and never written, so a repository that upgrades
in the middle of a pull request does not repost every standing finding.

## The report, and the `write_report` tool

An agent submits its report by calling `write_report`. The tool's arguments *are* the report; it
writes `$REPORT_FILE` (`.pitcrew-run/report.json`) itself.

```json
{
  "verdict": "pass | attention | fail",
  "summary": "one or two sentences",
  "findings": [{ "file": "src/x.ts", "line": 42, "severity": "high", "title": "…", "body": "…" }],
  "criteria": [{ "title": "…", "status": "met | unmet | not-demonstrable", "at": "01:24", "evidence": "…" }]
}
```

`findings` become one review with inline comments at the code. A finding whose line is not part of
the diff cannot be anchored - GitHub answers 422 - so it moves into the review body instead of being
dropped. A finding that disappears because of an API rule is worse than an ugly one. `criteria`
become a table, in the summary comment and, in full, in the run summary.

**Which of the two an agent may write is decided by its manifest, not by what it produced.** An
agent whose `report` is `criteria` cannot publish findings, and one whose `report` is `findings`
cannot publish criteria; `scripts/report.mjs` drops the wrong kind and says so in the log. The
acceptance agent drives a running application through its interface and never sees the source, so a
file and a line from it would be a guess wearing the clothes of evidence, and a reader cannot tell
those two apart. The prompt says as much; this is what makes it true whatever the model does.

The generic file-writing tools still work. The dedicated tool is what the prompts name, and what the
retry asks for.

### A run that reviewed nothing is not a run that found nothing

The agent skipping its own report is the common case, not the corner case. Over four consecutive
runs of one pull request the security agent wrote none three times, with the same prompt structure
the bug agent obeys. Rewording the instruction changed one of those runs and not the next. Wording
is not the lever.

What it costs is more than a missing summary: without the file there are no inline comments either,
so everything such a run *did* find is gone. Three answers, and all three were needed:

1. **A tool whose arguments are the report.** OpenCode's session layer can require *a* tool call
   (`toolChoice: "required"`) but not a *named* one, and that switch is exposed neither on the
   agent, nor on the GitHub action, nor on the plugin `chat.params` hook. There is nothing to set
   that would force this call. What can be done is to give the agent one obvious place to put the
   result and tell it to use that. Its permission is `allow` everywhere: an unanswered `ask` in CI
   waits until the job dies, which is exactly how a missing report used to look from outside.
2. **The session is read before anybody asks again.** `scripts/ensure-report.mjs` looks through the
   finished session for a `write_report` call, a write of the report file, or a JSON object in the
   agent's *last* reply, and writes the file from that. No model call. JSON that already appears in
   the prompt, the diff, or a tool output is ignored: that is quoted input, not a submitted report,
   and taking it would let a `pass` in a fixture inside the reviewed diff mint a green gate. Earlier
   assistant messages are ignored too, and so are user messages - the prompt contains a worked
   example, and publishing that as the review would be a special kind of embarrassing. Which session
   that is comes from `session list`, so it is the newest on the *machine* rather than this job's -
   exact on a fresh runner, a caveat on a reused one
   ([`docs/threat-model.md`](threat-model.md), "Runs are assumed not to share a runner").
3. **Still nothing? The same session gets one more turn**, asked to call `write_report` - not to
   write a file, which is the instruction it has already ignored. `opencode run --continue`, so the
   agent still has the diff and its findings in context. It is not a second review, it cannot fail
   the job, and the transcript stays one session. Afterwards the session is read again, in case the
   tool was called but the file still went missing.

   **This turn requires a session, and the requirement is checked rather than assumed.** `--continue`
   with nothing to continue does not fail: it opens a *new* session whose only instruction is to call
   `write_report`, and a model answering that with no diff in front of it writes a confident empty
   pass. The id from `session list` is the evidence that a session exists; without it this step is
   skipped and the run is published as one that reviewed nothing. An unreadable session still counts
   as one - an export that failed says nothing about whether the review happened, and that turn is
   what the whole step is for.

**Still nothing after that? The run fails, and says which kind of failure it is.** The comment is
headed `— no report` rather than a verdict, the gate line says the diff was not reviewed, and the
exit code is a different one. An infrastructure failure does not look like a passed gate, and a
passed gate does not look like a failure.

Deliberately **not** done: writing an empty report file up front. It would turn every failed run
into a clean pass, which is the one confusion this entire section exists to prevent. The recovery
turn above once did the same thing by a longer route, which is why it now checks for a session first.

### A review that never opened the files is not a review of the files

A hunk carries three lines of context. Every question the security prompt asks — is the tenant
condition still on that query, does this route still authenticate, where does this value come from —
is a question about the file, not about the hunk. Asking the model to be curious is not a floor:
one run read the whole diff, opened seven of twenty-nine changed files, claimed it had confirmed
things it never grepped for, and published `verdict: pass`.

Two halves, and either one alone leaves the hole open.

**Before the model:** `fetch-diff.mjs` writes the paths from that same diff to
`.pitcrew-run/changed-files.txt` and the prompt names `$CHANGED_FILES`. The list is decided by
exemption, not by an allow-list of "source" extensions — an allow-list silently drops the first file
in a language nobody thought of. Exempt: `.md`, `.mdx`, `.txt`, lockfiles, and files the diff
deletes. On an incremental push the list is the files in *that* diff, so the coverage claim matches
the scope claim next to it.

**After the model:** `ensure-coverage.mjs` walks the session the same way the transcript does, and
compares the paths a `read` actually opened against that list. A relative path, an absolute path and
a read through a symlink count as the same file. A shortfall gets one extra turn on the same session
— open the missing files, write the report again — and the second report is the one that gets
published. The number goes on the comment either way: `Scope: the whole pull request · 7 of 29
changed files opened`. That number used to exist only in the raw job log, which is why a shallow run
and a thorough one looked identical on the pull request.

An unreadable export is a `::warning::` and no number, never a silent `N of N`. Inventing full
coverage from a transcript we could not read would put the hole back.

`PITCREW_REQUIRE_FULL_COVERAGE=false` is what keeps a shortfall that survives the extra turn green.
Default is on: a pass built only on hunks is not evidence that the files were reviewed. The comment
still names the unread files either way. Publishing still comes first.

## The summary comment and its fixed frame

Every run leaves one comment on the pull request, and the script writes its frame:

```
### Bug review — ❌ needs changes

The report goes up before the exit code, so a red check never hides it.

**2 findings** — 🔴 1 high, ⚪ 1 low

**Quality gate: ❌ failed** — 1 finding in this run at or above `high`.

Scope: the 4353741..7e30841 push · 7 of 29 changed files opened · [Workflow run](…)
```

Heading, verdict, counts, gate line and links come from the report's structured fields, so the shape
is the same on every run and somebody scrolling a long pull request can place a comment without
reading it. A model asked for "three to six lines" produces six different shapes over six runs, and
then every one of them has to be read to find out what it is.

What stays the agent's is the part only it can write: the one sentence somebody needs if they read
nothing else. It is rendered as ordinary Markdown, not as a blockquote. A quote says "somebody else
said this, elsewhere" and gets skipped, and this is the one paragraph most people will read; a quote
also flattens whatever structure the agent gave it.

A run that reports criteria gets two things more: the criteria table, and a download link to the
artifact this run uploaded. Both used to live only in the run summary, one click away behind a green
check nobody opens, so the pull request showed a verdict and a sentence while *which* criterion
failed was somewhere else. If a model writes evidence long enough for the comment to burst GitHub's
size limit, the table is what gives way - it is complete in the run summary either way - and the
comment says so.

The link needs two things from the workflow: the permission `actions: read`, because an artifact id
only exists after the upload and only through the Actions API, and an artifact name to look for. A
workflow that uploads nothing simply gets no link, and every failure in looking it up is a warning:
a comment without the link is worth far more than no comment.

### Finding the comment to rewrite

OpenCode posts the agent's reply itself, before this script runs, and offers no switch to turn that
off. The choice is therefore between two comments per review and rewriting the one that exists. It
is found by the run link it carries *and* by a marker naming the review
(`<!-- pitcrew:summary:bug-review -->`, the slug derived from the agent's title). If nothing is
found, a comment of its own is posted: a duplicate beats a silent run.

**The run id alone is not enough once two reviews share it.** An orchestrator can call the bug review
and the security review as jobs of one run, and OpenCode puts that run's link on every reply.
Enforcing "exactly one comment per run" then rewrote the faster job's report with the slower one's
and deleted the rest: on one pull request a security report appeared and was gone seconds later,
replaced by two identical bug reports. So only a comment already bearing *this review's* marker is
deleted, and a sibling's raw reply is left alone - it may still say `[Working...]`, and OpenCode will
overwrite it at the end of its own step whatever anybody else wrote there.

**A re-run makes the search ambiguous, and getting it wrong is visible.** Re-running a workflow keeps
the run id, so the frame the first attempt wrote and the reply OpenCode posts on the second both
carry the same link. Rewriting the first match updated the stale frame and left the raw reply
standing, which on the pull request reads as a second report of the same run, in exactly the
free-form shape the frame exists to replace. So the fresh reply is what gets rewritten, but only
when it is the *only* unframed comment of this run - two jobs finishing together would otherwise
both claim the newest and the loser would vanish - and this review's older frame is then deleted.

Two conditions decide what may be touched at all: it belongs to this review, and its author is one
GitHub reports as a Bot. Somebody asking a question *about* the run quotes the same link, and their
comment is not the script's to edit or remove.

**A cancelled run gets nothing.** The publish step runs under `!cancelled()`, because a push that
supersedes a review is not a failed review, and an empty frame for it would be noise on exactly the
pull request this is meant to keep readable. A genuine failure still publishes.

**A run whose agent skipped the report gets the frame too**, headed `— no report`, with the agent's
own words kept inside it and cut at four thousand characters if it wrote an essay - visibly cut,
with a pointer to the job log, because on that path its words are the only content there is. This
case is the reason the frame exists: without it, the pull request shows free-form prose that reads
at a glance exactly like a run that went fine.

## Severity at a glance

A severity is a word, and a word among words is read at the same speed as all the others. Six
symbols carry it instead, each used in one meaning only:

| | |
| --- | --- |
| 🔴 🟠 ⚪ | how severe a finding is - high, medium, low |
| ✅ | fine: no objections, a criterion met |
| ⚠️ | worth a look: that verdict, and a criteria count that is not all green |
| ❌ | wrong: needs changes, a criterion not met |
| ➖ | not demonstrable, and a gate that was not evaluated |

They appear in the summary comment's heading and count line, in front of each inline finding, and in
both tables of the run summary. **The word always stays next to the symbol.** A colour alone tells a
screen reader nothing, and nobody should have to learn a legend to read a review.

A severity the report spells in some other way gets **no** symbol rather than a plausible one.
Marking an unexpected value `medium` would be the script inventing a fact the agent never stated.

Deliberately no [GitHub alerts](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#alerts):
an alert must be a top-level blockquote, so it renders neither in a table cell nor in the list of
findings that could not be anchored, and a full-width coloured panel per finding is the opposite of
being able to skim.

Changing the symbols means changing one more place in `publish-report.mjs`: the repeat filter reads
the title of an earlier finding back out of the rendered comment, and expects a symbol and a space
in front of the bold title. Put something else there and the filter silently stops matching - and a
defence that does not apply looks exactly like one that does.

## The transcript of a run

`scripts/publish-transcript.mjs` appends a second section to the run summary, under the report: one
line per tool call with a symbol for the kind of tool, its input behind a `<details>` fold, and the
agent's own text as Markdown. Above them one line of facts - agent, model, number of calls, wall
time, tokens, and cost when the endpoint publishes prices.

The outcome of a review and its *work* are different questions. The comment answers the first. The
second was only answerable by scrolling the raw job log, where OpenCode prints one line per
completed tool call - name plus input as a single line of JSON, no timing, nothing foldable.

It reads the session back out of OpenCode after the run, with two read-only calls:

```
opencode session list --format json -n 5   # the session id
opencode export <id> > file                # messages and parts as JSON
```

**The redirection is not cosmetic.** The CLI ends every command with `process.exit()` in a `finally`,
and a write to a *pipe* is asynchronous: a multi-megabyte export - which any session with a few file
reads in it is - gets cut off mid-document, and what arrives is JSON ending in the middle of a
string. The first run of this script hit exactly that: the short session of the security review came
through, the nine-minute bug review did not. A write to a regular file is synchronous and arrives
whole. When a parse fails anyway, the warning carries the length and both ends of what it got - "not
JSON" alone leaves the next reader guessing between noisy, empty and truncated.

The session id is not handed over, because OpenCode prints it into its own step's log and nowhere a
later step can read, so the newest root session of the project is taken. On a fresh container per job
that is this run's. `export` redacts nothing unless asked (`--sanitize` is opt-in), which is what
makes a readable transcript possible at all.

Left out on purpose: tool **outputs** - the bulk of a session and the least of what somebody
following along needs - reasoning, and the bookkeeping parts that describe the machinery rather than
the work. Inputs, texts and prompts are clipped, and a transcript too long for the 1 MiB a step
summary holds says how many steps it did not show.

**It is not offered as an artifact and never posted on the pull request.** This is a log: worth
having when a verdict surprises somebody, a wall in a comment thread. The summary comment links the
run, so it is one click away.

Two properties matter when changing it:

- **Nothing in it may fail a run.** Every problem is a `::warning::` and an exit code of 0. A missing
  transcript costs a convenience; a red check over a missing convenience costs the trust in the
  check.
- **A step summary is not masked the way the log is.** GitHub masks registered secrets in log output,
  not in the Markdown page a step writes - and a tool input is the agent's own text, which may quote
  a credential it was given. So every value this step can see under a name that sounds like a secret
  (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`) is replaced by `[redacted]`, and
  `TRANSCRIPT_REDACT` adds names that do not sound like one. That is how the acceptance run covers
  `PITCREW_ACCEPTANCE_TARGET_USERNAME`: a test account's address is not a password and is a secret all the same.

To look at one without a runner: `SESSION_EXPORT=session.json TRANSCRIPT_TITLE='Bug review' node
scripts/publish-transcript.mjs` prints to stdout what it would append. **That mode never writes to
the run summary**, not even inside a job where `GITHUB_STEP_SUMMARY` is set, and that is a fix rather
than a nicety: an acceptance agent once tried the script inside its own job, with a made-up export,
to prove that it renders what it claims - and `GITHUB_STEP_SUMMARY` pointed at *its* step, which runs
before the report. The run's page then read: a transcript of three invented tool calls, the report,
the real transcript. The summary belongs above the history; a rehearsal belongs in the log.

## The quality gate

A review that only comments is a review that can be merged past. Until this existed, a `high`
finding and "nothing found" produced the same green check, and the difference between them was how
carefully somebody read the comments on a long pull request. That is not a safeguard, it is a hope.

So a run ends red when what it found reaches a severity the repository chose:

| `PITCREW_FAIL_ON` | A run fails on |
| --- | --- |
| `high` | **the default** - a finding the agent marked `high` |
| `medium` | `high` or `medium` |
| `low` | any finding at all |
| `never` | nothing; the agent is advisory again |

Unset means `high`, because that is the severity the prompts reserve for a defect the agent can
demonstrate rather than argue about. A model allowed to turn a check red over every matter of taste
is a model somebody switches off after the third false alarm, and then nothing reviews anything.

A value that is none of these is refused, loudly, and `high` is used instead. A typo in a repository
variable must not be the quietest way there is to switch the gate off. A finding whose severity the
report spells in some other way counts as `medium`, which is also the severity it is rendered with,
so the gate and the comment never disagree about what a finding is.

**Publishing comes first, the exit code last.** The summary comment, the inline comments and the run
summary are all written before the process ends, so a red check never costs the report it is about.
And the reason sits where the check is, as a line in the comment and in the run summary, not only in
a log that gets opened by whoever already suspects it.

### A finding stays red until somebody deals with it

A review reads the *new* commits, not the whole pull request. Without a second rule, the next push -
one that does not touch the flagged line at all - would report nothing and turn the check green, and
green reads as "fixed".

So the gate also counts this package's **own review threads that are neither resolved nor
outdated**, whatever this particular run found. There are exactly two ways out, and both are
somebody deciding:

- **Change the line.** GitHub marks the thread outdated by itself, and it stops counting.
- **Resolve the thread.** A person saying they have looked and decided otherwise. Visible on the
  pull request, and not something that happens by accident.

The comment names them rather than counting them, with links, because "1 finding is still open" is a
sentence whose answer is three clicks up the pull request.

The threads are read over GraphQL, because whether a thread is resolved is a property of the thread
and the REST review-comment API does not carry it. The same two conditions as everywhere else decide
what counts as this package's own: the marker in the body *and* an author GitHub reports as a Bot.
They are read before anything is posted, so this run's own comments are history rather than part of
it. If the query fails, the run says so as a warning and is judged on its own findings - a missing
history costs strictness, refusing to publish would cost the report.

### The exit codes

| | |
| --- | --- |
| 0 | the gate holds |
| 1 | findings at or above the threshold, or a coverage shortfall (unless `PITCREW_REQUIRE_FULL_COVERAGE=false`) |
| 2 | no usable report: nothing was reviewed |
| 3 | there was a report and it could not be published |

The acceptance test sets `fail-on: never` in its own workflow, and not for want of a gate: it
reports criteria rather than findings, so there is no severity to hold against a threshold. Whether
an unmet criterion should be a red check is a different question, and not one this package answers
quietly on anybody's behalf. The verdict and the table are on the pull request; a person reads them.

`PITCREW_FAIL_ON_NO_REPORT=false` keeps a run whose agent produced nothing green, for a repository
that would rather have the check than the review.

`PITCREW_REQUIRE_FULL_COVERAGE=false` keeps a run whose agent skipped changed files green, for a
repository that would rather have the check than the floor. The number is on the comment either way.

## Starting the acceptance test

The acceptance test does not run on every push. A walk-through against a change that is still being
built costs real quota in a real environment, and a push is not a signal that anything is ready to
be shown.

The signal is the same one a human reviewer gets: somebody requests a review from the account in
`PITCREW_ACCEPTANCE_REVIEWER`. That fires `review_requested`, which is still a `pull_request` event.

**Why not `workflow_run`.** The obvious trigger for "run once everything else is green" is
`workflow_run`, and the OpenCode action refuses it: it knows `issue_comment`,
`pull_request_review_comment`, `issues`, `pull_request`, `schedule` and `workflow_dispatch`, and
ends anything else with `Unsupported event type`.

**Why not a job that waits.** The first answer to that was a job polling the commit's checks. It
worked and it was expensive: a runner stayed occupied for the whole wait. It was replaced by `needs:`
in an orchestrator, which waits in the queue where waiting costs nothing - and then the acceptance
test moved out of the orchestrator altogether, because `needs:` would start it as soon as the other
jobs went green, which is on every push. That is the one thing this trigger exists to prevent.

**Why not `CODEOWNERS`.** GitHub would request the account on every pull request, and the
walk-through would run by itself again.

What goes under *Reviewers* is an ordinary GitHub account - a machine account is enough - or a team,
with read access to the repository. Write access is not needed. A GitHub App bot (`slug[bot]`)
generally does not appear in that list at all; Copilot is a special case, not a pattern to copy.

Requesting the same reviewer again is the request for a second round. GitHub will not request
somebody who is already pending, so that means removing them and adding them back, or using
re-request once they have submitted a review. A push in between starts nothing and cancels nothing.
A draft blocks neither this nor `/acceptance`: both are an explicit ask. The two diff reviews still
skip drafts.

If the deployment is not serving this commit yet, `actions/check-deployment` fails the run before the
agent starts, and says so on the pull request: the failure becomes a report with no criteria, and it
goes through the frame every other run uses. Request the reviewer again once it is up. A runner that waited half an hour for the
other checks would be the polling job this package already removed.

## Why the concurrency group carries a comment id

`concurrency` is evaluated when a run is queued - **before** the job's `if:` may skip it. All three
workflows also listen for `issue_comment`, so with a group keyed only on the pull request number,
every comment on that pull request queued a run in the group, cancelled whatever review was in
flight, and then skipped its own job. What was left was a cancelled check and nothing else: no
error, no report, no clue. It was noticed because three runs died 35 seconds after starting, each
time to the second on somebody posting a comment.

So `github.event.comment.id` is in the key, and every comment gets a group of its own. On a
`pull_request` event that field is empty and the two diff reviews fall back to one group per pull
request, so a new push still supersedes the review running for the previous one.

The acceptance test has no push trigger, and its fallback is the requested login or team slug.
Requesting a *different* reviewer is a `review_requested` the job skips, and without that login in
the key it would still cancel the walk-through. Requesting *this* reviewer again shares the group,
so a remove-and-re-add replaces the run still in flight.

The reusable workflow declares this group for its own jobs, and the example caller declares the same
shape for the caller's run. Both are needed: a group only covers the run it is declared in.

## Sharing a run with your own CI

Out of the box each example listens for `pull_request` itself, and each is a separate check with a
separate run. To put the reviews in one run with your own build, add an orchestrator that calls
everything:

```yaml
name: Pull Request

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

# A called workflow can only narrow the caller's permissions, never widen them,
# so this has to be at least the union of what the called ones declare.
permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: read

jobs:
  ci:
    uses: ./.github/workflows/ci.yml            # yours
  bug:
    uses: RobYed/pr-pitcrew/.github/workflows/bug-review.yml@v1
    secrets:
      api-key: ${{ secrets.PITCREW_LLM_API_KEY }}
  security:
    uses: RobYed/pr-pitcrew/.github/workflows/security-review.yml@v1
    secrets:
      api-key: ${{ secrets.PITCREW_LLM_API_KEY }}
```

Your own workflows then hold `workflow_call:` instead of `pull_request:`, because the orchestrator
holds the trigger now and leaving both would run everything twice. Delete the small caller workflows
you copied from `examples/`, for the same reason.

**Do not hang the acceptance test behind `needs:` in that orchestrator** if you also use
`PITCREW_ACCEPTANCE_REVIEWER`. As long as the request is pending, every later push still lists that
reviewer, and every push would start the walk-through. The acceptance workflow keeps its
`workflow_call` trigger for a repository that wants that chaining and does not use a reviewer
account: called on a `pull_request` event that is not a review request, it runs like the other two.

Two things about called workflows that are easy to be surprised by:

- **The `github` context is the caller's.** `github.event_name` stays `pull_request`, which is the
  only reason the OpenCode action accepts the run at all. The same property makes `github.run_id` the
  caller's: two review jobs, one link, which is why the summary comment cannot be keyed on the run id
  alone.
- **Check names gain a prefix, one per level of nesting.** A job of a called workflow is reported as
  `<caller job id> / <job name>`, so `Pitcrew / Bug Review` appears as `bug-review / Pitcrew / Bug
  Review` with the example caller, and as `bug / Pitcrew / Bug Review` under the orchestrator above.
  If branch protection requires status checks by name, those are the names.

## The recording

The acceptance job runs in the official Playwright image, so browsers, their system libraries and the
video encoder are already there. Installing Playwright per run would download the same few hundred
megabytes every time and can break on an apt mirror having a bad day. Two consequences: the image
needs `unzip` added for the OpenCode installer, and a container job defaults to `sh` rather than the
runner's bash, so the workflow sets `shell: bash` or the first `set -o pipefail` ends a step with
"Illegal option".

**The browser is proven before the model is called.** The image brings the browsers; the recorder
needs the driver, the `playwright-core` package that speaks to them. Those are two different things,
and one run had the first without the second. Nothing checked, so the agent met the gap itself: half
an hour of a job that held the model key went into fetching a package and looking for a way around
its own permissions, and no verdict was written. `actions/check-browser` now resolves the driver -
`PITCREW_PLAYWRIGHT_MODULE` first, then the known locations, `npm root -g` and a depth-limited
search of named roots, never the workspace - and starts Chromium with it. A `stat` would not do: a package that resolves but cannot
start the browser fails at the same point in the run as no package at all. The proven path is
exported, so the recorder loads what the preflight loaded. A failure ends the job in seconds, with
one sentence in the log and on the pull request.

**What it proves, the workflow provides.** The preflight was written believing the image had a
driver. It does not, and never did: the official `mcr.microsoft.com/playwright` images ship the
browsers and delete the driver in their last layer. Until 1.2.0 the agent had been quietly filling
that gap itself, so removing that behaviour removed the only supply. The step before the preflight
therefore installs `playwright-core` at the version in the image tag - an exact release or the job
fails, so driver and baked browsers cannot drift - and it runs before any step that carries a
secret. **The preflight itself still installs nothing**, and neither does the agent: a driver
fetched by either would be a reaction to what it found, in a job that holds the model key and the
credentials of the environment under test. What that fetch costs is in
[`docs/threat-model.md`](threat-model.md); an image that carries its own driver skips it through
`PITCREW_PLAYWRIGHT_MODULE`.

**The agent knows when it has to stop.** `DEADLINE` is the job's timeout minus five minutes, and the
prompt says to file the report and reply when it comes. The OpenCode call is wrapped in `timeout` at
the same budget, because a step of a composite action cannot carry a `timeout-minutes` of its own -
so a run that overruns still leaves its artifact, its report and its comment behind.

**The report is a running record, not a last act.** The agent calls `write_report` as soon as the
first criterion is settled and again whenever something changes; the last call is the one that gets
published. Before that, a run that died in the middle published nothing at all, and a walk-through
that proved two criteria was indistinguishable on the pull request from one that proved none.

`scripts/recorder.mjs` opens a recording browser context and captures console output and failed
requests. It knows nothing about any particular application - no sign-in, no seeding, no fixtures,
no request mocking - because all of that would be knowledge about one project. Every click, selector
and assertion is written by the agent, for the criteria of that one issue. What the recorder does
take care of is the part that is easy to get wrong and ruins the proof: a video that never gets
flushed because the context stayed open, a failed request nobody noticed because only the screen was
watched, and a recording nobody can navigate because nothing marks where each criterion begins.
`run.mark(label)` stamps a position and returns `mm:ss`, which is what a criterion's `at` field
carries.

Two of its helpers are about finding a control rather than recording one, and they are here for the
same reason: how to find a button is browser knowledge, and this is where the browser knowledge
lives. `run.outline()` returns the page's roles and accessible names, so the agent takes its
selectors from the page instead of guessing them. `run.pick(locator)` waits for the one element a
locator names; when several match it reads their names and puts them in the error. It never takes
the first match - demonstrating the wrong switch is worse than a criterion nobody could
demonstrate. The prompt asks for accessible names rather than bare tags or indexes, and puts each
criterion in its own `try` / `catch`, so one ambiguous locator costs a criterion and not the walk-
through.

Video, screenshots and logs are uploaded as the `acceptance-proof` artifact, and the summary comment
links it.

**A video cannot be embedded in a pull request comment.** GitHub only plays media uploaded through
its own web interface, which no token can do, and it strips `<video>` from Markdown; in a private
repository a `raw.githubusercontent.com` link does not render either. A download link to the
artifact is as close as it gets, and that is what the comment carries.

**The deployment under test is the real one**, with its real quotas and its real bills. The prompt
keeps the number of expensive operations down; nothing stops a run from being wrong about that. And
a preview URL every pull request shares stays shared: `PITCREW_ACCEPTANCE_TARGET_HEALTH_URL` detects a takeover
by comparing the deployment's answer against both the head commit and the test merge commit - a
preview built by a `pull_request` workflow reports the latter - but it cannot prevent one. Without a
health URL the check is a no-op that says so, because not knowing is not the same as knowing the
wrong thing.
