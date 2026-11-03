/**
 * The pure part of the issue implementer: markers, which feedback is still
 * open, how a task and a comment read, and which patches may be pushed.
 *
 * The implementer keeps no state of its own. Every run reads the pull request
 * and decides from what it finds, so the event that woke it up is only a
 * signal. That matters because GitHub keeps one pending run per concurrency
 * group: a comment that arrives while a round is running can be replaced in the
 * queue by the implementer's own comment. The next run still sees it, because
 * it looks at the pull request, not at the event.
 *
 * What a round has handled is written into the round's own comment as a
 * snapshot time (`since`). Everything created after the newest snapshot is
 * open. A comment written while a round was running is newer than that round's
 * snapshot, so it is not lost.
 */

export const BRANCH_PREFIX = 'pitcrew/issue-';
export const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];

const ROUND = /<!-- pitcrew:implementer:round ([^>]*?) -->/g;
const FINDING = /<!-- (?:pitcrew:finding|opencode-review-finding) -->/;

export function roundMarker({ round, trigger, since }) {
  return `<!-- pitcrew:implementer:round n=${round} trigger=${trigger} since=${since} -->`;
}

/**
 * `{ round, trigger, since }` from a body, or null. The *last* marker counts:
 * the scripts write theirs at the end, after any text a model wrote.
 */
export function parseRoundMarker(body) {
  const match = [...String(body ?? '').matchAll(ROUND)].at(-1);
  if (!match) return null;
  const fields = Object.fromEntries(
    match[1]
      .split(/\s+/)
      .filter(Boolean)
      .map(pair => pair.split('=')),
  );
  if (!fields.since || Number.isNaN(Date.parse(fields.since))) return null;
  return { round: Number(fields.n) || 0, trigger: fields.trigger ?? 'unknown', since: fields.since };
}

const isBot = user => user?.type === 'Bot' || user?.__typename === 'Bot';

const sameLogin = (user, login) => Boolean(login) && String(user?.login ?? '').toLowerCase() === String(login).toLowerCase();

/**
 * Who may write a round marker: a bot, or the implementer's own account
 * (`self`), which is a plain user when it pushes with a personal token. A
 * person who pastes a marker into a comment must not be able to mark feedback
 * as handled.
 */
const mayMark = (user, self) => isBot(user) || sameLogin(user, self);

/** The rounds on a pull request, oldest first. */
export function roundsOf(pr, comments, { self } = {}) {
  const rounds = [];
  if (mayMark(pr?.user, self)) {
    const marker = parseRoundMarker(pr.body);
    if (marker) rounds.push(marker);
  }
  for (const comment of comments) {
    if (!mayMark(comment.user, self)) continue;
    const marker = parseRoundMarker(comment.body);
    if (marker) rounds.push(marker);
  }
  return rounds.sort((a, b) => a.since.localeCompare(b.since));
}

/**
 * Rounds at the end that ran without a person asking: rounds only bots asked
 * for, and rounds that ran out of time and woke the next one themselves. A
 * round a person asked for resets the count.
 */
export function trailingBotRounds(rounds) {
  let count = 0;
  for (const round of [...rounds].reverse()) {
    if (round.trigger === 'human' || round.trigger === 'issue') break;
    if (round.trigger === 'bot' || round.trigger === 'stopped') count++;
  }
  return count;
}

const after = (time, since) => Boolean(time) && (!since || Date.parse(time) > Date.parse(since));

const trustedHuman = (user, association, self) =>
  !isBot(user) && !sameLogin(user, self) && TRUSTED.includes(association);

/**
 * Everything on the pull request that a round has not handled yet.
 *
 * - Conversation comments and review bodies: from trusted people only, newer
 *   than the last snapshot. Slash commands such as `/review` are for the review
 *   agents and are left alone.
 * - Review threads: unresolved and not outdated, with a comment newer than the
 *   last snapshot from a trusted person or a Pitcrew finding. The whole thread
 *   goes into the task, because a reply makes no sense without what it answers.
 *
 * The implementer's own account (`self`) is never a person here, or its round
 * comments would be feedback for the next round.
 *
 * Returns items with `human: true|false`, so the caller can tell a round people
 * asked for from one only the review bots asked for.
 */
export function openFeedback({ comments = [], reviews = [], threads = [], since, self }) {
  const items = [];

  for (const comment of comments) {
    if (!trustedHuman(comment.user, comment.author_association, self)) continue;
    if (!after(comment.created_at, since)) continue;
    const body = String(comment.body ?? '').trim();
    if (!body || body.startsWith('/')) continue;
    items.push({ kind: 'comment', human: true, author: comment.user.login, url: comment.html_url, body });
  }

  for (const review of reviews) {
    if (!trustedHuman(review.user, review.author_association, self)) continue;
    if (!after(review.submitted_at, since)) continue;
    const body = String(review.body ?? '').trim();
    if (!body) continue;
    items.push({ kind: 'review', human: true, author: review.user.login, url: review.html_url, body, state: review.state });
  }

  for (const thread of threads) {
    if (thread.isResolved || thread.isOutdated) continue;
    const relevant = (thread.comments ?? []).filter(
      comment =>
        trustedHuman(comment.author, comment.authorAssociation, self) ||
        (isBot(comment.author) && FINDING.test(String(comment.body ?? ''))),
    );
    const fresh = relevant.filter(comment => after(comment.createdAt, since));
    if (!fresh.length) continue;
    items.push({
      kind: 'thread',
      human: fresh.some(comment => !isBot(comment.author) && !sameLogin(comment.author, self)),
      path: thread.path,
      line: thread.line ?? thread.originalLine ?? null,
      url: fresh.at(-1).url,
      comments: relevant.map(comment => ({
        author: comment.author?.login ?? 'unknown',
        bot: isBot(comment.author),
        body: stripMarkers(comment.body),
      })),
    });
  }

  return items;
}

