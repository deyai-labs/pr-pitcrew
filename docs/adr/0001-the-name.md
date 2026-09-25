# 1. The name is `pr-pitcrew`, and "OpenCode" is not in it

Status: accepted, 2026-08-24

## Context

The code arrived carrying the runtime's name everywhere: `opencode.json`, `.github/opencode/`,
`opencode-bug-review.yml`, check names beginning `OpenCode / `, environment variables
`OPENCODE_FAIL_ON`, a working directory `.opencode-run`, and the invisible marker under every
comment. Two problems with keeping it.

**It is somebody else's mark.** Naming OpenCode as the runtime is accurate and stays. A *package*
called OpenCode-something suggests a connection that does not exist.

**It would stop fitting.** The next agents are not all reviews. A documentation updater writes; a
licence review is not a review of code. A product name with "review" in it would have to be stretched
or replaced later, and replacing a name is expensive twice.

## Decision

**`pr-pitcrew`**, written *PR Pitcrew* in prose.

A pit crew is several specialists, each with one job, all working at once, and the car leaves in
better shape than it arrived. That describes the product better than any inspection or courtroom
metaphor, and it sounds like help rather than judgement - a review tool that makes developers feel
caught gets muted.

The `pr-` prefix is not decoration. "pitcrew" alone is taken many times over on GitHub, including by
two neighbouring projects that are themselves agent fleets, so a suffix like `-agents` would not
distinguish anything. The prefix goes in front, where it places the reader before they meet the
ambiguous word. `-actions` would tie the name to GitHub; `-reviews` would bring back the problem the
name is meant to avoid.

Verified before deciding: `github.com/RobYed/pr-pitcrew` was free, and `pr-pitcrew` was unclaimed on
the npm registry. The repository later moved to the `deyai-labs` organization, as
`github.com/deyai-labs/pr-pitcrew`. The name did not change.

Naming surfaces:

| Surface | Value |
| --- | --- |
| repository, npm name | `pr-pitcrew` |
| how it is used | `uses: deyai-labs/pr-pitcrew/.github/workflows/<agent>.yml@v1` |
| prose, README title | PR Pitcrew |
| variables and secrets | `PITCREW_LLM_API_KEY`, `PITCREW_LLM_API_BASE_URL`, `PITCREW_LLM_API_MODEL`, `PITCREW_ACCEPTANCE_TARGET_URL`, … |
| check names | `Pitcrew / Bug Review` |
| comment markers | `<!-- pitcrew:summary:<slug> -->`, `<!-- pitcrew:finding -->` |
| working directory | `.pitcrew-run/` |
| slash commands | unchanged: `/review`, `/security`, `/acceptance` - they name the agent, not the package |

The `pr-` prefix stays out of the variables, or every one of them would read
`PR_PITCREW_ACCEPTANCE_TARGET_HEALTH_URL`.

Within `PITCREW_*` the second segment sorts a variable into one of three families, and the sorting is
deliberate:

| Segment | What it configures | Examples |
| --- | --- | --- |
| `LLM_API_` | the model provider, for every agent | `PITCREW_LLM_API_KEY`, `PITCREW_LLM_API_BASE_URL`, `PITCREW_LLM_API_MODEL`, `PITCREW_LLM_API_MODEL_<AGENT>` |
| `ACCEPTANCE_` | the acceptance test only | `PITCREW_ACCEPTANCE_TARGET_URL`, `PITCREW_ACCEPTANCE_TARGET_USERNAME`, `PITCREW_ACCEPTANCE_REVIEWER`, `PITCREW_ACCEPTANCE_ALLOW_PUBLIC` |
| neither | every agent, and not the provider | `PITCREW_FAIL_ON`, `PITCREW_OUTPUT_LANGUAGE` |

Two problems made this worth the extra syllables.

**Two names mean "base URL" and two mean "credentials", pointing at completely different things** -
one pair at the model provider, the other at the application the acceptance test drives. A bare
`PITCREW_BASE_URL` next to a bare `PITCREW_TARGET_URL` invites somebody to put the app's address in
the wrong one, and the failure is a confusing HTTP error from a host that was never a model endpoint.

**A repository that runs only the two diff reviews should be able to see, from the name alone, that
half the table does not concern it.** `PITCREW_TARGET_URL` reads like something every agent needs.
`PITCREW_ACCEPTANCE_TARGET_URL` does not.

The per-agent model override stays in the `LLM_API_` family rather than moving into `ACCEPTANCE_`
(`PITCREW_LLM_API_MODEL_ACCEPTANCE_TEST`, not `PITCREW_ACCEPTANCE_MODEL`). It is one of three
variables that differ only in which agent they name, and separating one of them from its siblings
would hide the pattern to gain a prefix.

The segments also mean one `grep` finds every place a provider is configured, and another finds
everything the acceptance test needs.

## Consequences

**Two of these renames are functional, not cosmetic.** The comment markers are how a run recognises
the comments of its own earlier runs - for the deduplication of findings and for the standing
findings that keep a check red. Renaming them blind would make a repository repost every open
finding once and count none of them.

So [`scripts/review-comments.mjs`](../../scripts/review-comments.mjs) **writes** the new markers and
**recognises** both, including the pre-1.0 unnamed form. Tests cover all three. The compatibility
shim is small and there is no plan to remove it.

**What was not done.** No trademark search at EUIPO, DPMA or USPTO. This is a side project with no
commercial intent, and a registry search is a cost without a matching risk at this size. If that ever
changes, the search comes before the announcement, not after.

**A known trade-off.** Outside a developer context, "PR" reads as public relations. That matters for
a domain or a social handle. In a `uses:` line it never comes up.

Discoverability the name does not carry is carried by the repository topics instead:
`github-actions`, `code-review`, `ai-agents`, `pull-request`.
