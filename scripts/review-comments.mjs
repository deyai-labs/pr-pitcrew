/**
 * Which pull-request comments belong to *this* review, when several reviews
 * share a workflow run.
 *
 * Under the orchestrator, bug review, security review and the acceptance test
 * are jobs of one run. OpenCode puts that run's link on every reply, and
 * publish-report.mjs used to treat the link as identity: rewrite the newest,
 * delete the rest. The slower job then erased the faster one's report. The
 * run id is still what keeps a person who quotes the link out of the set; it
 * is no longer enough to tell the three jobs apart.
 *
 * Ownership is the marker the frame writes, which carries the review name.
 * A raw OpenCode reply has no marker yet; it may be claimed only if it is not
 * still `[Working...]` — OpenCode updates that placeholder at the end of its
 * step, and rewriting it is how one review's frame vanished under another's.
 */

/**
 * The marker is functional, not decoration: it is how a run recognises the
 * comments of its own earlier runs. Renaming it is therefore a migration, and
 * the old names stay readable — a repository that upgrades mid-pull-request
 * would otherwise post every standing finding a second time and count none of
 * them towards the quality gate. Written: the first. Recognised: all three.
 */
const SUMMARY_MARKERS = {
  write: slug => `<!-- pitcrew:summary:${slug} -->`,
  named: /<!-- (?:pitcrew:summary|opencode-review-summary):([a-z0-9-]+) -->/,
  any: /<!-- (?:pitcrew:summary(?::[a-z0-9-]+)?|opencode-review-summary(?::[a-z0-9-]+)?) -->/,
  /** Pre-1.0, before the marker carried the review name. */
  unnamed: '<!-- opencode-review-summary -->',
};

/**
 * The same migration, for the marker that sits under every inline finding.
 *
 * It carries the review name for the same reason the summary marker does: bug
 * review, security review and design review comment on the same pull request,
 * and each one's quality gate and repeat check must see its own findings only.
 * Before 1.6 the marker named no review, so an open bug-review finding failed
 * the design review too.
 */
const FINDING_MARKERS = {
  write: slug => `<!-- pitcrew:finding:${slug} -->`,
  named: /<!-- pitcrew:finding:([a-z0-9-]+) -->/,
  /** Before 1.6 (`pitcrew:finding`) and before 1.0 (`opencode-review-finding`). */
  unnamed: /<!-- (?:pitcrew:finding|opencode-review-finding) -->/,
};

export function findingMarker(title) {
  return FINDING_MARKERS.write(reviewSlug(title));
}

/**
 * Whether a finding comment belongs to the review called `title`.
 *
 * A named marker decides by itself. An unnamed one, from before 1.6, is
 * attributed by the review it was posted in: publish-report.mjs opens every
 * review body with `## <title>`. Without that body the finding belongs to no
 * review. Counting it for every review is the coupling this replaces.
 */
export function isOurFinding(body, title, reviewBody) {
  const text = String(body ?? '');
  const named = FINDING_MARKERS.named.exec(text);
  if (named) return named[1] === reviewSlug(title);
  if (!FINDING_MARKERS.unnamed.test(text)) return false;
  return isReviewOf(reviewBody, title);
}

/** Whether a finding comment carries a marker without a review name. */
export function hasUnnamedFindingMarker(body) {
  const text = String(body ?? '');
  return !FINDING_MARKERS.named.test(text) && FINDING_MARKERS.unnamed.test(text);
}

/** The heading publish-report.mjs writes as the first line of a review body. */
function isReviewOf(reviewBody, title) {
  const firstLine = String(reviewBody ?? '').split(/\r?\n/, 1)[0].trim();
  return firstLine === `## ${title}`;
}

export function reviewSlug(title) {
  return (
    String(title ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'review'
  );
}

export function summaryMarker(title) {
  return SUMMARY_MARKERS.write(reviewSlug(title));
}

export function isAnySummaryFrame(body) {
  return SUMMARY_MARKERS.any.test(String(body ?? ''));
}

export function isOurSummary(body, title) {
  const text = String(body ?? '');
  const named = SUMMARY_MARKERS.named.exec(text);
  if (named) return named[1] === reviewSlug(title);
  // Frames from before the marker carried the review name: same generic tag,
  // distinguished only by the heading this script writes.
  return text.includes(SUMMARY_MARKERS.unnamed) && text.includes(`### ${title}`);
}

/**
 * OpenCode's first comment, before the agent has answered. Another job's
 * publish step that rewrites this is racing the job that created it: that job
 * still holds the comment id and will overwrite whatever we wrote.
 */
export function isWorkingPlaceholder(body) {
  return /^\[Working\.\.\.\]\([^)]*\)\s*$/.test(String(body ?? '').trim());
}

/**
 * A run id is a prefix of longer run ids. `/actions/runs/123` must not match
 * a comment that links to `/actions/runs/12345`.
 */
export function belongsToRun(body, runId) {
  if (!runId) return false;
  const escaped = String(runId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`/actions/runs/${escaped}(?![0-9])`).test(String(body ?? ''));
}

const updated = comment => String(comment.updated_at ?? comment.created_at ?? '');

const latest = comments =>
  [...comments].sort((a, b) => updated(a).localeCompare(updated(b)) || Number(a.id) - Number(b.id)).at(-1) ?? null;

/**
 * The comment this review may rewrite, and the older frames of *this* review
 * to remove. Comments that belong to a sibling review are not in either set.
 *
 * A raw OpenCode reply is claimed only when it is the only one: two jobs that
 * finish together would otherwise both take the newest, and the loser would
 * vanish. A leftover raw comment next to a frame is ugly; a deleted sibling
 * report is invisible. One unmatched reply is the common case — the other job
 * is still on `[Working...]`, or has already framed — and then claiming it is
 * how a re-run replaces last attempt's frame with the fresh reply.
 */
export function pickSummaryTarget(comments, { title, runId }) {
  const bots = comments.filter(comment => comment?.body && comment.user?.type === 'Bot');
  const ours = bots.filter(comment => isOurSummary(comment.body, title));
  const claimable = bots.filter(
    comment =>
      belongsToRun(comment.body, runId) &&
      !isAnySummaryFrame(comment.body) &&
      !isWorkingPlaceholder(comment.body),
  );

  const existing = (claimable.length === 1 ? claimable[0] : null) ?? latest(ours) ?? null;
  const superseded = ours.filter(comment => comment.id !== existing?.id);
  return { existing, superseded };
}
