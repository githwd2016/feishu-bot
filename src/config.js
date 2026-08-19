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

export function loadConfig(env = process.env) {
  const agentBackend = (env.AGENT_BACKEND || 'codex').trim().toLowerCase();
  if (!['codex', 'opencode'].includes(agentBackend)) {
    throw new Error('AGENT_BACKEND 必须是 codex 或 opencode');
  }
  const allowedRepos = new Set(
    required(env, 'GITCODE_ALLOWED_REPOS').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean),
  );
  const reviewers = json(env, 'REVIEWERS_JSON', []);
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    throw new Error('REVIEWERS_JSON 至少需要配置一个审查机器人');
  }
  for (const reviewer of reviewers) {
    if (!reviewer.id || !reviewer.name || !reviewer.openId) {
      throw new Error('每个 reviewer 必须包含 id、name、openId');
    }
    reviewer.mode ??= 'feishu';
    if (!['feishu', 'local'].includes(reviewer.mode)) {
      throw new Error(`reviewer ${reviewer.id} 的 mode 必须是 feishu 或 local`);
    }
  }

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
      ownerOpenId: env.OWNER_OPEN_ID?.trim() || '',
      ownerName: env.OWNER_NAME?.trim() || 'PR 所有人',
    },
    gitcode: {
      token: required(env, 'GITCODE_TOKEN'),
      apiBase: (env.GITCODE_API_BASE || 'https://api.gitcode.com/api/v5').replace(/\/$/, ''),
      allowedRepos,
      workdirs: Object.fromEntries(
        Object.entries(workdirs).map(([repo, directory]) => [repo.toLowerCase(), directory]),
      ),
    },
    reviewers,
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
