import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseDiff } from '../../scripts/guide-diff.mjs';
import { scoreCase, summarise, weightedKappa } from './score.mjs';

const added = (path, count) =>
  [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${count} @@`, ...Array.from({ length: count }, (_, i) => `+${i}`)].join('\n');

const diff = parseDiff(`${added('src/pay.js', 10)}\n${added('docs/a.md', 5)}\n`);
const group = (id, file, consequence, categories = ['domain']) => ({
  id,
  title: id,
  categories,
  consequence,
  scenario: 'x',
  safeguards: 'none',
  ranges: [{ file }],
});

describe('the calibration score', () => {
  it('agrees fully with itself, and not at all with the opposite', () => {
    assert.equal(weightedKappa([['read', 'read'], ['skim', 'skim'], ['check', 'check']]), 1);
    assert.ok(weightedKappa([['read', 'skim'], ['skim', 'read'], ['check', 'check']]) < 0);
  });

  it('compares the mode of every rated group, line by line', () => {
    const rated = { kind: 'mixed', groups: [{ title: 'Pay', mode: 'read', ranges: [{ file: 'src/pay.js' }] }, { title: 'Docs', mode: 'skim', ranges: [{ file: 'docs/a.md' }] }] };
    const report = { groups: [group('pay', 'src/pay.js', 'severe'), group('docs', 'docs/a.md', 'none', ['routine'])] };
    const scored = scoreCase(rated, report, diff);
    assert.deepEqual(scored.groups.map(entry => entry.got), ['read', 'skim']);
    assert.equal(scored.falseAlarm, false);
  });

  it('counts a focus area in a routine pull request as a false alarm, and a skimmed critical group as missed', () => {
    const routine = scoreCase({ kind: 'routine', groups: [{ title: 'Docs', mode: 'skim', ranges: [{ file: 'docs/a.md' }] }] }, { groups: [group('d', 'docs/a.md', 'moderate')] }, diff);
    assert.equal(routine.falseAlarm, true);

    const critical = scoreCase({ kind: 'critical', groups: [{ title: 'Pay', mode: 'read', ranges: [{ file: 'src/pay.js' }] }] }, { groups: [group('p', 'src/pay.js', 'none')] }, diff);
    const total = summarise([{ kind: 'routine', ...routine }, { kind: 'critical', ...critical }]);
    assert.equal(total.falseAlarms, 1);
    assert.equal(total.missed, 1);
    assert.equal(total.skimmed, 1);
  });

  it('rates lines no group holds as the harness does: check', () => {
    const scored = scoreCase({ kind: 'mixed', groups: [{ title: 'Pay', mode: 'check', ranges: [{ file: 'src/pay.js' }] }] }, { groups: [] }, diff);
    assert.equal(scored.groups[0].got, 'check');
  });
});
