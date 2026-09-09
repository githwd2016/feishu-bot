import { summarizeUnresolvedReviewComments } from './gitcode-client.js';

const THREAD_FIELDS = `id isResolved isOutdated path line diffSide
  comments(first: 100) {
    nodes { id fullDatabaseId body author { login } url diffHunk }
    pageInfo { hasNextPage endCursor }
  }`;

export class GitHubClient {
  constructor({ token, apiBase = 'https://api.github.com', allowedRepos = new Set() }) {
    this.token = token;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.allowedRepos = allowedRepos;
  }

  async getCurrentUser() {
    this.currentUser ??= await this.request('/user');
    return this.currentUser;
  }

  async getPr(pr) {
    const data = await this.request(this.prPath(pr));
    // GitHub removes requested reviewers once they submit a review. Keep those
    // participants available for author dispatch and later review cycles.
    const reviews = await this.list(`${this.prPath(pr)}/reviews`);
    return { ...data, reviewed_by: reviews.filter((r) => r.state !== 'PENDING').map((r) => r.user).filter(Boolean) };
  }

  async listUserPulls({ scope, state = 'open' }) {
    if (!['need_my_approve', 'created_by_me'].includes(scope)) throw new Error(`不支持的 GitHub PR scope: ${scope}`);
    const user = await this.getCurrentUser();
    if (!user?.login) throw new Error('GitHub /user 未返回 login');
    const login = user.login.toLowerCase();
    const all = [];
    // Enumerate only allowlisted repositories, avoiding Search API indexing lag
    // and its 1,000-result cap.
    for (const repoKey of this.allowedRepos) {
      const pulls = await this.list(`/repos/${repoKey.split('/').map(encodeURIComponent).join('/')}/pulls?state=${encodeURIComponent(state)}&sort=updated&direction=desc`);
      all.push(...pulls.filter((pr) => scope === 'created_by_me'
        ? pr.user?.login?.toLowerCase() === login
        : pr.requested_reviewers?.some((reviewer) => reviewer.login?.toLowerCase() === login)));
    }
    return all;
  }

  async listFiles(pr) {
    return this.completePrList(pr, 'files', 'changed_files');
  }

  async listCommits(pr) {
    return this.completePrList(pr, 'commits', 'commits');
  }

  async completePrList(pr, resource, countField) {
    const details = await this.request(this.prPath(pr));
    const items = await this.list(`${this.prPath(pr)}/${resource}`);
    // GitHub caps the files and commits endpoints even when callers paginate.
    // Never present a truncated review input as the complete PR.
    if (!Number.isInteger(details?.[countField]) || items.length !== details[countField]) {
      throw new Error(`GitHub PR ${resource} 数据不完整或 PR 已变化，请重新读取`);
    }
    return items;
  }

  async listThreads(pr) {
    const threads = [];
    let after = null;
    do {
      const data = await this.graphql(`query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $after) {
              nodes { ${THREAD_FIELDS} }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`, { owner: pr.owner, repo: pr.repo, number: pr.number, after });
      const connection = data?.repository?.pullRequest?.reviewThreads;
      const next = nextCursor(connection);
      if (next && next === after) throw new Error('GitHub review threads 分页游标未前进');
      after = next;
      for (const thread of connection.nodes) {
        if (!thread?.id || typeof thread.isResolved !== 'boolean' || !thread.comments?.nodes?.length) {
          throw new Error('GitHub review thread 返回了不完整数据');
        }
        let commentCursor = nextCursor(thread.comments);
        const comments = [...thread.comments.nodes];
        while (commentCursor) {
          const more = await this.graphql(`query ThreadComments($id: ID!, $after: String!) {
            node(id: $id) { ... on PullRequestReviewThread {
              comments(first: 100, after: $after) {
                nodes { id fullDatabaseId body author { login } url diffHunk }
                pageInfo { hasNextPage endCursor }
              }
            } }
          }`, { id: thread.id, after: commentCursor });
          const batch = more?.node?.comments;
          const next = nextCursor(batch);
          if (next === commentCursor) throw new Error('GitHub comments 分页游标未前进');
          comments.push(...batch.nodes);
          commentCursor = next;
        }
        threads.push({ ...thread, comments });
      }
    } while (after);
    return threads;
  }

