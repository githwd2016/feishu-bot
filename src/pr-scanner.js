import {
  assertAllowedPr,
  gitcodePrMetadata,
  isGitCodePrWip,
  prFromGitCodeData,
} from './pr.js';
import { reviewerFromIdentity } from './workflow.js';

const ACTIVE_PHASES = new Set(['awaiting_review', 'addressing_feedback', 'awaiting_rereview']);

export class PrScanner {
  #running = false;
  #timer;
  #blockedWarnings = new Set();

  constructor({ config, store, gitcode, workflow, feishu, identities }) {
    this.config = config;
    this.store = store;
    this.gitcode = gitcode;
    this.workflow = workflow;
    this.feishu = feishu;
    this.identities = identities;
  }

  start() {
    if (!this.config.feishu.autoReviewChatId) {
      console.warn('[scanner] 未配置 AUTO_REVIEW_CHAT_ID，定时扫描已禁用；可在目标群发送“获取 chat_id”');
      return;
    }
    void this.scanOnce();
    this.#timer = setInterval(() => void this.scanOnce(), this.config.scan.intervalMs);
    this.#timer.unref();
    console.log(`[scanner] 已启动，间隔 ${this.config.scan.intervalMs / 1000} 秒`);
  }

  stop() {
    clearInterval(this.#timer);
  }

  async scanOnce() {
    if (this.#running) {
      console.log('[scanner] 上一轮仍在运行，跳过本轮');
      return false;
    }
    if (!this.config.feishu.autoReviewChatId) return false;
    this.#running = true;
    try {
      const [assigned, owned] = await Promise.all([
        this.gitcode.listUserPulls({ scope: 'need_my_approve', state: 'open' }),
        this.gitcode.listUserPulls({ scope: 'created_by_me', state: 'open' }),
      ]);
      for (const item of assigned) await this.#processAssigned(item);
      for (const item of owned) await this.#processOwned(item);
      return true;
    } catch (error) {
      console.error('[scanner] 扫描失败:', error);
      return false;
    } finally {
      this.#running = false;
    }
  }

  async #processAssigned(item) {
    try {
      const loaded = await this.#loadPr(item);
      if (!loaded) return;
      const { pr, metadata } = loaded;
      if (sameLogin(metadata.authorLogin, this.identities.self.gitcodeLogin)) return;
      const headSha = requiredHeadSha(metadata, pr);
      const key = `assigned-review|${pr.key}|${headSha}|${this.identities.self.gitcodeLogin.toLowerCase()}`;
      const authorIdentity = this.identities.byGitcodeLogin(metadata.authorLogin);
      await this.#runTask(key, {
        pr,
        headSha,
        responsibility: authorIdentity || this.identities.self,
        task: (lease) => this.workflow.reviewAutomatically({
          pr,
          authorIdentity,
          authorLogin: metadata.authorLogin,
          headSha,
          attempt: lease.attempts,
          maxAttempts: this.config.scan.maxAttempts,
        }),
      });
    } catch (error) {
      console.error('[scanner] 处理待审 PR 失败:', error);
    }
  }

  async #processOwned(item) {
    try {
      const loaded = await this.#loadPr(item);
      if (!loaded) return;
      const { pr, metadata } = loaded;
      if (!sameLogin(metadata.authorLogin, this.identities.self.gitcodeLogin)) return;
      const active = this.store.getPr(pr.key);
      if (active && ACTIVE_PHASES.has(active.phase)) return;

      const reviewerLogins = metadata.assigneeLogins.filter(
        (login) => !sameLogin(login, this.identities.self.gitcodeLogin),
      );
      if (reviewerLogins.length === 0) {
        await this.#warnBlocked(`no-reviewer|${pr.key}|${metadata.headSha}`,
          `PR 尚未配置其他审查人，无法自动分发：${pr.url}`);
        return;
      }

      const missing = reviewerLogins.filter((login) => !this.identities.byGitcodeLogin(login));
      if (missing.length > 0) {
        await this.#warnBlocked(`missing-reviewer|${pr.key}|${metadata.headSha}|${missing.sort().join(',')}`,
          `以下 GitCode 审查人缺少三方映射，未执行部分分发：${missing.join(', ')} ${pr.url}`);
        return;
      }

      const headSha = requiredHeadSha(metadata, pr);
      const candidates = reviewerLogins.map((login) => {
        const identity = this.identities.byGitcodeLogin(login);
        return {
          key: `owned-dispatch|${pr.key}|${headSha}|${login.toLowerCase()}`,
          reviewer: reviewerFromIdentity(identity),
        };
      }).filter(({ key }) => this.store.getAutomationTask(key)?.status !== 'succeeded');
      if (candidates.length === 0) return;

      const claimed = [];
      for (const candidate of candidates) {
        const lease = await this.#claim(candidate.key);
        if (lease) claimed.push(candidate);
      }
      if (claimed.length === 0) return;

      try {
        const result = await this.workflow.startAutomaticOwnedReview({
          pr,
          headSha,
          reviewers: claimed.map((item) => item.reviewer),
        });
        if (!result?.started) throw new Error(`自动分发未启动: ${result?.reason || 'unknown'}`);
        for (const { key } of claimed) await this.store.completeAutomationTask(key);
      } catch (error) {
        for (const { key } of claimed) {
          await this.#recordFailure(key, error, this.identities.self, pr, headSha);
        }
      }
    } catch (error) {
      console.error('[scanner] 处理本人 PR 失败:', error);
    }
  }

  async #loadPr(item) {
    const pr = prFromGitCodeData(item);
    if (!pr) throw new Error('GitCode PR 列表项缺少可识别的仓库或 PR 编号');
    if (this.config.gitcode.allowedRepos.size > 0 && !this.config.gitcode.allowedRepos.has(pr.repoKey)) return null;
    assertAllowedPr(pr, this.config.gitcode.allowedRepos);
    if (isGitCodePrWip(item)) {
      console.log(`[scanner] 跳过 WIP PR: ${pr.url}`);
      return null;
    }
    const details = await this.gitcode.getPr(pr);
    if (isGitCodePrWip(details)) {
      console.log(`[scanner] 跳过 WIP PR: ${pr.url}`);
      return null;
    }
    return { pr, details, metadata: gitcodePrMetadata(details) };
  }

  async #runTask(key, { pr, headSha, responsibility, task }) {
    const lease = await this.#claim(key);
    if (!lease) return;
    try {
      await task(lease);
      await this.store.completeAutomationTask(key);
    } catch (error) {
      await this.#recordFailure(key, error, responsibility, pr, headSha);
    }
  }

  #claim(key) {
    return this.store.claimAutomationTask(key, {
      maxAttempts: this.config.scan.maxAttempts,
      staleAfterMs: this.config.agent.timeoutMs + 10 * 60 * 1000,
    });
  }

  async #recordFailure(key, error, responsibility, pr, headSha) {
    const state = await this.store.failAutomationTask(key, error, {
      maxAttempts: this.config.scan.maxAttempts,
    });
    console.error(`[scanner] 自动任务失败 key=${key} attempt=${state.attempts}:`, error);
    const attempt = `commit ${shortSha(headSha)}，第 ${state.attempts}/${this.config.scan.maxAttempts} 次尝试`;
    const outcome = state.status === 'exhausted'
      ? '已停止重试'
      : '将在下次定时扫描重试';
    await this.feishu.send(this.config.feishu.autoReviewChatId,
      `自动审查失败，本次审查已结束（${attempt}），${outcome}。原因：${String(error?.message || error).slice(0, 500)} ${pr.url}`,
      responsibility ? [{ openId: responsibility.feishuOpenId, name: responsibility.displayName }] : []);
  }

  async #warnBlocked(key, message) {
    if (this.#blockedWarnings.has(key)) return;
    await this.feishu.send(this.config.feishu.autoReviewChatId, message, [{
      openId: this.identities.self.feishuOpenId,
      name: this.identities.self.displayName,
    }]);
    this.#blockedWarnings.add(key);
  }
}

function sameLogin(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function requiredHeadSha(metadata, pr) {
  if (!metadata.headSha) throw new Error(`GitCode PR 未返回 head SHA: ${pr.url}`);
  return metadata.headSha;
}

function shortSha(headSha) {
  return String(headSha || '未知').slice(0, 8);
}
