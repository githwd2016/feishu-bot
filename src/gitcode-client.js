export class GitCodeClient {
  constructor({ token, apiBase }) {
    this.token = token;
    this.apiBase = apiBase;
  }

  async getPr(pr) {
    return this.request(`/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}`);
  }

  async getCurrentUser() {
    return this.request('/user');
  }

  async listUserPulls({ scope, state = 'open' }) {
    if (!['need_my_approve', 'created_by_me'].includes(scope)) {
      throw new Error(`不支持的 GitCode PR scope: ${scope}`);
    }
    const all = [];
    for (let page = 1; page <= 100; page += 1) {
      const params = new URLSearchParams({
        scope,
        state,
        sort: 'updated',
        direction: 'desc',
        page: String(page),
        per_page: '100',
      });
      const batch = await this.request(`/user/pulls?${params}`);
      if (!Array.isArray(batch)) throw new Error('GitCode 用户 PR 列表接口返回了非数组数据');
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  async listFiles(pr) {
    return this.request(`/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}/files`);
  }

  async listComments(pr) {
    const all = [];
    for (let page = 1; page <= 20; page += 1) {
      const batch = await this.request(
        `/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}/comments?page=${page}&per_page=100&direction=asc`,
      );
      if (!Array.isArray(batch)) throw new Error('GitCode 评论接口返回了非数组数据');
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  async unresolvedComments(pr) {
    const comments = await this.listComments(pr);
    return comments.filter(isUnresolvedReviewComment);
  }

  async unresolvedSummary(pr) {
    return summarizeUnresolvedReviewComments(await this.listComments(pr));
  }

  async postInlineComment(pr, { body, path, position, needToResolve = true }) {
    return this.request(
      `/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}/comments`,
      { method: 'POST', body: { body, path, position, position_type: 'text', need_to_resolve: needToResolve } },
    );
  }

  async reply(pr, discussionId, body) {
    return this.request(
      `/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}/discussions/${encodeURIComponent(discussionId)}/comments`,
      { method: 'POST', body: { body } },
    );
  }

  async setResolved(pr, discussionId, resolved) {
    return this.request(
      `/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}/comments/${encodeURIComponent(discussionId)}`,
      { method: 'PUT', body: { resolved } },
    );
  }

  async request(resource, { method = 'GET', body } = {}) {
    const response = await fetch(`${this.apiBase}${resource}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    const data = text ? safeJson(text) : null;
    if (!response.ok) {
      throw new Error(`GitCode API ${method} ${resource.split('?')[0]} 返回 ${response.status}: ${summarize(data)}`);
    }
    return data;
  }
}

export function isUnresolvedReviewComment(comment) {
  if (!comment || typeof comment !== 'object') return false;
  if (comment.resolved === false) return true;
  if (comment.resolved === true) return false;
  return comment.need_to_resolve === true && comment.resolved !== true;
}

export function summarizeUnresolvedReviewComments(comments) {
  const discussions = new Map();
  for (const [index, comment] of comments.entries()) {
    if (!isUnresolvedReviewComment(comment)) continue;
    const discussionId = comment.discussion_id
      ?? comment.discussionId
      ?? comment.discussion?.id
      ?? comment.id
      ?? `comment-${index}`;
    if (!discussions.has(String(discussionId))) discussions.set(String(discussionId), comment);
  }
  const unresolvedReviewerLogins = [...new Set(
    [...discussions.values()].map(reviewAuthorLogin).filter(Boolean),
  )];
  return {
    unresolvedCount: discussions.size,
    unresolvedReviewerLogins,
  };
}

function reviewAuthorLogin(comment) {
  const login = comment.user?.login
    ?? comment.user?.username
    ?? comment.author?.login
    ?? comment.author?.username
    ?? comment.creator?.login
    ?? comment.creator?.username;
  return typeof login === 'string' ? login.trim() : '';
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return text; }
}

function summarize(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
