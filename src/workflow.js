import { assertAllowedPr, parsePrUrl } from './pr.js';
import { KeyedQueue } from './keyed-queue.js';
import { PROGRESS_HEARTBEAT_MS } from './progress.js';

const BOT_PROTOCOL_PREFIX = 'review-bot';
const BOT_PROTOCOL_PATTERN = /\[review-bot action=(request|result) mode=(initial|rereview) cycle=(\d+)(?: status=(success|failed))?\]/i;
const COMPATIBLE_BOT_FAILURE_PATTERN = /(?:审查|复审|review).{0,16}(?:失败|出错|报错|无法完成|被阻塞|failed|error|blocked)/i;
const COMPATIBLE_BOT_PROGRESS_PATTERN = /(?:正在|处理中|已收到|开始(?:审查|复审)|稍后|完成后|请(?:审查|复审))/i;
const COMPATIBLE_BOT_REQUEST_PATTERN = /(?:请|麻烦|帮忙|协助).{0,16}(?:审查|复审|review)|please.{0,16}(?:review|re-review)/i;
const COMPATIBLE_BOT_BARE_REQUEST_PATTERN = /(?:再次|重新|继续)?(?:审查|复审)(?:一下)?[\s:：，,]*(?:https?:\/\/|\[https?:\/\/)|(?:re-?review|review(?:\s+again)?)[\s:：,]*(?:https?:\/\/|\[https?:\/\/)/i;
const COMPATIBLE_BOT_SUCCESS_PATTERNS = [
  /(?:审查|复审)(?:意见|评论)?.{0,8}(?:已提交|提交完成|已完成|完成|完毕)/i,
  /已(?:完成|结束)(?:本次)?(?:审查|复审)/i,
  /(?:意见|评论|inline\s+comments?|comments?).{0,8}(?:已提交|提交完成|已发布|发布完成)/i,
  /(?:review).{0,8}(?:completed|done|finished|submitted)/i,
  /(?:comments?).{0,8}(?:submitted|posted|completed)/i,
  /未发现.{0,8}(?:问题|意见|评论)/i,
];
export class ReviewWorkflow {
  constructor({ config, store, feishu, agent, gitcode }) {
    this.config = config;
    this.store = store;
    this.feishu = feishu;
    this.agent = agent;
    this.gitcode = gitcode;
    this.queue = new KeyedQueue();
  }

  async recoverInterruptedTasks() {
    const localReviewerIds = new Set(
      this.config.reviewers.filter((reviewer) => reviewer.mode === 'local').map((reviewer) => reviewer.id),
    );
    for (const state of this.store.listPrs()) {
      if (['completed', 'failed'].includes(state.phase)) continue;
      const localReviewerWasRunning = ['awaiting_review', 'awaiting_rereview'].includes(state.phase)
        && Object.entries(state.pending || {}).some(
          ([reviewerId, status]) => localReviewerIds.has(reviewerId) && status === 'pending',
        );
      if (state.phase !== 'addressing_feedback' && !localReviewerWasRunning) continue;

      const reason = '服务重启中断了本地 agent 任务，请重新发起该 PR 的审查';
      await this.store.updatePr(state.key, (current) => ({ ...current, phase: 'failed', lastError: reason }));
      console.warn(`[workflow] 恢复中断任务 ${state.key}: ${reason}`);
      await this.#sendProgress(state.chatId, `${reason}：${state.url}`,
        state.requesterOpenId ? [this.#person(state.requesterOpenId, state.requesterName || '发起人')] : []);
    }
  }

  async onFeishuMessage(event) {
    if (!event.messageId || !event.chatId || !event.senderOpenId) return;
    if (!(await this.store.claimMessage(event.messageId))) return;
    if (event.messageType && event.messageType !== 'text') {
      await this.feishu.send(event.chatId, '请使用文本消息并附上 GitCode PR 链接。');
      return;
    }

    const protocol = parseReviewBotProtocol(event.text);
    if (isOpenIdRequest(event.text) && !isBotSender(event, protocol)) {
      console.log(`[setup] OWNER_OPEN_ID=${event.senderOpenId}`);
      await this.feishu.send(event.chatId,
        '已将你的 OWNER_OPEN_ID 输出到本机服务日志。请复制到 .env 后重启服务。',
        [this.#person(event.senderOpenId, '配置人')]);
      return;
    }
    if (!this.config.feishu.ownerOpenId && !isBotSender(event, protocol)) {
      console.log(`[setup] OWNER_OPEN_ID=${event.senderOpenId}`);
      await this.feishu.send(event.chatId,
        '机器人尚未绑定 PR 所有人，已将 OWNER_OPEN_ID 输出到本机服务日志。请写入 .env 后重启服务。',
        [this.#person(event.senderOpenId, '配置人')]);
      return;
    }

    let pr = parsePrUrl(event.text);
    if (!pr) {
      const active = this.store.findActivePr(event.chatId);
      if (active) pr = parsePrUrl(active.url);
    }
    try {
      assertAllowedPr(pr, this.config.gitcode.allowedRepos);
    } catch (error) {
      await this.feishu.send(event.chatId, error.message, [this.#person(event.senderOpenId, '发起人')]);
      return;
    }

    const owned = this.store.getPr(pr.key);
    if (!owned && isBotSender(event, protocol) && !isReviewRequest(event.text, protocol)) {
      console.warn(`[workflow] 忽略无对应任务的机器人状态消息 sender=${event.senderOpenId} pr=${pr.key}`);
      return;
    }

    if (event.senderOpenId === this.config.feishu.ownerOpenId) {
      this.queue.enqueue(pr.key, () => this.#startOwnedReview(pr, event))
        .catch((error) => this.#reportFailure(event.chatId, pr, error));
      return;
    }

    const task = owned
      ? () => this.#handleOwnedPrSignal(pr, event, protocol)
      : () => this.#reviewForExternalRequester(pr, event, protocol);
    this.queue.enqueue(pr.key, task).catch((error) => this.#reportFailure(event.chatId, pr, error));
  }

  async #startOwnedReview(pr, event) {
    if (event.chatType === 'p2p' && this.config.reviewers.some((reviewer) => reviewer.mode === 'feishu')) {
      await this.feishu.send(event.chatId,
        `当前 PR 配置了飞书 reviewer，无法在单聊中完成机器人互审。请在包含所有 reviewer 机器人的群聊中重新发起：${pr.url}`,
        [this.#person(event.senderOpenId, this.config.feishu.ownerName)]);
      return;
    }
    const existing = this.store.getPr(pr.key);
    if (existing && !['completed', 'failed'].includes(existing.phase)) {
      await this.feishu.send(event.chatId, `该 PR 已在处理中（${existing.phase}）：${pr.url}`,
        [this.#person(event.senderOpenId, this.config.feishu.ownerName)]);
      return;
    }
    const pending = Object.fromEntries(this.config.reviewers.map((reviewer) => [reviewer.id, 'pending']));
    const state = await this.store.putPr({
      key: pr.key,
      url: pr.url,
      chatId: event.chatId,
      requesterOpenId: event.senderOpenId,
      requesterName: this.config.feishu.ownerName,
      phase: 'awaiting_review',
      cycle: 0,
      pending,
    });
    await this.#sendProgress(event.chatId,
      `已收到 PR 审查请求，正在启动 ${this.config.reviewers.length} 个 reviewer：${pr.url}`);
    await this.#requestReviewers(pr, state, this.config.reviewers, 'initial');
  }

  async #requestReviewers(pr, state, reviewers, mode) {
    for (const reviewer of reviewers) {
      if (reviewer.mode === 'local') {
        const success = await this.#runLocalReviewer(pr, reviewer, mode, state);
        if (!success) return;
        continue;
      }
      const marker = buildReviewBotProtocol({ action: 'request', mode, cycle: state.cycle });
      const instruction = mode === 'rereview' ? '请复审并验证已回复的 comments' : '请审查并提交 inline comments';
      try {
        await this.feishu.send(state.chatId, `${marker} ${instruction}：${pr.url}`, [reviewer]);
      } catch (error) {
        await this.#recordReviewerOutcome(pr, reviewer.id, false, safeError(error));
        return;
      }
    }
  }

  async #runLocalReviewer(pr, reviewer, mode, state) {
    const action = mode === 'rereview' ? `第 ${state.cycle} 轮复审` : '首次审查';
    await this.#sendProgress(state.chatId, `${reviewer.name} 已开始${action}，耗时较长时会定期报告进度：${pr.url}`);
    try {
      const output = await this.#runAgentWithHeartbeat({
        chatId: state.chatId,
        pr,
        action: `${reviewer.name} 正在${action}`,
        task: () => this.agent.runReview({ pr, mode, reviewerName: reviewer.name }),
      });
      const finding = output.result.unresolvedCount
        ? `发现 ${output.result.unresolvedCount} 条待处理评论`
        : '未发现待处理评论';
      await this.#sendProgress(state.chatId,
        `${reviewer.name} 已完成${action}（${formatDuration(output.durationMs)}），${finding}：${pr.url}`);
      await this.#recordReviewerOutcome(pr, reviewer.id, true);
      return true;
    } catch (error) {
      await this.#recordReviewerOutcome(pr, reviewer.id, false, safeError(error));
      return false;
    }
  }

  async #handleOwnedPrSignal(pr, event, protocol) {
    const state = this.store.getPr(pr.key);
    if (!state || ['completed', 'failed'].includes(state.phase)) return;

    const reviewer = this.config.reviewers.find((item) => item.openId === event.senderOpenId);
    if (reviewer) {
      let success;
      if (protocol?.action === 'result') {
        if (protocol.cycle !== state.cycle) {
          console.log(`[workflow] 忽略 ${reviewer.id} 的过期复审结果: cycle=${protocol.cycle}, current=${state.cycle}`);
          return;
        }
        success = protocol.status !== 'failed';
      } else {
        const linkedPr = parsePrUrl(event.text);
        const compatibleResult = parseCompatibleReviewBotResult(event.text);
        if (!linkedPr || linkedPr.key !== pr.key || !compatibleResult) {
          console.warn(`[workflow] 忽略 ${reviewer.id} 缺少结果标记的消息`);
          return;
        }
        success = compatibleResult.status === 'success';
        console.warn(`[workflow] 接收 ${reviewer.id} 的第三方兼容结果 status=${compatibleResult.status} pr=${pr.key}`);
      }
      await this.#recordReviewerOutcome(pr, reviewer.id, success,
        success ? undefined : `审查机器人 ${reviewer.name} 报告执行失败`);
      return;
    }

    if (isBotSender(event, protocol)) {
      console.warn(`[workflow] 忽略未配置机器人 ${event.senderOpenId} 对 ${pr.key} 的状态消息`);
      return;
    }

    // 人工 reviewer @ 本机器人时，直接以 GitCode 上的实际 comments 为准。
    await this.#processReviewRound(pr, state);
  }

  async #recordReviewerOutcome(pr, reviewerId, success, error) {
    let state = this.store.getPr(pr.key);
    if (!state || ['completed', 'failed'].includes(state.phase)) return;
    if (!(reviewerId in state.pending)) {
      console.warn(`[workflow] 忽略当前轮次之外的 reviewer: ${reviewerId}`);
      return;
    }
    if (state.pending[reviewerId] !== 'pending') return;

    state = await this.store.updatePr(pr.key, (current) => ({
      ...current,
      pending: { ...current.pending, [reviewerId]: success ? 'done' : 'failed' },
      lastError: success ? current.lastError : error,
    }));
    if (!success) {
      await this.store.updatePr(pr.key, (current) => ({ ...current, phase: 'failed' }));
      await this.feishu.send(state.chatId, `PR 审查机器人执行失败，请查看对应机器人日志：${pr.url}`,
        [this.#person(state.requesterOpenId, state.requesterName)]);
      return;
    }
    if (Object.values(state.pending).some((status) => status === 'pending')) return;
    await this.#processReviewRound(pr, state);
  }

  async #processReviewRound(pr, state) {
    await this.#sendProgress(state.chatId, `所有 reviewer 已完成，正在同步 GitCode comments 状态：${pr.url}`);
    const inspection = await this.gitcode.unresolvedSummary(pr);
    console.log(`[workflow] ${pr.key} comments unresolved=${inspection.unresolvedCount} reviewers=${inspection.unresolvedReviewerLogins.join(',') || '-'}`);
    if (inspection.unresolvedCount === 0) {
      await this.store.updatePr(pr.key, (current) => ({ ...current, phase: 'completed' }));
      await this.feishu.send(state.chatId, `全部 review comments 已完成，可以合入：${pr.url}`,
        [this.#person(state.requesterOpenId, state.requesterName)]);
      return;
    }
    if (state.cycle >= this.config.maxReviewCycles) {
      await this.store.updatePr(pr.key, (current) => ({ ...current, phase: 'failed' }));
      await this.feishu.send(state.chatId,
        `已达到最大复审轮次，仍有 ${inspection.unresolvedCount} 条未解决评论，请人工处理：${pr.url}`,
        [this.#person(state.requesterOpenId, state.requesterName)]);
      return;
    }

    await this.store.updatePr(pr.key, (current) => ({ ...current, phase: 'addressing_feedback' }));
    await this.#sendProgress(state.chatId, `检测到 ${inspection.unresolvedCount} 条未解决评论，正在修改、测试并提交：${pr.url}`);
    const addressOutput = await this.#runAgentWithHeartbeat({
      chatId: state.chatId,
      pr,
      action: '正在按 review comments 修改代码',
      task: () => this.agent.runAddressFeedback({ pr }),
    });

    const targets = reviewersForLogins(this.config.reviewers, inspection.unresolvedReviewerLogins);
    const pending = Object.fromEntries(targets.map((reviewer) => [reviewer.id, 'pending']));
    const next = await this.store.updatePr(pr.key, (current) => ({
      ...current,
      phase: 'awaiting_rereview',
      cycle: current.cycle + 1,
      pending,
    }));
    const commit = addressOutput.result.commitSha ? `，commit ${addressOutput.result.commitSha.slice(0, 8)}` : '';
    await this.#sendProgress(state.chatId,
      `已按评论完成修改、测试和回复（${formatDuration(addressOutput.durationMs)}${commit}），正在请求原 reviewer 复审：${pr.url}`);
    await this.#requestReviewers(pr, next, targets, 'rereview');
  }

  async #reviewForExternalRequester(pr, event, protocol) {
    const mode = protocol?.action === 'request' ? protocol.mode : inferReviewMode(event.text);
    const cycle = await this.store.claimExternalReviewCycle({
      prKey: pr.key,
      chatId: event.chatId,
      requesterOpenId: event.senderOpenId,
      mode,
      cycle: protocol?.cycle,
    });
    const requesterIsBot = isBotSender(event, protocol);
    const requester = this.#person(event.senderOpenId, requesterIsBot ? '发起机器人' : '发起人');
    await this.#sendProgress(event.chatId, `已收到，正在${mode === 'rereview' ? '复审' : '审查'}，耗时较长时会定期报告进度：${pr.url}`,
      requesterIsBot ? [] : [requester]);

    try {
      const output = await this.#runAgentWithHeartbeat({
        chatId: event.chatId,
        pr,
        action: mode === 'rereview' ? '正在复审' : '正在审查',
        task: () => this.agent.runReview({
          pr,
          mode,
          reviewerName: this.config.feishu.botName,
        }),
      });
      const marker = buildReviewBotProtocol({ action: 'result', mode, cycle, status: 'success' });
      const message = output.result.unresolvedCount
        ? `${marker} 审查完成（${formatDuration(output.durationMs)}），当前有 ${output.result.unresolvedCount} 条待处理 inline comments：${pr.url}`
        : `${marker} 审查完成（${formatDuration(output.durationMs)}），未发现待解决问题：${pr.url}`;
      await this.feishu.send(event.chatId, message, [requester]);
    } catch (error) {
      const marker = buildReviewBotProtocol({ action: 'result', mode, cycle, status: 'failed' });
      await this.feishu.send(event.chatId, `${marker} 审查执行失败，请查看当前机器人日志：${safeError(error)} ${pr.url}`,
        [requester]);
    }
  }

  #person(openId, name) {
    return { openId, name };
  }

  async #runAgentWithHeartbeat({ chatId, pr, action, task }) {
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsed = formatDuration(Date.now() - startedAt);
      void this.#sendProgress(chatId, `${action}，已运行 ${elapsed}：${pr.url}`);
    }, PROGRESS_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      return await task();
    } finally {
      clearInterval(heartbeat);
    }
  }

  async #sendProgress(chatId, message, mentions = []) {
    try {
      await this.feishu.send(chatId, message, mentions);
    } catch (error) {
      console.warn(`[workflow] 进度消息发送失败: ${safeError(error)}`);
    }
  }

  async #reportFailure(chatId, pr, error) {
    const reason = safeError(error);
    console.error(`[workflow] ${pr.key} 执行失败:`, error);
    const state = this.store.getPr(pr.key);
    if (state && !['completed', 'failed'].includes(state.phase)) {
      await this.store.updatePr(pr.key, (current) => ({ ...current, phase: 'failed', lastError: reason }));
    }
    if (chatId) {
      await this.feishu.send(chatId, `执行失败，已停止自动流程，可重新发起。原因：${reason} ${pr.url}`,
        state?.requesterOpenId ? [this.#person(state.requesterOpenId, state.requesterName || '发起人')] : []);
    }
  }
}

