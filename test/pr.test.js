import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAllowedPr,
  gitcodePrMetadata,
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
