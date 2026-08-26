import 'dotenv/config';
import { installTimestampedConsole } from './logger.js';
import { loadConfig, resolveRuntimeIdentities } from './config.js';
import { StateStore } from './state-store.js';
import { FeishuGateway } from './feishu.js';
import { AgentRunner } from './agent-runner.js';
import { GitCodeClient } from './gitcode-client.js';
import { ReviewWorkflow } from './workflow.js';
import { PrScanner } from './pr-scanner.js';

installTimestampedConsole();

async function main() {
  const config = loadConfig();
  const store = new StateStore(config.stateFile);
  await store.load();
  const feishu = new FeishuGateway(config.feishu);
  const agent = new AgentRunner(config);
  const gitcode = new GitCodeClient(config.gitcode);
  const [botIdentity, gitcodeUser] = await Promise.all([
    feishu.getBotIdentity(),
    gitcode.getCurrentUser(),
  ]);
  console.log(`[setup] BOT_OPEN_ID=${botIdentity.openId} BOT_NAME=${botIdentity.name}`);
  console.log(`[setup] GITCODE_LOGIN=${gitcodeUser.login}`);
  const identities = resolveRuntimeIdentities(config.identityMappings, { botIdentity, gitcodeUser });
  console.log(`[setup] IDENTITY_MATCH FEISHU_OPEN_ID=${identities.self.feishuOpenId}`);
  const workflow = new ReviewWorkflow({ config, store, feishu, agent, gitcode, identities });
  const scanner = new PrScanner({ config, store, feishu, gitcode, workflow, identities });

  await workflow.recoverInterruptedTasks();
  feishu.start((event) => workflow.onFeishuMessage(event));
  scanner.start();
  console.log(`[main] ${config.feishu.botName} 已启动`);
}

main().catch((error) => {
  console.error('[main] 启动失败:', error);
  process.exitCode = 1;
});
