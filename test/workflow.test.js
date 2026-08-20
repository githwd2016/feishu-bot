import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state-store.js';
import {
  ReviewWorkflow,
  buildReviewBotProtocol,
  parseCompatibleReviewBotResult,
  parseReviewBotProtocol,
} from '../src/workflow.js';

test('owned PR waits for every mentioned bot, fixes feedback, rereviews, and notifies merge', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-workflow-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.load();
  const sent = [];
  let unresolved = [{ resolved: false, user: { login: 'lisi' } }];
  let inspectCalls = 0;
  let addressCalls = 0;
  const config = {
    projectRoot: directory,
    feishu: { ownerOpenId: 'owner', ownerName: '张三', botName: '张三bot' },
    gitcode: { allowedRepos: new Set(['org/repo']) },
    reviewers: [
      { id: 'lisi', name: '李四bot', openId: 'bot-lisi', gitcodeLogin: 'lisi', mode: 'feishu' },
      { id: 'wangwu', name: '王五bot', openId: 'bot-wangwu', gitcodeLogin: 'wangwu', mode: 'feishu' },
    ],
    maxReviewCycles: 3,
  };
  const workflow = new ReviewWorkflow({
    config,
    store,
    feishu: { send: async (...args) => sent.push(args) },
    gitcode: {
      unresolvedSummary: async () => {
        inspectCalls += 1;
        return { unresolvedCount: unresolved.length, unresolvedReviewerLogins: unresolved.length ? ['lisi'] : [] };
      },
    },
    agent: {
      runReview: async () => ({ result: { unresolvedCount: unresolved.length, unresolvedReviewerLogins: ['lisi'] } }),
      runAddressFeedback: async () => {
        addressCalls += 1;
        return { result: { commitSha: '1234567890abcdef' }, durationMs: 65_000 };
      },
    },
  });

  await workflow.onFeishuMessage({
    messageId: 'm-owner', chatId: 'chat', senderOpenId: 'owner', senderType: 'user', messageType: 'text',
    text: 'https://gitcode.com/org/repo/pull/7',
  });
  await waitFor(() => sent.filter(isInitialRequest).length === 2);
  assert.deepEqual(sent.filter(isInitialRequest).map((item) => item[2][0].openId).sort(), ['bot-lisi', 'bot-wangwu']);

  await workflow.onFeishuMessage({
    messageId: 'm-lisi-ack', chatId: 'chat', senderOpenId: 'bot-lisi', senderType: 'app', messageType: 'text',
    text: '已收到，正在审查：https://gitcode.com/org/repo/pull/7',
  });
  await tick();
  assert.equal(store.getPr('org/repo#7').pending.lisi, 'pending', 'progress without a result marker must be ignored');

  await workflow.onFeishuMessage(botResult('m-lisi-0', 'bot-lisi', 'initial', 0));
  await waitFor(() => store.getPr('org/repo#7').pending.lisi === 'done');
  assert.equal(inspectCalls, 0, 'must wait for every configured reviewer');

  await workflow.onFeishuMessage(botResult('m-wangwu-0', 'bot-wangwu', 'initial', 0));
  await waitFor(() => store.getPr('org/repo#7').phase === 'awaiting_rereview');
  assert.equal(inspectCalls, 1);
  assert.equal(addressCalls, 1);
  const rereview = sent.find((item) => String(item[1]).includes('action=request mode=rereview cycle=1'));
  assert.equal(rereview[2][0].openId, 'bot-lisi');

  await workflow.onFeishuMessage(botResult('m-lisi-stale', 'bot-lisi', 'initial', 0));
  await tick();
  assert.equal(store.getPr('org/repo#7').phase, 'awaiting_rereview', 'stale cycle must be ignored');
  assert.equal(inspectCalls, 1);

  unresolved = [];
  await workflow.onFeishuMessage(botResult('m-lisi-1', 'bot-lisi', 'rereview', 1));
  await waitFor(() => store.getPr('org/repo#7').phase === 'completed');
  assert.equal(inspectCalls, 2);
  assert.equal(addressCalls, 1);
  assert.ok(sent.some((item) => String(item[1]).includes('可以合入')));
});

