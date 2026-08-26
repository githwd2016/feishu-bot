import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAllowedPr,
  gitcodePrMetadata,
  isGitCodePrWip,
  parsePrUrl,
  prFromGitCodeData,
} from '../src/pr.js';

test('parsePrUrl extracts and canonicalizes a GitCode PR URL', () => {
  assert.deepEqual(parsePrUrl('请看 https://gitcode.com/Org_Name/repo.js/pull/42?x=1'), {
    owner: 'Org_Name',
    repo: 'repo.js',
    number: 42,
    repoKey: 'org_name/repo.js',
    key: 'org_name/repo.js#42',
    url: 'https://gitcode.com/Org_Name/repo.js/pull/42',
  });
});

test('GitCode WIP helper accepts API flags and the title marker', () => {
  assert.equal(isGitCodePrWip({ draft: true }), true);
  assert.equal(isGitCodePrWip({ work_in_progress: 1 }), true);
  assert.equal(isGitCodePrWip({ work_in_progress: 'true' }), true);
  assert.equal(isGitCodePrWip({ title: ' [WIP] refactor scanner' }), true);
  assert.equal(isGitCodePrWip({ draft: false, work_in_progress: 0, title: 'Handle WIP labels' }), false);
});

test('assertAllowedPr rejects repositories outside the allowlist', () => {
  const pr = parsePrUrl('https://gitcode.com/a/b/pull/1');
  assert.throws(() => assertAllowedPr(pr, new Set(['x/y'])), /不在白名单/);
  assert.equal(assertAllowedPr(pr, new Set(['a/b'])), pr);
});

test('GitCode PR response helpers normalize references and routing metadata', () => {
  assert.equal(prFromGitCodeData({
    number: 12,
    base: { repo: { path: 'repo', name_space: { path: 'Org' } } },
  }).key, 'org/repo#12');
  assert.deepEqual(gitcodePrMetadata({
    user: { login: 'Author' },
    head: { sha: 'abcdef' },
    assignees: [{ login: 'LiSi' }, { username: 'lisi' }, { login: 'WangWu' }],
  }), {
    authorLogin: 'Author',
    headSha: 'abcdef',
    assigneeLogins: ['lisi', 'wangwu'],
  });
});
