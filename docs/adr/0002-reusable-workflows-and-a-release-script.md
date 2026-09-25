# 2. A composite action behind a reusable workflow, with a release script to keep the refs honest

Status: accepted, 2026-08-24

## Context

The previous shape was a bundle to copy: five directories, put them in another repository, set two
values, done. That is right for one repository and wrong as an offer to other developers. Whoever
copies never receives a fix, and every improvement is a request to copy again.

The requirements were: install in minutes, update by moving a tag, choose agents individually, and
extend by adding a directory rather than by rearranging anything.

## Decision

**Two layers.**

A **composite action** (`actions/agent`) is the engine. When an action is referenced as
`owner/repo/path@ref`, GitHub checks out the whole repository at that ref, so the scripts, the
prompts, the manifests and the permission profiles travel with it. Nobody copies anything.

A **reusable workflow** per agent (`.github/workflows/<agent>.yml`, `on: workflow_call`) is the
facade. It carries what an action cannot: the job's `if:`, its permissions, the concurrency group,
the container for the acceptance test, and the checkout. In the consumer's repository what remains is
about seventeen lines - triggers, permissions, concurrency, `uses:`, one secret.

**Versioning** is semantic tags plus a moving `v1`. The README recommends pinning a commit SHA with
Dependabot and calls `@v1` what it is: the convenient option.

## The wrinkle, and the release script

A reusable workflow **cannot** reference its own repository's action relatively. `uses: ./actions/agent`
inside a called workflow resolves against the runner's workspace - which holds the *caller's*
checkout, not this package. This was checked before the structure was built on it, because getting
it wrong would have produced a package that works in its own repository and nowhere else.

So the reference has to be fully qualified: `deyai-labs/pr-pitcrew/actions/agent@<ref>`. And a `uses:`
ref cannot be an expression, so it is a literal in a file - which means every release has to set it,
and the day somebody forgets, a tag that says `v1.2.0` runs whatever is newest.

That day is why [`scripts/release.mjs`](../../scripts/release.mjs) exists:

- On `main`, the self-references say `@main`. That is what lets this repository review its own pull
  requests with the code sitting beside them.
- `node scripts/release.mjs 1.2.0` makes a **separate commit on a throwaway branch** in which the
  self-references are rewritten to `v1.2.0`, tags that commit, and force-moves `v1`. `main` is not
  touched, and the branch is deleted - if it were merged back, every self-reference would freeze at
  that version.
- `--verify` runs in CI and fails if `main` ever says anything but `@main`, or if the examples say
  anything but `@v1`. A test asserts the same thing
  ([`scripts/package.test.mjs`](../../scripts/package.test.mjs)).

## Consequences

- **Installation is one file and no copies.** A fix here reaches a consumer when `v1` moves.
- **Each agent is independent.** No workflow assumes another is enabled.
- **The consumer needs no `.gitignore` entry.** The action writes `.pitcrew-run/` into
  `.git/info/exclude` itself - repo-local, never committed, one fewer step to forget. The forgotten
  version of that step used to turn a review into a commit.
- **Check names gain a prefix.** A job of a called workflow is reported as
  `<caller job id> / <job name>`, so the check is `bug-review / Pitcrew / Bug Review`. Branch
  protection has to point at that name.
- **Dogfooding has a hole.** The package's own self-review calls `actions/agent@main`, so a pull
  request that changes the action itself is reviewed by the *old* action. There is no fix within
  GitHub's expression rules; `CONTRIBUTING.md` says so and says what to do instead.
- **`secrets: inherit` is not used, anywhere.** It would hand every secret in the consumer's
  repository to a workflow from a repository they do not control. The reusable workflows declare the
  secrets they need by name and the examples pass exactly those.
