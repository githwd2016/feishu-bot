import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('discussion write fallback rejects a mismatched exact PR confirmation', () => {
  const result = spawnSync(process.execPath, [
    path.join(projectRoot, 'scripts', 'gitcode-api.js'),
    'reply', 'https://gitcode.com/org/repo/pull/9',
    '--discussion-id', 'discussion', '--body-file', '/does/not/matter',
    '--confirm-target', 'org/repo#10',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITCODE_TOKEN: 'test-token',
      GITCODE_ALLOWED_REPOS: 'org/repo',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /写入确认目标不匹配/);
});
