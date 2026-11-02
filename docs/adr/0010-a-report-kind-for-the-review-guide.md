# 10. A report kind for the review guide

Status: accepted, 2026-11-02. Issue
[deyai-labs/pr-pitcrew#45](https://github.com/deyai-labs/pr-pitcrew/issues/45). Concept:
[`docs/concepts/review-guide.md`](../concepts/review-guide.md).

## Context

[`docs/adding-an-agent.md`](../adding-an-agent.md) promises that a new agent changes nothing in
`scripts/`. That promise holds for an agent whose report is `findings` or `criteria`: the harness
already fetches its inputs, publishes its report and runs its gate.

The review guide fits neither kind. It reports no defects and proves no criteria. It writes groups
of changes, answers to fixed questions per group, ranges of lines and diagrams as data. Its comment
is not a frame around one sentence but a document that the harness builds: links, numbers, excerpts
and reading modes. And it is published differently: one comment that a new run updates, no comments
at the code, no quality gate.

Two ways were open:

- **Bend `findings`.** One finding per group, with the mode in the severity. The gate, the dedup,
  the inline comments and the frame would all have to ignore the guide's findings again, one `if` at
  a time. A finding that is not a finding is exactly the kind of thing a reader cannot tell apart.
- **A third kind, `guide`.** The kind is in the manifest. `shapeReport` keeps the guide's fields and
  drops findings and criteria, as it already does between the other two kinds. Publishing branches
  once, at the top of `publish-report.mjs`.

## Decision

**`guide` is a third report kind, with its own schema in `write_report` and its own publisher.**

- `scripts/write_report.js` accepts `intent`, `groups`, `order`, `diagrams` and `notAssessed`, and
  writes them only when `groups` is present. A guide's verdict is always `pass`.
- `scripts/report.mjs` keeps those fields for `guide` and drops findings and criteria. A finding in a
  guide would reach the pull request without the gate, the dedup and the anchoring that make a
  finding worth reading.
- `scripts/guide.mjs` checks the report against the diff, derives the reading mode, and renders the
  comment. `scripts/publish-guide.mjs` publishes it. `publish-report.mjs` hands a `guide` over before
  it does anything else, so the action keeps one publish step for every agent.
- The manifest gets an optional field `diffScope`. `pull-request` makes `fetch-diff.mjs` hand over
  the whole pull request on every run, which the guide needs because it describes the whole pull
  request. The default, `incremental`, keeps the behaviour of the reviews.

**The model gives structure, the code gives facts.** The model never picks a reading mode and never
writes a link, a number or a line of code. That is the reason the harness grew, rather than the
prompt: a link or an excerpt from a model cannot be checked by a reader, a computed one can.

## Consequences

- `docs/adding-an-agent.md` now says when its promise holds: for `findings` and `criteria`. A new kind
  is a change to the package and needs an ADR.
- The recovery of a report from a session (`recover-report.mjs`) keeps the guide's fields, and the
  extra turns of `ensure-report.mjs` and `ensure-coverage.mjs` ask for the guide by its fields.
- `fetch-issue.mjs` writes the pull request's title and body to `DESCRIPTION_FILE`. On the
  `pull_request` path the runtime adds no pull request context to the prompt (ADR 9), and the guide
  compares the changes with the description.
- The action gets one input, `guide-floors`, and one upload step, for the guide's report and rating.
  A small action `actions/guide-outdated` marks a guide as outdated when a repository switched the
  push trigger off.
- The guide's check has no gate. It is red only when no guide came out of the run.
