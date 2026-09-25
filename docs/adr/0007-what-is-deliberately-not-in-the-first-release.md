# 7. What is deliberately not in the first release

Status: accepted, 2026-08-24

## Context

Four things were designed alongside this release and left out of it. Leaving them out is a decision,
and a decision that is not written down reads later as an oversight.

The rule applied to each: **would a convenient version of this be worse than none?**

## Decisions

### A path for fork pull requests

Left out. In an open-source repository this is the difference between useful and irrelevant, so it is
the most expensive omission here, and [`docs/threat-model.md`](../threat-model.md) says so in the
matrix rather than in a footnote.

Why not yet: the obvious answer is `pull_request_target`, and the obvious answer is the dangerous
one. It runs with the base repository's secrets and, unless every executable thing is explicitly
checked out from the base branch, it runs a stranger's code with them. Shipping that in a hurry is
the classic mistake with that event.

The shape it should take is already clear - shell-less agents only, opt-in, behind a GitHub
environment with a required approver, and a test per cell of the matrix rather than a paragraph
claiming it works. The last README that made this claim in prose got it wrong for half the triggers,
and both security reviews caught it. What goes in the README next time has to be something a test
demonstrates.

### Agents that write

Left out, including the documentation updater that motivated it.

Everything here rests on two facts that a writing agent contradicts: `edit` is denied outside the run
directory, and the jobs run with `contents: read`. Both matter because the runtime commits and pushes
a dirty working tree by itself. Opening those up for one agent opens them for all of them.

The design that keeps the promise is two lanes, distinguishable in the manifest: a writing agent
produces a **patch** in its working directory and nothing else - no push, no commit, no token with
write access anywhere in its process environment - and a **second job**, with no model key, applies
that patch and opens a pull request. The job that reads a stranger's text cannot write; the job that
can write reads one file. That is a property, not a setting.

Building the lane before the agent that needs it means less falls over at once.

### A versioned JSON Schema for the report

Left out. What a schema would buy over the current handling is validation of fields nothing reads,
and what it would cost is a second definition to keep in step with the code - or a schema validator,
which means a dependency this package does not want
([ADR 4](0004-no-dependencies-manifests-in-json.md)).

The part of it that was actually load-bearing is in: an agent's manifest declares its report kind,
and [`scripts/report.mjs`](../../scripts/report.mjs) drops fields that kind may not fill. Malformed
reports were already handled - reported rather than swallowed - which is the behaviour that matters
when the input is model output.

### `npx pr-pitcrew init`

Left out, and probably permanently. The installation is one file of seventeen lines that a reader can
see whole in `examples/`. A generator would be a second thing to keep in step with the workflows, to
save a copy and paste.

## Consequences

These are the roadmap, and they are filed as issues rather than left here, so that this record does
not become a to-do list nobody rereads: [#1](https://github.com/deyai-labs/pr-pitcrew/issues/1) forks,
[#2](https://github.com/deyai-labs/pr-pitcrew/issues/2) the writing lane,
[#3](https://github.com/deyai-labs/pr-pitcrew/issues/3) prompt additions,
[#4](https://github.com/deyai-labs/pr-pitcrew/issues/4) an end-to-end proof,
[#5](https://github.com/deyai-labs/pr-pitcrew/issues/5) measured costs.

The larger consequence is one the README states plainly: this is a package that reviews pull requests
from people who can already push. That is a genuine and common case - it is exactly the case it was
built for - and it is not the case an open-source maintainer has.
