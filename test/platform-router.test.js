import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveRuntimeIdentities } from '../src/config.js';
import { StateStore } from '../src/state-store.js';
import { ReviewWorkflow } from '../src/workflow.js';
import { PrScanner } from '../src/pr-scanner.js';
import { createPlatformRouter } from '../src/platform-router.js';

async function context(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-platform-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.load();
  const config = loadConfig({
    FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', BOT_NAME: 'bot',
    REPO_PROVIDERS: 'gitcode,github',
    GITCODE_TOKEN: 'gc-token', GITHUB_TOKEN: 'gh-token',
    GITCODE_ALLOWED_REPOS: 'org/repo', GITHUB_ALLOWED_REPOS: 'org/repo',
    AUTO_REVIEW_CHAT_ID: 'chat',
    IDENTITY_MAPPINGS_JSON: JSON.stringify([
      { displayName: 'Owner', feishuOpenId: 'owner-user', botOpenId: 'owner-bot', gitcodeLogin: 'gc-owner', githubLogin: 'gh-owner' },
      { displayName: 'Reviewer', feishuOpenId: 'reviewer-user', botOpenId: 'reviewer-bot', gitcodeLogin: 'gc-reviewer', githubLogin: 'gh-reviewer' },
    ]),
  });
  const sent = [];
  const feishu = { send: async (...args) => sent.push(args) };
  const workflows = {};
  const scanners = {};
  const addressed = [];
  const unresolved = { gitcode: 1, github: 1 };
  for (const provider of config.repoProviders) {
    const prefix = provider === 'github' ? 'gh' : 'gc';
    const platformConfig = { ...config, repoProvider: provider };
    const identities = resolveRuntimeIdentities(config.identityMappings, {
      botIdentity: { openId: 'owner-bot' }, repositoryUser: { login: `${prefix}-owner` }, provider,
    });
    const client = {
      getPr: async () => ({
        user: { login: `${prefix}-owner` }, head: { sha: 'head' },
        assignees: [{ login: 'gc-reviewer' }],
        requested_reviewers: [{ login: 'gh-reviewer' }],
      }),
      listUserPulls: async ({ scope }) => scope === 'created_by_me'
        ? [{ html_url: `https://${provider}.com/org/repo/pull/7` }] : [],
      unresolvedSummary: async () => ({
        unresolvedCount: unresolved[provider], unresolvedReviewerLogins: unresolved[provider] ? [`${prefix}-reviewer`] : [],
      }),
    };
    const agent = {
      runAddressFeedback: async ({ pr }) => {
        addressed.push(pr.key);
        return { durationMs: 100, result: { commitSha: 'new-head' } };
      },
    };
    const workflow = new ReviewWorkflow({ config: platformConfig, store, feishu, client, identities, agent });
    workflows[provider] = workflow;
    scanners[provider] = new PrScanner({ config: platformConfig, store, feishu, client, identities, workflow });
  }
  return { config, store, sent, feishu, workflows, scanners, addressed, unresolved,
    route: createPlatformRouter({ workflows, store, feishu }) };
}

function message(id, text, sender = 'owner-user') {
  return { messageId: id, chatId: 'chat', senderOpenId: sender, senderType: sender.endsWith('bot') ? 'app' : 'user', messageType: 'text', chatType: 'group', text };
}

