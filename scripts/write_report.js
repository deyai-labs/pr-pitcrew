/**
 * Submits the structured report this run publishes.
 *
 * The filename is the tool name (`write_report`). Arguments are JSON Schema
 * rather than Zod so this file has no package to install: OpenCode loads it
 * from `~/.config/opencode/tools/` (copied there by the composite action) and
 * accepts either form.
 *
 * It writes `REPORT_FILE` itself. The generic write/edit tools remain as a
 * fallback the recover step can still read; this is the call the prompts name.
 */

const finding = {
  type: 'object',
  additionalProperties: true,
  properties: {
    file: { type: 'string', description: 'Path relative to the repository root.' },
    line: { type: 'integer', description: 'Line in the new version of the file.' },
    severity: { type: 'string', enum: ['high', 'medium', 'low'] },
    title: { type: 'string', description: 'Short, specific, no punctuation at the end.' },
    body: { type: 'string', description: 'What goes wrong, for which input, and how to fix it.' },
  },
  required: ['title', 'body'],
};

const criterion = {
  type: 'object',
  additionalProperties: true,
  properties: {
    title: { type: 'string', description: 'The criterion, as the issue words it.' },
    status: { type: 'string', enum: ['met', 'unmet', 'not-demonstrable'] },
    at: { type: 'string', description: 'Timestamp in the recording, mm:ss.' },
    evidence: { type: 'string', description: 'What you did and what the app showed.' },
  },
  required: ['title'],
};

const range = {
  file: { type: 'string', description: 'Path relative to the repository root, as the diff names it.' },
  from: { type: 'integer', description: 'First line. New side of the file; old side for a deleted file.' },
  to: { type: 'integer', description: 'Last line.' },
};

const group = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string', description: 'Short id, [a-z0-9-].' },
    title: { type: 'string' },
    categories: {
      type: 'array',
      items: { type: 'string', enum: ['domain', 'ux', 'security', 'privacy', 'data', 'architecture', 'operations', 'routine'] },
      description: 'One to three. routine stands alone.',
    },
    context: { type: 'string', description: 'One or two sentences: where this code sits and what it does.' },
    what: { type: 'string', description: 'What changes.' },
    consequence: { type: 'string', enum: ['severe', 'moderate', 'minor', 'none'] },
    reason: { type: 'string', description: 'An observation and a possible consequence, as your assessment.' },
    scenario: { type: 'string', description: 'The input or sequence that leads to the consequence.' },
    safeguards: { type: 'string', enum: ['strong', 'partial', 'none'] },
    evidence: { type: 'array', items: { type: 'string' }, description: 'Paths of tests or ADRs that back the safeguards.' },
    reversible: { type: 'boolean' },
    architecture: { type: 'string', description: 'Only with the category architecture.' },
    excerpt: { type: 'object', additionalProperties: true, properties: range, description: 'At most 15 lines.' },
    verify: {
      type: 'array',
      items: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' }, ...range } },
      description: 'At most three statements a reviewer confirms at these lines.',
    },
    ranges: {
      type: 'array',
      items: { type: 'object', additionalProperties: true, properties: range },
      description: 'The lines of the group. Without from and to, the whole file.',
    },
  },
  required: ['title', 'categories', 'consequence', 'safeguards', 'ranges'],
};

export default {
  description:
    'Submit what this run publishes (verdict, summary, and findings, criteria or the guide fields). Call it as soon as you have something, and again whenever it changes — the last call is the one that gets published. You MUST call it at least once before you reply, even when there is nothing to report: a reply without it is published as a failed review. Empty findings or criteria arrays are valid.',
  args: {
    verdict: {
      type: 'string',
      enum: ['pass', 'attention', 'fail'],
      description:
        'pass when nothing was found (or every criterion is met); attention for low/medium findings or undemonstrated criteria; fail when a finding is high or a criterion is unmet.',
    },
    summary: {
      type: 'string',
      description: 'One or two sentences shown above the inline comments.',
    },
    findings: {
      type: 'array',
      description: 'Defects, or an empty list. Used by bug and security review. Omit or leave empty for the acceptance test.',
      items: finding,
    },
    criteria: {
      type: 'array',
      description: 'Acceptance criteria, or an empty list. Used by the acceptance test. Omit or leave empty for a code review.',
      items: criterion,
    },
    intent: {
      type: 'object',
      additionalProperties: true,
      description: 'Review guide only. Whether the changes match the description or the linked issue.',
      properties: {
        source: { type: 'string', enum: ['issue', 'description', 'none'] },
        fit: { type: 'string', enum: ['matches', 'partly', 'unclear'] },
        outside: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { ...range, note: { type: 'string' } } } },
      },
    },
    groups: { type: 'array', description: 'Review guide only. The groups of changes.', items: group },
    order: { type: 'array', items: { type: 'string' }, description: 'Review guide only. Group ids in the order to read them.' },
    diagrams: {
      type: 'array',
      description: 'Review guide only. At most two flowcharts as data: nodes and edges.',
      items: { type: 'object', additionalProperties: true },
    },
    notAssessed: {
      type: 'array',
      description: 'Review guide only. Files you could not assess, with the reason.',
      items: { type: 'object', additionalProperties: true, properties: { file: { type: 'string' }, reason: { type: 'string' } } },
    },
  },
  async execute(args) {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');

    const target = (process.env.REPORT_FILE ?? '').trim();
    if (!target) {
      return 'REPORT_FILE is not set, so there is nowhere to write the report.';
    }

    const guide = Array.isArray(args.groups);
    const report = {
      // The guide judges nothing, so a missing verdict there is a pass.
      verdict: args.verdict ?? (guide ? 'pass' : undefined),
      summary: typeof args.summary === 'string' ? args.summary : '',
      findings: Array.isArray(args.findings) ? args.findings : [],
      criteria: Array.isArray(args.criteria) ? args.criteria : [],
    };
    if (guide) {
      for (const key of ['intent', 'groups', 'order', 'diagrams', 'notAssessed']) {
        if (args[key] !== undefined) report[key] = args[key];
      }
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return `Wrote the report to ${target}. Call this tool again if anything changes; reply when you are done.`;
  },
};
