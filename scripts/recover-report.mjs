/**
 * Turns a finished OpenCode session into the report file the rest of the run
 * reads, when the agent reviewed the diff but never wrote that file.
 *
 * Prompting it to write the file has been tried, more than once, and is not the
 * lever: over four consecutive runs of one pull request the security agent
 * skipped the file three times, with the same prompt structure the bug agent
 * obeys. What it *does* leave behind is the session — tool calls and the text
 * of its reply. This module reads those and, if a usable report is in there,
 * writes the file. No second model call.
 *
 * Sources, newest first:
 *
 *   1. A `write_report` tool call. That tool exists so the agent has one
 *      obvious place to put the result; its arguments *are* the report.
 *   2. A `write` / `edit` of the report file. Same content, older path.
 *   3. A JSON object in the agent's *last* reply. The review was done; it just
 *      landed in the text instead of a tool call. Earlier assistant messages
 *      and any object that already appears in the prompt, the diff, or a tool
 *      output are ignored: that is quoted input, not a submitted report.
 *
 * User messages are ignored: the prompt contains a worked example, and taking
 * that would publish the example as the review.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const WRITE_TOOLS = new Set(['write', 'edit', 'write_report']);

/**
 * A report the publisher can turn into a comment.
 *
 * `verdict` is the one field the frame cannot invent. Findings and criteria
 * may be empty — that is a clean review, not a missing one. A random object
 * with neither a verdict nor a list is not a report.
 */
export function isUsableReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  // A guide judges nothing; its groups are what make it a report.
  const guide = Array.isArray(value.groups);
  if (!guide && (typeof value.verdict !== 'string' || !value.verdict.trim())) return false;
  if (value.findings !== undefined && !Array.isArray(value.findings)) return false;
  if (value.criteria !== undefined && !Array.isArray(value.criteria)) return false;
  return true;
}

const GUIDE_FIELDS = ['intent', 'groups', 'order', 'diagrams', 'notAssessed'];

export function normaliseReport(value) {
  const report = {
    verdict: typeof value.verdict === 'string' && value.verdict.trim() ? value.verdict.trim() : 'pass',
    summary: typeof value.summary === 'string' ? value.summary : '',
    findings: Array.isArray(value.findings) ? value.findings : [],
    criteria: Array.isArray(value.criteria) ? value.criteria : [],
  };
  // The review guide's fields, kept as they are. Without them a recovered
  // guide would be a summary and nothing else.
  if (Array.isArray(value.groups)) {
    for (const key of GUIDE_FIELDS) if (value[key] !== undefined) report[key] = value[key];
  }
  return report;
}