test('one bot handles colliding PRs on both platforms through a full GitHub feedback cycle', async (t) => {
  const c = await context(t);
  await c.route(message('gc-start', 'https://gitcode.com/org/repo/pull/7'));
  await c.route(message('gh-start', 'https://github.com/org/repo/pull/7'));
  assert.deepEqual(c.store.getPr('org/repo#7').pending, { 'gc-reviewer': 'pending' });
  assert.deepEqual(c.store.getPr('github:org/repo#7').pending, { 'gh-reviewer': 'pending' });
  assert.equal(c.store.getPr('github:org/repo#7').reviewers[0].githubLogin, 'gh-reviewer');
  const before = c.sent.length;
  await c.route(message('gh-start', 'https://github.com/org/repo/pull/7'));
  assert.equal(c.sent.length, before, 'shared message deduplication still works');
  await c.route(message('ambiguous', '取消任务'));
  assert.match(c.sent.at(-1)[1], /多个进行中的任务/);
  assert.equal(c.store.getPr('github:org/repo#7').phase, 'awaiting_review');

  await c.route(message('gh-review', '[review-bot action=result mode=initial cycle=0 status=success] https://github.com/org/repo/pull/7', 'reviewer-bot'));
  assert.deepEqual(c.addressed, ['github:org/repo#7']);
  assert.equal(c.store.getPr('github:org/repo#7').phase, 'awaiting_rereview');
  assert.equal(c.store.getPr('org/repo#7').phase, 'awaiting_review');
  c.unresolved.github = 0;
  await c.route(message('gh-rereview', '[review-bot action=result mode=rereview cycle=1 status=success] https://github.com/org/repo/pull/7', 'reviewer-bot'));
  assert.equal(c.store.getPr('github:org/repo#7').phase, 'completed');
  assert.equal(c.store.getPr('org/repo#7').phase, 'awaiting_review');
  await c.route(message('cancel-only-active', '取消任务'));
  assert.equal(c.store.getPr('org/repo#7').phase, 'cancelled');
});

test('both scanners dispatch with their own identities and independent task keys', async (t) => {
  const c = await context(t);
  assert.deepEqual(await Promise.all(Object.values(c.scanners).map((scanner) => scanner.scanOnce())), [true, true]);
  assert.equal(c.store.getPr('org/repo#7').reviewers[0].id, 'gc-reviewer');
  assert.equal(c.store.getPr('github:org/repo#7').reviewers[0].id, 'gh-reviewer');
  const initial = c.sent.filter((item) => item[1].includes('action=request mode=initial')).length;
  await Promise.all(Object.values(c.scanners).map((scanner) => scanner.scanOnce()));
  assert.equal(c.sent.filter((item) => item[1].includes('action=request mode=initial')).length, initial);
});

test('routing rejects disabled platforms without falling back to GitCode', async (t) => {
  const c = await context(t);
  const route = createPlatformRouter({ workflows: { gitcode: c.workflows.gitcode }, store: c.store, feishu: c.feishu });
  await route(message('disabled', 'https://github.com/org/repo/pull/7'));
  assert.match(c.sent.at(-1)[1], /未启用 github/);
  assert.equal(c.store.listPrs().length, 0);
});

test('a GitCode scan failure does not prevent the GitHub scanner from dispatching', async (t) => {
  const c = await context(t);
  c.scanners.gitcode.client.listUserPulls = async () => { throw new Error('GitCode unavailable'); };
  assert.deepEqual(await Promise.all(Object.values(c.scanners).map((scanner) => scanner.scanOnce())), [false, true]);
  assert.equal(c.store.getPr('org/repo#7'), null);
  assert.equal(c.store.getPr('github:org/repo#7').phase, 'awaiting_review');
});

test('recovery only handles states belonging to its platform', async (t) => {
  const c = await context(t);
  for (const provider of ['gitcode', 'github']) {
    await c.store.claimExternalReviewRequest({
      prKey: `${provider === 'github' ? 'github:' : ''}org/repo#8`,
      prUrl: `https://${provider}.com/org/repo/pull/8`,
      chatId: 'chat', requesterOpenId: 'requester', headSha: 'head', mode: 'initial', cycle: 0,
    });
  }
  await c.workflows.gitcode.recoverInterruptedTasks();
  assert.equal(c.store.listRunningExternalReviewRequests().length, 1);
  assert.match(c.store.listRunningExternalReviewRequests()[0].prUrl, /github.com/);
  await c.workflows.github.recoverInterruptedTasks();
  assert.equal(c.store.listRunningExternalReviewRequests().length, 0);
  assert.equal(c.sent.length, 2);
});
