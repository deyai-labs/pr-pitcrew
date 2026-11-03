/**
 * The review guide's harness: it checks what the model wrote, rates every
 * group, and renders the comment.
 *
 * The specification is docs/concepts/review-guide.md. Its central rule (P2):
 * the model gives structure and answers, the code gives facts. So the model
 * never picks a reading mode, never writes a link, a line count or a line of
 * code. It answers fixed questions per group, and this module turns the
 * answers into a mode through a fixed table (6.5). It also checks every range
 * against the diff, collects the lines no group holds, applies the path floors
 * of the repository, copies excerpts verbatim from the diff, renders diagrams
 * from data, and shortens the comment in a fixed order when it is too long.
 *
 * Everything here is a pure function of the report, the parsed diff and a few
 * options. The I/O lives in publish-guide.mjs.
 */

import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { isLockfile } from './changed-files.mjs';
import { changedLines, lineKey, linesInRange, overlapsHunk, pathHash, sideOf } from './guide-diff.mjs';

export const CATEGORIES = {
  domain: { emoji: '💼', label: 'Domain logic', covers: 'Business rules with business risk: calculations, prices, contracts, states of business objects' },
  ux: { emoji: '👥', label: 'UX', covers: 'Behaviour users see: flows, forms, error messages, accessibility' },
  security: { emoji: '🔒', label: 'Security', covers: 'Login, permissions, input handling, secrets, trust boundaries, new dependencies' },
  privacy: { emoji: '🪪', label: 'Privacy', covers: 'Personal data: collected, stored, shared, logged or deleted' },
  data: { emoji: '🗄️', label: 'Data', covers: 'Stored data: schema, migrations, deletions, consistency' },
  architecture: { emoji: '🏛️', label: 'Architecture', covers: 'Structure: module boundaries, new components and dependencies, contracts, public APIs, decisions' },
  operations: { emoji: '⚙️', label: 'Operations', covers: 'Deployment, CI/CD, configuration, performance, monitoring, cost' },
  routine: { emoji: '🧹', label: 'Routine', covers: 'Tests, docs, formatting, refactoring without new behaviour, generated code' },
};

export const MODES = {
  read: { rank: 3, bar: '▰▰▰', label: 'Read closely', phrase: 'to read closely' },
  check: { rank: 2, bar: '▰▰▱', label: 'Check', phrase: 'to check' },
  skim: { rank: 1, bar: '▰▱▱', label: 'Skim', phrase: 'to skim' },
};

const MODE_ORDER = ['read', 'check', 'skim'];
const CONSEQUENCES = ['severe', 'moderate', 'minor', 'none'];
const SAFEGUARDS = ['strong', 'partial', 'none'];

/** 6.5, mechanism 3. The model never chooses the mode; this table does. */
export const MATRIX = {
  severe: { none: 'read', partial: 'read', strong: 'check' },
  moderate: { none: 'check', partial: 'check', strong: 'skim' },
  minor: { none: 'skim', partial: 'skim', strong: 'skim' },
  none: { none: 'skim', partial: 'skim', strong: 'skim' },
};

/** 6.7. Terraform changes infrastructure, CODEOWNERS changes who must review. */
export const DEFAULT_FLOORS = `.github/workflows/**   check
.github/actions/**     check
**/action.yml          check
**/Dockerfile          check
**/migrations/**       check
**/*.tf                check
**/CODEOWNERS          check
dependencies           check
`;

/** GitHub rejects a comment above 65,536 characters; the margin is for the frame. */
export const COMMENT_LIMIT = 60000;
export const EXCERPT_LINES = 15;
export const MAX_ROUTINE_GROUPS = 3;
/** 6.11 and decision 8: start values, to be calibrated with data from 8.1. */
export const LARGE = { groups: 7, lines: 400 };
export const DOCS_URL = 'https://github.com/deyai-labs/pr-pitcrew/blob/main/docs/review-guide.md';
export const FOOTER = 'Recommendations by an AI agent, not a verified or complete review. Every line stays in the diff.';

const MAX_GROUPS = 200;
const MAX_RANGES = 100;
const MAX_VERIFY = 3;
const MAX_NODES = 15;
const MAX_EDGES = 20;
const MAX_DIAGRAMS = 2;

const asArray = value => (Array.isArray(value) ? value : []);
const lower = value => String(value ?? '').trim().toLowerCase();
const higher = (a, b) => (MODES[a].rank >= MODES[b].rank ? a : b);

/* ------------------------------------------------------------------ text */

/**
 * A Pitcrew marker anywhere in a comment body decides which agent owns it:
 * review-comments.mjs takes the first one it finds. Text that reaches the body
 * from the model or from a file name must never carry one.
 */
export const defuse = text => String(text ?? '').replace(/<!--/g, '<!\u2010\u2010');

const MARKER = /<!--\s*(?:pitcrew|opencode-review)/i;

const MENTION = /(^|[^\w`])@([A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9_.-]+)?)/g;

function cleanProse(text) {
  return text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<(?:https?|ftp|mailto):[^>]*>/gi, '')
    .replace(/\b(?:https?|ftp):\/\/[^\s)]*/gi, '')
    .replace(/\bwww\.[^\s)]+/gi, '')
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, '')
    .replace(/`/g, '')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(MENTION, (_, before, name) => `${before}\`@${name}\``);
}

/**
 * Free text from the model, made safe for one paragraph of a comment (6.7):
 * no URL, no HTML, no code block, no line break, no `@name` that notifies
 * anybody. Identifiers in backticks stay.
 */
export function cleanText(value, max = 600) {
  if (typeof value !== 'string') return '';
  let flat = value.replace(/```+|~~~+/g, ' ').replace(/\s+/g, ' ').trim();
  // Cut first, clean second. A cut inside a code span leaves its opening
  // backtick without a partner; the split below then reads the rest as prose
  // and cleans it. Cut after cleaning, the raw content of that span would
  // reach the comment as bare markup.
  const cut = flat.length > max;
  if (cut) flat = flat.slice(0, max - 1).trimEnd();
  const text = flat
    .split(/(`[^`]+`)/)
    .map((part, index) => (index % 2 === 1 ? defuse(part) : cleanProse(part)))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return cut ? `${text}…` : text;
}

const escapeHtml = text =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Cleaned text for an HTML context, such as `<summary>`: backticks become `<code>`. */
export const htmlInline = text =>
  String(text)
    .split(/(`[^`]+`)/)
    .map((part, index) => (index % 2 === 1 ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : part))
    .join('');

/** A code span that holds any text, backticks included. */
export function code(text) {
  const value = defuse(text).replace(/[\r\n]+/g, ' ');
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** Cleaned text as the label of a Markdown link. */
const linkLabel = text =>
  String(text)
    .split(/(`[^`]+`)/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/([[\]])/g, '\\$1')))
    .join('');

/** Markdown tables have no way to escape a newline, and a pipe needs a backslash. */
const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

const short = sha => String(sha ?? '').slice(0, 7);
const signed = ({ plus, minus }) => `+${plus} \u2212${minus}`;
const lineLabel = (from, to) => (from === to ? `L${from}` : `L${from}\u2013L${to}`);
const slug = value =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/* ----------------------------------------------------------------- floors */

