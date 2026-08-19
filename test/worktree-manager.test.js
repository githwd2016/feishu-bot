import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorktreeManager } from '../src/worktree-manager.js';

const execFileAsync = promisify(execFile);

test('WorktreeManager removes a dirty temporary worktree when the task fails', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-manager-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, 'repo');
  const tempRoot = path.join(directory, 'temporary');
  await fs.mkdir(repository);
  await fs.mkdir(tempRoot);
  await git(repository, 'init', '-b', 'main');
  await git(repository, 'config', 'user.name', 'Review Bot Test');
  await git(repository, 'config', 'user.email', 'review-bot@example.com');
  await fs.writeFile(path.join(repository, 'tracked.txt'), 'tracked\n');
  await git(repository, 'add', 'tracked.txt');
  await git(repository, 'commit', '-m', 'initial');

  const manager = new WorktreeManager({ tempRoot });
  let createdPath;
  await assert.rejects(
    manager.run({ repository, label: 'org/repo#1' }, async (worktree) => {
      createdPath = worktree;
      await fs.writeFile(path.join(worktree, 'untracked.txt'), 'temporary\n');
      throw new Error('simulated agent failure');
    }),
    /simulated agent failure/,
  );

  await assert.rejects(fs.access(createdPath));
  const worktreeList = await git(repository, 'worktree', 'list', '--porcelain');
  assert.equal(worktreeList.stdout.match(/^worktree /gm)?.length, 1);
});

function git(cwd, ...args) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8' });
}