export function buildReviewBotProtocol({ action, mode, cycle, status }) {
  const resultStatus = action === 'result' ? ` status=${status || 'success'}` : '';
  return `[${BOT_PROTOCOL_PREFIX} action=${action} mode=${mode} cycle=${cycle}${resultStatus}]`;
}

export function parseReviewBotProtocol(text = '') {
  const match = String(text).match(BOT_PROTOCOL_PATTERN);
  if (!match) return null;
  return {
    action: match[1].toLowerCase(),
    mode: match[2].toLowerCase(),
    cycle: Number(match[3]),
    status: match[4]?.toLowerCase(),
  };
}

export function parseCompatibleReviewBotResult(text = '') {
  const value = String(text);
  if (COMPATIBLE_BOT_FAILURE_PATTERN.test(value)) return { status: 'failed' };
  if (COMPATIBLE_BOT_PROGRESS_PATTERN.test(value)) return null;
  if (COMPATIBLE_BOT_SUCCESS_PATTERNS.some((pattern) => pattern.test(value))) return { status: 'success' };
  return null;
}

function inferReviewMode(text = '') {
  return /复审|rereview/i.test(text) ? 'rereview' : 'initial';
}

function isOpenIdRequest(text = '') {
  return /获取(?:我的)?\s*open[_ -]?id/i.test(String(text));
}

