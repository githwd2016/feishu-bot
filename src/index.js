import 'dotenv/config';
import { installTimestampedConsole } from './logger.js';
import { loadConfig } from './config.js';
import { StateStore } from './state-store.js';
import { FeishuGateway } from './feishu.js';
import { AgentRunner } from './agent-runner.js';
import { GitCodeClient } from './gitcode-client.js';
import { ReviewWorkflow } from './workflow.js';

installTimestampedConsole();

async function main() {
  const config = loadConfig();
  const store = new StateStore(config.stateFile);
  await store.load();
  const feishu = new FeishuGateway(config.feishu);
  const agent = new AgentRunner(config);
  const gitcode = new GitCodeClient(config.gitcode);
  const workflow = new ReviewWorkflow({ config, store, feishu, agent, gitcode });

  try {
    const identity = await feishu.getBotIdentity();
    console.log(`[setup] BOT_OPEN_ID=${identity.openId} BOT_NAME=${identity.name}`);
  } catch (error) {
    console.warn('[setup] 暂时无法获取 BOT_OPEN_ID，机器人仍将继续启动:', error.message);
  }
  await workflow.recoverInterruptedTasks();
  feishu.start((event) => workflow.onFeishuMessage(event));
  console.log(`[main] ${config.feishu.botName} 已启动`);
}

main().catch((error) => {
  console.error('[main] 启动失败:', error);
  process.exitCode = 1;
});
