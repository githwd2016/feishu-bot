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
