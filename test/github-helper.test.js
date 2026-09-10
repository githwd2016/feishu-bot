import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/github-api.js', import.meta.url));
function run(url, target, allowed = 'org/repo') {
  return spawnSync(process.execPath, [helper, 'reply', url,
    '--discussion-id', 'thread', '--body-file', '/does/not/matter', '--confirm-target', target,
  ], { encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: 'test-token', GITHUB_ALLOWED_REPOS: allowed } });
}

test('GitHub helper rejects platform, allowlist and exact target mismatches before network or file reads', () => {
  for (const [url, target, allowed, pattern] of [
    ['https://gitcode.com/org/repo/pull/7', 'org/repo#7', 'org/repo', /仅支持 github/],
    ['https://github.com/org/repo/pull/7', 'org/repo#7', 'org/repo', /写入确认目标不匹配/],
    ['https://github.com/org/repo/pull/7', 'github:org/repo#8', 'org/repo', /写入确认目标不匹配/],
    ['https://github.com/org/repo/pull/7', 'github:org/repo#7', 'other/repo', /不在白名单/],
    ['https://github.com/org/repo/pull/7', 'github:org/repo#7', '', /GITHUB_ALLOWED_REPOS/],
  ]) {
    const result = run(url, target, allowed);
    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
  }
});
