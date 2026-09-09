import { parsePrUrl } from './pr.js';
import { isWeeklyReportRequest } from './weekly-report.js';

// A message must reach exactly one workflow: both platforms share message
// deduplication and state, but use different API clients and identity lookups.
export function createPlatformRouter({ workflows, store, feishu }) {
  const fallback = Object.values(workflows)[0];
  return async (event) => {
    if (!event.messageId || !event.chatId || !event.senderOpenId) return;
    const globalCommand = isWeeklyReportRequest(event.text)
      || /获取(?:我的|当前)?\s*(?:open|chat)[_ -]?id/i.test(String(event.text));
    let pr = globalCommand ? null : parsePrUrl(event.text);
    if (!pr && !globalCommand) {
      const candidates = new Map();
      for (const state of store.listPrs()) {
        if (state.chatId !== event.chatId || ['completed', 'failed', 'cancelled'].includes(state.phase)) continue;
        const candidate = parsePrUrl(state.url);
        if (candidate) candidates.set(candidate.key, candidate);
      }
      for (const request of store.listRunningExternalReviewRequests()) {
        if (request.chatId !== event.chatId) continue;
        const candidate = parsePrUrl(request.prUrl);
        if (candidate) candidates.set(candidate.key, candidate);
      }
      if (candidates.size > 1) {
        if (await store.claimMessage(event.messageId)) await feishu.send(event.chatId, '当前会话有多个进行中的任务，请附上目标 PR 链接。');
        return;
      }
      pr = [...candidates.values()][0] || null;
    }
    const workflow = pr ? workflows[pr.provider] : fallback;
    if (!workflow) {
      if (await store.claimMessage(event.messageId)) {
        await feishu.send(event.chatId, `当前机器人未启用 ${pr.provider}，请检查 REPO_PROVIDERS 配置。`);
      }
      return;
    }
    return workflow.onFeishuMessage(event, pr);
  };
}
