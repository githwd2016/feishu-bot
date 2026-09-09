import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state-store.js';
import { PrScanner } from '../src/pr-scanner.js';
import { parsePrUrl } from '../src/pr.js';
import {
  ReviewWorkflow,
  buildReviewBotProtocol,
  isManualReviewCompletionRequest,
  parseCompatibleReviewBotResult,
  parseReviewBotProtocol,
} from '../src/workflow.js';

const SELF = { displayName: '张三', feishuOpenId: 'user-zhangsan', gitcodeLogin: 'zhangsan', botOpenId: 'bot-zhangsan' };
const LISI = { displayName: '李四', feishuOpenId: 'user-lisi', gitcodeLogin: 'lisi', botOpenId: 'bot-lisi' };
const WANGWU = { displayName: '王五', feishuOpenId: 'user-wangwu', gitcodeLogin: 'wangwu', botOpenId: 'bot-wangwu' };
const REVIEW_COMPLETION_TEXT = 'review完成 qwren/opsbot#185《docs: 建立开发工作流指南与文档模板体系》：未发现严重问题，仅有 2 处轻微问题（已标注在 PR 代码行）。@何伟栋分身 共 2 处问题待处理，可修复后再次 @王晨阳TARS 评审，或 @王晨阳 决定是否合入：https://gitcode.com/qwren/opsbot/pull/185';

test('owned PR uses GitCode assignees, fixes feedback, and rereviews the original commenter', async (t) => {
  const context = await makeContext(t);
  let unresolved = ['lisi'];
  let addressCalls = 0;
  const workflow = makeWorkflow(context, {
    gitcode: {
      getPr: async () => prDetails({ author: 'zhangsan', assignees: ['lisi', 'wangwu'] }),
      unresolvedSummary: async () => ({
        unresolvedCount: unresolved.length,
        unresolvedReviewerLogins: unresolved,
      }),
    },
    agent: {
      runAddressFeedback: async () => {
        addressCalls += 1;
        return { durationMs: 1000, result: { commitSha: '1234567890abcdef' } };
      },
    },
  });

  await workflow.onFeishuMessage(message({
    messageId: 'owner-start', senderOpenId: SELF.feishuOpenId,
    text: 'https://gitcode.com/org/repo/pull/7',
  }));
  await waitFor(() => context.sent.filter(isInitialRequest).length === 2);
  assert.deepEqual(context.sent.filter(isInitialRequest).map((item) => item[2][0].openId).sort(),
    ['bot-lisi', 'bot-wangwu']);

  await workflow.onFeishuMessage(botResult('lisi-initial', LISI.botOpenId, 'initial', 0));
  await workflow.onFeishuMessage(botResult('wangwu-initial', WANGWU.botOpenId, 'initial', 0));
  await waitFor(() => context.store.getPr('org/repo#7').phase === 'awaiting_rereview');
  assert.equal(addressCalls, 1);
  const rereview = context.sent.find((item) => String(item[1]).includes('action=request mode=rereview cycle=1'));
  assert.equal(rereview[2][0].openId, LISI.botOpenId);

  unresolved = [];
  await workflow.onFeishuMessage(botResult('lisi-rereview', LISI.botOpenId, 'rereview', 1));
  await waitFor(() => context.store.getPr('org/repo#7').phase === 'completed');
  assert.ok(context.sent.some((item) => String(item[1]).includes('可以合入')));
});

