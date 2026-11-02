import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { shapeReport } from './report.mjs';
import { isUsableReport, normaliseReport } from './recover-report.mjs';
import writeReport from './write_report.js';

const guide = {
  summary: 'What and why.',
  intent: { source: 'description', fit: 'matches', outside: [] },
  groups: [{ id: 'a', title: 'A', categories: ['routine'], consequence: 'none', safeguards: 'none', ranges: [{ file: 'a.md' }] }],
  order: ['a'],
  diagrams: [],
  notAssessed: [],
};

describe('the guide report kind', () => {
  it('keeps the guide fields and drops findings and criteria', () => {
    const shaped = shapeReport({ ...guide, findings: [{ title: 't', body: 'b' }], criteria: [{ title: 'c' }] }, 'guide');
    assert.deepEqual(shaped.findings, []);
    assert.deepEqual(shaped.criteria, []);
    assert.deepEqual(shaped.dropped, ['1 finding', '1 criterion']);
    assert.equal(shaped.verdict, 'pass');
    assert.deepEqual(shaped.guide.groups, guide.groups);
    assert.deepEqual(shaped.guide.intent, guide.intent);
  });

  it('does not grow guide fields on the other kinds', () => {
    assert.equal(shapeReport({ verdict: 'pass', ...guide }, 'findings').guide, undefined);
  });

  it('survives the recovery from a session, without a verdict', () => {
    assert.equal(isUsableReport({ groups: [] }), true);
    const normal = normaliseReport(guide);
    assert.equal(normal.verdict, 'pass');
    assert.deepEqual(normal.groups, guide.groups);
    assert.deepEqual(normal.order, ['a']);
    assert.equal(normaliseReport({ verdict: 'fail', findings: [] }).groups, undefined);
  });

  it('is written by the write_report tool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pitcrew-report-'));
    const target = join(dir, 'report.json');
    const before = process.env.REPORT_FILE;
    process.env.REPORT_FILE = target;
    try {
      await writeReport.execute(guide);
    } finally {
      if (before === undefined) delete process.env.REPORT_FILE;
      else process.env.REPORT_FILE = before;
    }
    const written = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(written.verdict, 'pass');
    assert.deepEqual(written.groups, guide.groups);
    assert.deepEqual(written.intent, guide.intent);
  });
});
