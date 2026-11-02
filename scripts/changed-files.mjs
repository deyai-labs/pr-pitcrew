/**
 * The files a review has to open, taken from the same diff the agent is handed.
 *
 * A hunk is three lines of context. Every question a security or bug review
 * actually asks — is the tenant condition still on that query, does this route
 * still authenticate, where does this value go — is a question about the file,
 * not about the hunk. The list is the floor: a file that is not on it does not
 * have to be opened, and a file that is on it cannot be cleared from the hunk
 * alone.
 *
 * Which files count is decided by exemption rather than by an allow-list of
 * "source" extensions. An allow-list silently drops the first file in a
 * language nobody thought of. Exempt: prose (`.md`, `.mdx`, `.txt`), lockfiles,
 * and files the diff deletes. Everything else is on the list, including
 * `package.json`, `index.html`, a new `.toml`, a binary the change touches.
 *
 * The paths are the ones the diff names at the head revision — the `b/` side,
 * the rename target — because that is what is in the checkout the agent reads.
 */

import { basename, extname } from 'node:path';

const EXEMPT_EXTENSIONS = new Set(['.md', '.mdx', '.txt']);

/**
 * Basenames, not patterns. A glob like `*lock*` would drop a source file named
 * `lock.ts`; a lockfile whose name nobody listed here stays on the review list,
 * which is the safe direction.
 */
const LOCKFILE_NAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'poetry.lock',
  'Pipfile.lock',
  'pdm.lock',
  'uv.lock',
  'flake.lock',
  'go.sum',
  'go.work.sum',
  'Podfile.lock',
  'Package.resolved',
  'packages.lock.json',
  'mix.lock',
  'pubspec.lock',
  'gradle.lockfile',
]);

/** Whether a path is a lockfile this package knows by name. */
export function isLockfile(path) {
  return LOCKFILE_NAMES.has(basename(String(path ?? '')));
}

export function isExemptPath(path) {
  const name = basename(String(path ?? ''));
  if (!name) return true;
  if (LOCKFILE_NAMES.has(name)) return true;
  return EXEMPT_EXTENSIONS.has(extname(name).toLowerCase());
}

/**
 * Git's C-style quoting: a path with a space, a tab, a quote or a non-ASCII
 * byte arrives wrapped in double quotes with backslash escapes. Unquoted paths
 * contain no spaces — that is why the splitter below can split on them.
 */
export function unescapeGitPath(raw) {
  const text = String(raw ?? '');
  if (!(text.startsWith('"') && text.endsWith('"') && text.length >= 2)) return text;
  const inner = text.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== '\\') {
      out += inner[i];
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) {
      out += '\\';
      break;
    }
    if (next >= '0' && next <= '7') {
      let digits = next;
      let consumed = 1;
      for (let extra = 1; extra < 3; extra += 1) {
        const digit = inner[i + 1 + extra];
        if (digit === undefined || digit < '0' || digit > '7') break;
        digits += digit;
        consumed += 1;
      }
      out += String.fromCharCode(parseInt(digits, 8));
      i += consumed;
      continue;
    }
    const escaped = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '"': '"', '\\': '\\' };
    out += Object.hasOwn(escaped, next) ? escaped[next] : next;
    i += 1;
  }
  return out;
}

function stripDiffPrefix(path) {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

function takeGitPath(text, start) {
  let i = start;
  while (text[i] === ' ') i += 1;
  if (i >= text.length) return { path: '', next: i };
  if (text[i] === '"') {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === '\\') {
        j += 2;
        continue;
      }
      if (text[j] === '"') {
        const quoted = text.slice(i, j + 1);
        return { path: stripDiffPrefix(unescapeGitPath(quoted)), next: j + 1 };
      }
      j += 1;
    }
    return { path: stripDiffPrefix(unescapeGitPath(text.slice(i))), next: text.length };
  }
  const space = text.indexOf(' ', i);
  const end = space === -1 ? text.length : space;
  return { path: stripDiffPrefix(text.slice(i, end)), next: end };
}

/** `{ oldPath, newPath }` from a `diff --git` line, with prefixes stripped. */
export function parseDiffGitLine(line) {
  const rest = String(line ?? '').replace(/^diff --git /, '');
  const first = takeGitPath(rest, 0);
  const second = takeGitPath(rest, first.next);
  return {
    oldPath: first.path,
    newPath: second.path || first.path,
  };
}

function plusPath(line) {
  const rest = String(line).slice(4).split('\t')[0].trim();
  if (!rest || rest === '/dev/null') return null;
  if (rest.startsWith('"')) return stripDiffPrefix(unescapeGitPath(rest));
  return stripDiffPrefix(rest);
}

/**
 * Repo-relative paths the agent has to open, in the order the diff names them,
 * each once. Deleted files, prose and lockfiles never appear.
 */
export function changedFilesFromDiff(text) {
  const seen = new Set();
  const files = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const path = current.newPath;
    current = null;
    if (!path || path === '/dev/null') return;
    if (currentDeleted) return;
    if (isExemptPath(path)) return;
    if (seen.has(path)) return;
    seen.add(path);
    files.push(path);
  };

  let currentDeleted = false;

  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentDeleted = false;
      const parsed = parseDiffGitLine(line);
      current = { oldPath: parsed.oldPath, newPath: parsed.newPath };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('deleted file mode')) currentDeleted = true;
    else if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      const prefix = line.startsWith('rename to ') ? 'rename to ' : 'copy to ';
      current.newPath = unescapeGitPath(line.slice(prefix.length).trim());
    } else if (line.startsWith('+++ ')) {
      const path = plusPath(line);
      if (path === null) currentDeleted = true;
      else current.newPath = path;
    }
  }
  flush();
  return files;
}

export function formatChangedFiles(paths) {
  return paths.length ? `${paths.join('\n')}\n` : '';
}