test('local reviewer reports visible phases and uses GitCode directly for final status', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-local-progress-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.load();
  const sent = [];
  let summaryCalls = 0;
  const workflow = new ReviewWorkflow({
    config: {
      feishu: { ownerOpenId: 'owner', ownerName: '张三', botName: '张三bot' },
      gitcode: { allowedRepos: new Set(['org/repo']) },
      reviewers: [
        { id: 'local', name: '本地审查角色', openId: 'display-only', gitcodeLogin: 'zhangsan', mode: 'local' },
      ],
      maxReviewCycles: 3,
    },
    store,
    feishu: { send: async (...args) => sent.push(args) },
    gitcode: {
      unresolvedSummary: async () => {
        summaryCalls += 1;
        return { unresolvedCount: 0, unresolvedReviewerLogins: [] };
      },
    },
    agent: {
      runReview: async () => ({
        durationMs: 65_000,
        result: { unresolvedCount: 0, unresolvedReviewerLogins: [] },
      }),
    },
  });

  await workflow.onFeishuMessage({
    messageId: 'local-owner', chatId: 'chat', senderOpenId: 'owner', senderType: 'user', messageType: 'text',
    text: 'https://gitcode.com/org/repo/pull/11',
  });
  await waitFor(() => store.getPr('org/repo#11')?.phase === 'completed');

  assert.equal(summaryCalls, 1);
  assert.ok(sent.some((item) => String(item[1]).includes('已收到 PR 审查请求')));
  assert.ok(sent.some((item) => String(item[1]).includes('已开始首次审查')));
  assert.ok(sent.some((item) => String(item[1]).includes('已完成首次审查（1 分 5 秒）')));
  assert.ok(sent.some((item) => String(item[1]).includes('正在同步 GitCode comments')));
  assert.ok(sent.some((item) => String(item[1]).includes('可以合入')));
});

test('startup recovery marks an interrupted local agent task as retryable failure', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.load();
  await store.putPr({
    key: 'org/repo#12',
    url: 'https://gitcode.com/org/repo/pull/12',
    chatId: 'chat',
    requesterOpenId: 'owner',
    requesterName: '张三',
    phase: 'addressing_feedback',
    cycle: 0,
    pending: { local: 'done' },
  });
  const sent = [];
  const workflow = new ReviewWorkflow({
    config: {
      feishu: { ownerOpenId: 'owner', ownerName: '张三', botName: '张三bot' },
      gitcode: { allowedRepos: new Set(['org/repo']) },
      reviewers: [{ id: 'local', name: '本地审查角色', openId: 'display-only', mode: 'local' }],
      maxReviewCycles: 3,
    },
    store,
    feishu: { send: async (...args) => sent.push(args) },
    agent: {},
    gitcode: {},
  });

  await workflow.recoverInterruptedTasks();

  assert.equal(store.getPr('org/repo#12').phase, 'failed');
  assert.match(store.getPr('org/repo#12').lastError, /服务重启中断/);
  assert.match(sent[0][1], /请重新发起/);
  assert.equal(sent[0][2][0].openId, 'owner');
});

test('a bot-authored review request is reviewed and only the final result mentions the requester bot', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-external-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.load();
  const sent = [];
  const modes = [];
  const workflow = new ReviewWorkflow({
    config: {
      feishu: { ownerOpenId: 'human-owner', ownerName: '李四', botName: '李四bot' },
      gitcode: { allowedRepos: new Set(['org/repo']) },
      reviewers: [{ id: 'owner-bot', name: '张三bot', openId: 'bot-owner', mode: 'feishu' }],
      maxReviewCycles: 3,
    },
    store,
    feishu: { send: async (...args) => sent.push(args) },
    agent: {
      runReview: async ({ mode }) => {
        modes.push(mode);
        return { result: { unresolvedCount: 0, unresolvedReviewerLogins: [] } };
      },
    },
  });

  await workflow.onFeishuMessage({
    messageId: 'request-1', chatId: 'chat', senderOpenId: 'bot-owner', senderType: 'app', messageType: 'text',
    text: `${buildReviewBotProtocol({ action: 'request', mode: 'rereview', cycle: 2 })} https://gitcode.com/org/repo/pull/9`,
  });
  await waitFor(() => sent.length === 2);
  assert.deepEqual(modes, ['rereview']);
  assert.deepEqual(sent[0][2], [], 'progress message must not @ the requester bot');
  assert.equal(sent[1][2][0].openId, 'bot-owner');
  assert.match(sent[1][1], /action=result mode=rereview cycle=2 status=success/);
});