/** HTML comments are bookkeeping for scripts; the model does not need them. */
export function stripMarkers(text) {
  return String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

/**
 * The text put in front of the model. Everything in it is data somebody typed,
 * so it is fenced and labelled as such; the prompt says what to do with it.
 */
export function renderIssueTask({ issue, comments = [] }) {
  const lines = [
    `# Task: implement issue #${issue.number}`,
    '',
    `Title: ${issue.title}`,
    '',
    '## Issue text',
    '',
    fence(issue.body || '(empty)'),
  ];
  const trusted = comments.filter(comment => trustedHuman(comment.user, comment.author_association));
  if (trusted.length) {
    lines.push('', '## Comments on the issue', '');
    for (const comment of trusted) {
      lines.push(`### ${comment.user.login}`, '', fence(comment.body || ''), '');
    }
  }
  return `${lines.join('\n').trim()}\n`;
}

export function renderFeedbackTask({ pr, issue, items }) {
  const lines = [
    `# Task: address review feedback on pull request #${pr.number}`,
    '',
    `The pull request implements issue #${issue?.number ?? '?'}: ${issue?.title ?? pr.title}`,
    '',
    '## The issue, for context',
    '',
    fence(issue?.body || '(not available)'),
    '',
    '## Feedback to address',
    '',
  ];
  items.forEach((item, index) => {
    const id = `F${index + 1}`;
    if (item.kind === 'thread') {
      lines.push(`### ${id}: comment thread at \`${item.path}${item.line ? `:${item.line}` : ''}\``, '');
      for (const comment of item.comments) {
        lines.push(`${comment.author}${comment.bot ? ' (review bot)' : ''} wrote:`, '', fence(comment.body), '');
      }
    } else {
      const what = item.kind === 'review' ? `review (${String(item.state ?? '').toLowerCase()})` : 'comment';
      lines.push(`### ${id}: ${what} by ${item.author}`, '', fence(item.body), '');
    }
  });
  return `${lines.join('\n').trim()}\n`;
}

/** A fence longer than any backtick run inside, so the text cannot close it. */
export function fence(text) {
  const value = String(text ?? '');
  const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map(match => match[0].length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}text\n${value}\n${marks}`;
}

/**
 * Paths a patch may not touch. `.github/workflows/` because a GitHub App
 * token without the `workflows` permission cannot push them, and because the
 * agent must not change the workflow that runs it. `.pitcrew-run/` is the
 * agent's scratch space and never part of a change.
 */
export function forbiddenPaths(paths) {
  return paths.filter(path => /^\.github\/workflows\//.test(path) || /(^|\/)\.pitcrew-run\//.test(path));
}

/**
 * Every path a patch from `git diff --binary` touches, old and new names of a
 * rename included. Read from the patch text rather than from `git apply
 * --numstat`, which reports only one side of a rename.
 */
export function pathsFromPatch(text) {
  const paths = new Set();
  const unquote = value => value.replace(/^"(.*)"$/, '$1');
  for (const line of String(text ?? '').split('\n')) {
    let match;
    if ((match = /^diff --git (.*)$/.exec(line))) {
      const rest = match[1];
      const quoted = /^"a\/(.*)" "b\/(.*)"$/.exec(rest);
      if (quoted) {
        paths.add(quoted[1]).add(quoted[2]);
      } else if (rest.startsWith('a/')) {
        // `a/P b/P`: both halves have the same length unless it is a rename,
        // and a rename names both sides again in its own lines below.
        const half = (rest.length - 1) / 2;
        if (Number.isInteger(half) && rest.slice(half + 1).startsWith('b/')) {
          paths.add(rest.slice(2, half)).add(rest.slice(half + 3));
        }
      }
    } else if ((match = /^(?:rename|copy) (?:from|to) (.*)$/.exec(line))) {
      paths.add(unquote(match[1]));
    } else if ((match = /^(?:---|\+\+\+) [ab]\/(.*)$/.exec(line))) {
      paths.add(unquote(match[1]).replace(/\t$/, ''));
    }
  }
  return [...paths];
}

export function commitMessage({ mode, issue, round }) {
  if (mode === 'issue') return `Implement #${issue.number}: ${issue.title}`;
  return `Address review feedback (round ${round})`;
}

const STOPPED = '> [!WARNING]\n> The agent ran out of time. This change may be incomplete.\n';

export function pullRequestBody({ issue, summary, marker, runUrl, stopped }) {
  return [
    `Closes #${issue.number}`,
    '',
    stopped ? STOPPED : null,
    summary || '_The agent wrote no summary._',
    '',
    '---',
    '',
    `Implemented by the Pitcrew issue implementer. [Run](${runUrl})`,
    'Comment on this pull request or on a line, and the next round addresses it.',
    marker,
  ]
    .filter(line => line !== null)
    .join('\n');
}

export function roundComment({ round, summary, commitUrl, marker, runUrl, stopped }) {
  return [
    `### Issue implementer, round ${round}`,
    '',
    stopped ? STOPPED : null,
    commitUrl ? `Pushed ${commitUrl}.` : 'No code changes in this round.',
    '',
    summary || '_The agent wrote no summary._',
    '',
    `[Run](${runUrl})`,
    marker,
  ]
    .filter(line => line !== null)
    .join('\n');
}