test('Feishu round exhaustion survives scans, queued automatic starts, and reloads', async (t) => {
  const context = await makeContext(t);
  const pr = parsePrUrl('https://gitcode.com/org/repo/pull/7');
  let headSha = 'initial-head';
  let addressCalls = 0;
  const workflow = makeWorkflow(context, {
    config: { maxReviewCycles: 1, scan: { maxAttempts: 3 }, agent: { timeoutMs: 1000 } },
    gitcode: {
      getPr: async () => prDetails({ author: 'zhangsan', assignees: ['lisi'], sha: headSha }),
      listUserPulls: async ({ scope }) => scope === 'created_by_me' ? [{ html_url: pr.url }] : [],
      unresolvedSummary: async () => ({ unresolvedCount: 1, unresolvedReviewerLogins: ['lisi'] }),
    },
    agent: { runAddressFeedback: async () => {
      addressCalls += 1;
      headSha = 'fixed-head';
      return { durationMs: 1, result: { commitSha: headSha } };
    } },
  });
  const scanner = new PrScanner({
    config: workflow.config, store: context.store, gitcode: workflow.gitcode,
    workflow, feishu: workflow.feishu, identities: workflow.identities,
  });
  await workflow.onFeishuMessage(message({ messageId: 'limit-start', text: pr.url }));
  await workflow.onFeishuMessage(botResult('limit-initial', LISI.botOpenId, 'initial', 0));
  assert.equal(context.store.getPr(pr.key).headSha, 'fixed-head');

  // Simulate an automatic start already queued behind the last Feishu result.
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const finishingRound = workflow.queue.enqueue(pr.key, async () => {
    await blocker;
    await context.store.updatePr(pr.key, (current) => ({
      ...current, phase: 'failed', stopReason: 'max-review-cycles',
    }));
  });
  const automaticStart = workflow.startAutomaticOwnedReview({
    pr, headSha, reviewers: context.store.getPr(pr.key).reviewers,
  });
  release();
  await finishingRound;
  assert.deepEqual(await automaticStart, {
    started: false, skipped: true, reason: 'max-review-cycles',
  });

  // Exercise the real round-limit transition, including its persisted reason.
  await context.store.updatePr(pr.key, (current) => ({
    ...current, phase: 'awaiting_rereview', stopReason: undefined,
  }));
  await workflow.onFeishuMessage(botResult('limit-final', LISI.botOpenId, 'rereview', 1));
  const stopped = context.store.getPr(pr.key);
  assert.equal(stopped.phase, 'failed');
  assert.equal(stopped.stopReason, 'max-review-cycles');
  assert.ok(context.sent.some((item) => String(item[1]).includes('已达到最大复审轮次')));
  await context.store.load();
  headSha = 'later-head';
  await scanner.scanOnce();
  await scanner.scanOnce();
  assert.deepEqual(context.store.getPr(pr.key), JSON.parse(JSON.stringify(stopped)));
  assert.equal(context.sent.filter(isInitialRequest).length, 1);
  assert.equal(addressCalls, 1);

  // Only a new explicit user request resets the stopped PR.
  await workflow.onFeishuMessage(message({ messageId: 'limit-manual-restart', text: pr.url }));
  assert.equal(context.store.getPr(pr.key).cycle, 0);
  assert.equal(context.store.getPr(pr.key).stopReason, undefined);
  assert.equal(context.sent.filter(isInitialRequest).length, 2);
  await scanner.scanOnce();
  assert.equal(context.sent.filter(isInitialRequest).length, 2);
});

test('bot protocol requests are persisted and de-duplicated by PR, sender, mode, and cycle', async (t) => {
  const context = await makeContext(t);
  let reviewCalls = 0;
  const workflow = makeWorkflow(context, {
    gitcode: { getPr: async () => prDetails({ author: 'lisi', assignees: [], sha: 'protocol-sha' }) },
    agent: {
      runReview: async () => {
        reviewCalls += 1;
        return { durationMs: 1000, result: { unresolvedCount: 0 } };
      },
    },
  });
  const text = `${buildReviewBotProtocol({ action: 'request', mode: 'initial', cycle: 4 })} https://gitcode.com/org/repo/pull/9`;

  await workflow.onFeishuMessage(message({ messageId: 'request-one', senderOpenId: LISI.botOpenId, senderType: 'app', text }));
  await waitFor(() => reviewCalls === 1);
  await workflow.onFeishuMessage(message({ messageId: 'request-two', senderOpenId: LISI.botOpenId, senderType: 'app', text }));
  await tick();

  assert.equal(reviewCalls, 1);
  assert.ok(context.sent.some((item) => /action=result mode=initial cycle=4 status=success/.test(String(item[1]))));
});

