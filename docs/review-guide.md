# The review guide

Coding agents write a large part of the code today. People still review it, so review becomes the
main work of many developers. A diff does not help with that work. It shows the files in alphabetical
order. It does not show which changes belong together, which are risky and which are routine. The
reviewer works that out again for each pull request.

The `review-guide` agent supports the human reviewer with this work. It writes one comment on each
pull request. The comment says what changes, where an error would hurt, and in which order to read.
For each group of changes, it recommends a reading mode: read closely, check or skim.

## What it is for

The guide has three goals:

- **Less cognitive load.** You get the context first. Then you read the risky parts with a plan.
- **Less time per review.** You spend your attention where an error would hurt, and skim the routine.
- **Better reviews.** Risky changes get a close read. This goal is a hypothesis. The concept says how
  to measure it.

The guide does not replace your review. It reports no defects and approves nothing. Every line stays
in the diff; the guide only recommends how closely to read it. `bug-review` and `security-review`
look for defects. All three run in parallel and do not depend on each other.

## When to use it

Use the guide when people review your pull requests and the review takes time. It helps most with
these pull requests:

- **From coding agents.** They are often large and change more than the task asked for. The guide
  names changes that the description or the linked issue does not mention.
- **In code you do not know well.** Each group starts with one or two sentences of context: where the
  code sits and what it does.
- **Large ones.** The number of focus areas follows the risk, not the size. When a pull request has
  too much to read closely, the guide says so and suggests splitting it.
- **Mixed ones.** A few risky changes hide between tests, docs and renames. The guide puts them first.

It helps less in these cases:

- **Small pull requests** that you read in a few minutes. The guide then often says "nothing to read
  closely". That is correct, but it saves little time.
- **No human review.** The guide points human attention. Without a human reviewer, it has no reader.
- **Tight model budget.** Each run reads the whole pull request and costs about as much as a full
  `bug-review`. Set `PITCREW_GUIDE_ON_PUSH=false` to run it only when the pull request opens and on
  `/guide`.

## Background

