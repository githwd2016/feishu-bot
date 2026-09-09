import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resolveRuntimeIdentities } from '../src/config.js';

const mappings = [
  { displayName: '张三', feishuOpenId: 'ou_user_zhangsan', gitcodeLogin: 'ZhangSan', commit_name: ['张三提交'], botOpenId: 'ou_bot_zhangsan' },
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
  assert.deepEqual(config.identityMappings[0].commit_name, ['张三提交']);

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
  assert.throws(() => loadConfig({ ...baseEnv, IDENTITY_MAPPINGS_JSON: JSON.stringify([
    { ...mappings[0], commit_name: '张三提交' }, mappings[1],
  ]) }), /commit_name 必须是数组/);
  assert.throws(() => loadConfig({ ...baseEnv, IDENTITY_MAPPINGS_JSON: JSON.stringify([
    mappings[0], { ...mappings[1], commit_name: ['张三提交'] },
  ]) }), /commit_name 不能重复/);
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

test('dual-platform config separates allowlists, workdirs and identity lookup', () => {
  const config = loadConfig({
    ...baseEnv, REPO_PROVIDERS: 'gitcode,github',
    GITHUB_TOKEN: 'github-token', GITHUB_ALLOWED_REPOS: 'ORG/REPO',
    REPO_WORKDIRS_JSON: JSON.stringify({
      'org/repo': '/tmp/gitcode-repo', 'github:org/repo': '/tmp/github-repo',
    }),
    IDENTITY_MAPPINGS_JSON: JSON.stringify([
      { ...mappings[0], githubLogin: 'zhangsan-gh' },
      { ...mappings[1], githubLogin: 'Lisi-GH' },
      { displayName: 'GitHub only', feishuOpenId: 'gh-user', githubLogin: 'gh-only', botOpenId: 'gh-bot' },
    ]),
  });
  assert.deepEqual(config.repoProviders, ['gitcode', 'github']);
  assert.equal(config.gitcode.token, 'token');
  assert.equal(config.github.token, 'github-token');
  assert.equal(config.github.apiBase, 'https://api.github.com');
  assert.deepEqual([...config.github.allowedRepos], ['org/repo']);
  assert.deepEqual(config.gitcode.workdirs, { 'org/repo': '/tmp/gitcode-repo' });
  assert.deepEqual(config.github.workdirs, { 'org/repo': '/tmp/github-repo' });
  assert.deepEqual(config.weeklyWorkdirs, { 'gitcode:org/repo': '/tmp/gitcode-repo', 'github:org/repo': '/tmp/github-repo' });
  const identities = resolveRuntimeIdentities(config.identityMappings, {
    botIdentity: { openId: 'ou_bot_zhangsan' }, repositoryUser: { login: 'zhangsan-gh' }, provider: 'github',
  });
  assert.equal(identities.self.login, 'zhangsan-gh');
  assert.equal(identities.byLogin('LISI-GH').login, 'Lisi-GH');
  assert.equal(identities.byLogin('lisi'), null);
  assert.equal(identities.byLogin('gh-only').botOpenId, 'gh-bot');
});

test('GitHub-only configuration requires no GitCode credentials or identities', () => {
  const config = loadConfig({
    FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', BOT_NAME: 'bot',
    REPO_PROVIDERS: 'github', GITHUB_TOKEN: 'token', GITHUB_ALLOWED_REPOS: 'org/repo',
    IDENTITY_MAPPINGS_JSON: JSON.stringify([{ feishuOpenId: 'user', botOpenId: 'bot', githubLogin: 'person' }]),
    REPO_WORKDIRS_JSON: '{"org/repo":"/tmp/github"}',
  });
  assert.equal(config.gitcode, undefined);
  assert.equal(config.github.workdirs['org/repo'], '/tmp/github');
  assert.throws(() => resolveRuntimeIdentities(config.identityMappings, {
    botIdentity: { openId: 'bot' }, repositoryUser: { login: 'other' }, provider: 'github',
  }), /GITHUB_TOKEN 属于/);
});

test('dual-platform configuration rejects missing credentials and ambiguous identities', () => {
  assert.throws(() => loadConfig({ ...baseEnv, REPO_PROVIDERS: 'gitlab' }), /REPO_PROVIDERS/);
  assert.throws(() => loadConfig({ ...baseEnv, REPO_PROVIDERS: 'gitcode,github' }), /GITHUB_ALLOWED_REPOS/);
  assert.throws(() => loadConfig({ ...baseEnv, GITCODE_ALLOWED_REPOS: ', ,' }), /有效的 owner\/repo/);
  assert.throws(() => loadConfig({
    ...baseEnv, REPO_PROVIDERS: 'gitcode,github',
    IDENTITY_MAPPINGS_JSON: JSON.stringify(mappings.map((item) => ({ ...item, githubLogin: 'duplicate' }))),
  }), /githubLogin 不能重复/);
  assert.throws(() => resolveRuntimeIdentities(mappings, {
    botIdentity: { openId: 'ou_bot_zhangsan' }, repositoryUser: { login: 'person' }, provider: 'github',
  }), /缺少 githubLogin/);
});