  async listComments(pr) {
    const threads = await this.listThreads(pr);
    return threads.flatMap((thread) => thread.comments.map((comment) => ({
      ...comment,
      id: comment.fullDatabaseId,
      node_id: comment.id,
      user: comment.author,
      discussion_id: thread.id,
      resolved: thread.isResolved,
      need_to_resolve: true,
      is_outdated: thread.isOutdated,
      path: thread.path,
      line: thread.line,
      side: thread.diffSide,
    })));
  }

  async unresolvedComments(pr) {
    return (await this.listComments(pr)).filter((comment) => !comment.resolved);
  }

  async unresolvedSummary(pr) {
    return summarizeUnresolvedReviewComments(await this.listComments(pr));
  }

  async postInlineComment(pr, { body, path, line, side = 'RIGHT', commitId }) {
    if (!Number.isSafeInteger(line) || line <= 0 || !['LEFT', 'RIGHT'].includes(side) || !path || !body?.trim() || !commitId) {
      throw new Error('GitHub inline comment 必须包含 body、path、line、side 和 commitId');
    }
    const latest = await this.request(this.prPath(pr));
    if (latest.head?.sha !== commitId) throw new Error('GitHub PR head 已变化，请重新审查后再发表评论');
    return this.request(`${this.prPath(pr)}/comments`, {
      method: 'POST', body: { body, path, line, side, commit_id: commitId },
    });
  }

  async reply(pr, discussionId, body) {
    const thread = await this.targetThread(pr, discussionId);
    const rootId = thread.comments[0]?.fullDatabaseId;
    if (!rootId) throw new Error('GitHub discussion 缺少根评论 ID');
    return this.request(`${this.prPath(pr)}/comments/${rootId}/replies`, { method: 'POST', body: { body } });
  }

  async setResolved(pr, discussionId, resolved) {
    const thread = await this.targetThread(pr, discussionId);
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    const data = await this.graphql(`mutation ResolveThread($id: ID!) {
      ${mutation}(input: {threadId: $id}) { thread { id isResolved } }
    }`, { id: thread.id });
    const result = data?.[mutation]?.thread;
    if (result?.id !== thread.id || result.isResolved !== resolved) throw new Error('GitHub discussion resolved 状态验证失败');
    return result;
  }

  async targetThread(pr, discussionId) {
    const thread = (await this.listThreads(pr)).find((item) => item.id === discussionId);
    if (!thread) throw new Error('GitHub discussion 不属于目标 PR');
    return thread;
  }

  prPath(pr) {
    return `/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}`;
  }

  async list(resource) {
    const all = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request(`${resource}${resource.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('GitHub 列表接口返回了非数组数据');
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }

  async graphql(query, variables) {
    const response = await this.request('/graphql', { method: 'POST', body: { query, variables } });
    if (response?.errors?.length || !response?.data) {
      throw new Error('GitHub GraphQL 返回错误或不完整数据，请检查权限及接口状态');
    }
    return response.data;
  }

  async request(resource, { method = 'GET', body } = {}) {
    const response = await fetch(`${this.apiBase}${resource}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2026-03-10',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${resource.split('?')[0]} 返回 ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
}

function nextCursor(connection) {
  if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
    throw new Error('GitHub GraphQL 分页数据不完整');
  }
  if (!connection.pageInfo.hasNextPage) return null;
  if (!connection.pageInfo.endCursor) throw new Error('GitHub GraphQL 缺少分页游标');
  return connection.pageInfo.endCursor;
}
