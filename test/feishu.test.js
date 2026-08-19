import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuGateway } from '../src/feishu.js';

test('FeishuGateway resolves the current bot open_id through the official bot info API', async () => {
  const requests = [];
  const gateway = new FeishuGateway({ botName: 'fallback' }, {
    client: {
      request: async (request) => {
        requests.push(request);
        return { bot: { open_id: 'ou_bot', app_name: '审查bot' } };
      },
    },
  });

  assert.deepEqual(await gateway.getBotIdentity(), { openId: 'ou_bot', name: '审查bot' });
  assert.deepEqual(requests, [{ url: '/open-apis/bot/v3/info', method: 'GET' }]);
});
