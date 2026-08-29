import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state-store.js';

test('StateStore persists PR state and de-duplicates messages', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-bot-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const store = new StateStore(file);
  await store.load();
  assert.equal(await store.claimMessage('m1'), true);
  assert.equal(await store.claimMessage('m1'), false);
  const initial = await store.claimExternalReviewRequest({
    prKey: 'a/b#1', prUrl: 'https://gitcode.com/a/b/pull/1', chatId: 'c1',
    requesterOpenId: 'bot', mode: 'initial', headSha: 'sha-1',
  });
  assert.equal(initial.claimed, true);
  assert.equal(initial.record.cycle, 0);
  assert.equal((await store.claimExternalReviewRequest({
    prKey: 'a/b#1', prUrl: 'https://gitcode.com/a/b/pull/1', chatId: 'c1',
    requesterOpenId: 'bot', mode: 'initial', headSha: 'sha-1',
  })).claimed, false);
  const rereview = await store.claimExternalReviewRequest({
    prKey: 'a/b#1', prUrl: 'https://gitcode.com/a/b/pull/1', chatId: 'c1',
    requesterOpenId: 'bot', mode: 'rereview', headSha: 'sha-1',
  });
  assert.equal(rereview.record.cycle, 1);
  assert.equal((await store.claimExternalReviewRequest({
    prKey: 'a/b#1', prUrl: 'https://gitcode.com/a/b/pull/1', chatId: 'c1',
    requesterOpenId: 'bot', mode: 'rereview', headSha: 'sha-1',
  })).record.cycle, 1);
  assert.equal((await store.claimExternalReviewRequest({
    prKey: 'a/b#1', prUrl: 'https://gitcode.com/a/b/pull/1', chatId: 'c1',
    requesterOpenId: 'bot', mode: 'rereview', headSha: 'sha-2',
  })).record.cycle, 2);
  const lease = await store.claimAutomationTask('review|a/b#1|sha', {
    maxAttempts: 3, staleAfterMs: 60_000,
  });
  assert.equal(lease.status, 'running');
  assert.equal(lease.attempts, 1);
  assert.match(lease.updatedAt, /^\d{4}-/);
  await store.completeAutomationTask('review|a/b#1|sha');
  await store.putPr({ key: 'a/b#1', url: 'https://gitcode.com/a/b/pull/1', chatId: 'c1', phase: 'awaiting_review' });

  const reloaded = new StateStore(file);
  await reloaded.load();
  assert.equal(reloaded.getPr('a/b#1').chatId, 'c1');
  assert.deepEqual(reloaded.listPrs().map((item) => item.key), ['a/b#1']);
  assert.equal(await reloaded.claimMessage('m1'), false);
  assert.equal((await reloaded.claimExternalReviewRequest({
    prKey: 'a/b#1', prUrl: 'https://gitcode.com/a/b/pull/1', chatId: 'c1',
    requesterOpenId: 'bot', mode: 'rereview', headSha: 'sha-2',
  })).claimed, false);
  assert.equal(reloaded.getAutomationTask('review|a/b#1|sha').status, 'succeeded');
  assert.equal(await reloaded.claimAutomationTask('review|a/b#1|sha', {
    maxAttempts: 3, staleAfterMs: 0,
  }), null);
});

test('StateStore migrates version 4 cycle counters and preserves running external reviews', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-bot-v4-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const trackerKey = JSON.stringify(['a/b#2', 'c1', 'bot']);
  const legacyRequestKey = JSON.stringify(['a/b#2', 'bot', 'rereview', 2]);
  await fs.writeFile(file, JSON.stringify({
    version: 4,
    prs: { 'a/b#2': { key: 'a/b#2', phase: 'completed' } },
    externalReviewCycles: { [trackerKey]: 2 },
    externalReviewRequests: {
      [legacyRequestKey]: {
        key: legacyRequestKey, prKey: 'a/b#2', prUrl: 'https://gitcode.com/a/b/pull/2', chatId: 'c1',
        requesterOpenId: 'bot', mode: 'rereview', cycle: 2, status: 'running', resultMessage: '',
      },
    },
    automationTasks: { legacy: { status: 'succeeded', attempts: 1 } },
    seenMessageIds: ['legacy-message'],
  }));

  const store = new StateStore(file);
  await store.load();
  assert.equal(store.listRunningExternalReviewRequests()[0].key, legacyRequestKey);
  assert.equal(store.getAutomationTask('legacy').status, 'succeeded');
  assert.equal(await store.claimMessage('legacy-message'), false);
  const next = await store.claimExternalReviewRequest({
    prKey: 'a/b#2', prUrl: 'https://gitcode.com/a/b/pull/2', chatId: 'c1',
    requesterOpenId: 'bot', mode: 'rereview', headSha: 'sha-new',
  });
  assert.equal(next.record.cycle, 3);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 5);
});
