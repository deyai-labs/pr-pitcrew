#!/usr/bin/env node
/**
 * Scores review guides against the calibration set (docs/concepts/review-guide.md,
 * 6.5, mechanism 5).
 *
 * Rules give the score, never a model: the same principle as the evaluation
 * suite of issue #21. A case is a pull request a person rated group by group.
 * A run is the `report.json` the guide wrote for that pull request, taken from
 * the `pitcrew-review-guide` artifact or from the runner of #21 once it exists.
 * The harness then rates the report exactly as it does on a pull request, and
 * this script compares the reading mode of every rated group with the person's.
 *
 *   node eval/review-guide/score.mjs --runs <dir>
 *
 * `<dir>` holds one `<case>.json` per case, the report of that case. A case
 * without a report is listed as not run. The diff of a case comes from git
 * (`base` and `head` in its case.json), so run this in a full clone.
 *
 * The three numbers, and their goals:
 *
 *   false alarms  routine pull requests with at least one focus area   near 0
 *   missed        groups rated "read closely" that the guide did not   near 0
 *                 rate so; and any of them under "skim" is a failure
 *   kappa         agreement per group, linear weights over the modes   high
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lineKey, linesInRange, changedLines, parseDiff } from '../../scripts/guide-diff.mjs';
import { MODES, assessGuide, normaliseRange, parseFloors, DEFAULT_FLOORS } from '../../scripts/guide.mjs';

const ORDER = ['skim', 'check', 'read'];

/** The mode a guide gave a line: the highest mode of the groups that hold it. */
export function modesByLine(assessment) {
  const modes = new Map();
  for (const group of assessment.groups) {
    for (const range of group.ranges) {
      const file = assessment.index.get(range.file);
      const lines = range.whole ? changedLines(file) : linesInRange(file, range.from, range.to).filter(line => line.kind !== ' ');
      for (const line of lines) {
        const key = lineKey(file.path, line);
        const before = modes.get(key);
        if (!before || MODES[group.mode].rank > MODES[before].rank) modes.set(key, group.mode);
      }
    }
  }
  return modes;
}

/**
 * The mode the guide gave a rated group: the mode most of its changed lines
 * got, the higher one on a tie. A guide may cut the change differently from
 * the person; the lines are what both describe.
 */
export function modeOfRatedGroup(rated, index, modes) {
  const count = { skim: 0, check: 0, read: 0 };
  for (const raw of rated.ranges ?? []) {
    const range = normaliseRange(raw, index);
    if (range.error) continue;
    const file = index.get(range.file);
    const lines = range.whole ? changedLines(file) : linesInRange(file, range.from, range.to).filter(line => line.kind !== ' ');
    for (const line of lines) count[modes.get(lineKey(file.path, line)) ?? 'check'] += 1;
  }
  const total = count.skim + count.check + count.read;
  if (total === 0) return null;
  return [...ORDER].reverse().reduce((best, mode) => (count[mode] > count[best] ? mode : best), 'read');
}

/** Cohen's kappa with linear weights over skim < check < read. */
export function weightedKappa(pairs) {
  const n = pairs.length;
  if (n === 0) return null;
  const k = ORDER.length;
  const weight = (i, j) => 1 - Math.abs(i - j) / (k - 1);
  const observed = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const [a, b] of pairs) observed[ORDER.indexOf(a)][ORDER.indexOf(b)] += 1;
  const rows = observed.map(row => row.reduce((sum, value) => sum + value, 0));
  const cols = ORDER.map((_, j) => observed.reduce((sum, row) => sum + row[j], 0));
  let po = 0;
  let pe = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      po += (weight(i, j) * observed[i][j]) / n;
      pe += (weight(i, j) * rows[i] * cols[j]) / (n * n);
    }
  }
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

/** One case: the guide's mode for every rated group, and whether it raised a false alarm. */
export function scoreCase(rated, report, diff, options = {}) {
  const assessment = assessGuide(report, diff, { floors: parseFloors(DEFAULT_FLOORS).rules, ...options });
  const modes = modesByLine(assessment);
  const groups = (rated.groups ?? []).map(group => ({
    title: group.title,
    expected: group.mode,
    got: modeOfRatedGroup(group, assessment.index, modes),
  }));
  const focus = assessment.groups.filter(group => group.mode !== 'skim').length;
  return { groups, focus, falseAlarm: rated.kind === 'routine' && focus > 0 };
}

export function summarise(cases) {
  const pairs = cases.flatMap(entry => entry.groups.filter(group => group.got).map(group => [group.expected, group.got]));
  const critical = cases.flatMap(entry => entry.groups.filter(group => group.expected === 'read'));
  const routine = cases.filter(entry => entry.kind === 'routine');
  return {
    falseAlarms: routine.filter(entry => entry.falseAlarm).length,
    routine: routine.length,
    missed: critical.filter(group => group.got !== 'read').length,
    skimmed: critical.filter(group => group.got === 'skim').length,
    critical: critical.length,
    kappa: weightedKappa(pairs),
  };
}

function caseDiff(dir, rated) {
  const file = join(dir, 'case.diff');
  if (existsSync(file)) return readFileSync(file, 'utf8');
  return execFileSync('git', ['diff', `${rated.base}...${rated.head}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function caseTree(dir, rated) {
  const file = join(dir, 'tree.txt');
  const text = existsSync(file)
    ? readFileSync(file, 'utf8')
    : execFileSync('git', ['ls-tree', '-r', '--name-only', rated.head], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return new Set(text.split('\n').filter(Boolean));
}

function main() {
  const at = process.argv.indexOf('--runs');
  const runs = at > 0 ? process.argv[at + 1] : '';
  if (!runs || !existsSync(runs)) {
    console.error('Usage: node eval/review-guide/score.mjs --runs <dir with one <case>.json report per case>');
    process.exit(1);
  }
  const casesDir = join(dirname(fileURLToPath(import.meta.url)), 'cases');
  const results = [];
  const lines = ['| Case | Kind | Rated groups | Same mode | Missed "read closely" | Focus areas |', '| --- | --- | --- | --- | --- | --- |'];
  for (const name of readdirSync(casesDir).sort()) {
    const dir = join(casesDir, name);
    const rated = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'));
    const reportFile = join(runs, `${name}.json`);
    if (!existsSync(reportFile)) {
      lines.push(`| ${name} | ${rated.kind} | ${rated.groups.length} | not run | | |`);
      continue;
    }
    const tree = caseTree(dir, rated);
    const scored = scoreCase(rated, JSON.parse(readFileSync(reportFile, 'utf8')), parseDiff(caseDiff(dir, rated)), {
      exists: path => tree.has(path),
    });
    results.push({ name, kind: rated.kind, ...scored });
    const same = scored.groups.filter(group => group.got === group.expected).length;
    const missed = scored.groups.filter(group => group.expected === 'read' && group.got !== 'read').length;
    lines.push(`| ${name} | ${rated.kind} | ${scored.groups.length} | ${same} | ${missed} | ${scored.focus}${scored.falseAlarm ? ' (false alarm)' : ''} |`);
  }
  const total = summarise(results);
  lines.push(
    '',
    `False alarms: ${total.falseAlarms} of ${total.routine} routine pull requests.`,
    `Missed: ${total.missed} of ${total.critical} groups rated "read closely"; ${total.skimmed} of them under "skim".`,
    `Weighted kappa: ${total.kappa === null ? 'no rated group' : total.kappa.toFixed(2)}.`,
  );
  console.log(lines.join('\n'));
  process.exit(total.skimmed > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
