import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AgentRunner,
  extractOpenCodeSessionId,
  parseOpenCodeExport,
  parseOpenCodeResult,
  summarizeCodexEvent,
  summarizeOpenCodeEvent,
} from '../src/agent-runner.js';
import { parsePrUrl } from '../src/pr.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

test('AgentRunner runs codex in a temporary worktree and cleans it afterward', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-codex-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, 'repo');
  await fs.mkdir(repository);
  await git(repository, 'init', '-b', 'main');
  await git(repository, 'config', 'user.name', 'Review Bot Test');
  await git(repository, 'config', 'user.email', 'review-bot@example.com');
  await fs.writeFile(path.join(repository, 'tracked.txt'), 'tracked\n');
  await git(repository, 'add', 'tracked.txt');
  await git(repository, 'commit', '-m', 'initial');
  await fs.mkdir(path.join(repository, '.workbuddy'));
  await fs.writeFile(path.join(repository, '.workbuddy', 'local.txt'), 'main worktree only\n');

  const fakeCodex = path.join(directory, 'codex');
  const observedPath = path.join(directory, 'observed.json');
  await fs.writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const output = args[args.indexOf('--output-last-message') + 1];
  if (!args.includes('exec') || !args.includes('--output-schema') || !prompt.includes('https://gitcode.com/org/repo/pull/9')) process.exit(2);
  if (!args.includes('--json') || args.includes('--ephemeral')) process.exit(5);
  if (!prompt.includes('临时 detached Git worktree') || process.env.REVIEW_BOT_TEMP_WORKTREE !== 'true') process.exit(3);
  if (fs.existsSync(path.join(process.cwd(), '.workbuddy'))) process.exit(4);
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'codex-session-test' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'secret command content' } }) + '\\n');
  fs.writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({ cwd: process.cwd() }));
  fs.writeFileSync(output, JSON.stringify({
    status: 'success', action: 'review', prUrl: 'https://gitcode.com/org/repo/pull/9',
    unresolvedCount: 1, unresolvedReviewerLogins: ['reviewer'], commentsPosted: 1,
    commentsReplied: 0, commentsResolved: 0, commitSha: null, summary: 'ok', blockers: []
  }));
});
`, { mode: 0o755 });

  const runner = new AgentRunner({
    projectRoot,
    gitcode: {
      token: 'test-token', apiBase: 'https://api.gitcode.com/api/v5',
      allowedRepos: new Set(['org/repo']), workdirs: { 'org/repo': repository },
    },
    agent: {
      backend: 'codex',
      timeoutMs: 5000,
      codex: { bin: fakeCodex, model: '', profile: '', bypassApprovalsAndSandbox: false },
      opencode: { bin: 'opencode', model: '', agent: '', variant: '', autoApprove: false },
    },
  });
  const output = await runner.runReview({
    pr: parsePrUrl('https://gitcode.com/org/repo/pull/9'), mode: 'initial', reviewerName: '测试bot',
  });
  assert.equal(output.result.unresolvedCount, 1);
  assert.equal(output.result.status, 'success');
  assert.equal(output.sessionId, 'codex-session-test');
  const observed = JSON.parse(await fs.readFile(observedPath, 'utf8'));
  assert.notEqual(observed.cwd, repository);
  await assert.rejects(fs.access(observed.cwd));
  assert.equal(await fs.readFile(path.join(repository, '.workbuddy', 'local.txt'), 'utf8'), 'main worktree only\n');
  const worktreeList = await git(repository, 'worktree', 'list', '--porcelain');
  assert.equal(worktreeList.stdout.match(/^worktree /gm)?.length, 1);
});

test('AgentRunner supports the OpenCode JSON event backend', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-opencode-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fakeOpenCode = path.join(directory, 'opencode');
  await fs.writeFile(fakeOpenCode, `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.length - 1];
if (!args.includes('run') || !args.includes('--format') || !prompt.includes('https://gitcode.com/org/repo/pull/9')) process.exit(2);
const result = {
  status: 'success', action: 'review', prUrl: 'https://gitcode.com/org/repo/pull/9',
  unresolvedCount: 2, unresolvedReviewerLogins: ['reviewer'], commentsPosted: 2,
  commentsReplied: 0, commentsResolved: 0, commitSha: null, summary: 'ok', blockers: []
};
process.stdout.write(JSON.stringify({ type: 'step_start', sessionID: 'opencode-session-test', part: { type: 'step-start' } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: JSON.stringify(result) } }) + '\\n');
`, { mode: 0o755 });
  const runner = new AgentRunner({
    projectRoot,
    gitcode: {
      token: 'test-token', apiBase: 'https://api.gitcode.com/api/v5',
      allowedRepos: new Set(['org/repo']), workdirs: {},
    },
    agent: {
      backend: 'opencode', timeoutMs: 5000,
      codex: { bin: 'codex', model: '', profile: '', bypassApprovalsAndSandbox: false },
      opencode: { bin: fakeOpenCode, model: '', agent: '', variant: '', autoApprove: true },
    },
  });
  const output = await runner.runReview({
    pr: parsePrUrl('https://gitcode.com/org/repo/pull/9'), mode: 'initial', reviewerName: '测试bot',
  });
  assert.equal(output.result.unresolvedCount, 2);
  assert.equal(output.sessionId, 'opencode-session-test');
});

test('progress summaries never include agent text, commands, or tool arguments', () => {
  assert.equal(summarizeCodexEvent({
    type: 'item.started',
    item: { type: 'command_execution', command: 'curl https://secret.example/token' },
  }), '正在运行命令或测试');
  assert.equal(summarizeCodexEvent({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'very long private agent output' },
  }), null);
  assert.equal(summarizeOpenCodeEvent({
    type: 'tool_use',
    part: { input: { token: 'secret' } },
  }), '正在调用工具');
  assert.equal(summarizeOpenCodeEvent({
    type: 'text',
    part: { text: 'very long private agent output' },
  }), null);
});

test('parseOpenCodeResult accepts fenced JSON text events', () => {
  const result = parseOpenCodeResult(JSON.stringify({
    type: 'text',
    part: { text: '```json\\n{"status":"success","prUrl":"x"}\\n```' },
  }));
  assert.equal(result.status, 'success');
});

test('OpenCode export fallback finds the last structured assistant text', () => {
  const stream = '{"type":"step_start","sessionID":"ses_test","part":{"type":"step-start"}}\n';
  assert.equal(extractOpenCodeSessionId(stream), 'ses_test');
  const result = parseOpenCodeExport(JSON.stringify({ messages: [{ parts: [
    { type: 'text', text: 'intermediate' },
    { type: 'text', text: '{"status":"success","prUrl":"x"}' },
  ] }] }));
  assert.equal(result.prUrl, 'x');
});

function git(cwd, ...args) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8' });
}