test('plain bot requests using 检视 are accepted as review requests', async (t) => {
  const context = await makeContext(t);
  let reviewCalls = 0;
  const workflow = makeWorkflow(context, {
    gitcode: { getPr: async () => prDetails({ author: 'lisi', assignees: [], sha: '检视-sha' }) },
    agent: {
      runReview: async () => {
        reviewCalls += 1;
        return { durationMs: 1000, result: { unresolvedCount: 0 } };
      },
    },
  });

  await workflow.onFeishuMessage(message({
    messageId: 'plain-inspect-request',
    senderOpenId: LISI.botOpenId,
    senderType: 'app',
    text: '@张三bot 受 @张三 委托，请检视此 PR：https://gitcode.com/org/repo/pull/9，评审意见请标注到对应代码行',
  }));

  assert.equal(reviewCalls, 1);
  assert.equal(context.sent.length, 2);
  assert.match(context.sent[1][1], /action=result mode=initial cycle=0 status=success/);
});

test('a failed bot protocol request can retry the same PR, mode, and cycle', async (t) => {
  const context = await makeContext(t);
  let reviewCalls = 0;
  const workflow = makeWorkflow(context, {
    gitcode: { getPr: async () => prDetails({ author: 'lisi', assignees: [], sha: 'retry-sha' }) },
    agent: {
      runReview: async () => {
        reviewCalls += 1;
        if (reviewCalls === 1) throw new Error('temporary review failure');
        return { durationMs: 1000, result: { unresolvedCount: 0 } };
      },
    },
  });
  const text = `${buildReviewBotProtocol({ action: 'request', mode: 'initial', cycle: 4 })} https://gitcode.com/org/repo/pull/9`;

  await workflow.onFeishuMessage(message({
    messageId: 'failed-request', senderOpenId: LISI.botOpenId, senderType: 'app', text,
  }));
  await waitFor(() => context.sent.some((item) => /status=failed/.test(String(item[1]))));
  await workflow.onFeishuMessage(message({
    messageId: 'retry-request', senderOpenId: LISI.botOpenId, senderType: 'app', text,
  }));
  await waitFor(() => context.sent.some((item) => /status=success/.test(String(item[1]))));

  assert.equal(reviewCalls, 2);
});

test('different message IDs for the same plain request are coalesced before the PR queue', async (t) => {
  const context = await makeContext(t);
  let reviewCalls = 0;
  let releaseReview;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releaseReview = resolve; });
  const workflow = makeWorkflow(context, {
    gitcode: { getPr: async () => prDetails({ author: 'lisi', assignees: [], sha: 'same-sha' }) },
    agent: {
      runReview: async () => {
        reviewCalls += 1;
        markStarted();
        await gate;
        return { durationMs: 1000, result: { unresolvedCount: 0 } };
      },
    },
  });
  const request = (messageId) => message({
    messageId, senderOpenId: LISI.botOpenId, senderType: 'app',
    text: '请审查：https://gitcode.com/org/repo/pull/9',
  });

  const first = workflow.onFeishuMessage(request('plain-one'));
  await started;
  await workflow.onFeishuMessage(request('plain-two'));

  assert.equal(reviewCalls, 1);
  assert.ok(context.sent.some((item) => String(item[1]).includes('已在审查处理中（cycle 0）')));
  releaseReview();
  await first;
  assert.equal(reviewCalls, 1);
});

test('plain initial requests replay completed results until the head SHA changes', async (t) => {
  const context = await makeContext(t);
  let headSha = 'sha-1';
  let reviewCalls = 0;
  const workflow = makeWorkflow(context, {
    gitcode: { getPr: async () => prDetails({ author: 'lisi', assignees: [], sha: headSha }) },
    agent: {
      runReview: async () => {
        reviewCalls += 1;
        return { durationMs: 1000, result: { unresolvedCount: 0 } };
      },
    },
  });
  const request = (messageId) => message({
    messageId, senderOpenId: LISI.botOpenId, senderType: 'app',
    text: '请审查：https://gitcode.com/org/repo/pull/9',
  });

  await workflow.onFeishuMessage(request('initial-one'));
  await workflow.onFeishuMessage(request('initial-duplicate'));
  assert.equal(reviewCalls, 1);
  assert.equal(context.sent.filter((item) => /action=result mode=initial cycle=0 status=success/.test(String(item[1]))).length, 2);

  headSha = 'sha-2';
  await workflow.onFeishuMessage(request('initial-new-head'));
  assert.equal(reviewCalls, 2);
  assert.ok(context.sent.some((item) => /action=result mode=initial cycle=1 status=success/.test(String(item[1]))));
});

