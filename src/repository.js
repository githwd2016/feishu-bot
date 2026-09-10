import { GitCodeClient } from './gitcode-client.js';
import { GitHubClient } from './github-client.js';

export function repositoryConfig(config) {
  return config[activeProvider(config)];
}

export function createRepositoryClient(config) {
  return activeProvider(config) === 'github'
    ? new GitHubClient(repositoryConfig(config))
    : new GitCodeClient(repositoryConfig(config));
}

export function activeProvider(config) {
  if (config.repoProvider) return config.repoProvider;
  if (config.repoProviders?.length > 1) throw new Error('双平台配置必须指定本次任务的 repoProvider');
  return config.repoProviders?.[0] || 'gitcode';
}

export function identityLogin(identity) {
  return identity?.login || identity?.gitcodeLogin || identity?.githubLogin || '';
}

export function identityByLogin(identities, login) {
  return identities.byLogin ? identities.byLogin(login) : identities.byGitcodeLogin(login);
}
