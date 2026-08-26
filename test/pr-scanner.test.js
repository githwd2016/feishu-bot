import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PrScanner } from '../src/pr-scanner.js';
import { StateStore } from '../src/state-store.js';

const SELF = { displayName: '张三', feishuOpenId: 'user-self', gitcodeLogin: 'zhangsan', botOpenId: 'bot-self' };
const LISI = { displayName: '李四', feishuOpenId: 'user-lisi', gitcodeLogin: 'lisi', botOpenId: 'bot-lisi' };
const WANGWU = { displayName: '王五', feishuOpenId: 'user-wangwu', gitcodeLogin: 'wangwu', botOpenId: 'bot-wangwu' };

test('scanner reviews assigned PRs and dispatches each mapped assignee once per head SHA', async (t) => {
  const context = await makeContext(t);
  let assignedSha = 'assigned-a';
  let ownedSha = 'owned-a';
  const automaticReviews = [];
  const ownedDispatches = [];
  const scanner = makeScanner(context, {
    gitcode: {
      listUserPulls: async ({ scope }) => scope === 'need_my_approve'
        ? [{ html_url: 'https://gitcode.com/org/repo/pull/1' }]
        : [{ html_url: 'https://gitcode.com/org/repo/pull/2' }],
      getPr: async (pr) => pr.number === 1
        ? details('lisi', assignedSha, ['zhangsan'])
        : details('zhangsan', ownedSha, ['lisi', 'wangwu']),
    },
    workflow: {
      reviewAutomatically: async (input) => automaticReviews.push(input),
      startAutomaticOwnedReview: async (input) => {
        ownedDispatches.push(input);
        return { started: true };
      },
    },
  });

  assert.equal(await scanner.scanOnce(), true);
  assert.equal(automaticReviews.length, 1);
  assert.deepEqual(ownedDispatches[0].reviewers.map((item) => item.openId).sort(), ['bot-lisi', 'bot-wangwu']);

  await scanner.scanOnce();
  assert.equal(automaticReviews.length, 1);
  assert.equal(ownedDispatches.length, 1);

  assignedSha = 'assigned-b';
  ownedSha = 'owned-b';
  await scanner.scanOnce();
  assert.equal(automaticReviews.length, 2);
  assert.equal(ownedDispatches.length, 2);
});

test('scanner refuses partial owned-PR dispatch when an assignee mapping is missing', async (t) => {
  const context = await makeContext(t);
  let dispatchCalls = 0;
  const scanner = makeScanner(context, {
    people: [SELF, LISI],
    gitcode: {
      listUserPulls: async ({ scope }) => scope === 'created_by_me'
        ? [{ html_url: 'https://gitcode.com/org/repo/pull/2' }]
        : [],
      getPr: async () => details('zhangsan', 'owned-a', ['lisi', 'unknown']),
    },
    workflow: { startAutomaticOwnedReview: async () => { dispatchCalls += 1; } },
  });

  await scanner.scanOnce();
  await scanner.scanOnce();

  assert.equal(dispatchCalls, 0);
  assert.equal(context.sent.length, 1, 'blocked warning is emitted once per process and fingerprint');
  assert.match(context.sent[0][1], /unknown/);
  assert.equal(context.sent[0][2][0].openId, SELF.feishuOpenId);
});

test('scanner skips WIP PRs in both automatic scopes', async (t) => {
  const context = await makeContext(t);
  const automaticReviews = [];
  const ownedDispatches = [];
  const loadedPrNumbers = [];
  const scanner = makeScanner(context, {
    gitcode: {
      listUserPulls: async ({ scope }) => scope === 'need_my_approve'
        ? [{ html_url: 'https://gitcode.com/org/repo/pull/1', draft: true }]
        : [{ html_url: 'https://gitcode.com/org/repo/pull/2' }],
      getPr: async (pr) => {
        loadedPrNumbers.push(pr.number);
        return { ...details('zhangsan', 'owned-a', ['lisi']), work_in_progress: true };
      },
    },
    workflow: {
      reviewAutomatically: async (input) => automaticReviews.push(input),
      startAutomaticOwnedReview: async (input) => {
        ownedDispatches.push(input);
        return { started: true };
      },
    },
  });

  assert.equal(await scanner.scanOnce(), true);
  assert.deepEqual(loadedPrNumbers, [2], 'list-level WIP flags skip the details request');
  assert.equal(automaticReviews.length, 0);
  assert.equal(ownedDispatches.length, 0);
});

test('scanner retries failed automatic reviews three times and then alerts the responsible user', async (t) => {
  const context = await makeContext(t);
  let attempts = 0;
  const scanner = makeScanner(context, {
    gitcode: {
      listUserPulls: async ({ scope }) => scope === 'need_my_approve'
        ? [{ html_url: 'https://gitcode.com/org/repo/pull/1' }]
        : [],
      getPr: async () => details('lisi', 'assigned-a', ['zhangsan']),
    },
    workflow: {
      reviewAutomatically: async () => {
        attempts += 1;
        throw new Error('agent failed');
      },
    },
  });

  await scanner.scanOnce();
  await scanner.scanOnce();
  await scanner.scanOnce();
  await scanner.scanOnce();

  assert.equal(attempts, 3);
  const alert = context.sent.find((item) => String(item[1]).includes('连续失败 3 次'));
  assert.equal(alert[2][0].openId, LISI.feishuOpenId);
});

test('scanner skips a tick while the previous scan is still running', async (t) => {
  const context = await makeContext(t);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const scanner = makeScanner(context, {
    gitcode: {
      listUserPulls: async () => {
        await blocked;
        return [];
      },
    },
  });

  const first = scanner.scanOnce();
  assert.equal(await scanner.scanOnce(), false);
  release();
  assert.equal(await first, true);
});

async function makeContext(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-scanner-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.load();
  return { store, sent: [] };
}

function makeScanner(context, { people = [SELF, LISI, WANGWU], gitcode, workflow = {} }) {
  const identities = {
    self: SELF,
    byGitcodeLogin: (login) => people.find((item) => item.gitcodeLogin === String(login).toLowerCase()) || null,
  };
  return new PrScanner({
    config: {
      feishu: { autoReviewChatId: 'auto-chat' },
      gitcode: { allowedRepos: new Set(['org/repo']) },
      scan: { intervalMs: 300_000, maxAttempts: 3 },
      agent: { timeoutMs: 1000 },
    },
    store: context.store,
    gitcode,
    workflow,
    feishu: { send: async (...args) => context.sent.push(args) },
    identities,
  });
}

function details(author, sha, assignees) {
  return {
    user: { login: author },
    head: { sha },
    assignees: assignees.map((login) => ({ login })),
  };
}