The design and the research behind it are in the concept,
[`docs/concepts/review-guide.md`](concepts/review-guide.md). This page is for the people who read
the guide and the people who configure it. An example is the guide for
[deyai-labs/pr-pitcrew#43](https://github.com/deyai-labs/pr-pitcrew/pull/43):
[`docs/concepts/review-guide-example.md`](concepts/review-guide-example.md).

## What the comment shows

| Part | Content |
| --- | --- |
| Heading | The number of groups per reading mode, for example "2 to read closely · 2 to check · 2 to skim" |
| In short | Two or three sentences: what changes and why |
| Intent | Whether the changes match the description or the linked issue, and changes outside of it |
| Map | The touched components, when there are more than two |
| Recommended focus areas | One row per group to read closely or to check: link, size, categories, mode, and why the agent suggests it |
| Reading load | Changed lines per reading mode |
| Groups | Per group: context, what changes, why, architecture, an excerpt from the diff, checks, links. Groups to read closely are open. |
| Coverage | How many files and changed lines are in a group, and what was not assessed |
| Legend | The categories and the reading modes, folded |
| Footer | "Recommendations by an AI agent, not a verified or complete review", the commit it describes, and a link to the ratings in the run summary |

A group is a set of changes with one purpose. It can hold parts of several files. A group with the
mode "read closely" or "check" is a focus area.

## Categories

A category says which kind of risk a group carries. A group has one to three. Routine stands alone.

| Category | Covers |
| --- | --- |
| 💼 Domain logic | Business rules with business risk: calculations, prices, contracts, states of business objects |
| 👥 UX | Behaviour users see: flows, forms, error messages, accessibility |
| 🔒 Security | Login, permissions, input handling, secrets, trust boundaries, new dependencies |
| 🪪 Privacy | Personal data: collected, stored, shared, logged or deleted |
| 🗄️ Data | Stored data: schema, migrations, deletions, consistency |
| 🏛️ Architecture | Structure: module boundaries, new components and dependencies, contracts, public APIs, decisions |
| ⚙️ Operations | Deployment, CI/CD, configuration, performance, monitoring, cost |
| 🧹 Routine | Tests, docs, formatting, refactoring without new behaviour, generated code |

A group with 🏛️ Architecture gets a paragraph "Architecture": what is new or decided, what it means
for later changes, and whether an ADR records it. The category does not set the reading mode.

## Reading modes

| Mode | When |
| --- | --- |
| ▰▰▰ Read closely | A severe consequence is possible, and little protects against it. |
| ▰▰▱ Check | A moderate consequence is possible, or a severe one with strong protection. |
| ▰▱▱ Skim | A minor consequence at most, or a moderate one with strong protection. |

The mode is absolute. The same change gets the same mode in every pull request. The guide does not
weigh groups against each other, so "nothing to read closely" is a normal result.

## How the guide rates a group

The model never picks the mode. It answers five questions per group:

| Question | Values |
| --- | --- |
| What is the worst realistic consequence if the code is wrong? | `severe`, `moderate`, `minor`, `none` |
| Which input or sequence leads there? | one sentence, the scenario |
| What would catch the error? | `strong`, `partial`, `none` |
| Which tests or ADRs back that answer? | paths of files |
| Can the change be undone? | yes or no |

The levels of the consequence:

| Level | Meaning |
| --- | --- |
| `severe` | Harm outside the code: security, data loss, privacy, money, a main function down |
| `moderate` | A function behaves wrongly in a reachable case. A fix repairs the harm. |
| `minor` | Cosmetic, only visible internally or only to developers |
| `none` | No changed behaviour: docs, tests only, formatting, refactoring without new behaviour |

The prompt gives anchors per category, for example: 🔒 Security `severe` is a bypass of login, a
permission or a check, an injection, or a secret in plain text. The full table is in the concept,
section 6.5.

The levels of the safeguards:

| Level | Meaning |
| --- | --- |
| `strong` | Tests check exactly this scenario, or an ADR on the base branch carries the decision. The change can be undone. |
| `partial` | Tests check part of the scenario, or an ADR arrives only with this pull request. |
| `none` | No test checks the scenario, and no ADR carries the decision. |

The harness corrects the answers, in this order:

1. `severe` or `moderate` without a scenario becomes `minor`.
2. `strong` or `partial` without an evidence file in the repository becomes `none`.
3. Evidence that the pull request adds or changes counts at most as `partial`. An agent cannot lower
   its rating with its own tests.
4. A change that cannot be undone has the safeguards `none`.

Then a fixed table gives the mode:

| Consequence \ Safeguards | `none` | `partial` | `strong` |
| --- | --- | --- | --- |
| `severe` | Read closely | Read closely | Check |
| `moderate` | Check | Check | Skim |
| `minor` | Skim | Skim | Skim |
| `none` | Skim | Skim | Skim |

A group without a category gets at least "check". Last, the floors apply.

Every answer, every correction and the mode are in the run summary of the job. The comment shows the
consequence and the safeguards of each focus area, so you can disagree with one answer rather than
with a verdict.

## Floors

A floor is a path rule with a minimum mode. It catches a model that misses a risk, and a pull request
that tries to talk the model down. The default:

```text
.github/workflows/**   check
.github/actions/**     check
**/action.yml          check
**/Dockerfile          check
**/migrations/**       check
**/*.tf                check
**/CODEOWNERS          check
dependencies           check
```

`dependencies` is a special rule. It applies when a manifest or a lockfile adds, removes or changes a
dependency. A version bump of the package itself does not count.

To set your own floors, set the repository variable `PITCREW_GUIDE_FLOORS`. It replaces the default.
Write one rule per line: a pattern and `check` or `read`. `#` starts a comment. Example for a team
with billing code:

```text
.github/workflows/**   check
dependencies           check
src/billing/**         read
db/migrations/**       read
```

`**` matches any number of directories, `*` matches within one directory. The variable lives in the
repository settings, not in the branch, so a pull request cannot lower its own floors. A variable
without a valid rule keeps the default and writes a warning.

Lines that no group holds go to "Not assigned to a group", with the mode "check". They never fall to
"skim".

## Links and excerpts

The harness writes every link. Each range gets two:

- a link into the diff, at the first line of the range: `…/pull/<n>/files#diff-<sha256 of the path>R<line>`
- a permalink to the file at the head commit, with the range: `…/blob/<sha>/<path>#L<from>-L<to>`

A deleted file links to the base commit. A Markdown file gets `?plain=1`, so GitHub shows the source.

A focus area shows an excerpt of at most 15 lines. The harness copies it from the diff, character for
character. It never changes a character: an excerpt outside the diff, or with a Pitcrew marker in
it, is left out, and the link stays. Groups to skim show links only.

## Checks and ticks

A focus area has up to three checks: statements you confirm at the code, each with a link to its
lines. They are a task list. Tick one when you have confirmed it.

When the guide updates after a push, a tick stays if the text of the check, its lines and the code
under them are the same. When the code changes, the tick goes: you have not confirmed the new code.
Only people with write access can tick.

## Large pull requests

The number of groups follows the risk, not the size. The agent splits risky changes finely and
collects routine in at most three groups. When there are more, the harness merges the rest into
"Other routine changes". There is no limit on focus areas: a limit would hide what you should see.

With more than 7 groups to read closely, or more than 400 changed lines to read closely, the heading
says "consider splitting".

A comment holds at most 65,536 characters. Above 60,000, the harness shortens in this order and names
each step in the footer:

1. diagrams in groups
2. groups to skim, cut to title and link
3. excerpts in groups to check
4. checks in groups to check, cut to two
5. groups to check, cut to title and link
6. details of groups, moved to the run summary: groups to check first, groups to read closely last

The table of focus areas stays through these six steps. A comment that is still too long then loses
the map and the legend, and last the rows of the table. The footer names each step, and the full
guide is in the run summary. Only a pull request of several hundred focus areas gets that far.

## When it runs

| Trigger | Runs |
| --- | --- |
| Pull request opened, reopened, ready for review | yes |
| Push | yes. A new push cancels the guide in flight. |
| Comment `/guide` | yes, by an owner, member or collaborator |
| Draft | no |

The guide reads the whole pull request on every run, so it costs about as much as a full
`bug-review`. To save, set `PITCREW_GUIDE_ON_PUSH=false`. A push then marks the old guide as
outdated instead, for no model cost: the heading says "outdated", and a line says which commit the
guide describes.

The check `Pitcrew / Review Guide` is red only when no guide came out of the run. An earlier guide
then stays, marked as outdated.

The run uploads the artifact `pitcrew-review-guide`: the report as the agent wrote it, and the rating
as the harness made it.

## Install

Copy [`examples/review-guide.yml`](../examples/review-guide.yml) into `.github/workflows/`. It needs
the same secret and variables as the other agents. The variables of the guide are in
[configuration.md](configuration.md).

## Limits

- **The guide can anchor your attention.** You may read only what it marks. The floors, the coverage
  count and the fall to "check" narrow this. They do not remove it. Every line stays in the diff.
- **It is not a review.** It does not say that a change is correct, and it never says that a part
  can be merged without reading.
- **The calibration set is small.** It lives in [`eval/review-guide/`](../eval/review-guide/) and
  measures false alarms, missed critical groups and agreement with people. The concept asks for 20
  to 30 rated pull requests.
- **No way back from the code to the guide yet.** Annotations in the diff are extension E1 of the
  concept.