test('plain rereview cycles advance only when mode or head SHA changes', async (t) => {
  const context = await makeContext(t);
  let headSha = 'sha-1';
  let reviewCalls = 0;
  const workflow = makeWorkflow(context, {
    gitcode: { getPr: async () => prDetails({ author: 'lisi', assignees: [], sha: headSha }) },
    agent: {
      runReview: async () => {
        reviewCalls += 1;
        return { durationMs: 1000, result: { unresolvedCount: 0 } };
      },
    },
  });
  const request = (messageId, text) => message({
    messageId, senderOpenId: LISI.botOpenId, senderType: 'app', text,
  });

  await workflow.onFeishuMessage(request('cycle-initial', '请审查：https://gitcode.com/org/repo/pull/9'));
  await workflow.onFeishuMessage(request('cycle-rereview', '评论均已解决，请复审：https://gitcode.com/org/repo/pull/9'));
  await workflow.onFeishuMessage(request('cycle-rereview-duplicate', '评论均已解决，请复审：https://gitcode.com/org/repo/pull/9'));
  assert.equal(reviewCalls, 2);
  assert.equal(context.sent.filter((item) => /action=result mode=rereview cycle=1 status=success/.test(String(item[1]))).length, 2);

  headSha = 'sha-2';
  await workflow.onFeishuMessage(request('cycle-rereview-new-head', '评论均已解决，请复审：https://gitcode.com/org/repo/pull/9'));
  assert.equal(reviewCalls, 3);
  assert.ok(context.sent.some((item) => /action=result mode=rereview cycle=2 status=success/.test(String(item[1]))));
});

test('external reviews fail before enqueueing when GitCode omits the head SHA', async (t) => {
  const context = await makeContext(t);
  let reviewCalls = 0;
  const workflow = makeWorkflow(context, {
    gitcode: { getPr: async () => prDetails({ author: 'lisi', assignees: [], sha: '' }) },
    agent: { runReview: async () => { reviewCalls += 1; } },
  });

  await workflow.onFeishuMessage(message({
    messageId: 'missing-head', senderOpenId: LISI.botOpenId, senderType: 'app',
    text: '请审查：https://gitcode.com/org/repo/pull/9',
  }));

  assert.equal(reviewCalls, 0);
  assert.ok(context.sent.some((item) => /未返回 head SHA/.test(String(item[1]))));
});
test('automatic assigned review with findings mentions the mapped PR author', async (t) => {
  const context = await makeContext(t);
  const workflow = makeWorkflow(context, {
    agent: {
      runReview: async () => ({ durationMs: 65_000, result: { unresolvedCount: 2 } }),
    },
  });

  await workflow.reviewAutomatically({
    pr: { owner: 'org', repo: 'repo', repoKey: 'org/repo', key: 'org/repo#8', url: 'https://gitcode.com/org/repo/pull/8', number: 8 },
    authorIdentity: LISI,
    authorLogin: 'lisi',
    headSha: '1234567890abcdef',
    attempt: 2,
    maxAttempts: 3,
  });

  assert.match(context.sent[0][1], /commit 12345678，第 2\/3 次尝试/);
  const final = context.sent.at(-1);
  assert.match(final[1], /2 条待处理/);
  assert.match(final[1], /commit 12345678，第 2\/3 次尝试/);
  assert.equal(final[2][0].openId, LISI.feishuOpenId);
});

test('automatic assigned review without findings mentions the current reviewer', async (t) => {
  const context = await makeContext(t);
  const workflow = makeWorkflow(context, {
    agent: {
      runReview: async () => ({ durationMs: 65_000, result: { unresolvedCount: 0 } }),
    },
  });

  await workflow.reviewAutomatically({
    pr: { owner: 'org', repo: 'repo', repoKey: 'org/repo', key: 'org/repo#8', url: 'https://gitcode.com/org/repo/pull/8', number: 8 },
    authorIdentity: LISI,
    authorLogin: 'lisi',
  });

  const final = context.sent.at(-1);
  assert.match(final[1], /未发现待解决问题/);
  assert.equal(final[2][0].openId, SELF.feishuOpenId);
});

