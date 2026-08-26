const PR_RE = /https:\/\/gitcode\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/i;

export function parsePrUrl(input) {
  const match = String(input ?? '').match(PR_RE);
  if (!match) return null;
  const [, owner, repo, number] = match;
  return {
    owner,
    repo,
    number: Number(number),
    repoKey: `${owner}/${repo}`.toLowerCase(),
    key: `${owner}/${repo}#${number}`.toLowerCase(),
    url: `https://gitcode.com/${owner}/${repo}/pull/${number}`,
  };
}

export function assertAllowedPr(pr, allowedRepos) {
  if (!pr) throw new Error('消息中没有有效的 GitCode PR 链接');
  if (allowedRepos.size > 0 && !allowedRepos.has(pr.repoKey)) {
    throw new Error(`仓库 ${pr.owner}/${pr.repo} 不在白名单中`);
  }
  return pr;
}

export function prFromGitCodeData(data) {
  const direct = parsePrUrl(data?.html_url ?? data?.htmlUrl ?? '');
  if (direct) return direct;

  const apiMatch = String(data?.url || '').match(/\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)/i);
  if (apiMatch) {
    return makePr(apiMatch[1], apiMatch[2], Number(apiMatch[3]));
  }

  const number = Number(data?.number ?? data?.iid);
  const repo = data?.base?.repo ?? data?.head?.repo ?? data?.repository;
  const owner = repo?.name_space?.path
    ?? repo?.namespace?.path
    ?? repo?.owner?.login
    ?? repo?.owner?.path;
  const repoPath = repo?.path ?? repo?.name;
  if (owner && repoPath && Number.isInteger(number) && number > 0) {
    return makePr(owner, repoPath, number);
  }
  return null;
}

export function gitcodePrMetadata(data) {
  const authorLogin = firstString(
    data?.user?.login,
    data?.author?.login,
    data?.author?.username,
    data?.creator?.login,
  );
  const headSha = firstString(data?.head?.sha, data?.head_sha, data?.sha);
  const assigneeLogins = [...new Set(
    (Array.isArray(data?.assignees) ? data.assignees : [])
      .map((item) => firstString(item?.login, item?.username))
      .filter(Boolean)
      .map((item) => item.toLowerCase()),
  )];
  return { authorLogin, headSha, assigneeLogins };
}

export function isGitCodePrWip(data) {
  return isEnabledFlag(data?.draft)
    || isEnabledFlag(data?.work_in_progress)
    || /^\s*\[WIP\](?:\s|$)/i.test(String(data?.title || ''));
}

function makePr(owner, repo, number) {
  return parsePrUrl(`https://gitcode.com/${owner}/${repo}/pull/${number}`);
}

function firstString(...values) {
  const value = values.find((item) => typeof item === 'string' && item.trim());
  return value ? value.trim() : '';
}

function isEnabledFlag(value) {
  if (value === true || value === 1) return true;
  return typeof value === 'string' && ['true', '1'].includes(value.trim().toLowerCase());
}
