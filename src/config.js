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

function normalizeIdentityMappings(env) {
  if (env.OWNER_OPEN_ID?.trim() || env.OWNER_NAME?.trim() || env.REVIEWERS_JSON?.trim()) {
    throw new Error('OWNER_OPEN_ID、OWNER_NAME 和 REVIEWERS_JSON 已废弃，请改用 IDENTITY_MAPPINGS_JSON');
  }
  const mappings = json(env, 'IDENTITY_MAPPINGS_JSON', []);
  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw new Error('IDENTITY_MAPPINGS_JSON 至少需要配置一个用户');
  }
  const normalized = mappings.map((mapping, index) => {
    const feishuOpenId = String(mapping?.feishuOpenId || '').trim();
    const gitcodeLogin = String(mapping?.gitcodeLogin || '').trim();
    const botOpenId = String(mapping?.botOpenId || '').trim();
    if (!feishuOpenId || !gitcodeLogin || !botOpenId) {
      throw new Error(`IDENTITY_MAPPINGS_JSON[${index}] 必须包含 feishuOpenId、gitcodeLogin、botOpenId`);
    }
    return {
      displayName: String(mapping?.displayName || gitcodeLogin).trim() || gitcodeLogin,
      feishuOpenId,
      gitcodeLogin,
      botOpenId,
    };
  });
  assertUnique(normalized, 'feishuOpenId', false);
  assertUnique(normalized, 'gitcodeLogin', true);
  assertUnique(normalized, 'botOpenId', false);
  return normalized;
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
  const allowedRepos = new Set(
    required(env, 'GITCODE_ALLOWED_REPOS').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean),
  );
  const identityMappings = normalizeIdentityMappings(env);

  const workdirs = json(env, 'REPO_WORKDIRS_JSON', {});
  for (const [repo, directory] of Object.entries(workdirs)) {
    if (!path.isAbsolute(directory)) throw new Error(`REPO_WORKDIRS_JSON 中 ${repo} 必须使用绝对路径`);
  }

  return {
    projectRoot,
    feishu: {
      appId: required(env, 'FEISHU_APP_ID'),
      appSecret: required(env, 'FEISHU_APP_SECRET'),
      botName: required(env, 'BOT_NAME'),
      autoReviewChatId: env.AUTO_REVIEW_CHAT_ID?.trim() || '',
    },
    gitcode: {
      token: required(env, 'GITCODE_TOKEN'),
      apiBase: (env.GITCODE_API_BASE || 'https://api.gitcode.com/api/v5').replace(/\/$/, ''),
      allowedRepos,
      workdirs: Object.fromEntries(
        Object.entries(workdirs).map(([repo, directory]) => [repo.toLowerCase(), directory]),
      ),
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

export function resolveRuntimeIdentities(identityMappings, { botIdentity, gitcodeUser }) {
  const botOpenId = String(botIdentity?.openId || '').trim();
  const gitcodeLogin = String(gitcodeUser?.login || '').trim();
  if (!botOpenId) throw new Error('无法识别当前飞书 bot open_id');
  if (!gitcodeLogin) throw new Error('GitCode /user 未返回 login');

  const byBot = identityMappings.find((item) => item.botOpenId === botOpenId);
  if (!byBot) throw new Error(`当前飞书 bot ${botOpenId} 未出现在 IDENTITY_MAPPINGS_JSON 中`);
  if (byBot.gitcodeLogin.toLowerCase() !== gitcodeLogin.toLowerCase()) {
    throw new Error(`当前飞书 bot 映射到 ${byBot.gitcodeLogin}，但 GITCODE_TOKEN 属于 ${gitcodeLogin}`);
  }

  return {
    self: { ...byBot },
    byGitcodeLogin(login) {
      const normalized = String(login || '').trim().toLowerCase();
      return identityMappings.find((item) => item.gitcodeLogin.toLowerCase() === normalized) || null;
    },
    byBotOpenId(openId) {
      return identityMappings.find((item) => item.botOpenId === openId) || null;
    },
  };
}