/** `**` for any number of directories, `*` within one, `?` for one character. */
export function globToRegExp(glob) {
  const source = String(glob).replace(/^\.?\//, '');
  let pattern = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '*' && source[i + 1] === '*') {
      const atStart = i === 0 || source[i - 1] === '/';
      if (atStart && source[i + 2] === '/') {
        pattern += '(?:.*/)?';
        i += 2;
      } else {
        pattern += '.*';
        i += 1;
      }
    } else if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

/** One rule per line: a pattern and `check` or `read`. `#` starts a comment. */
export function parseFloors(text) {
  const rules = [];
  const warnings = [];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = raw.replace(/(^|\s)#.*$/, '').trim();
      if (!line) return;
      const parts = line.split(/\s+/);
      const mode = lower(parts[1]);
      if (parts.length !== 2 || !['check', 'read'].includes(mode)) {
        warnings.push(`Line ${index + 1} of the floors, "${raw.trim()}", is not "<pattern> check" or "<pattern> read". Ignored.`);
        return;
      }
      rules.push({ pattern: parts[0], mode, test: parts[0] === 'dependencies' ? null : globToRegExp(parts[0]) });
    });
  return { rules, warnings };
}

/**
 * The repository variable replaces the default. A variable that holds no valid
 * rule does not switch the floors off: a typo must not be the quiet way to do
 * that.
 */
export function resolveFloors(variable) {
  const configured = String(variable ?? '').trim();
  if (!configured) return { ...parseFloors(DEFAULT_FLOORS), source: 'default' };
  const parsed = parseFloors(configured);
  if (parsed.rules.length === 0) {
    return {
      ...parseFloors(DEFAULT_FLOORS),
      source: 'default',
      warnings: [...parsed.warnings, 'PITCREW_GUIDE_FLOORS holds no valid rule, so the default floors apply.'],
    };
  }
  return { ...parsed, source: 'PITCREW_GUIDE_FLOORS' };
}

const MANIFESTS = new Set([
  'package.json', 'composer.json', 'deno.json', 'deno.jsonc', 'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg',
  'go.mod', 'Cargo.toml', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'packages.config',
  'Directory.Packages.props', 'pubspec.yaml', 'mix.exs', 'Package.swift', 'Podfile', 'vcpkg.json', 'conanfile.txt',
  'environment.yml',
]);
const MANIFEST_PATTERNS = [/^requirements.*\.(?:txt|in)$/i, /\.gemspec$/, /\.(?:cs|fs|vb)proj$/];
const JSON_MANIFESTS = new Set(['package.json', 'composer.json', 'deno.json', 'deno.jsonc']);
const TOML_MANIFESTS = new Set(['pyproject.toml', 'Cargo.toml', 'Pipfile']);
const JSON_DEPENDENCY_KEY = /(?:dependencies|^overrides|^resolutions|^require(?:-dev)?|^imports)$/i;

const indentOf = raw => /^\s*/.exec(raw.slice(1))[0].length;

/**
 * Whether a changed line of a JSON manifest sits in a block of dependencies.
 * It walks up the hunk to the nearest enclosing key. When the hunk does not
 * show one, the answer is yes: a floor that does not fire is the costly error.
 */
function inJsonDependencies(hunk, index) {
  const line = hunk.lines[index];
  const own = /^\s*"([^"]+)"\s*:\s*[{[]/.exec(line.raw.slice(1));
  if (own) return JSON_DEPENDENCY_KEY.test(own[1]);
  const indent = indentOf(line.raw);
  for (let i = index - 1; i >= 0; i--) {
    const other = hunk.lines[i];
    if (other.kind !== ' ' && other.kind !== line.kind) continue;
    const text = other.raw.slice(1);
    if (indentOf(other.raw) >= indent || !text.trim()) continue;
    if (/^\{\s*$/.test(text)) return false;
    const key = /^\s*"([^"]+)"\s*:\s*[{[]/.exec(text);
    if (key) return JSON_DEPENDENCY_KEY.test(key[1]);
  }
  return true;
}

function inTomlDependencies(hunk, index) {
  const line = hunk.lines[index];
  for (let i = index; i >= 0; i--) {
    const other = hunk.lines[i];
    if (other.kind !== ' ' && other.kind !== line.kind) continue;
    const text = other.raw.slice(1);
    if (/^\s*[\w.-]*(?:dependencies|requires)\s*=/i.test(text)) return true;
    const section = /^\s*\[\[?([^\]]+)\]/.exec(text);
    if (section) return /depend|requires|packages/i.test(section[1]);
  }
  return true;
}

/** The special floor rule `dependencies` (6.7): a manifest or lockfile changes a dependency. */
export function isDependencyChange(file, from, to) {
  const name = basename(file.path);
  const lines = linesInRange(file, from, to).filter(line => line.kind !== ' ');
  if (isLockfile(file.path)) return lines.length > 0 || file.hunks.length === 0;
  const json = JSON_MANIFESTS.has(name);
  const toml = TOML_MANIFESTS.has(name);
  if (!json && !toml && !MANIFESTS.has(name) && !MANIFEST_PATTERNS.some(pattern => pattern.test(name))) return false;
  if (!json && !toml) return lines.length > 0;
  return lines.some(line => (json ? inJsonDependencies : inTomlDependencies)(file.hunks[line.hunk], line.at));
}

/* ----------------------------------------------------------------- ranges */

const toLine = value => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

export function cleanPath(value) {
  if (typeof value !== 'string') return '';
  const path = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (!path || path.split('/').includes('..')) return '';
  return path;
}

