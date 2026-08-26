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

const SELF = { displayName: '张三', feishuOpenId: 'user-zhangsan', gitcodeLogin: 'zhangsan', botOpenId: 'bot-zhangsan' };
const LISI = { displayName: '李四', feishuOpenId: 'user-lisi', gitcodeLogin: 'lisi', botOpenId: 'bot-lisi' };
const WANGWU = { displayName: '王五', feishuOpenId: 'user-wangwu', gitcodeLogin: 'wangwu', botOpenId: 'bot-wangwu' };

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

test('bot protocol requests are persisted and de-duplicated by PR, sender, mode, and cycle', async (t) => {
  const context = await makeContext(t);
  let reviewCalls = 0;
  const workflow = makeWorkflow(context, {
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

test('automatic assigned review runs the agent and mentions the mapped PR author', async (t) => {
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
  });

  const final = context.sent.at(-1);
  assert.match(final[1], /2 条待处理/);
  assert.equal(final[2][0].openId, LISI.feishuOpenId);
});

test('setup commands report the current chat ID and sender Feishu open ID', async (t) => {
  const context = await makeContext(t);
  const workflow = makeWorkflow(context);

  await workflow.onFeishuMessage(message({ messageId: 'chat-command', text: '获取 chat_id' }));
  await workflow.onFeishuMessage(message({ messageId: 'open-command', text: '获取我的 open_id' }));

  assert.match(context.sent[0][1], /当前会话 chat_id：chat/);
  assert.match(context.sent[1][1], new RegExp(SELF.feishuOpenId));
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
    requesterOpenId: LISI.botOpenId, mode: 'initial', cycle: 2,
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
  assert.deepEqual(parseCompatibleReviewBotResult('审查意见已提交'), { status: 'success' });
  assert.deepEqual(parseCompatibleReviewBotResult('本次复审执行失败'), { status: 'failed' });
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