function isReviewRequest(text, protocol) {
  if (protocol) return protocol.action === 'request';
  const value = String(text);
  if (COMPATIBLE_BOT_FAILURE_PATTERN.test(value)) return false;
  if (COMPATIBLE_BOT_SUCCESS_PATTERNS.some((pattern) => pattern.test(value))) return false;
  if (COMPATIBLE_BOT_REQUEST_PATTERN.test(value)) return true;
  if (COMPATIBLE_BOT_PROGRESS_PATTERN.test(value)) return false;
  return COMPATIBLE_BOT_BARE_REQUEST_PATTERN.test(value);
}

function isBotSender(event, protocol) {
  return protocol?.action === 'request'
    || protocol?.action === 'result'
    || ['app', 'bot'].includes(String(event.senderType || '').toLowerCase());
}

function reviewersForLogins(reviewers, reviewerLogins) {
  const logins = new Set(reviewerLogins.map((item) => item.toLowerCase()).filter(Boolean));
  const matched = reviewers.filter((reviewer) => reviewer.gitcodeLogin && logins.has(reviewer.gitcodeLogin.toLowerCase()));
  return matched.length > 0 ? matched : reviewers;
}

function safeError(error) {
  return String(error?.message || error).slice(0, 1000);
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '未知耗时';
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`;
}
