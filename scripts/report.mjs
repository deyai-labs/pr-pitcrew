/**
 * The shape of an agent's report, and the one rule about it that is not the
 * agent's to break.
 */

const isFinding = value =>
  value && typeof value === 'object' && typeof value.title === 'string' && typeof value.body === 'string';

const isCriterion = value => value && typeof value === 'object' && typeof value.title === 'string';

/**
 * What an agent is allowed to have written down, decided by what kind of agent
 * it is rather than by what it happened to produce.
 *
 * `findings` are anchored in the diff; `criteria` are anchored in behaviour; a
 * `guide` carries groups of changes and reports neither (ADR 10). An
 * agent that drives a running application through its interface never sees the
 * source, so a file and a line from it would be a guess wearing the clothes of
 * evidence - and a reader cannot tell those two apart. The prompt says as much;
 * this is what makes it true whatever the model does.
 *
 * `unknown` is the permissive default, for a caller that did not say. Dropping
 * fields for a kind we do not recognise would be the silent kind of strictness.
 */
export function shapeReport(parsed, kind = 'unknown') {
  const findings = Array.isArray(parsed.findings) ? parsed.findings.filter(isFinding) : [];
  const criteria = Array.isArray(parsed.criteria) ? parsed.criteria.filter(isCriterion) : [];
  const dropped = [];

  if (kind === 'criteria' && findings.length) {
    dropped.push(`${findings.length} finding${findings.length === 1 ? '' : 's'}`);
    findings.length = 0;
  }
  if (kind === 'findings' && criteria.length) {
    dropped.push(`${criteria.length} criteri${criteria.length === 1 ? 'on' : 'a'}`);
    criteria.length = 0;
  }
  // The guide reports neither: it points attention, it does not judge code.
  // A finding in a guide would reach the pull request without the gate, the
  // dedup and the anchoring that make a finding worth reading.
  if (kind === 'guide') {
    if (findings.length) dropped.push(`${findings.length} finding${findings.length === 1 ? '' : 's'}`);
    if (criteria.length) dropped.push(`${criteria.length} criteri${criteria.length === 1 ? 'on' : 'a'}`);
    findings.length = 0;
    criteria.length = 0;
  }

  const shaped = {
    verdict: typeof parsed.verdict === 'string' ? parsed.verdict : kind === 'guide' ? 'pass' : 'attention',
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    findings,
    criteria,
    dropped,
  };
  if (kind === 'guide') {
    shaped.guide = {
      intent: parsed.intent,
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      order: Array.isArray(parsed.order) ? parsed.order : [],
      diagrams: Array.isArray(parsed.diagrams) ? parsed.diagrams : [],
      notAssessed: Array.isArray(parsed.notAssessed) ? parsed.notAssessed : [],
    };
  }
  return shaped;
}

