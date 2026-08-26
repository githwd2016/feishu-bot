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
  assert.equal(await store.claimExternalReviewCycle({
    prKey: 'a/b#1', chatId: 'c1', requesterOpenId: 'user', mode: 'initial',
  }), 0);
  assert.equal(await store.claimExternalReviewCycle({
    prKey: 'a/b#1', chatId: 'c1', requesterOpenId: 'user', mode: 'rereview',
  }), 1);
  assert.equal((await store.claimExternalReviewRequest({
    prKey: 'a/b#1', chatId: 'c1', requesterOpenId: 'bot', mode: 'initial', cycle: 0,
  })).claimed, true);
  assert.equal((await store.claimExternalReviewRequest({
    prKey: 'a/b#1', chatId: 'c1', requesterOpenId: 'bot', mode: 'initial', cycle: 0,
  })).claimed, false);
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
  assert.equal(await reloaded.claimExternalReviewCycle({
    prKey: 'a/b#1', chatId: 'c1', requesterOpenId: 'user', mode: 'rereview',
  }), 2);
  assert.equal(reloaded.getAutomationTask('review|a/b#1|sha').status, 'succeeded');
  assert.equal(await reloaded.claimAutomationTask('review|a/b#1|sha', {
    maxAttempts: 3, staleAfterMs: 0,
  }), null);
});
