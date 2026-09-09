import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${key}`);
  return value;
}

function json(env, key, fallback) {
  if (!env[key]) return fallback;
  try {
    return JSON.parse(env[key]);
  } catch (error) {
    throw new Error(`${key} 不是合法 JSON: ${error.message}`);
  }
}

function integer(env, key, fallback) {
  const value = env[key] ? Number(env[key]) : fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} 必须是正整数`);
  return value;
}

function integerAtLeast(env, key, fallback, minimum) {
  const value = env[key] ? Number(env[key]) : fallback;
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${key} 必须是大于等于 ${minimum} 的整数`);
  }
  return value;
}

function normalizeIdentityMappings(env, providers) {
  if (env.OWNER_OPEN_ID?.trim() || env.OWNER_NAME?.trim() || env.REVIEWERS_JSON?.trim()) {
    throw new Error('OWNER_OPEN_ID、OWNER_NAME 和 REVIEWERS_JSON 已废弃，请改用 IDENTITY_MAPPINGS_JSON');
  }
  const mappings = json(env, 'IDENTITY_MAPPINGS_JSON', []);
  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw new Error('IDENTITY_MAPPINGS_JSON 至少需要配置一个用户');
  }
  const normalized = mappings.map((mapping, index) => {
    const feishuOpenId = String(mapping?.feishuOpenId || '').trim();
    const logins = Object.fromEntries(providers.map((provider) => {
      const field = `${provider}Login`;
      return [field, String(mapping?.[field] || '').trim()];
    }).filter(([, login]) => login));
    const login = Object.values(logins)[0];
    const botOpenId = String(mapping?.botOpenId || '').trim();
    if (!feishuOpenId || !login || !botOpenId) {
      throw new Error(`IDENTITY_MAPPINGS_JSON[${index}] 必须包含 feishuOpenId、至少一个已启用平台的 login、botOpenId`);
    }
    const commitNames = mapping?.commit_name === undefined
      ? []
      : normalizeCommitNames(mapping.commit_name, index);
    return {
      displayName: String(mapping?.displayName || login).trim() || login,
      feishuOpenId,
      ...logins,
      botOpenId,
      commit_name: commitNames,
    };
  });
  assertUnique(normalized, 'feishuOpenId', false);
  for (const provider of providers) {
    const field = `${provider}Login`;
    assertUnique(normalized.filter((item) => item[field]), field, true);
  }
  assertUnique(normalized, 'botOpenId', false);
  assertUniqueCommitNames(normalized);
  return normalized;
}

function normalizeCommitNames(value, index) {
  if (!Array.isArray(value)) throw new Error(`IDENTITY_MAPPINGS_JSON[${index}].commit_name 必须是数组`);
  const names = value.map((item) => String(item || '').trim()).filter(Boolean);
  const seen = new Set();
  for (const name of names) {
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) throw new Error(`IDENTITY_MAPPINGS_JSON[${index}].commit_name 不能重复: ${name}`);
    seen.add(normalized);
  }
  return names;
}

function assertUniqueCommitNames(items) {
  const seen = new Map();
  for (const item of items) {
    for (const name of item.commit_name) {
      const normalized = name.toLowerCase();
      if (seen.has(normalized)) {
        throw new Error(`IDENTITY_MAPPINGS_JSON 中 commit_name 不能重复: ${name}`);
      }
      seen.set(normalized, item.feishuOpenId);
    }
  }
}

function assertUnique(items, field, caseInsensitive) {
  const seen = new Set();
  for (const item of items) {
    const value = caseInsensitive ? item[field].toLowerCase() : item[field];
    if (seen.has(value)) throw new Error(`IDENTITY_MAPPINGS_JSON 中 ${field} 不能重复: ${item[field]}`);
    seen.add(value);
  }
}

export function loadConfig(env = process.env) {
  const agentBackend = (env.AGENT_BACKEND || 'codex').trim().toLowerCase();
  if (!['codex', 'opencode'].includes(agentBackend)) {
    throw new Error('AGENT_BACKEND 必须是 codex 或 opencode');
  }
  const repoProviders = [...new Set((env.REPO_PROVIDERS || 'gitcode').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (!repoProviders.length || repoProviders.some((provider) => !['gitcode', 'github'].includes(provider))) {
    throw new Error('REPO_PROVIDERS 必须是 gitcode、github 或 gitcode,github');
  }
  const identityMappings = normalizeIdentityMappings(env, repoProviders);
  const workdirs = json(env, 'REPO_WORKDIRS_JSON', {});
  if (!workdirs || Array.isArray(workdirs) || typeof workdirs !== 'object') throw new Error('REPO_WORKDIRS_JSON 必须是对象');
  const normalizedWorkdirs = {};
  for (const [repo, directory] of Object.entries(workdirs)) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error(`REPO_WORKDIRS_JSON 中 ${repo} 必须使用绝对路径`);
    if (!/^(?:(gitcode|github):)?[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)) throw new Error(`REPO_WORKDIRS_JSON 仓库键无效: ${repo}`);
    normalizedWorkdirs[repo.toLowerCase()] = directory;
  }
  const repositories = {};
  for (const provider of repoProviders) {
    const prefix = provider.toUpperCase();
    const allowedRepos = new Set(required(env, `${prefix}_ALLOWED_REPOS`).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
    if (!allowedRepos.size || [...allowedRepos].some((repo) => !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo))) {
      throw new Error(`${prefix}_ALLOWED_REPOS 必须包含有效的 owner/repo`);
    }
    // Unprefixed keys retain their original GitCode meaning. In GitHub-only
    // deployments they can also be used for convenience.
    const platformWorkdirs = {};
    for (const [key, directory] of Object.entries(normalizedWorkdirs)) {
      if (!key.includes(':') && (provider === 'gitcode' || repoProviders.length === 1)) platformWorkdirs[key] = directory;
    }
    for (const [key, directory] of Object.entries(normalizedWorkdirs)) {
      if (key.startsWith(`${provider}:`)) platformWorkdirs[key.slice(provider.length + 1)] = directory;
    }
    repositories[provider] = {
      token: required(env, `${prefix}_TOKEN`),
      apiBase: (env[`${prefix}_API_BASE`] || (provider === 'github' ? 'https://api.github.com' : 'https://api.gitcode.com/api/v5')).replace(/\/$/, ''),
      allowedRepos,
      workdirs: platformWorkdirs,
    };
  }
  const weeklyWorkdirs = {};
  const seenDirectories = new Set();
  for (const provider of repoProviders) {
    for (const [repo, directory] of Object.entries(repositories[provider].workdirs)) {
      if (seenDirectories.has(directory)) continue;
      weeklyWorkdirs[repoProviders.length > 1 ? `${provider}:${repo}` : repo] = directory;
      seenDirectories.add(directory);
    }
  }

  return {
    projectRoot,
    repoProviders,
    weeklyWorkdirs,
    ...repositories,
    feishu: {
      appId: required(env, 'FEISHU_APP_ID'),
      appSecret: required(env, 'FEISHU_APP_SECRET'),
      botName: required(env, 'BOT_NAME'),
      autoReviewChatId: env.AUTO_REVIEW_CHAT_ID?.trim() || '',
    },
    identityMappings,
    scan: {
      intervalMs: integerAtLeast(env, 'PR_SCAN_INTERVAL_SECONDS', 300, 60) * 1000,
      maxAttempts: 3,
    },
    agent: {
      backend: agentBackend,
      timeoutMs: integer(env, 'AGENT_TIMEOUT_MS', Number(env.CODEX_TIMEOUT_MS) || 1_800_000),
      codex: {
        bin: env.CODEX_BIN || 'codex',
        model: env.CODEX_MODEL || '',
        profile: env.CODEX_PROFILE || '',
        bypassApprovalsAndSandbox: env.CODEX_BYPASS_APPROVALS_AND_SANDBOX === 'true',
      },
      opencode: {
        bin: env.OPENCODE_BIN || 'opencode',
        model: env.OPENCODE_MODEL || '',
        agent: env.OPENCODE_AGENT || '',
        variant: env.OPENCODE_VARIANT || '',
        autoApprove: env.OPENCODE_AUTO_APPROVE === 'true',
      },
    },
    maxReviewCycles: integer(env, 'MAX_REVIEW_CYCLES', 3),
    stateFile: path.resolve(projectRoot, env.STATE_FILE || './data/state.json'),
  };
}

export function resolveRuntimeIdentities(identityMappings, { botIdentity, gitcodeUser, repositoryUser = gitcodeUser, provider = 'gitcode' }) {
  const loginField = `${provider}Login`;
  const label = provider === 'github' ? 'GitHub' : 'GitCode';
  const botOpenId = String(botIdentity?.openId || '').trim();
  const login = String(repositoryUser?.login || '').trim();
  if (!botOpenId) throw new Error('无法识别当前飞书 bot open_id');
  if (!login) throw new Error(`${label} /user 未返回 login`);

  const byBot = identityMappings.find((item) => item.botOpenId === botOpenId);
  if (!byBot) throw new Error(`当前飞书 bot ${botOpenId} 未出现在 IDENTITY_MAPPINGS_JSON 中`);
  if (!byBot[loginField]) throw new Error(`当前飞书 bot 缺少 ${loginField} 映射`);
  if (byBot[loginField].toLowerCase() !== login.toLowerCase()) {
    throw new Error(`当前飞书 bot 映射到 ${byBot[loginField]}，但 ${provider.toUpperCase()}_TOKEN 属于 ${login}`);
  }

  const forPlatform = (item) => item?.[loginField] ? { ...item, login: item[loginField], provider } : null;
  const byLogin = (login) => {
    const normalized = String(login || '').trim().toLowerCase();
    return forPlatform(identityMappings.find((item) => item[loginField]?.toLowerCase() === normalized));
  };
  return {
    self: forPlatform(byBot),
    byLogin,
    byGitcodeLogin: byLogin,
    byBotOpenId(openId) {
      return forPlatform(identityMappings.find((item) => item.botOpenId === openId));
    },
  };
}