test('automatic assigned review for an unmapped author is sent privately to the current reviewer', async (t) => {
  const context = await makeContext(t);
  const workflow = makeWorkflow(context, {
    agent: {
      runReview: async () => ({ durationMs: 65_000, result: { unresolvedCount: 2 } }),
    },
  });

  await workflow.reviewAutomatically({
    pr: { owner: 'org', repo: 'repo', repoKey: 'org/repo', key: 'org/repo#8', url: 'https://gitcode.com/org/repo/pull/8', number: 8 },
    authorIdentity: null,
    authorLogin: 'unknown-author',
    headSha: '1234567890abcdef',
    attempt: 1,
    maxAttempts: 3,
  });

  assert.ok(context.sent.length >= 2);
  assert.ok(context.sent.every((item) => item[0] === SELF.feishuOpenId));
  assert.ok(context.sent.every((item) => item[3]?.receiveIdType === 'open_id'));
  assert.match(context.sent.at(-1)[1], /未配置飞书映射/);
});

test('setup commands report the current chat ID and sender Feishu open ID', async (t) => {
  const context = await makeContext(t);
  const workflow = makeWorkflow(context);

  await workflow.onFeishuMessage(message({ messageId: 'chat-command', text: '获取 chat_id' }));
  await workflow.onFeishuMessage(message({ messageId: 'open-command', text: '获取我的 open_id' }));

  assert.match(context.sent[0][1], /当前会话 chat_id：chat/);
  assert.match(context.sent[1][1], new RegExp(SELF.feishuOpenId));
});

test('weekly report command reads only configured repository workdirs', async (t) => {
  const context = await makeContext(t);
  const workflow = makeWorkflow(context, {
    config: { gitcode: { workdirs: { 'org/configured': context.directory } } },
  });

  await workflow.onFeishuMessage(message({ messageId: 'weekly-report', text: '总结本周提交，形成周报' }));

  assert.equal(context.sent.length, 2);
  assert.match(context.sent[0][1], /正在汇总/);
  assert.match(context.sent[1][1], /本周提交周报/);
  assert.match(context.sent[1][1], /【org\/configured】/);
  assert.doesNotMatch(context.sent[1][1], /org\/other/);
});

test('weekly report command uses the configured AI backend for natural-language grouping', async (t) => {
  const context = await makeContext(t);
  let prompt = '';
  const workflow = makeWorkflow(context, {
    config: {
      gitcode: { workdirs: { 'org/configured': context.directory } },
      identityMappings: [SELF, LISI],
    },
    agent: {
      runWeeklySummary: async ({ prompt: received }) => {
        prompt = received;
        return { text: '## 张三（zhangsan）\n- 登录：完成登录流程改进。\n\n## 李四（lisi）\n- 本周暂无提交。' };
      },
    },
  });

  await workflow.onFeishuMessage(message({ messageId: 'weekly-ai-report', text: '生成周报' }));

  assert.match(prompt, /zhangsan/);
  assert.match(prompt, /lisi/);
  assert.match(context.sent[1][1], /登录：完成登录流程改进/);
  assert.doesNotMatch(context.sent[1][1], /统计仓库：/);
});

test('manual own-PR dispatch is rejected in a p2p chat', async (t) => {
  const context = await makeContext(t);
  const workflow = makeWorkflow(context, {
    gitcode: { getPr: async () => prDetails({ author: 'zhangsan', assignees: ['lisi'] }) },
  });

  await workflow.onFeishuMessage(message({
    messageId: 'p2p', senderOpenId: SELF.feishuOpenId, chatType: 'p2p', text: 'https://gitcode.com/org/repo/pull/7',
  }));
  await waitFor(() => context.sent.length === 1);

  assert.match(context.sent[0][1], /无法在单聊中完成互审/);
  assert.equal(context.store.getPr('org/repo#7'), null);
});

