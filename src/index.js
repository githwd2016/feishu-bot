import 'dotenv/config';
import { installTimestampedConsole } from './logger.js';
import { loadConfig, resolveRuntimeIdentities } from './config.js';
import { StateStore } from './state-store.js';
import { FeishuGateway } from './feishu.js';
import { AgentRunner } from './agent-runner.js';
import { createRepositoryClient } from './repository.js';
import { ReviewWorkflow } from './workflow.js';
import { PrScanner } from './pr-scanner.js';
import { createPlatformRouter } from './platform-router.js';

installTimestampedConsole();

async function main() {
  const config = loadConfig();
  const store = new StateStore(config.stateFile);
  await store.load();
  const feishu = new FeishuGateway(config.feishu);
  const botIdentity = await feishu.getBotIdentity();
  console.log(`[setup] BOT_OPEN_ID=${botIdentity.openId} BOT_NAME=${botIdentity.name}`);
  const workflows = {};
  const scanners = [];
  for (const provider of config.repoProviders) {
    const platformConfig = { ...config, repoProvider: provider };
    const client = createRepositoryClient(platformConfig);
    const repositoryUser = await client.getCurrentUser();
    console.log(`[setup] ${provider.toUpperCase()}_LOGIN=${repositoryUser.login}`);
    const identities = resolveRuntimeIdentities(config.identityMappings, { botIdentity, repositoryUser, provider });
    console.log(`[setup] ${provider} IDENTITY_MATCH FEISHU_OPEN_ID=${identities.self.feishuOpenId}`);
    const agent = new AgentRunner(platformConfig);
    const workflow = new ReviewWorkflow({ config: platformConfig, store, feishu, agent, client, identities });
    workflows[provider] = workflow;
    scanners.push(new PrScanner({ config: platformConfig, store, feishu, client, workflow, identities }));
  }

  for (const workflow of Object.values(workflows)) await workflow.recoverInterruptedTasks();
  feishu.start(createPlatformRouter({ workflows, store, feishu }));
  for (const scanner of scanners) scanner.start();
  console.log(`[main] ${config.feishu.botName} 已启动`);
}

main().catch((error) => {
  console.error('[main] 启动失败:', error);
  process.exitCode = 1;
});
