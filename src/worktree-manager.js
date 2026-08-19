import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class WorktreeManager {
  constructor({ tempRoot = os.tmpdir(), runGit = defaultRunGit } = {}) {
    this.tempRoot = path.resolve(tempRoot);
    this.runGit = runGit;
  }

  async run({ repository, label }, task) {
    const repositoryRoot = await this.#validateRepository(repository);
    const safeLabel = String(label).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'pr';
    const container = await fs.mkdtemp(path.join(this.tempRoot, `feishu-review-${safeLabel}-`));
    const worktree = path.join(container, 'worktree');
    let registered = false;
    let result;
    let taskError;

    try {
      await this.runGit(['-C', repositoryRoot, 'worktree', 'add', '--detach', worktree, 'HEAD']);
      registered = true;
      console.log(`[worktree] 已创建 ${label} path=${worktree} source=${repositoryRoot}`);
      result = await task(worktree);
    } catch (error) {
      taskError = error;
    }

    const cleanupError = await this.#cleanup({ repositoryRoot, container, worktree, registered, label });
    if (taskError) {
      if (cleanupError) console.error(`[worktree] ${label} 原任务失败且清理失败: ${cleanupError.message}`);
      throw taskError;
    }
    if (cleanupError) throw cleanupError;
    return result;
  }

  async #validateRepository(repository) {
    const configured = await fs.realpath(repository).catch(() => {
      throw new Error(`REPO_WORKDIRS_JSON 路径不存在: ${repository}`);
    });
    const { stdout } = await this.runGit(['-C', configured, 'rev-parse', '--show-toplevel']);
    const topLevel = await fs.realpath(stdout.trim());
    if (topLevel !== configured) {
      throw new Error(`REPO_WORKDIRS_JSON 必须指向 Git 仓库根目录: ${repository}，实际根目录为 ${topLevel}`);
    }
    await this.runGit(['-C', configured, 'rev-parse', '--verify', 'HEAD^{commit}']);
    return configured;
  }

  async #cleanup({ repositoryRoot, container, worktree, registered, label }) {
    try {
      this.#assertTemporaryContainer(container);
      if (registered) {
        try {
          await this.runGit(['-C', repositoryRoot, 'worktree', 'remove', '--force', worktree]);
        } catch (error) {
          console.warn(`[worktree] git worktree remove 失败，改用受限路径清理: ${error.message}`);
          await fs.rm(worktree, { recursive: true, force: true });
        }
      } else {
        await fs.rm(worktree, { recursive: true, force: true });
      }
      await this.runGit(['-C', repositoryRoot, 'worktree', 'prune', '--expire', 'now']);
      const { stdout } = await this.runGit(['-C', repositoryRoot, 'worktree', 'list', '--porcelain']);
      if (stdout.split(/\r?\n/).includes(`worktree ${worktree}`)) {
        throw new Error(`Git 仍记录临时 worktree: ${worktree}`);
      }
      await fs.rm(container, { recursive: true, force: true });
      console.log(`[worktree] 已清理 ${label} path=${worktree}`);
      return null;
    } catch (error) {
      return new Error(`临时 worktree 清理失败 ${worktree}: ${error.message}`);
    }
  }

  #assertTemporaryContainer(container) {
    const resolved = path.resolve(container);
    if (!resolved.startsWith(`${this.tempRoot}${path.sep}`)
      || !path.basename(resolved).startsWith('feishu-review-')) {
      throw new Error(`拒绝清理非机器人临时目录: ${resolved}`);
    }
  }
}

async function defaultRunGit(args) {
  return execFileAsync('git', args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
  });
}