/** The file of the diff a path names: exactly, or by a suffix only one file has. */
function lookup(index, path) {
  if (index.has(path)) return index.get(path);
  const matches = [...index.values()].filter(file => file.path.endsWith(`/${path}`));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * `{ file, from, to, whole }`, or `{ error }`. Without lines a range is the
 * whole file. Reversed bounds are turned round (PR-Agent #2765). A range must
 * touch a hunk, or the diff link would point at nothing.
 */
export function normaliseRange(raw, index) {
  if (!raw || typeof raw !== 'object') return { error: 'not a range' };
  const path = cleanPath(raw.file);
  if (!path) return { error: 'no file' };
  const file = lookup(index, path);
  if (!file) return { error: `${path} is not in the diff` };
  let from = toLine(raw.from);
  let to = toLine(raw.to);
  if (from === null && to === null) return { file: file.path, whole: true, from: null, to: null };
  if (from === null) from = to;
  if (to === null) to = from;
  if (from > to) [from, to] = [to, from];
  if (!overlapsHunk(file, from, to)) return { error: `${file.path} ${lineLabel(from, to)} is outside the diff` };
  return { file: file.path, whole: false, from, to };
}

/* -------------------------------------------------------------- diagrams */

const STATE_CLASSES = {
  added: { def: 'fill:#dafbe1,stroke:#1a7f37,color:#1f2328', legend: 'Green: new.' },
  changed: { def: 'fill:#fff8c5,stroke:#9a6700,color:#1f2328', legend: 'Yellow: changed.' },
  removed: { def: 'fill:#eaeef2,stroke:#57606a,color:#1f2328,stroke-dasharray:5 5', legend: 'Grey: removed.' },
  risk: { def: 'fill:#ffebe9,stroke:#cf222e,color:#1f2328', legend: 'Red: where an error would hurt most.' },
};
const SHAPES = {
  box: label => `["${label}"]`,
  decision: label => `{"${label}"}`,
  start: label => `(["${label}"])`,
  store: label => `[("${label}")]`,
};

/**
 * A label inside quotes, with every character Mermaid could read as syntax
 * replaced by an entity. Line breaks become `<br/>`, at most three lines.
 */
export function mermaidLabel(value) {
  const lines = String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .split(/\r?\n/)
    .map(line => line.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 3)
    .map(line =>
      (line.length > 60 ? `${line.slice(0, 59)}…` : line)
        .replace(/#/g, '#35;')
        .replace(/"/g, '#quot;')
        .replace(/</g, '#lt;')
        .replace(/>/g, '#gt;')
        .replace(/`/g, '#96;')
        .replace(/\|/g, '#124;'),
    );
  return lines.join('<br/>');
}

/**
 * `{ mermaid, legend }` or `{ error }`. The model's ids never reach Mermaid:
 * `end`, `graph` and an id that starts with `o` or `x` after an arrow are all
 * syntax. Nodes get `n1`, `n2`, ... instead.
 */
export function renderDiagram(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'not an object' };
  const nodes = asArray(raw.nodes);
  const edges = asArray(raw.edges);
  if (nodes.length === 0) return { error: 'no nodes' };
  if (nodes.length > MAX_NODES) return { error: `${nodes.length} nodes, more than ${MAX_NODES}` };
  if (edges.length > MAX_EDGES) return { error: `${edges.length} edges, more than ${MAX_EDGES}` };

  const ids = new Map();
  for (const node of nodes) {
    const id = String(node?.id ?? '');
    if (!/^[a-z0-9-]+$/.test(id)) return { error: `node id "${id.slice(0, 40)}" is not [a-z0-9-]` };
    if (ids.has(id)) return { error: `node id "${id}" twice` };
    ids.set(id, `n${ids.size + 1}`);
  }
  for (const edge of edges) {
    if (!ids.has(String(edge?.from)) || !ids.has(String(edge?.to))) {
      return { error: `edge ${String(edge?.from).slice(0, 40)} → ${String(edge?.to).slice(0, 40)} names an unknown node` };
    }
  }

  const direction = ['TD', 'LR'].includes(String(raw.direction).toUpperCase()) ? String(raw.direction).toUpperCase() : 'TD';
  const used = new Set();
  const lines = [`flowchart ${direction}`];
  for (const node of nodes) {
    const shape = SHAPES[lower(node.shape)] ?? SHAPES.box;
    const state = lower(node.state);
    const label = mermaidLabel(node.label) || ' ';
    const klass = Object.hasOwn(STATE_CLASSES, state) ? state : '';
    if (klass) used.add(klass);
    lines.push(`  ${ids.get(String(node.id))}${shape(label)}${klass ? `:::${klass}` : ''}`);
  }
  for (const edge of edges) {
    const arrow = lower(edge.style) === 'dashed' ? '-.->' : '-->';
    const label = mermaidLabel(edge.label);
    lines.push(`  ${ids.get(String(edge.from))} ${arrow}${label ? `|"${label}"|` : ''} ${ids.get(String(edge.to))}`);
  }
  for (const klass of Object.keys(STATE_CLASSES)) {
    if (used.has(klass)) lines.push(`  classDef ${klass} ${STATE_CLASSES[klass].def}`);
  }

  const legend = Object.keys(STATE_CLASSES)
    .filter(klass => used.has(klass))
    .map(klass => STATE_CLASSES[klass].legend)
    .join(' ');
  return { mermaid: lines.join('\n'), legend, nodes: nodes.length };
}

/* ------------------------------------------------------------ assessment */

function readGroup(raw, position, index) {
  const corrections = [];
  const dropped = { ranges: [], verify: 0 };

  const ranges = [];
  for (const entry of asArray(raw.ranges).slice(0, MAX_RANGES)) {
    const range = normaliseRange(entry, index);
    if (range.error) dropped.ranges.push(range.error);
    else ranges.push(range);
  }

  const given = asArray(raw.categories).map(lower).filter(Boolean);
  let categories = [...new Set(given.filter(category => Object.hasOwn(CATEGORIES, category)))];
  for (const unknown of new Set(given.filter(category => !Object.hasOwn(CATEGORIES, category)))) {
    corrections.push(`unknown category "${unknown.slice(0, 30)}" removed`);
  }
  if (categories.includes('routine') && categories.length > 1) {
    categories = categories.filter(category => category !== 'routine');
    corrections.push('routine stands alone; removed next to other categories');
  }
  if (categories.length > 3) {
    categories = categories.slice(0, 3);
    corrections.push('more than three categories; kept the first three');
  }

  let consequence = lower(raw.consequence);
  if (!CONSEQUENCES.includes(consequence)) {
    corrections.push(`consequence "${String(raw.consequence ?? '').slice(0, 20)}" unknown: moderate`);
    consequence = 'moderate';
  }
  let safeguards = lower(raw.safeguards);
  if (!SAFEGUARDS.includes(safeguards)) {
    corrections.push(`safeguards "${String(raw.safeguards ?? '').slice(0, 20)}" unknown: none`);
    safeguards = 'none';
  }
  if (categories.length === 1 && categories[0] === 'routine' && ['severe', 'moderate'].includes(consequence)) {
    categories = [];
    corrections.push(`routine with a ${consequence} consequence; routine removed`);
  }

  const excerpt = raw.excerpt ? normaliseRange(raw.excerpt, index) : null;

  const verify = [];
  for (const entry of asArray(raw.verify)) {
    const text = cleanText(entry?.text, 300);
    const range = normaliseRange(entry, index);
    if (!text || range.error || range.whole) {
      dropped.verify += 1;
      continue;
    }
    if (verify.length < MAX_VERIFY) verify.push({ text, ...range });
  }

  return {
    id: slug(raw.id) || `group-${position + 1}`,
    position,
    kind: 'model',
    title: cleanText(raw.title, 120) || `Group ${position + 1}`,
    categories,
    context: cleanText(raw.context, 600),
    what: cleanText(raw.what, 600),
    reason: cleanText(raw.reason, 400),
    scenario: cleanText(raw.scenario, 400),
    architecture: cleanText(raw.architecture, 600),
    given: {
      consequence: String(raw.consequence ?? ''),
      safeguards: String(raw.safeguards ?? ''),
      categories: given,
    },
    consequence,
    safeguards,
    evidence: [...new Set(asArray(raw.evidence).map(cleanPath).filter(Boolean))].slice(0, 10),
    reversible: !(raw.reversible === false || lower(raw.reversible) === 'false'),
    ranges,
    excerpt: excerpt && !excerpt.error && !excerpt.whole ? excerpt : null,
    excerptNote: excerpt?.error ? `excerpt left out: ${excerpt.error}` : '',
    verify,
    corrections,
    dropped,
  };
}

/** 6.11: at most three groups of routine. The rest become one. */
function mergeRoutine(groups) {
  const routine = groups.filter(group => group.categories.length === 1 && group.categories[0] === 'routine');
  if (routine.length <= MAX_ROUTINE_GROUPS) return groups;
  const keep = new Set(routine.slice(0, MAX_ROUTINE_GROUPS - 1));
  const merged = routine.filter(group => !keep.has(group));
  const worst = CONSEQUENCES.find(level => merged.some(group => group.consequence === level)) ?? 'none';
  const group = {
    id: 'other-routine-changes',
    position: Math.min(...merged.map(entry => entry.position)),
    kind: 'merged',
    title: 'Other routine changes',
    categories: ['routine'],
    context: `More than ${MAX_ROUTINE_GROUPS} groups of routine; the harness merged these: ${merged.map(entry => entry.title).join('; ')}.`,
    what: '',
    reason: '',
    scenario: '',
    architecture: '',
    given: { consequence: worst, safeguards: 'none', categories: ['routine'] },
    consequence: worst,
    safeguards: 'none',
    evidence: [],
    reversible: merged.every(entry => entry.reversible),
    ranges: merged.flatMap(entry => entry.ranges),
    excerpt: null,
    excerptNote: '',
    verify: [],
    corrections: [`merged from ${merged.length} groups of routine`],
    dropped: { ranges: merged.flatMap(entry => entry.dropped.ranges), verify: 0 },
  };
  return [...groups.filter(entry => !merged.includes(entry)), group];
}

/** 6.5, rules 1 to 4, then the table, then the floors. */
function rate(group, { exists, touched, floors, index }) {
  const notes = group.corrections;
  let { consequence, safeguards } = group;

  if (['severe', 'moderate'].includes(consequence) && !group.scenario) {
    notes.push(`${consequence} without a scenario: minor`);
    consequence = 'minor';
  }

  const found = group.evidence.filter(path => exists(path));
  if (['strong', 'partial'].includes(safeguards) && found.length === 0) {
    notes.push(`${safeguards} without an evidence file in the repository: none`);
    safeguards = 'none';
  } else if (safeguards === 'strong' && found.every(path => touched.has(path))) {
    notes.push('strong, but all evidence is added or changed by this pull request: partial');
    safeguards = 'partial';
  }
  if (!group.reversible && safeguards !== 'none') {
    notes.push(`not reversible: safeguards ${safeguards} → none`);
    safeguards = 'none';
  }

  let mode = MATRIX[consequence][safeguards];
  if (group.categories.length === 0 && MODES[mode].rank < MODES.check.rank) {
    notes.push('no category: at least check');
    mode = 'check';
  }

  const floorNotes = [];
  for (const rule of floors) {
    const hit = group.ranges.some(range => {
      const file = index.get(range.file);
      if (rule.test === null) return isDependencyChange(file, range.from, range.to);
      return rule.test.test(file.path) || (file.oldPath && rule.test.test(file.oldPath));
    });
    if (!hit) continue;
    if (MODES[rule.mode].rank > MODES[mode].rank) {
      floorNotes.push(`path rule \`${rule.pattern}\`: raised from ${mode} to ${rule.mode}`);
      mode = rule.mode;
    } else {
      floorNotes.push(`path rule \`${rule.pattern}\`: at least ${rule.mode}, no change`);
    }
  }
  notes.push(...floorNotes);

  return {
    ...group,
    consequence,
    safeguards,
    evidence: found,
    evidenceFromPullRequest: found.filter(path => touched.has(path)),
    raisedBy: floorNotes.filter(note => note.includes('raised')),
    mode,
  };
}

/** The lines of a range, keyed for coverage and counted for the frame. */
function rangeKeys(file, range) {
  const lines = range.whole ? changedLines(file) : linesInRange(file, range.from, range.to).filter(line => line.kind !== ' ');
  return lines.map(line => ({ key: lineKey(file.path, line), kind: line.kind }));
}

/** Contiguous runs of uncovered lines, as ranges on the side the file is read from. */
function uncoveredRanges(file, covered, named) {
  if (file.hunks.length === 0 || changedLines(file).length === 0) {
    return named.has(file.path) ? [] : [{ file: file.path, whole: true, from: null, to: null }];
  }
  const ranges = [];
  for (const hunk of file.hunks) {
    let run = null;
    for (const line of hunk.lines) {
      const open = line.kind !== ' ' && !covered.has(lineKey(file.path, line));
      if (!open) {
        if (run) ranges.push(run);
        run = null;
        continue;
      }
      const at = sideOf(file) === 'old' ? line.oldNo : line.kind === '-' ? line.next : line.newNo;
      if (!run) run = { file: file.path, whole: false, from: at, to: at };
      else run.to = Math.max(run.to, at);
    }
    if (run) ranges.push(run);
  }
  return ranges;
}

/**
 * Everything the comment and the run summary show, decided once.
 *
 * Options: `exists(path)` says whether an evidence file is in the repository;
 * `floors` are the parsed path rules; `cutFiles` are files the agent's diff did
 * not hold because it was cut at 1 MB.
 */
export function assessGuide(report, diff, options = {}) {
  const exists = options.exists ?? (() => false);
  const floors = options.floors ?? parseFloors(DEFAULT_FLOORS).rules;
  const index = new Map(diff.files.map(file => [file.path, file]));
  const touched = new Set(diff.files.flatMap(file => [file.path, file.oldPath].filter(Boolean)));
  const notes = { droppedRanges: [], droppedVerify: 0, droppedGroups: [], droppedDiagrams: [], droppedExcerpts: [] };

  const seen = new Set();
  let groups = [];
  asArray(report?.groups)
    .slice(0, MAX_GROUPS)
    .forEach((raw, position) => {
      if (!raw || typeof raw !== 'object') return;
      const group = readGroup(raw, position, index);
      let id = group.id;
      for (let n = 2; seen.has(id); n++) id = `${group.id}-${n}`;
      seen.add(id);
      group.id = id;
      notes.droppedRanges.push(...group.dropped.ranges.map(error => `${group.title}: ${error}`));
      notes.droppedVerify += group.dropped.verify;
      if (group.excerptNote) notes.droppedExcerpts.push(`${group.title}: ${group.excerptNote}`);
      if (group.ranges.length === 0) {
        notes.droppedGroups.push(group.title);
        return;
      }
      groups.push(group);
    });

  groups = mergeRoutine(groups).map(group => rate(group, { exists, touched, floors, index }));

  // Coverage, before the harness adds its own group.
  const covered = new Set();
  const named = new Set();
  for (const group of groups) {
    for (const range of group.ranges) {
      named.add(range.file);
      for (const { key } of rangeKeys(index.get(range.file), range)) covered.add(key);
    }
  }
  const allLines = diff.files.flatMap(file => changedLines(file).map(line => lineKey(file.path, line)));
  const filesCovered = diff.files.filter(file => {
    const lines = changedLines(file);
    if (lines.length === 0) return named.has(file.path);
    return lines.every(line => covered.has(lineKey(file.path, line)));
  }).length;
  const coverage = {
    files: diff.files.length,
    filesCovered,
    lines: allLines.length,
    linesCovered: allLines.filter(key => covered.has(key)).length,
  };

  const rest = diff.files.flatMap(file => uncoveredRanges(file, covered, named));
  if (rest.length > 0) {
    groups.push(
      rate(
        {
          id: 'not-assigned',
          position: Number.MAX_SAFE_INTEGER,
          kind: 'unassigned',
          title: 'Not assigned to a group',
          categories: [],
          context: 'The agent put these changed lines in no group. The harness collected them here.',
          what: '',
          reason: 'No group holds these lines. They fall to check, never to skim.',
          scenario: '',
          architecture: '',
          given: { consequence: '', safeguards: '', categories: [] },
          consequence: 'moderate',
          safeguards: 'none',
          evidence: [],
          reversible: true,
          ranges: rest,
          excerpt: null,
          excerptNote: '',
          verify: [],
          corrections: ['lines in no group: check'],
          dropped: { ranges: [], verify: 0 },
        },
        { exists, touched, floors, index },
      ),
    );
  }

  // Order: the model's, each group once, then by reading mode.
  const position = new Map();
  for (const id of asArray(report?.order)) {
    const key = slug(id);
    if (!position.has(key)) position.set(key, position.size);
  }
  const place = group =>
    group.kind === 'unassigned'
      ? Number.MAX_SAFE_INTEGER
      : position.has(group.id)
        ? position.get(group.id)
        : 100000 + group.position;
  groups.sort((a, b) => MODES[b.mode].rank - MODES[a.mode].rank || place(a) - place(b));

  // Numbers: per group, and per mode with each line counted once, at its highest mode.
  const modeOf = new Map();
  for (const group of groups) {
    const keys = new Map();
    for (const range of group.ranges) for (const entry of rangeKeys(index.get(range.file), range)) keys.set(entry.key, entry.kind);
    group.plus = [...keys.values()].filter(kind => kind === '+').length;
    group.minus = [...keys.values()].filter(kind => kind === '-').length;
    for (const [key, kind] of keys) {
      const before = modeOf.get(key);
      modeOf.set(key, { kind, mode: before ? higher(before.mode, group.mode) : group.mode });
    }
  }
  groups.forEach((group, i) => {
    group.number = i + 1;
  });

  const load = Object.fromEntries(MODE_ORDER.map(mode => [mode, { plus: 0, minus: 0 }]));
  for (const { kind, mode } of modeOf.values()) load[mode][kind === '+' ? 'plus' : 'minus'] += 1;
  const counts = Object.fromEntries(MODE_ORDER.map(mode => [mode, groups.filter(group => group.mode === mode).length]));

  // Diagrams: at most two, one map at the top, one flow in an open group.
  let overview = null;
  let kept = 0;
  for (const raw of asArray(report?.diagrams)) {
    const placement = slug(raw?.placement);
    const where = placement === 'overview' ? 'the map' : `the diagram for "${String(raw?.placement ?? '').slice(0, 40)}"`;
    if (kept >= MAX_DIAGRAMS) {
      notes.droppedDiagrams.push(`${where}: more than ${MAX_DIAGRAMS} diagrams`);
      continue;
    }
    const rendered = renderDiagram(raw);
    if (rendered.error) {
      notes.droppedDiagrams.push(`${where}: ${rendered.error}`);
      continue;
    }
    rendered.caption = cleanText(raw.caption, 200);
    if (placement === 'overview') {
      if (overview) notes.droppedDiagrams.push(`${where}: a second map`);
      else if (rendered.nodes <= 2) notes.droppedDiagrams.push(`${where}: two components or fewer`);
      else {
        overview = rendered;
        kept += 1;
      }
      continue;
    }
    const target = groups.find(group => group.id === placement && group.kind === 'model');
    if (!target) notes.droppedDiagrams.push(`${where}: no such group`);
    else if (target.mode !== 'read') notes.droppedDiagrams.push(`${where}: the group is not open, and a folded diagram may not render`);
    else if (target.diagram) notes.droppedDiagrams.push(`${where}: a second diagram in one group`);
    else {
      target.diagram = rendered;
      kept += 1;
    }
  }

  const intentRaw = report?.intent && typeof report.intent === 'object' ? report.intent : {};
  const source = ['issue', 'description', 'none'].includes(lower(intentRaw.source)) ? lower(intentRaw.source) : 'none';
  const fit = ['matches', 'partly', 'unclear'].includes(lower(intentRaw.fit)) ? lower(intentRaw.fit) : 'unclear';
  const outside = [];
  for (const entry of asArray(intentRaw.outside).slice(0, 10)) {
    const range = normaliseRange(entry, index);
    const path = cleanPath(entry?.file);
    const file = path ? lookup(index, path) : null;
    if (!file) continue;
    outside.push({ file: file.path, range: range.error ? null : range, note: cleanText(entry?.note, 300) });
  }

  const notAssessed = [];
  for (const entry of asArray(report?.notAssessed).slice(0, 50)) {
    const path = cleanPath(entry?.file);
    const file = path ? lookup(index, path) : null;
    if (file) notAssessed.push({ file: file.path, reason: cleanText(entry?.reason, 200) });
  }

  const readLines = load.read.plus + load.read.minus;
  return {
    summary: cleanText(report?.summary, 1200),
    intent: { source, fit, outside },
    groups,
    overview,
    counts,
    load,
    coverage,
    notAssessed,
    cutFiles: [...new Set(options.cutFiles ?? [])],
    large: counts.read > LARGE.groups || readLines > LARGE.lines,
    readLines,
    notes,
    index,
  };
}

/* -------------------------------------------------------------- links */

const RENDERED = new Set(['.md', '.mdx', '.markdown', '.rst', '.adoc', '.asciidoc', '.org', '.textile', '.rdoc', '.csv', '.tsv', '.ipynb', '.svg']);

/**
 * Two links per range (6.9): one into the diff, one to the file at a commit.
 * The diff link names one line, because ranges are not documented in the new
 * "Files changed" view; the permalink carries the range.
 */
export function linker({ server = 'https://github.com', repository, prNumber, headSha, baseSha }) {
  const files = `${server}/${repository}/pull/${prNumber}/files`;
  const blob = (path, sha, fragment) => {
    const encoded = String(path).split('/').map(encodeURIComponent).join('/');
    const plain = RENDERED.has(extname(path).toLowerCase()) ? '?plain=1' : '';
    return `${server}/${repository}/blob/${sha}/${encoded}${plain}${fragment}`;
  };
  return {
    diff: (path, side, line) => `${files}#diff-${pathHash(path)}${line ? `${side === 'old' ? 'L' : 'R'}${line}` : ''}`,
    /** The first line a range shows in the diff, on the side the diff link needs. */
    anchor(file, range) {
      const lines = range.whole ? file.hunks.flatMap(hunk => hunk.lines) : linesInRange(file, range.from, range.to);
      if (sideOf(file) === 'old') {
        const first = lines.find(line => line.oldNo !== null);
        return first ? { side: 'old', line: first.oldNo } : { side: 'new', line: null };
      }
      const first = lines.find(line => line.kind !== '-');
      if (first) return { side: 'new', line: range.whole ? null : first.newNo };
      const removed = lines.find(line => line.kind === '-');
      return removed ? { side: 'old', line: range.whole ? null : removed.oldNo } : { side: 'new', line: null };
    },
    rangeLink(file, range) {
      const { side, line } = this.anchor(file, range);
      return this.diff(file.path, side, line);
    },
    permalink(file, range) {
      const old = sideOf(file) === 'old';
      const sha = old ? baseSha || headSha : headSha;
      const fragment = range.whole ? '' : range.from === range.to ? `#L${range.from}` : `#L${range.from}-L${range.to}`;
      return { url: blob(file.path, sha, fragment), sha };
    },
  };
}

/** The hash a check carries, so a tick survives an update only on unchanged code. */
export function verifyHash(item, file) {
  const lines = linesInRange(file, item.from, item.to)
    .map(line => line.raw)
    .join('\n');
  return createHash('sha256').update(`${item.text}\n${item.file}\n${item.from}\n${item.to}\n${lines}`).digest('hex').slice(0, 16);
}

const VERIFY_MARK = hash => `<!-- pitcrew:verify:${hash} -->`;

/** The checks a person ticked in an earlier version of the comment. */
export function parseTicks(body) {
  const ticked = new Set();
  for (const match of String(body ?? '').matchAll(/^\s*[-*] \[([xX ])\][^\n]*<!-- pitcrew:verify:([0-9a-f]{6,64}) -->/gm)) {
    if (match[1] !== ' ') ticked.add(match[2]);
  }
  return ticked;
}

/* -------------------------------------------------------------- excerpts */

/**
 * The excerpt of a group, cut from the diff and never changed (6.8): the
 * lines of the first hunk the range touches, at most fifteen. `{ text, fence,
 * caption }`, or `{ error }` when it has to be left out.
 */
export function cutExcerpt(file, range) {
  const lines = linesInRange(file, range.from, range.to);
  if (lines.length === 0) return { error: 'outside the diff' };
  const hunk = lines[0].hunk;
  const all = lines.filter(line => line.hunk === hunk);
  const shown = all.slice(0, EXCERPT_LINES);
  const text = shown.map(line => line.raw).join('\n');
  if (MARKER.test(text)) return { error: 'it holds a Pitcrew marker' };
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const newSide = shown.filter(line => line.kind !== '-').map(line => line.newNo);
  const oldSide = shown.filter(line => line.oldNo !== null).map(line => line.oldNo);
  const old = sideOf(file) === 'old' || newSide.length === 0;
  const numbers = old ? oldSide : newSide;
  return {
    text,
    fence: '`'.repeat(Math.max(3, longest + 1)),
    side: old ? 'old' : 'new',
    from: Math.min(...numbers),
    to: Math.max(...numbers),
    shown: shown.length,
    total: all.length,
  };
}

/* ------------------------------------------------------------- rendering */

const categoryLabel = categories =>
  categories.map(category => `${CATEGORIES[category].emoji} ${CATEGORIES[category].label}`).join(' · ');

function headingLine(assessment, ctx) {
  const { read, check, skim } = assessment.counts;
  const parts = [read ? `${read} ${MODES.read.phrase}` : `nothing ${MODES.read.phrase}`, `${check} ${MODES.check.phrase}`, `${skim} ${MODES.skim.phrase}`];
  let line = `### ${ctx.title} — ${parts.join(' · ')}`;
  if (assessment.large) line += ' · consider splitting';
  if (ctx.outdated) line += ' · ⚠️ outdated';
  return line;
}

function intentParagraph({ source, fit, outside }, ctx, links) {
  if (source === 'none') return ['**Intent.** Neither a description nor a linked issue to compare the changes with.'];
  const what = source === 'issue' ? 'linked issue' : 'description';
  const sentence = {
    matches: `The changes match the ${what}.`,
    partly: `The changes match the ${what} in part.`,
    unclear: `Whether the changes match the ${what} is unclear.`,
  }[fit];
  if (outside.length === 0) return [`**Intent.** ${sentence} No change is outside the described scope.`];
  const lines = [`**Intent.** ${sentence} Outside the described scope:`, ''];
  for (const entry of outside) {
    const file = ctx.index.get(entry.file);
    const label = entry.range && !entry.range.whole ? `${code(entry.file)} ${lineLabel(entry.range.from, entry.range.to)}` : code(entry.file);
    const target = links.rangeLink(file, entry.range ?? { whole: true });
    lines.push(`- [${label}](${target})${entry.note ? `: ${entry.note}` : ''}`);
  }
  return lines;
}

function diagramBlock(diagram) {
  const caption = [diagram.caption, diagram.legend].filter(Boolean).join(' ');
  return ['```mermaid', diagram.mermaid, '```', ...(caption ? ['', `<sub>${caption}</sub>`] : [])];
}

function titleLink(group, ctx, links) {
  const range = group.excerpt ?? group.ranges[0];
  return links.rangeLink(ctx.index.get(range.file), range);
}

function rangeLinks(group, ctx, links, limit = 12) {
  const parts = group.ranges.slice(0, limit).map(range => {
    const file = ctx.index.get(range.file);
    const label = range.whole ? code(range.file) : `${code(range.file)} ${lineLabel(range.from, range.to)}`;
    const { url, sha } = links.permalink(file, range);
    return `[${label}](${links.rangeLink(file, range)}) ([file at ${code(short(sha))}](${url}))`;
  });
  const more = group.ranges.length - limit;
  return `**Code:** ${parts.join(' · ')}${more > 0 ? ` · and ${more} more ranges` : ''}`;
}

function verifyLines(group, ctx, links, max) {
  const lines = ['**To verify**', ''];
  const primary = group.ranges[0]?.file;
  for (const item of group.verify.slice(0, max)) {
    const file = ctx.index.get(item.file);
    const hash = verifyHash(item, file);
    const where = defuse(`${item.file === primary ? '' : `${basename(item.file)} `}${lineLabel(item.from, item.to)}`).replace(/([[\]\\`])/g, '\\$1');
    const box = ctx.ticks?.has(hash) ? '[x]' : '[ ]';
    lines.push(`- ${box} ${item.text} ([${where}](${links.rangeLink(file, item)})). ${VERIFY_MARK(hash)}`);
  }
  return lines;
}

function whyParagraph(group) {
  if (group.kind !== 'model') return group.reason ? [`**Why it is here.** ${group.reason}`] : [];
  const evidence = group.evidence.length ? ` (${group.evidence.map(code).join(', ')})` : '';
  const raised = group.raisedBy.length ? ` Raised by ${group.raisedBy.map(note => note.replace(/: raised from .*$/, '')).join(' and ')}.` : '';
  const reason = group.reason ? `${group.reason} ` : '';
  return [`**Why the agent suggests it.** ${reason}Possible consequence: **${group.consequence}**. Safeguards found: **${group.safeguards}**${evidence}.${raised}`];
}

function groupBlock(group, ctx, links, view) {
  const compact =
    (group.mode === 'skim' && view.skimCompact) || (group.mode === 'check' && view.checkCompact);
  const counts = signed(group);
  const cats = categoryLabel(group.categories);
  if (compact) {
    return [`- [${group.number} · ${linkLabel(group.title)}](${titleLink(group, ctx, links)})${cats ? ` · ${cats}` : ''} · ${counts}`];
  }

  const open = group.mode === 'read' ? ' open' : '';
  const summary = `<summary><b>${group.number} · ${htmlInline(group.title)}</b>${cats ? ` · ${cats}` : ''} · ${counts}</summary>`;
  const out = [`<details${open}>`, summary, ''];
  const paragraph = lines => {
    if (lines.length) out.push(...lines, '');
  };
  if (group.context) paragraph([`**Context.** ${group.context}`]);
  if (group.what) paragraph([`**What changes.** ${group.what}`]);

  if (group.mode !== 'skim') {
    paragraph(whyParagraph(group));
    if (group.architecture && group.categories.includes('architecture')) paragraph([`**Architecture.** ${group.architecture}`]);

    const wantExcerpt = group.excerpt && (group.mode === 'read' || view.checkExcerpts);
    if (wantExcerpt) {
      const file = ctx.index.get(group.excerpt.file);
      const excerpt = cutExcerpt(file, group.excerpt);
      if (excerpt.error) {
        ctx.excerptNotes?.add(`${group.title}: excerpt left out, ${excerpt.error}`);
      } else {
        const link = links.diff(file.path, excerpt.side, excerpt.from);
        const more = excerpt.total > excerpt.shown ? ` · first ${excerpt.shown} of ${excerpt.total} lines` : '';
        paragraph([`${excerpt.fence}diff`, excerpt.text, excerpt.fence]);
        paragraph([`<sub>[${code(file.path)} ${lineLabel(excerpt.from, excerpt.to)}](${link}), from the diff${more}</sub>`]);
      }
    }
    if (group.diagram && view.groupDiagrams) paragraph(diagramBlock(group.diagram));
    const max = group.mode === 'check' && view.checkVerifyTwo ? 2 : MAX_VERIFY;
    if (group.verify.length) paragraph(verifyLines(group, ctx, links, max));
  }

  paragraph([rangeLinks(group, ctx, links)]);
  out.push('</details>');
  return out;
}

function focusTable(groups, ctx, links, limit) {
  const focus = groups.filter(group => group.mode !== 'skim');
  if (focus.length === 0) return ['No recommended focus areas.'];
  const lines = ['| # | Focus area | Category | Recommendation | Why the agent suggests it |', '| --- | --- | --- | --- | --- |'];
  for (const group of focus.slice(0, limit)) {
    const mode = MODES[group.mode];
    lines.push(
      `| ${group.number} | ${cell(`[${linkLabel(group.title)}](${titleLink(group, ctx, links)}) · ${signed(group)}`)} | ${cell(categoryLabel(group.categories) || '—')} | ${mode.bar} ${mode.label} | ${cell(group.reason || '—')} |`,
    );
  }
  if (focus.length > limit) lines.push('', `… and ${focus.length - limit} more focus areas. All of them are in the [run summary](${ctx.runUrl}).`);
  return lines;
}

function alsoChanged(groups, ctx, links, limit) {
  const skim = groups.filter(group => group.mode === 'skim');
  if (skim.length === 0) return [];
  const routine = skim.every(group => group.categories.length === 1 && group.categories[0] === 'routine');
  const entries = skim.slice(0, limit).map(group => {
    const counts = group.minus ? signed(group) : `+${group.plus}`;
    return `[${group.number} · ${linkLabel(group.title)}](${titleLink(group, ctx, links)}) ${counts}`;
  });
  const more = skim.length > limit ? ` · and ${skim.length - limit} more` : '';
  return [`Also changed, ${routine ? '🧹 routine, ' : ''}to skim:`, `${entries.join(' ·\n')}${more}`];
}

function coverageLines(assessment) {
  const { files, filesCovered, lines, linesCovered } = assessment.coverage;
  let text = `**Coverage.** ${filesCovered} of ${files} files and ${linesCovered} of ${lines} changed lines are in a group.`;
  if (linesCovered < lines) text += ` The other ${lines - linesCovered} are under "Not assigned to a group", to check.`;
  const parts = assessment.notAssessed.map(entry => `${code(entry.file)}${entry.reason ? ` (${entry.reason})` : ''}`);
  if (assessment.cutFiles.length) {
    const listed = assessment.cutFiles.slice(0, 5).map(code).join(', ');
    const more = assessment.cutFiles.length > 5 ? ` and ${assessment.cutFiles.length - 5} more` : '';
    parts.push(`${listed}${more}, behind the 1 MB cut of the diff the agent read`);
  }
  text += ` Not assessed: ${parts.length ? parts.join('; ') : 'nothing'}.`;
  return [text];
}

function legend() {
  const lines = ['<details>', '<summary>What the categories and reading modes mean</summary>', '', '| Category | Covers |', '| --- | --- |'];
  for (const category of Object.values(CATEGORIES)) lines.push(`| ${category.emoji} ${category.label} | ${category.covers} |`);
  lines.push(
    '',
    '| Reading mode | When |',
    '| --- | --- |',
    `| ${MODES.read.bar} ${MODES.read.label} | A severe consequence is possible, and little protects against it. |`,
    `| ${MODES.check.bar} ${MODES.check.label} | A moderate consequence is possible, or a severe one with strong protection. |`,
    `| ${MODES.skim.bar} ${MODES.skim.label} | A minor consequence at most, or a moderate one with strong protection. |`,
    '',
    'The agent answers fixed questions for each group. The reading mode follows from a fixed table, not',
    'from a choice of the agent. Path rules can raise it. See',
    `[how the guide rates changes](${DOCS_URL}).`,
    '',
    '</details>',
  );
  return lines;
}

function footer(assessment, ctx, shortened) {
  const parts = [FOOTER, 'Code excerpts are copied from the diff, not written by the agent.'];
  if (ctx.headSha) parts.push(`Describes ${code(short(ctx.headSha))}`);
  if (ctx.coverageCaption) parts.push(ctx.coverageCaption);
  const dropped = assessment.notes.droppedRanges.length;
  if (dropped) parts.push(`${dropped} range${dropped === 1 ? '' : 's'} outside the diff removed`);
  if (assessment.notes.droppedDiagrams.length) parts.push(`${assessment.notes.droppedDiagrams.length} diagram${assessment.notes.droppedDiagrams.length === 1 ? '' : 's'} left out`);
  if (shortened.length) parts.push(`Shortened to fit a comment: ${shortened.join(', ')}. The full guide is in the run summary`);
  parts.push(ctx.runUrl ? `All ratings and corrections are in the [run summary](${ctx.runUrl}).` : 'All ratings and corrections are in the run summary.');
  return [`<sub>${parts.join(' · ')}</sub>`, ctx.marker];
}

function compose(assessment, ctx, view, shortened) {
  const links = linker(ctx);
  const out = [headingLine(assessment, ctx), ''];
  if (ctx.outdated) out.push(`**Outdated.** ${ctx.outdated}`, '');
  if (assessment.large) {
    const { read } = assessment.counts;
    out.push(`**This pull request has ${read} area${read === 1 ? '' : 's'} to read closely, with ${assessment.readLines} changed lines. Consider splitting it.**`, '');
  }
  if (assessment.summary) out.push(`**In short.** ${assessment.summary}`, '');
  out.push(...intentParagraph(assessment.intent, ctx, links), '');
  if (assessment.overview && view.overview) out.push(...diagramBlock(assessment.overview), '');

  out.push('#### Recommended focus areas', '', ...focusTable(assessment.groups, ctx, links, view.tableLimit), '');
  const also = alsoChanged(assessment.groups, ctx, links, view.alsoLimit);
  if (also.length) out.push(...also, '');
  const { load } = assessment;
  out.push(
    `Reading load: **${signed(load.read)}** ${MODES.read.phrase} · ${signed(load.check)} ${MODES.check.phrase} · ${signed(load.skim)} ${MODES.skim.phrase}.`,
    '',
  );

  const detailed = assessment.groups.filter(group => !view.moved.has(group.id));
  if (detailed.length) {
    out.push('#### Focus areas in suggested order', '');
    for (const mode of MODE_ORDER) {
      const inMode = detailed.filter(group => group.mode === mode);
      if (inMode.length === 0) continue;
      out.push(`##### ${MODES[mode].bar} ${MODES[mode].label}`, '');
      for (const group of inMode) out.push(...groupBlock(group, ctx, links, view), '');
    }
  }
  if (view.moved.size) out.push(`Details of ${view.moved.size} group${view.moved.size === 1 ? ' are' : 's are'} in the [run summary](${ctx.runUrl}).`, '');

  out.push(...coverageLines(assessment), '');
  if (view.legend) out.push(...legend(), '');
  out.push(...footer(assessment, ctx, shortened));
  return out.join('\n');
}

const FULL_VIEW = () => ({
  overview: true,
  legend: true,
  groupDiagrams: true,
  skimCompact: false,
  checkExcerpts: true,
  checkVerifyTwo: false,
  checkCompact: false,
  moved: new Set(),
  tableLimit: Infinity,
  alsoLimit: Infinity,
});

/**
 * The comment, and the full guide when the comment had to be shortened.
 *
 * Shortening follows 6.10, step by step, and each step is named in the footer:
 * diagrams in groups, groups to skim down to title and link, excerpts in groups
 * to check, checks to two, groups to check down to title and link. Then the
 * details move to the run summary, groups to check first, groups to read
 * closely last. The table stays. Only a pull request beyond any reasonable size
 * loses the map, the legend and then rows of the table, and the comment says
 * so. A cut beyond that keeps the footer.
 *
 * `ctx`: server, repository, prNumber, headSha, baseSha, runUrl, title,
 * marker, coverageCaption, ticks, outdated, limit.
 */
export function renderGuide(assessment, ctx) {
  const limit = ctx.limit ?? COMMENT_LIMIT;
  const context = { ...ctx, index: assessment.index, excerptNotes: new Set() };
  const full = compose(assessment, context, FULL_VIEW(), []);
  if (full.length <= limit) return { body: full, full, shortened: [], excerptNotes: [...context.excerptNotes] };

  const view = FULL_VIEW();
  const shortened = [];
  const fits = () => compose(assessment, context, view, shortened).length <= limit;
  const steps = [
    ['diagrams in groups removed', () => (view.groupDiagrams = false)],
    ['groups to skim cut to title and link', () => (view.skimCompact = true)],
    ['excerpts in groups to check removed', () => (view.checkExcerpts = false)],
    ['checks in groups to check cut to two', () => (view.checkVerifyTwo = true)],
    ['groups to check cut to title and link', () => (view.checkCompact = true)],
  ];
  for (const [note, apply] of steps) {
    if (fits()) break;
    apply();
    shortened.push(note);
  }

  if (!fits()) {
    shortened.push('details moved to the run summary');
    const order = [
      ...assessment.groups.filter(group => group.mode === 'skim'),
      ...assessment.groups.filter(group => group.mode === 'check').reverse(),
      ...assessment.groups.filter(group => group.mode === 'read').reverse(),
    ];
    for (const group of order) {
      if (fits()) break;
      view.moved.add(group.id);
    }
  }
  if (!fits()) {
    view.overview = false;
    view.legend = false;
    shortened.push('map and legend removed');
  }
  if (!fits()) {
    shortened.push('the lists cut');
    for (let size = 200; size >= 0 && !fits(); size = size > 20 ? size - 20 : size - 1) {
      view.tableLimit = size;
      view.alsoLimit = Math.min(size, 20);
    }
  }

  let body = compose(assessment, context, view, shortened);
  if (body.length > limit) {
    // The last resort cuts the middle, never the footer: the footer names the
    // commit the guide describes, and guide-outdated.mjs reads it from there.
    const lines = body.split('\n');
    const foot = lines.slice(-2).join('\n');
    const note = '\n\n*(Cut here. The full guide is in the run summary.)*\n\n';
    body = `${lines.slice(0, -2).join('\n').slice(0, Math.max(0, limit - foot.length - note.length))}${note}${foot}`;
  }
  return { body, full, shortened, excerptNotes: [...context.excerptNotes] };
}

/** The comment of a run that produced no guide, when there is no earlier one to keep. */
export function renderMissing(ctx, reason) {
  return [`### ${ctx.title} — no guide`, '', reason, '', `<sub>${FOOTER}${ctx.runUrl ? ` · [Workflow run](${ctx.runUrl})` : ''}</sub>`, ctx.marker].join('\n');
}

/**
 * Marks an earlier guide as outdated in place, in the heading and in one line
 * under it. Used when the pull request moved on and no new guide replaces it.
 */
export function markOutdated(body, sentence) {
  const lines = String(body).split('\n');
  const heading = lines.findIndex(line => line.startsWith('### '));
  if (heading < 0) return body;
  if (!lines[heading].includes('⚠️ outdated')) lines[heading] += ' · ⚠️ outdated';
  const existing = lines.findIndex(line => line.startsWith('**Outdated.**'));
  if (existing >= 0) lines[existing] = `**Outdated.** ${sentence}`;
  else lines.splice(heading + 1, 0, '', `**Outdated.** ${sentence}`);
  return lines.join('\n');
}

/* ---------------------------------------------------------- run summary */

/** 6.5, mechanism 6: every answer, every correction and the mode, per group. */
export function ratingSummary(assessment, { title = 'Review guide', floorsSource = 'default', warnings = [] } = {}) {
  const lines = [`## ${title}: ratings`, '', '| # | Group | Categories | Consequence | Safeguards | Evidence | Reversible | Correction | Mode |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const group of assessment.groups) {
    lines.push(
      `| ${group.number} | ${cell(group.title)} | ${cell(group.categories.join(', ') || '—')} | ${group.consequence} | ${group.safeguards} | ${cell(group.evidence.map(code).join(', ') || '—')} | ${group.reversible ? 'yes' : 'no'} | ${cell(group.corrections.join('; ') || '—')} | ${MODES[group.mode].label} |`,
    );
  }
  lines.push('');
  const scenarios = assessment.groups.filter(group => group.scenario);
  if (scenarios.length) {
    lines.push('**Scenarios**', '');
    for (const group of scenarios) lines.push(`${group.number}. **${group.title}**: ${group.scenario}`);
    lines.push('');
  }
  lines.push(`Floors: ${floorsSource === 'default' ? 'the default rules' : 'PITCREW_GUIDE_FLOORS'}.`, '');
  const { notes } = assessment;
  const issues = [
    ...warnings,
    ...notes.droppedRanges.map(note => `Range removed: ${note}.`),
    ...notes.droppedGroups.map(name => `Group without a valid range removed: ${name}.`),
    ...notes.droppedDiagrams.map(note => `Diagram left out: ${note}.`),
    ...notes.droppedExcerpts.map(note => `${note}.`),
    ...(notes.droppedVerify ? [`${notes.droppedVerify} checks without text or a valid range removed.`] : []),
  ];
  if (issues.length) lines.push('**Corrections to the report**', '', ...issues.map(issue => `- ${cell(issue)}`), '');
  return lines.join('\n');
}

/** The assessment without its internal indexes, for the artifact. */
export function ratingJson(assessment) {
  return {
    counts: assessment.counts,
    load: assessment.load,
    coverage: assessment.coverage,
    large: assessment.large,
    groups: assessment.groups.map(group => ({
      number: group.number,
      id: group.id,
      title: group.title,
      kind: group.kind,
      categories: group.categories,
      given: group.given,
      consequence: group.consequence,
      safeguards: group.safeguards,
      evidence: group.evidence,
      reversible: group.reversible,
      scenario: group.scenario,
      corrections: group.corrections,
      mode: group.mode,
      plus: group.plus,
      minus: group.minus,
      ranges: group.ranges,
    })),
    notes: assessment.notes,
  };
}
