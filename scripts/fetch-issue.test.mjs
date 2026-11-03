/**
 * The tests for the one decision fetch-issue.mjs makes: which issue, if any, a
 * pull request closes.
 *
 * Getting this wrong in the generous direction is worse than getting no issue
 * at all. The acceptance agent tests the change against the criteria in the
 * file it is handed; a neighbouring issue's criteria would send it looking for
 * behaviour nobody wrote, and the report would read exactly like a real
 * failure. Not finding an issue, by contrast, is a normal day - the prompt says
 * what to do then.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { describePullRequest, findIssueNumber } from './fetch-issue.mjs';

const repo = 'acme/widgets';

describe('closing keywords', () => {
  for (const keyword of ['Closes', 'closes', 'Closed', 'Close', 'Fixes', 'fixed', 'Fix', 'Resolves', 'resolved', 'Resolve']) {
    it(`recognises "${keyword} #12"`, () => {
      assert.equal(findIssueNumber(`${keyword} #12`, repo), 12);
    });
  }

  it('recognises the keyword with a colon and with plain whitespace', () => {
    assert.equal(findIssueNumber('Closes: #12', repo), 12);
    assert.equal(findIssueNumber('Closes:  #12', repo), 12);
    assert.equal(findIssueNumber('Fixes\n#12', repo), 12);
    assert.equal(findIssueNumber('Resolves   #12', repo), 12);
  });

  it('reads the keyword out of a body that says other things first', () => {
    const body = ['Adds the export button.', '', 'Closes #12', '', 'Reviewed by nobody yet.'].join('\n');
    assert.equal(findIssueNumber(body, repo), 12);
  });

  it('takes the first of several closing keywords', () => {
    assert.equal(findIssueNumber('Fixes #7\nCloses #9\nResolves #11', repo), 7);
  });
});

describe('the URL form, and only for this repository', () => {
  it('accepts a full URL into this repository, because that is what a paste produces', () => {
    assert.equal(findIssueNumber('Closes https://github.com/acme/widgets/issues/12', repo), 12);
    assert.equal(findIssueNumber('fixed https://github.com/acme/widgets/issues/12', repo), 12);
    assert.equal(findIssueNumber('Resolves: https://github.com/acme/widgets/issues/12', repo), 12);
  });

  it('refuses the same line when it points somewhere else', () => {
    // An agent that followed the link would be testing against criteria nobody
    // in this repository wrote.
    assert.equal(findIssueNumber('Closes https://github.com/acme/widgets/issues/12', 'acme/other'), null);
    assert.equal(findIssueNumber('Closes https://github.com/acme/widgets/issues/12', 'other/widgets'), null);
    assert.equal(findIssueNumber('Closes https://github.com/attacker/evil/issues/1', repo), null);
  });

  it('does not let a repository name with a dot match a neighbour', () => {
    // The repository is spliced into a regular expression, so its dot has to be
    // a dot and not "any character".
    assert.equal(findIssueNumber('Closes https://github.com/acme/site.io/issues/12', 'acme/site.io'), 12);
    assert.equal(findIssueNumber('Closes https://github.com/acme/siteXio/issues/12', 'acme/site.io'), null);
  });
});

describe('a mention is not a link', () => {
  it('ignores a bare number with no keyword', () => {
    assert.equal(findIssueNumber('#12', repo), null);
    assert.equal(findIssueNumber('Part of #12', repo), null);
  });

  it('ignores the words people use for a mention', () => {
    assert.equal(findIssueNumber('See #12', repo), null);
    assert.equal(findIssueNumber('Related to #12', repo), null);
    assert.equal(findIssueNumber('Follow-up to #12', repo), null);
  });

  it('ignores prose that happens to contain a number', () => {
    const body = [
      'This does not close anything yet.',
      '',
      'The same crash was reported in #12, but that one is about the importer',
      'and this only touches the exporter.',
    ].join('\n');
    assert.equal(findIssueNumber(body, repo), null);
  });

  it('ignores a bare URL nobody put a keyword in front of', () => {
    assert.equal(findIssueNumber('Background: https://github.com/acme/widgets/issues/12', repo), null);
  });
});

describe('an empty body', () => {
  it('is not an error, just no issue', () => {
    assert.equal(findIssueNumber('', repo), null);
    assert.equal(findIssueNumber(null, repo), null);
    assert.equal(findIssueNumber(undefined, repo), null);
    assert.equal(findIssueNumber('   \n\n  ', repo), null);
  });
});

describe('describePullRequest', () => {
  it('puts the title above the body, and says so when there is no body', () => {
    assert.equal(describePullRequest('Fix it', 'Closes #3.'), '# Fix it\n\nCloses #3.\n');
    assert.equal(describePullRequest('Fix it', null), '# Fix it\n\n(The pull request has no description.)\n');
  });
});
