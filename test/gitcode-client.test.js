import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isUnresolvedReviewComment,
  summarizeUnresolvedReviewComments,
} from '../src/gitcode-client.js';

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
