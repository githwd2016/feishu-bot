import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resolveRuntimeIdentities } from '../src/config.js';

const mappings = [
  { displayName: '张三', feishuOpenId: 'ou_user_zhangsan', gitcodeLogin: 'ZhangSan', botOpenId: 'ou_bot_zhangsan' },
  { displayName: '李四', feishuOpenId: 'ou_user_lisi', gitcodeLogin: 'lisi', botOpenId: 'ou_bot_lisi' },
];
const baseEnv = {
  FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', BOT_NAME: 'bot',
  GITCODE_TOKEN: 'token', GITCODE_ALLOWED_REPOS: 'org/repo', REPO_WORKDIRS_JSON: '{}',
  IDENTITY_MAPPINGS_JSON: JSON.stringify(mappings),
};

test('loadConfig selects Codex by default and configures scanning', () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.agent.backend, 'codex');
  assert.equal(config.scan.intervalMs, 300_000);
  assert.equal(config.feishu.autoReviewChatId, '');
  assert.equal(config.identityMappings[0].gitcodeLogin, 'ZhangSan');

  const opencode = loadConfig({ ...baseEnv, AGENT_BACKEND: 'opencode', OPENCODE_AUTO_APPROVE: 'true' });
  assert.equal(opencode.agent.backend, 'opencode');
  assert.equal(opencode.agent.opencode.autoApprove, true);
});

test('loadConfig validates identity mappings and rejects obsolete owner/reviewer config', () => {
  assert.throws(() => loadConfig({ ...baseEnv, IDENTITY_MAPPINGS_JSON: '[]' }), /至少需要配置一个用户/);
  assert.throws(() => loadConfig({
    ...baseEnv,
    IDENTITY_MAPPINGS_JSON: JSON.stringify([...mappings, {
      ...mappings[1], feishuOpenId: 'another-user', botOpenId: 'another-bot',
    }]),
  }), /gitcodeLogin 不能重复/);
  assert.throws(() => loadConfig({ ...baseEnv, OWNER_OPEN_ID: 'old-owner' }), /已废弃/);
  assert.throws(() => loadConfig({ ...baseEnv, REVIEWERS_JSON: '[]' }), /已废弃/);
});

test('loadConfig requires scan interval of at least sixty seconds', () => {
  assert.equal(loadConfig({ ...baseEnv, PR_SCAN_INTERVAL_SECONDS: '60' }).scan.intervalMs, 60_000);
  assert.throws(() => loadConfig({ ...baseEnv, PR_SCAN_INTERVAL_SECONDS: '59' }), /大于等于 60/);
});

test('resolveRuntimeIdentities requires bot and token to identify the same mapping', () => {
  const identities = resolveRuntimeIdentities(mappings, {
    botIdentity: { openId: 'ou_bot_zhangsan' },
    gitcodeUser: { login: 'zhangsan' },
  });
  assert.equal(identities.self.feishuOpenId, 'ou_user_zhangsan');
  assert.equal(identities.byGitcodeLogin('LISI').botOpenId, 'ou_bot_lisi');
  assert.throws(() => resolveRuntimeIdentities(mappings, {
    botIdentity: { openId: 'ou_bot_zhangsan' }, gitcodeUser: { login: 'lisi' },
  }), /但 GITCODE_TOKEN 属于/);
});
