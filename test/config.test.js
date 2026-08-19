import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const baseEnv = {
  FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', BOT_NAME: 'bot',
  OWNER_OPEN_ID: 'owner-id', OWNER_NAME: 'owner', GITCODE_TOKEN: 'token',
  GITCODE_ALLOWED_REPOS: 'org/repo', REPO_WORKDIRS_JSON: '{}',
  REVIEWERS_JSON: '[{"id":"r","name":"reviewer","openId":"reviewer-id","mode":"local"}]',
};

test('loadConfig selects Codex by default and OpenCode explicitly', () => {
  assert.equal(loadConfig(baseEnv).agent.backend, 'codex');
  const opencode = loadConfig({ ...baseEnv, AGENT_BACKEND: 'opencode', OPENCODE_AUTO_APPROVE: 'true' });
  assert.equal(opencode.agent.backend, 'opencode');
  assert.equal(opencode.agent.opencode.autoApprove, true);
});

test('loadConfig rejects unknown agent backends', () => {
  assert.throws(() => loadConfig({ ...baseEnv, AGENT_BACKEND: 'unknown' }), /codex 或 opencode/);
});

test('loadConfig defaults reviewers to native Feishu delivery', () => {
  const config = loadConfig({
    ...baseEnv,
    REVIEWERS_JSON: '[{"id":"r","name":"reviewer","openId":"reviewer-id"}]',
  });
  assert.equal(config.reviewers[0].mode, 'feishu');
  assert.equal(config.peer, undefined);
});

test('loadConfig rejects obsolete remote reviewer mode', () => {
  assert.throws(() => loadConfig({
    ...baseEnv,
    REVIEWERS_JSON: '[{"id":"r","name":"reviewer","openId":"reviewer-id","mode":"remote"}]',
  }), /feishu 或 local/);
});

test('loadConfig supports first start before owner identity is known', () => {
  const { OWNER_OPEN_ID, OWNER_NAME, ...firstStartEnv } = baseEnv;
  const config = loadConfig(firstStartEnv);
  assert.equal(config.feishu.ownerOpenId, '');
  assert.equal(config.feishu.ownerName, 'PR 所有人');
  assert.equal(config.feishu.botOpenId, undefined);
});