test('manual review completion skips missing bot results and starts feedback addressing', async (t) => {
  const context = await makeContext(t);
  let addressCalls = 0;
  const workflow = makeWorkflow(context, {
    gitcode: {
      getPr: async () => prDetails({ author: 'zhangsan', assignees: ['lisi', 'wangwu'] }),
      unresolvedSummary: async () => ({ unresolvedCount: 1, unresolvedReviewerLogins: ['lisi'] }),
    },
    agent: {
      runAddressFeedback: async () => {
        addressCalls += 1;
        return { durationMs: 1000, result: { commitSha: '1234567890abcdef' } };
      },
    },
  });

  await workflow.onFeishuMessage(message({
    messageId: 'manual-review-start', senderOpenId: SELF.feishuOpenId,
    text: 'https://gitcode.com/org/repo/pull/7',
  }));
  await waitFor(() => context.sent.filter(isInitialRequest).length === 2);
  await workflow.onFeishuMessage(botResult('one-result', LISI.botOpenId, 'initial', 0));
  await workflow.onFeishuMessage(message({
    messageId: 'ordinary-human-message', senderOpenId: SELF.feishuOpenId,
    text: '收到，稍等',
  }));
  assert.equal(context.store.getPr('org/repo#7').phase, 'awaiting_review');
  await workflow.onFeishuMessage(message({
    messageId: 'manual-review-confirm', senderOpenId: SELF.feishuOpenId,
    text: '确认审查完成：https://gitcode.com/org/repo/pull/7',
  }));

  await waitFor(() => context.store.getPr('org/repo#7').phase === 'awaiting_rereview');
  assert.equal(addressCalls, 1);
  assert.deepEqual(context.store.getPr('org/repo#7').manualReviewSkippedReviewers, ['wangwu']);
  assert.ok(context.sent.some((item) => /跳过 1 个未返回结果的 reviewer/.test(String(item[1]))));
});

test('manual review completion command parser accepts explicit Chinese and English forms', () => {
  assert.equal(isManualReviewCompletionRequest(REVIEW_COMPLETION_TEXT), true);
  assert.equal(isManualReviewCompletionRequest('确认审查完成'), true);
  assert.equal(isManualReviewCompletionRequest('人工决定本轮复审结束'), true);
  assert.equal(isManualReviewCompletionRequest('review completed, start modifying'), true);
  assert.equal(isManualReviewCompletionRequest('审查完成'), true);
  assert.equal(isManualReviewCompletionRequest('确认完成'), true);
  assert.equal(isManualReviewCompletionRequest('收到，正在审查'), false);
});

for (const senderType of ['user', 'app']) {
  test(`review完成 summary from ${senderType} starts feedback addressing`, async (t) => {
    const context = await makeContext(t);
    let addressCalls = 0;
    const workflow = makeWorkflow(context, {
      config: { gitcode: { allowedRepos: new Set(['qwren/opsbot']) } },
      gitcode: {
        getPr: async () => prDetails({ author: 'zhangsan', assignees: ['lisi'] }),
        unresolvedSummary: async () => ({ unresolvedCount: 2, unresolvedReviewerLogins: ['lisi'] }),
      },
      agent: {
        runAddressFeedback: async () => {
          addressCalls += 1;
          return { durationMs: 1, result: { commitSha: 'fixed-head' } };
        },
      },
    });
    await workflow.onFeishuMessage(message({
      messageId: 'summary-start', text: 'https://gitcode.com/qwren/opsbot/pull/185',
    }));
    await workflow.onFeishuMessage(message({
      messageId: 'summary-result', senderType,
      senderOpenId: senderType === 'app' ? LISI.botOpenId : LISI.feishuOpenId,
      text: REVIEW_COMPLETION_TEXT,
    }));
    assert.equal(addressCalls, 1);
    assert.equal(context.store.getPr('qwren/opsbot#185').phase, 'awaiting_rereview');
  });
}

test('startup recovery marks interrupted feedback addressing as failed', async (t) => {
  const context = await makeContext(t);
  await context.store.putPr({
    key: 'org/repo#12', url: 'https://gitcode.com/org/repo/pull/12', chatId: 'chat',
    requesterOpenId: SELF.feishuOpenId, requesterName: SELF.displayName,
    phase: 'addressing_feedback', cycle: 0, pending: { lisi: 'done' }, reviewers: [],
  });
  const workflow = makeWorkflow(context);

  await workflow.recoverInterruptedTasks();

  assert.equal(context.store.getPr('org/repo#12').phase, 'failed');
  assert.match(context.sent[0][1], /服务重启中断/);
});

