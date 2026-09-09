import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAllowedPr,
  gitcodePrMetadata,
  isGitCodePrWip,
  parsePrUrl,
  prFromGitCodeData,
  prFromData,
  prMetadata,
} from '../src/pr.js';

test('parsePrUrl extracts and canonicalizes a GitCode PR URL', () => {
  assert.deepEqual(parsePrUrl('请看 https://gitcode.com/Org_Name/repo.js/pull/42?x=1'), {
    provider: 'gitcode',
    owner: 'Org_Name',
    repo: 'repo.js',
    number: 42,
    repoKey: 'org_name/repo.js',
    key: 'org_name/repo.js#42',
    url: 'https://gitcode.com/Org_Name/repo.js/pull/42',
  });
});

test('GitHub PRs preserve platform identity and cannot pass a GitCode allowlist', () => {
  const github = parsePrUrl('请审查 https://github.com/Org/Repo/pull/42/files#diff-123');
  const gitcode = parsePrUrl('https://gitcode.com/Org/Repo/pull/42');
  assert.equal(github.provider, 'github');
  assert.equal(github.key, 'github:org/repo#42');
  assert.notEqual(github.key, gitcode.key);
  assert.equal(github.url, 'https://github.com/Org/Repo/pull/42');
  assert.throws(() => assertAllowedPr(github, new Set(['org/repo'])), /仅支持 gitcode/);
  assert.equal(assertAllowedPr(github, new Set(['org/repo']), 'github'), github);
  assert.equal(prFromData({ number: 42, base: { repo: { name: 'Repo', owner: { login: 'Org' } } } }, 'github').key, github.key);
  for (const url of ['https://github.com/Org/Repo/pull/0', 'https://github.com/Org/Repo/pull/42evil', 'https://github.com.evil/Org/Repo/pull/42']) {
    assert.equal(parsePrUrl(url), null);
  }
});

test('GitHub routing uses requested and previous reviewers, not issue assignees', () => {
  assert.deepEqual(prMetadata({
    user: { login: 'author' }, head: { sha: 'sha' },
    assignees: [{ login: 'not-a-reviewer' }],
    requested_reviewers: [{ login: 'Reviewer' }],
    reviewed_by: [{ login: 'reviewer' }, { login: 'previous-reviewer' }],
  }, 'github'), { authorLogin: 'author', headSha: 'sha', assigneeLogins: ['reviewer', 'previous-reviewer'] });
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
