import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../src/github-client.js';
import { parsePrUrl } from '../src/pr.js';

const pr = parsePrUrl('https://github.com/org/repo/pull/7');
const connection = (nodes, after = null) => ({ nodes, pageInfo: { hasNextPage: Boolean(after), endCursor: after } });
const comment = (id, login = 'reviewer') => ({ id: `C${id}`, fullDatabaseId: String(id), body: `comment ${id}`, author: { login } });
const thread = (id, resolved = false) => ({
  id, isResolved: resolved, isOutdated: true, path: 'src/a.js', line: 12, diffSide: 'RIGHT',
  comments: connection([comment(1)]),
});
const threadResponse = (threads, after = null) => ({ repository: { pullRequest: { reviewThreads: connection(threads, after) } } });

test('GitHub scans only allowlisted repos, paginates, and uses requested reviewers', async () => {
  const client = new GitHubClient({ token: 'token', allowedRepos: new Set(['org/repo']) });
  const paths = [];
  client.request = async (path) => {
    paths.push(path);
    if (path === '/user') return { login: 'Me' };
    if (new URL(path, 'https://api.github.com').searchParams.get('page') === '1') return Array.from({ length: 100 }, (_, i) => ({ number: i, user: { login: 'other' } }));
    return [
      { number: 101, user: { login: 'me' } },
      { number: 102, user: { login: 'other' }, requested_reviewers: [{ login: 'ME' }] },
      { number: 103, user: { login: 'other' }, assignees: [{ login: 'me' }] },
    ];
  };
  assert.deepEqual((await client.listUserPulls({ scope: 'need_my_approve' })).map((p) => p.number), [102]);
  assert.deepEqual((await client.listUserPulls({ scope: 'created_by_me' })).map((p) => p.number), [101]);
  assert.equal(paths.filter((path) => path === '/user').length, 1);
  assert.ok(paths.every((path) => path === '/user' || path.startsWith('/repos/org/repo/pulls?')));
  await assert.rejects(client.listUserPulls({ scope: 'unsupported' }), /scope/);
});

test('GitHub retains reviewers after their requested review is submitted', async () => {
  const client = new GitHubClient({ token: 'token' });
  client.request = async (path) => path.includes('/reviews?')
    ? [{ state: 'COMMENTED', user: { login: 'reviewer' } }, { state: 'PENDING', user: { login: 'pending' } }]
    : { head: { sha: 'head' }, requested_reviewers: [] };
  assert.deepEqual((await client.getPr(pr)).reviewed_by, [{ login: 'reviewer' }]);
});

test('GitHub refuses truncated files or commits despite successful pagination', async () => {
  const client = new GitHubClient({ token: 'token' });
  let count = 2;
  client.request = async (path) => path.includes('?') ? [{ filename: 'one-file' }] : { changed_files: count, commits: count };
  await assert.rejects(client.listFiles(pr), /数据不完整/);
  await assert.rejects(client.listCommits(pr), /数据不完整/);
  count = 1;
  assert.equal((await client.listFiles(pr)).length, 1);
  assert.equal((await client.listCommits(pr)).length, 1);
});

test('GitHub paginates threads and replies and counts each unresolved root once', async () => {
  const client = new GitHubClient({ token: 'token' });
  const seen = [];
  client.graphql = async (query, variables) => {
    seen.push(variables);
    assert.doesNotMatch(query, /\bdatabaseId\b/);
    assert.match(query, /fullDatabaseId/);
    if (query.includes('query ThreadComments')) return { node: { comments: connection([comment(2, 'reply-author')]) } };
    if (variables.after === 'next-threads') return threadResponse([thread('resolved-thread', true)]);
    return threadResponse([{ ...thread('unresolved-thread'), comments: connection([comment(1)], 'next-comments') }], 'next-threads');
  };
  const comments = await client.listComments(pr);
  assert.equal(comments.length, 3);
  assert.equal(comments[1].discussion_id, 'unresolved-thread');
  assert.equal(comments[1].user.login, 'reply-author');
  assert.equal(comments[0].is_outdated, true);
  assert.deepEqual(await client.unresolvedSummary(pr), { unresolvedCount: 1, unresolvedReviewerLogins: ['reviewer'] });
  assert.ok(seen.some((v) => v.after === 'next-comments'));
  assert.ok(seen.some((v) => v.after === 'next-threads'));
});

test('GitHub fails closed on GraphQL errors or missing resolution and pagination data', async () => {
  const client = new GitHubClient({ token: 'token' });
  client.request = async () => ({ data: threadResponse([]), errors: [{ message: 'permission error' }] });
  await assert.rejects(client.unresolvedSummary(pr), /GraphQL/);
  client.request = async () => ({ data: { repository: null } });
  await assert.rejects(client.unresolvedSummary(pr), /分页数据不完整/);
  client.request = async () => ({ data: threadResponse([{ ...thread('t'), isResolved: undefined }]) });
  await assert.rejects(client.unresolvedSummary(pr), /不完整数据/);
});

test('GitHub inline writes use line, side and reviewed commit and reject changed heads', async () => {
  const client = new GitHubClient({ token: 'token' });
  const writes = [];
  client.request = async (path, options) => {
    if (!options) return { head: { sha: 'head' } };
    writes.push({ path, ...options });
    return { id: 9, ...options.body };
  };
  await client.postInlineComment(pr, { body: 'bug', path: 'a.js', line: 3, side: 'LEFT', commitId: 'head' });
  assert.deepEqual(writes, [{ path: '/repos/org/repo/pulls/7/comments', method: 'POST', body: { body: 'bug', path: 'a.js', line: 3, side: 'LEFT', commit_id: 'head' } }]);
  await assert.rejects(client.postInlineComment(pr, { body: 'bug', path: 'a.js', line: 3, commitId: 'old' }), /head 已变化/);
  assert.equal(writes.length, 1);
});

test('GitHub reply and resolve verify discussion belongs to the exact PR before writing', async () => {
  const client = new GitHubClient({ token: 'token' });
  client.listThreads = async () => [{ ...thread('target'), comments: [comment('9223372036854775806')] }];
  const writes = [];
  client.request = async (path, options) => { writes.push({ path, ...options }); return {}; };
  client.graphql = async (query, variables) => {
    writes.push({ query, variables });
    return { resolveReviewThread: { thread: { id: 'target', isResolved: true } } };
  };
  await assert.rejects(client.reply(pr, 'foreign-thread', 'reply'), /不属于目标 PR/);
  await assert.rejects(client.setResolved(pr, 'foreign-thread', true), /不属于目标 PR/);
  assert.equal(writes.length, 0);
  await client.reply(pr, 'target', 'fixed');
  assert.equal(writes[0].path, '/repos/org/repo/pulls/7/comments/9223372036854775806/replies');
  await client.setResolved(pr, 'target', true);
  assert.deepEqual(writes[1].variables, { id: 'target' });
});

test('GitHub HTTP requests use token headers and do not leak upstream secrets on errors', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response('{"message":"test-token"}', { status: 403 });
  });
  const client = new GitHubClient({ token: 'test-token' });
  await assert.rejects(client.getCurrentUser(), (error) => /返回 403/.test(error.message) && !error.message.includes('test-token'));
  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].options.redirect, 'error');
});