test('review bot protocol round-trips request and result metadata', () => {
  const marker = buildReviewBotProtocol({ action: 'result', mode: 'rereview', cycle: 3, status: 'failed' });
  assert.deepEqual(parseReviewBotProtocol(`@机器人 ${marker} PR failed`), {
    action: 'result', mode: 'rereview', cycle: 3, status: 'failed',
  });
});

test('a configured third-party bot can report completion without the native protocol marker', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-third-party-result-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.load();
  const sent = [];
  let summaryCalls = 0;
  const workflow = new ReviewWorkflow({
    config: {
      feishu: { ownerOpenId: 'owner', ownerName: '何伟栋', botName: '何伟栋分身' },
      gitcode: { allowedRepos: new Set(['qwren/opsbot']) },
      reviewers: [
        { id: 'hangdu-bot', name: 'hangdu-bot', openId: 'bot-hangdu', gitcodeLogin: 'hangdu', mode: 'feishu' },
      ],
      maxReviewCycles: 3,
    },
    store,
    feishu: { send: async (...args) => sent.push(args) },
    gitcode: {
      unresolvedSummary: async () => {
        summaryCalls += 1;
        return { unresolvedCount: 0, unresolvedReviewerLogins: [] };
      },
    },
    agent: {},
  });

  await workflow.onFeishuMessage({
    messageId: 'third-party-owner', chatId: 'chat', senderOpenId: 'owner', senderType: 'user', messageType: 'text',
    text: 'https://gitcode.com/qwren/opsbot/pull/127',
  });
  await waitFor(() => sent.some(isInitialRequest));

  await workflow.onFeishuMessage({
    messageId: 'third-party-progress', chatId: 'chat', senderOpenId: 'bot-hangdu', senderType: 'app', messageType: 'text',
    text: '@何伟栋分身 已收到，正在审查：https://gitcode.com/qwren/opsbot/pull/127',
  });
  await tick();
  assert.equal(store.getPr('qwren/opsbot#127').pending['hangdu-bot'], 'pending');

  await workflow.onFeishuMessage({
    messageId: 'third-party-no-link', chatId: 'chat', senderOpenId: 'bot-hangdu', senderType: 'app', messageType: 'text',
    text: '@何伟栋分身 审查意见已提交',
  });
  await tick();
  assert.equal(store.getPr('qwren/opsbot#127').pending['hangdu-bot'], 'pending', 'compatibility requires an explicit PR link');

  await workflow.onFeishuMessage({
    messageId: 'third-party-complete', chatId: 'chat', senderOpenId: 'bot-hangdu', senderType: 'app', messageType: 'text',
    text: '@何伟栋分身 审查意见已提交：[https://gitcode.com/qwren/opsbot/pull/127](https://gitcode.com/qwren/opsbot/pull/127)',
  });
  await waitFor(() => store.getPr('qwren/opsbot#127').phase === 'completed');

  assert.equal(summaryCalls, 1);
  assert.ok(sent.some((item) => String(item[1]).includes('可以合入')));
});

test('third-party result compatibility distinguishes progress, success, and failure', () => {
  assert.equal(parseCompatibleReviewBotResult('已收到，正在审查'), null);
  assert.deepEqual(parseCompatibleReviewBotResult('审查意见已提交'), { status: 'success' });
  assert.deepEqual(parseCompatibleReviewBotResult('本次复审执行失败'), { status: 'failed' });
  assert.equal(parseCompatibleReviewBotResult('请审查并提交 inline comments'), null);
});

