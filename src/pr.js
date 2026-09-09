const PR_RE = /https:\/\/(gitcode|github)\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?=$|[/?#\s)\]}>，。])/i;

export function parsePrUrl(input) {
  const match = String(input ?? '').match(PR_RE);
  if (!match) return null;
  const [, platform, owner, repo, number] = match;
  const provider = platform.toLowerCase();
  if (!Number.isSafeInteger(Number(number)) || Number(number) <= 0) return null;
  return {
    provider,
    owner,
    repo,
    number: Number(number),
    repoKey: `${owner}/${repo}`.toLowerCase(),
    key: `${provider === 'github' ? 'github:' : ''}${owner}/${repo}#${Number(number)}`.toLowerCase(),
    url: `https://${provider}.com/${owner}/${repo}/pull/${Number(number)}`,
  };
}

export function assertAllowedPr(pr, allowedRepos, provider = 'gitcode') {
  if (!pr) throw new Error('消息中没有有效的 GitCode 或 GitHub PR 链接');
  if ((pr.provider || 'gitcode') !== provider) throw new Error(`当前机器人仅支持 ${provider} 仓库`);
  if (allowedRepos.size > 0 && !allowedRepos.has(pr.repoKey)) {
    throw new Error(`仓库 ${pr.owner}/${pr.repo} 不在白名单中`);
  }
  return pr;
}

export function prFromData(data, provider = 'gitcode') {
  const direct = parsePrUrl(data?.html_url ?? data?.htmlUrl ?? '');
  if (direct) return direct;

  const apiMatch = String(data?.url || '').match(/\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)/i);
  if (apiMatch) {
    return makePr(apiMatch[1], apiMatch[2], Number(apiMatch[3]), provider);
  }

  const number = Number(data?.number ?? data?.iid);
  const repo = data?.base?.repo ?? data?.head?.repo ?? data?.repository;
  const owner = repo?.name_space?.path
    ?? repo?.namespace?.path
    ?? repo?.owner?.login
    ?? repo?.owner?.path;
  const repoPath = repo?.path ?? repo?.name;
  if (owner && repoPath && Number.isInteger(number) && number > 0) {
    return makePr(owner, repoPath, number, provider);
  }
  return null;
}

export function prMetadata(data, provider = 'gitcode') {
  const authorLogin = firstString(
    data?.user?.login,
    data?.author?.login,
    data?.author?.username,
    data?.creator?.login,
  );
  const headSha = firstString(data?.head?.sha, data?.head_sha, data?.sha);
  const assigneeLogins = [...new Set(
    (provider === 'github'
      ? [...(data?.requested_reviewers || []), ...(data?.reviewed_by || [])]
      : (Array.isArray(data?.assignees) ? data.assignees : []))
      .map((item) => firstString(item?.login, item?.username))
      .filter(Boolean)
      .map((item) => item.toLowerCase()),
  )];
  return { authorLogin, headSha, assigneeLogins };
}

export function isPrWip(data) {
  return isEnabledFlag(data?.draft)
    || isEnabledFlag(data?.work_in_progress)
    || /^\s*\[WIP\](?:\s|$)/i.test(String(data?.title || ''));
}

function makePr(owner, repo, number, provider) {
  return parsePrUrl(`https://${provider}.com/${owner}/${repo}/pull/${number}`);
}

function firstString(...values) {
  const value = values.find((item) => typeof item === 'string' && item.trim());
  return value ? value.trim() : '';
}

function isEnabledFlag(value) {
  if (value === true || value === 1) return true;
  return typeof value === 'string' && ['true', '1'].includes(value.trim().toLowerCase());
}

// Compatibility exports for existing GitCode integrations.
export const prFromGitCodeData = prFromData;
export const gitcodePrMetadata = prMetadata;
export const isGitCodePrWip = isPrWip;