test('startup recovery turns an interrupted external bot review into a retryable failed result', async (t) => {
  const context = await makeContext(t);
  await context.store.claimExternalReviewRequest({
    prKey: 'org/repo#13', prUrl: 'https://gitcode.com/org/repo/pull/13', chatId: 'chat',
    requesterOpenId: LISI.botOpenId, mode: 'initial', cycle: 2, headSha: 'interrupted-sha',
  });
  const workflow = makeWorkflow(context);

  await workflow.recoverInterruptedTasks();

  assert.match(context.sent[0][1], /action=result mode=initial cycle=2 status=failed/);
  assert.equal(context.sent[0][2][0].openId, LISI.botOpenId);
});

test('review protocol and third-party result compatibility remain supported', () => {
  const marker = buildReviewBotProtocol({ action: 'result', mode: 'rereview', cycle: 3, status: 'failed' });
  assert.deepEqual(parseReviewBotProtocol(marker), {
    action: 'result', mode: 'rereview', cycle: 3, status: 'failed',
  });
  assert.equal(parseCompatibleReviewBotResult('已收到，正在审查'), null);
  assert.deepEqual(parseCompatibleReviewBotResult(REVIEW_COMPLETION_TEXT), { status: 'success' });
  assert.deepEqual(parseCompatibleReviewBotResult('review完成：发现 2 处问题，已标注在 PR 代码行'), { status: 'success' });
  assert.equal(parseCompatibleReviewBotResult('正在 review，完成后通知'), null);
  assert.equal(parseCompatibleReviewBotResult('已收到，正在检视'), null);
  assert.deepEqual(parseCompatibleReviewBotResult('审查意见已提交'), { status: 'success' });
  assert.deepEqual(parseCompatibleReviewBotResult('检视意见已提交'), { status: 'success' });
  assert.deepEqual(parseCompatibleReviewBotResult('本次复审执行失败'), { status: 'failed' });
  assert.deepEqual(parseCompatibleReviewBotResult('本次评审执行失败'), { status: 'failed' });
});

async function makeContext(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-workflow-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.load();
  return { directory, store, sent: [] };
}

function makeWorkflow(context, overrides = {}) {
  const people = [SELF, LISI, WANGWU];
  const identities = {
    self: SELF,
    byGitcodeLogin: (login) => people.find((item) => item.gitcodeLogin.toLowerCase() === String(login).toLowerCase()) || null,
    byBotOpenId: (openId) => people.find((item) => item.botOpenId === openId) || null,
  };
  return new ReviewWorkflow({
    config: {
      projectRoot: context.directory,
      feishu: { botName: '张三bot', autoReviewChatId: 'auto-chat' },
      gitcode: { allowedRepos: new Set(['org/repo']) },
      maxReviewCycles: 3,
      ...overrides.config,
    },
    store: context.store,
    feishu: { send: async (...args) => context.sent.push(args) },
    gitcode: overrides.gitcode || {},
    agent: overrides.agent || {},
    identities,
  });
}

function prDetails({ author, assignees, sha = 'head-sha' }) {
  return {
    user: { login: author },
    head: { sha },
    assignees: assignees.map((login) => ({ login })),
  };
}

function message({ messageId, senderOpenId = SELF.feishuOpenId, senderType = 'user', chatType = 'group', text }) {
  return { messageId, chatId: 'chat', chatType, senderOpenId, senderType, messageType: 'text', text };
}

function botResult(messageId, senderOpenId, mode, cycle) {
  return message({
    messageId, senderOpenId, senderType: 'app',
    text: `${buildReviewBotProtocol({ action: 'result', mode, cycle, status: 'success' })} https://gitcode.com/org/repo/pull/7`,
  });
}

function isInitialRequest(item) {
  return String(item[1]).includes('action=request mode=initial cycle=0');
}

async function tick(count = 2) {
  for (let index = 0; index < count; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for workflow');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
