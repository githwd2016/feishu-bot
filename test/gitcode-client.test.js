import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GitCodeClient,
  isUnresolvedReviewComment,
  summarizeUnresolvedReviewComments,
} from '../src/gitcode-client.js';

test('GitCodeClient lists current-user pull requests with scope and pagination', async (t) => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const page = new URL(url).searchParams.get('page');
    const data = page === '1' ? Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })) : [{ number: 101 }];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const client = new GitCodeClient({ token: 'secret', apiBase: 'https://api.gitcode.com/api/v5' });
  const prs = await client.listUserPulls({ scope: 'need_my_approve' });

  assert.equal(prs.length, 101);
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[0]).searchParams.get('scope'), 'need_my_approve');
  assert.equal(new URL(urls[0]).searchParams.get('state'), 'open');
  assert.doesNotMatch(urls[0], /secret/);
});

test('isUnresolvedReviewComment handles GitCode response variants', () => {
  assert.equal(isUnresolvedReviewComment({ resolved: false }), true);
  assert.equal(isUnresolvedReviewComment({ resolved: true, need_to_resolve: true }), false);
  assert.equal(isUnresolvedReviewComment({ need_to_resolve: true }), true);
  assert.equal(isUnresolvedReviewComment({ need_to_resolve: false }), false);
  assert.equal(isUnresolvedReviewComment({ body: 'ordinary timeline note' }), false);
});

test('summarizeUnresolvedReviewComments de-duplicates discussions and reviewer logins', () => {
  const summary = summarizeUnresolvedReviewComments([
    { id: 1, discussion_id: 'd1', resolved: false, user: { login: 'lisi' } },
    { id: 2, discussion_id: 'd1', resolved: false, user: { login: 'lisi' } },
    { id: 3, discussion_id: 'd2', need_to_resolve: true, author: { username: 'wangwu' } },
    { id: 4, discussion_id: 'd3', resolved: true, user: { login: 'zhaoliu' } },
    { id: 5, body: 'ordinary timeline note' },
  ]);
  assert.deepEqual(summary, {
    unresolvedCount: 2,
    unresolvedReviewerLogins: ['lisi', 'wangwu'],
  });
});
