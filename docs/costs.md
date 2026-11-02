# What a run costs

Three bills, and they are not the same bill: tokens at your model provider, minutes on GitHub's
runners, and whatever the acceptance test does to the environment it drives.

**A caveat before the numbers.** The figures below are ranges observed on one repository with one
provider, not a benchmark. Token use varies by more than an order of magnitude with the size of the
diff and the model's appetite for reading files, and the acceptance test varies with how patient the
model is with a slow page. Measure your own first week before you budget. Where this document does
not know, it says so rather than inventing a number.

## Runner minutes

| Agent | Job shape | Typical wall time |
| --- | --- | --- |
| `bug-review` | `ubuntu-latest`, no container | a few minutes on a small diff; the timeout is 20 |
| `security-review` | the same | the same |
| `acceptance-test` | Playwright container, ~1.5 GB image pull | the longest by far; the timeout is 30 |

The two diff reviews are cheap in minutes and the acceptance test is not. Nothing polls and nothing
waits: an earlier version of this had a gatekeeper job that occupied a runner for up to half an hour
watching other checks go green. It is gone. Ordering between jobs is `needs:`, which waits in the
queue and costs nothing, and the acceptance test does not wait for anything at all - it starts on an
explicit request, by which time the other checks have usually finished.

On a private repository those minutes are billed. On a public one they are not.

## Tokens

What drives the number, in order:

1. **The diff.** On a push the agents are given the commits since the last published review, not the
   whole pull request, which is the single largest saving in the package, and it exists for a
   different reason (see [`how-it-works.md`](how-it-works.md), "Reviewing the same pull request
   twice"). A `/review` comment deliberately re-reads everything.
2. **The files the agent decides to read.** A review agent reads around the diff to check whether a
   suspicion is real. That is most of its input on a small diff, and it is not bounded.
3. **`AGENTS.md` / `CLAUDE.md` and what they point at.** The prompts send the review agents to the
   project's rule file. A very long rule file is paid for on every run.
4. **The pull request's title, body and comments**, which the runtime adds to the prompt on a
   comment-triggered run. A `pull_request` does not pay for them; see
   [`how-it-works.md`](how-it-works.md), "Two ways into the runtime".
5. **The recovery turn**, if it happens. When an agent finishes without submitting a report, the
   session is read back and, only if the report cannot be recovered from it, one further turn is
   spent asking for the tool by name. Never a second review.

The review guide is the exception to the first point: it reads the whole pull request on every run,
because it describes the whole pull request. A guide costs about as much as a full `bug-review` of the
same pull request, on every push. A new push cancels the guide in flight.

Rough shape, for a review of a diff of a few hundred lines: input in the tens of thousands of tokens,
output in the low thousands. The acceptance test is a different animal. It is an agentic loop with
a browser, so it is dominated by the number of turns, and a run of tens of turns is normal.

**Two models, not one.** `PITCREW_LLM_API_MODEL_BUG_REVIEW`, `PITCREW_LLM_API_MODEL_SECURITY_REVIEW` and
`PITCREW_LLM_API_MODEL_ACCEPTANCE_TEST` exist because reading a diff and driving a browser for half an hour
are different jobs. A cheap model can be entirely adequate at one and useless at the other. This is
the first knob to reach for.

## The environment under test

The acceptance test uses your **real** deployment, with its real quotas, its real outbound e-mail
and its real third-party bills. If your app calls a paid API, a walk-through calls it too.

The prompt keeps the number of expensive operations down: "one demonstration per criterion, not
three". Nothing enforces that. This is the cost most likely to surprise you, because it does not
appear on either of the other two bills.

It is also why the acceptance test does not start on every push. See below.

## The knobs

| If it is too expensive | Do this |
| --- | --- |
| The reviews run on every push | Nothing stops that today; they are cheap. If it still matters, drop `synchronize` from your caller's `on:` and rerun with `/review`. |
| The review guide runs on every push | Set `PITCREW_GUIDE_ON_PUSH=false`. The guide then runs when the pull request opens and on `/guide`; a push only marks the old guide as outdated, for no model cost. |
| The acceptance test runs too often | It already only runs on an explicit request. Do not put the reviewer account in `CODEOWNERS`, and do not hang it behind `needs:` in an orchestrator - both make it automatic again. |
| The model is too expensive for the reviews | Set `PITCREW_LLM_API_MODEL_BUG_REVIEW` and `PITCREW_LLM_API_MODEL_SECURITY_REVIEW` to something cheaper and leave the acceptance test alone. |
| Only one agent earns its keep | Enable only that one. They are independent workflows. |
| A run costs more than it should on a big pull request | Review earlier and smaller. The incremental diff makes a series of small pushes cheaper than one large one. |
| You want a human to decide before anything is spent | Put the job in a GitHub environment with a required reviewer. |

## What is not measured yet

Honest gaps, listed rather than glossed over:

- No per-agent token accounting is published here. The run transcript prints the tokens and, when
  the endpoint publishes prices, the cost of each run, so the data exists per run, in your own run
  summaries. It has not been aggregated into a table anyone should budget from.
- The image pull for the acceptance test is not cached across runs.
- There is no cost ceiling. Nothing in this package stops a run from being expensive; the timeouts
  are the only backstop, and they are time, not money.