test('first-start mode reports how to bind the owner without running a review', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-bootstrap-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.load();
  const sent = [];
  let reviewCalls = 0;
  const workflow = new ReviewWorkflow({
    config: {
      feishu: { ownerOpenId: '', ownerName: 'PR 所有人', botName: '未绑定bot' },
      gitcode: { allowedRepos: new Set(['org/repo']) },
      reviewers: [{ id: 'lisi', name: '李四bot', openId: 'bot-lisi', mode: 'feishu' }],
      maxReviewCycles: 3,
    },
    store,
    feishu: { send: async (...args) => sent.push(args) },
    agent: { runReview: async () => { reviewCalls += 1; } },
  });

  await workflow.onFeishuMessage({
    messageId: 'setup-message', chatId: 'chat', senderOpenId: 'owner-from-event', senderType: 'user',
    messageType: 'text', text: '@bot 获取我的 open_id',
  });
  assert.equal(reviewCalls, 0);
  assert.match(sent[0][1], /已将你的 OWNER_OPEN_ID 输出/);
  assert.equal(sent[0][2][0].openId, 'owner-from-event');
});

test('owned PR with Feishu reviewers is rejected in a p2p chat', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-p2p-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.load();
  const sent = [];
  let reviewCalls = 0;
  const workflow = new ReviewWorkflow({
    config: {
      feishu: { ownerOpenId: 'owner', ownerName: '张三', botName: '张三bot' },
      gitcode: { allowedRepos: new Set(['org/repo']) },
      reviewers: [{ id: 'lisi', name: '李四bot', openId: 'bot-lisi', mode: 'feishu' }],
      maxReviewCycles: 3,
    },
    store,
    feishu: { send: async (...args) => sent.push(args) },
    agent: { runReview: async () => { reviewCalls += 1; } },
  });

  await workflow.onFeishuMessage({
    messageId: 'owner-p2p', chatId: 'p2p-chat', chatType: 'p2p', senderOpenId: 'owner', senderType: 'user',
    messageType: 'text', text: 'https://gitcode.com/org/repo/pull/10',
  });
  await waitFor(() => sent.length === 1);
  assert.match(sent[0][1], /无法在单聊中完成机器人互审/);
  assert.equal(reviewCalls, 0);
  assert.equal(store.getPr('org/repo#10'), null);
});

test('open_id setup command works even when an owner value is already configured', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-open-id-command-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.load();
  const sent = [];
  let reviewCalls = 0;
  const workflow = new ReviewWorkflow({
    config: {
      feishu: { ownerOpenId: 'old-placeholder', ownerName: '张三', botName: '张三bot' },
      gitcode: { allowedRepos: new Set(['org/repo']) },
      reviewers: [{ id: 'lisi', name: '李四bot', openId: 'bot-lisi', mode: 'feishu' }],
      maxReviewCycles: 3,
    },
    store,
    feishu: { send: async (...args) => sent.push(args) },
    agent: { runReview: async () => { reviewCalls += 1; } },
  });

  await workflow.onFeishuMessage({
    messageId: 'get-open-id', chatId: 'p2p-chat', chatType: 'p2p', senderOpenId: 'actual-owner', senderType: 'user',
    messageType: 'text', text: '获取我的 open_id',
  });
  assert.equal(reviewCalls, 0);
  assert.match(sent[0][1], /已将你的 OWNER_OPEN_ID 输出/);
  assert.equal(sent[0][2][0].openId, 'actual-owner');
});

function botResult(messageId, senderOpenId, mode, cycle) {
  return {
    messageId,
    chatId: 'chat',
    senderOpenId,
    senderType: 'app',
    messageType: 'text',
    text: `${buildReviewBotProtocol({ action: 'result', mode, cycle, status: 'success' })} https://gitcode.com/org/repo/pull/7`,
  };
}

function isInitialRequest(item) {
  return String(item[1]).includes('action=request mode=initial cycle=0');
}

async function tick(count = 2) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for workflow');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
