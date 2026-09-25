# Contributing

PR Pitcrew runs three agents on a pull request: a bug review and a security
review that read the diff, and an acceptance test that drives the deployed
application in a browser and records a video. They run on the
[OpenCode](https://opencode.ai) runtime, inside the consumer's own GitHub
Actions runner, against whichever OpenAI-compatible endpoint the operator
chooses. It is consumed as a reusable workflow plus a composite action; nothing
is copied into the consumer's repository.

Issues and pull requests are welcome. For anything larger than a fix, open an
issue first - a change to a prompt or a permission profile is a change to what
runs in other people's repositories with their model key, and it is cheaper to
agree on the shape before the diff exists.

## Development setup

Node 20.10 or newer. That is the whole setup.

```sh
git clone https://github.com/deyai-labs/pr-pitcrew.git
cd pr-pitcrew
node --test
```

There is no install step, because there is nothing to install. The package has
**zero npm dependencies, on purpose**: a composite action gets no install step,
so every dependency would have to be vendored into the repository or fetched at
run time into a job that holds the model key and the repository token. Node's
own test runner and `fetch` cover what the scripts need. A pull request that
adds a runtime dependency needs an argument for why that trade is worth making.

## Checks

CI runs these on Node 20.10, 22 and 24, plus actionlint on the workflows and the
actions. Run them before you push:

```sh
node --test                     # unit tests, from the repository root
node scripts/check-syntax.mjs   # parses every script
node scripts/release.mjs --verify
```

Workflows are linted with [actionlint](https://github.com/rhysd/actionlint) in
CI. It parses the YAML and, through shellcheck, the shell inside every `run:`
block - a second language in the file that nothing else reads. To run it
locally:

```sh
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12 -color
```

`scripts/package.test.mjs` is the one worth knowing about before you touch an
agent. It fails when the package's parts stop agreeing with each other: an agent
manifest and its reusable workflow, the prompt and the placeholders the harness
actually fills, the permission profiles, the pinning of third-party actions.

## How the package is laid out

| Directory | What lives there |
| --- | --- |
| `agents/<id>/` | `agent.json` and `prompt.md` - one directory per agent, the only place an agent is described |
| `profiles/` | Permission profiles, referenced by name from a manifest |
| `actions/agent/` | The composite action. Everything a run does happens here |
| `.github/workflows/<id>.yml` | The reusable workflow that runs agent `<id>` |
| `examples/<id>.yml` | What a consumer copies into their repository |
| `scripts/` | The harness: config, diff, report, transcript, release |
| `docs/` | Threat model, decision records |

## Adding or changing an agent

An agent is described once, in `agents/<id>/agent.json`. Three other places have
to keep saying the same thing, and none of them can be generated - a workflow's
`name:` and `uses:` have to be literals - so they are checked instead. Adding an
agent means all four:

1. `agents/<id>/agent.json` and `agents/<id>/prompt.md`. The prompt may only use
   placeholders the harness fills (see `PLACEHOLDERS` in
   `scripts/build-config.mjs`), and it has to name `write_report`: a run whose
   agent produced no report is a run whose findings are gone.
2. `.github/workflows/<id>.yml`, passing `agent: <id>` and carrying the job name
   from the manifest's `check`.
3. `examples/<id>.yml`, referencing `@v1`.
4. A permission profile in `profiles/`, or a reference to one that exists.
   Profiles are shared, not copied - two identical blocks are the state a fourth
   agent copies and a fifth quietly diverges from.

Every profile must deny writes outside `.pitcrew-run/`, deny
`external_directory`, deny reads of `/proc`, `/sys` and `.git`, and deny
`webfetch` and `websearch`. The tests enforce this. If your change loosens a
profile, say so in the pull request and say why.

## Changing the action itself

One limitation, stated honestly, because it will bite you: **a called workflow's
`uses:` cannot be an expression.** So `.github/workflows/bug-review.yml` reaches
for `deyai-labs/pr-pitcrew/actions/agent@main` - the action as it is on the default
branch, not as your pull request changes it.

A pull request that touches `actions/agent/action.yml` is therefore reviewed by
the *old* action, and the self-review passing proves nothing about your change.
Verify it some other way: a fork, or a scratch repository whose workflow points
at `deyai-labs/pr-pitcrew/actions/agent@your-branch`. Then say in the pull request
which one you did.

Changes to `agents/`, `profiles/`, `scripts/` and the reusable workflows do not
have this problem - they are read out of the checkout at the pinned ref, and the
self-review exercises them as written.

## Documentation

`docs/` explains decisions, not code. If your change makes a document wrong, fix
the document in the same pull request. A document that explains a decision that
no longer holds is worse than no document: it gets read and believed.

## Releasing

Maintainer task, and unusual enough to describe in full.

`main` keeps `uses: deyai-labs/pr-pitcrew/actions/...@main`. That is what lets this
repository review its own pull requests with its own code, and it is also why a
tag cannot point at a commit on `main`: a tag whose workflows still say
`@main` would quietly run the newest code inside a version somebody pinned on
purpose.

So a release is a **separate commit on a throwaway branch**, in which every
self-reference is rewritten to the tag. That commit is what the tag points at.
Nothing on `main` changes, and the branch is deleted afterwards so nobody can
merge it back and freeze the self-references at one version.

```sh
node scripts/release.mjs 1.2.0 --dry-run   # show the diff, change nothing
node scripts/release.mjs 1.2.0             # commit, tag v1.2.0, force-move v1
git push origin v1.2.0 && git push -f origin v1
```

The major tag `v1` is force-moved on every release. Moving it is the point: a
repository pinned to `@v1` gets a fix without touching a file.

`node scripts/release.mjs --verify` is what CI runs. It checks that the
workflows on `main` still say `@main` and that the examples still say `@v1`. The
working tree has to be clean before a release: the release commit is made from
what is there.

Update `CHANGELOG.md` and `package.json`'s `version` on `main` before cutting
the tag.

## Pull requests

Keep them focused. Explain what changed and why in the description - the
template asks the questions that matter here. Commit messages in the imperative,
present tense.

By contributing you agree that your contribution is licensed under the MIT
licence, as the rest of the project is.