export function writeReportFile(reportFile, report) {
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(normaliseReport(report), null, 2)}\n`, 'utf8');
}

/**
 * Whether a tool call was aimed at the report file this run is waiting for.
 *
 * Absolute paths, relative paths, and a write that only got the basename all
 * happen; the comparison is on the suffix, not on string equality. A write of
 * some other file in `.pitcrew-run/` is not a report.
 */
export function isReportPath(filePath, reportFile) {
  const value = String(filePath ?? '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '');
  if (!value) return false;

  const expected = String(reportFile ?? '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '');
  if (expected && value === expected) return true;

  // The working directory of these runs, by name. A `report.json` anywhere
  // else in the tree is not this file.
  return /(?:^|\/)\.pitcrew-run\/report\.json$/.test(value);
}

/**
 * The first complete JSON document in a string, or '' when there is none.
 *
 * Copied in spirit from publish-transcript.mjs: bracket-counting rather than
 * first-brace-to-last, so a log line after the document cannot break the parse.
 */
export function carve(text) {
  const start = String(text ?? '').search(/[[{]/);
  if (start < 0) return '';

  const closing = { '{': '}', '[': ']' };
  const stack = [];
  let inString = false;
  let escaped = false;
  const source = String(text);

  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') stack.push(closing[char]);
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return '';
      if (stack.length === 0) return source.slice(start, i + 1);
    }
  }
  return '';
}

export function carveAll(text) {
  const found = [];
  let rest = String(text ?? '');
  while (rest) {
    const doc = carve(rest);
    if (!doc) break;
    const at = rest.indexOf(doc);
    found.push(doc);
    rest = rest.slice(at + doc.length);
  }
  return found;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asReport(value) {
  if (isUsableReport(value)) return value;
  if (value && typeof value === 'object' && isUsableReport(value.report)) return value.report;
  return null;
}

/**
 * A report recovered from prose, not from a tool call.
 *
 * The tool paths are intent-bearing: the agent chose `write_report` or wrote
 * the file. Text is not. A verdict alone, or an object the agent only echoed
 * from the diff, must not become the published result — that is how a `pass`
 * would be minted from a fixture in the pull request.
 */
function asTextReport(value) {
  const report = asReport(value);
  if (!report) return null;
  if (typeof report.summary !== 'string' || !report.summary.trim()) return null;
  if (!Array.isArray(report.findings) && !Array.isArray(report.criteria) && !Array.isArray(report.groups)) return null;
  return report;
}

function fingerprint(report) {
  return JSON.stringify(normaliseReport(report));
}

function reportsInText(text) {
  const found = [];
  for (const doc of carveAll(text)) {
    const parsed = asReport(parseJson(doc));
    if (parsed) found.push(fingerprint(parsed));
  }
  return found;
}

function collectStrings(value, into, skipKeys = new Set()) {
  if (typeof value === 'string') {
    if (value.trim()) into.push(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into, skipKeys);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (skipKeys.has(key)) continue;
    collectStrings(nested, into, skipKeys);
  }
}

function toolOutputText(part) {
  const chunks = [];
  const state = part?.state;
  if (state && typeof state === 'object') {
    collectStrings(state, chunks, new Set(['input', 'args']));
  }
  collectStrings(part?.output, chunks);
  collectStrings(part?.result, chunks);
  return chunks.join('\n');
}

/**
 * Report-shaped JSON that was already in the session as *input* to the agent:
 * the prompt (worked example), the diff, file reads, other tool output.
 *
 * A match against this set is an echo, not a submission.
 */
export function untrustedReportFingerprints(session, extraUntrusted = '') {
  const messages = messagesOf(session);
  const set = new Set();
  const add = text => {
    for (const fp of reportsInText(text)) set.add(fp);
  };

  add(extraUntrusted);
  for (const message of messages) {
    if (roleOf(message) === 'user') {
      for (const part of partsOf(message)) add(String(part?.text ?? ''));
      continue;
    }
    for (const part of partsOf(message)) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'tool' || WRITE_TOOLS.has(toolName(part))) add(toolOutputText(part));
    }
  }
  return set;
}

function lastAssistantIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (roleOf(messages[i]) === 'assistant') return i;
  }
  return -1;
}

function toolName(part) {
  return String(part?.tool ?? part?.name ?? '').toLowerCase();
}

function toolInput(part) {
  return part?.state?.input ?? part?.input ?? part?.args ?? {};
}

function toolFailed(part) {
  const status = part?.state?.status ?? part?.status;
  return status === 'error' || status === 'failed';
}

function contentFromWrite(input) {
  for (const key of ['content', 'newString', 'new_string', 'contents']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key];
  }
  return '';
}

function filePathFromWrite(input) {
  for (const key of ['filePath', 'path', 'file_path', 'filepath']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key];
  }
  return '';
}

function messagesOf(session) {
  if (Array.isArray(session?.messages)) return session.messages;
  if (Array.isArray(session)) return session;
  return [];
}

function partsOf(message) {
  if (Array.isArray(message?.parts)) return message.parts;
  if (Array.isArray(message?.content)) return message.content;
  return [];
}

function roleOf(message) {
  return String(message?.info?.role ?? message?.role ?? '').toLowerCase();
}

/**
 * The newest usable report in the session, and where it came from.
 *
 * `null` when the session contains a review in prose but no structured report:
 * inventing fields from that prose is exactly the guess this pipeline refuses
 * to make. The caller then asks the same session for `write_report`.
 */
export function recoverReport(session, reportFile = '', extraUntrusted = '') {
  const messages = messagesOf(session);
  const echoed = untrustedReportFingerprints(session, extraUntrusted);
  const lastAssistant = lastAssistantIndex(messages);

  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const message = messages[m];
    if (roleOf(message) === 'user') continue;

    const parts = partsOf(message);
    for (let p = parts.length - 1; p >= 0; p -= 1) {
      const part = parts[p];
      if (!part || typeof part !== 'object') continue;

      if (part.type === 'tool' || WRITE_TOOLS.has(toolName(part))) {
        if (toolFailed(part)) continue;
        const name = toolName(part);
        const input = toolInput(part);

        if (name === 'write_report' || name.endsWith('_write_report')) {
          const report = asReport(input);
          if (report) return { report, source: 'write_report' };
          continue;
        }

        if (name === 'write' || name === 'edit') {
          if (!isReportPath(filePathFromWrite(input), reportFile)) continue;
          const raw = contentFromWrite(input);
          const parsed = asReport(parseJson(raw)) ?? asReport(parseJson(carve(raw)));
          if (parsed) return { report: parsed, source: name };
        }
        continue;
      }

      if (m !== lastAssistant) continue;
      if (part.type === 'text' || typeof part.text === 'string') {
        if (part.synthetic || part.ignored) continue;
        const text = String(part.text ?? '');
        // Last carved object first: a reply that quotes the prompt's example
        // and then writes the real report puts the real one second.
        const docs = carveAll(text);
        for (let d = docs.length - 1; d >= 0; d -= 1) {
          const parsed = asTextReport(parseJson(docs[d]));
          if (!parsed) continue;
          if (echoed.has(fingerprint(parsed))) continue;
          return { report: parsed, source: 'text' };
        }
      }
    }
  }

  return null;
}
