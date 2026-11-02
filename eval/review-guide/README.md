# Calibration set of the review guide

This set measures whether the review guide gives each change the reading mode a person gives it. The
concept defines it in [section 6.5](../../docs/concepts/review-guide.md#65-einstufung-und-normalisierung),
mechanism 5.

The set follows the rules of the evaluation suite in issue
[deyai-labs/pr-pitcrew#21](https://github.com/deyai-labs/pr-pitcrew/issues/21):

- Rules give the score. A model never gives it.
- A person starts a run and commits the result. CI does not run it, because it costs tokens.
- The set adds no dependency. The published package does not contain it: `package.json` lists the
  directories to publish, and `eval/` is not one of them.

## Status

The set has 3 cases. The concept asks for 20 to 30. Add cases until the set has routine, mixed and
critical pull requests from more than one repository.

| Case | Kind | Rated by |
| --- | --- | --- |
| `pr-43` | mixed | the author of the concept, with knowledge of the findings on that pull request |
| `pr-44` | routine | the maintainers |
| `pr-46` | routine | the maintainers |

## A case

A case is a directory under `cases/` with one file, `case.json`:

```json
{
  "title": "Keep base-branch merges out of incremental reviews",
  "pullRequest": "deyai-labs/pr-pitcrew#43",
  "base": "<merge base>",
  "head": "<head commit>",
  "kind": "mixed",
  "ratedBy": "Who rated the groups, and what they knew.",
  "groups": [
    { "title": "Skip decision", "mode": "read", "ranges": [{ "file": "scripts/fetch-diff.mjs", "from": 334, "to": 404 }] }
  ]
}
```

| Field | Values |
| --- | --- |
| `kind` | `routine`: no change needs more than a skim. `mixed`: some do. `critical`: most do. |
| `groups[].mode` | `read`, `check` or `skim`, as the person rates the group |
| `groups[].ranges` | the lines of the group, as in a guide report. Without `from` and `to`, the whole file. |

The script reads the diff with `git diff base...head`. For a pull request of another repository, put
the diff in `case.diff` and the list of files at the head commit in `tree.txt`.

To add a case:

1. Pick a merged pull request. Note its merge base and its head commit.
2. Let a person who did not see a guide for it split it into groups and rate each group.
3. Write `case.json`. Rate only what the person rated; the other lines do not count.

## A run

1. Let the guide run on the pull request of each case. Take `report.json` from the artifact
   `pitcrew-review-guide` of that run. When the runner of #21 exists, use it instead.
2. Put the reports in one directory, one file per case: `pr-43.json`, `pr-44.json`, ...
3. Score them in a full clone:

```bash
node eval/review-guide/score.mjs --runs <directory>
```

The script rates every report with the harness, as on a pull request, with the default floors. It
then compares, per rated group, the mode most of its changed lines got. It prints a table and three
numbers:

| Number | Meaning | Goal |
| --- | --- | --- |
| False alarms | routine pull requests with at least one focus area | near 0 |
| Missed | groups rated `read` that the guide did not rate `read` | near 0, and none under `skim` |
| Weighted kappa | agreement per group, with linear weights | high |

The script exits with 1 when a group rated `read` falls to `skim`. That is the failure the concept
calls unacceptable.

## When to run it

Run the set before each release that changes the prompt, the scale, the anchors or the recommended
model. Put the old and the new result in the pull request.
