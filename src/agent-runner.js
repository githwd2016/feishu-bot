import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WorktreeManager } from './worktree-manager.js';

export class AgentRunner {
  constructor(config, { worktreeManager = new WorktreeManager() } = {}) {
    this.config = config;
    this.worktreeManager = worktreeManager;
  }

  async runReview({ pr, mode, reviewerName }) {
    return this.#run({
      pr,
      repository: this.#repository(pr, false),
      template: 'review.md',
      replacements: { PR_URL: pr.url, REVIEW_MODE: mode, REVIEWER_NAME: reviewerName },
    });
  }

  async runAddressFeedback({ pr }) {
    return this.#run({
      pr,
      repository: this.#repository(pr, true),
      template: 'address-feedback.md',
      replacements: { PR_URL: pr.url },
    });
  }

  async runInspect({ pr }) {
    return this.#run({
      pr,
      repository: this.#repository(pr, false),
      template: 'inspect.md',
      replacements: { PR_URL: pr.url },
    });
  }

  #repository(pr, required) {
    const directory = this.config.gitcode.workdirs[pr.repoKey];
    if (required && !directory) {
      throw new Error(`REPO_WORKDIRS_JSON 未配置 ${pr.owner}/${pr.repo} 的本地仓库`);
    }
    return directory || null;
  }

  async #run({ pr, repository, template, replacements }) {
    const worktreeNotice = repository
      ? '当前目录是机器人为本次任务创建的临时 detached Git worktree。主工作区中的未跟踪文件与本任务无关，不得因此阻塞；不得访问或修改主工作区。'
      : '此 PR 未配置本地仓库。禁止根据当前目录中的本地文件推断 PR 内容，只能使用 GitCode 远端数据完成只读审查。';
    const run = (workdir) => this.#runInWorkdir({
      pr,
      workdir,
      template,
      replacements: { ...replacements, WORKTREE_NOTICE: worktreeNotice },
      usesWorktree: Boolean(repository),
    });
    if (!repository) return run(this.config.projectRoot);
    return this.worktreeManager.run({ repository, label: pr.key }, run);
  }

  async #runInWorkdir({ pr, workdir, template, replacements, usesWorktree }) {
    const backend = this.config.agent.backend;
    const taskName = template.replace(/\.md$/, '');
    const startedAt = Date.now();
    const promptPath = path.join(this.config.projectRoot, 'prompts', backend, template);
    let prompt = await fs.readFile(promptPath, 'utf8');
    for (const [key, value] of Object.entries(replacements)) {
      prompt = prompt.replaceAll(`{{${key}}}`, String(value));
    }
    const env = {
      ...process.env,
      GITCODE_TOKEN: this.config.gitcode.token,
      GITCODE_API_URL: this.config.gitcode.apiBase,
      GITCODE_API_BASE: this.config.gitcode.apiBase,
      GITCODE_ALLOWED_REPOS: [...this.config.gitcode.allowedRepos].join(','),
      REVIEW_BOT_HELPER: path.join(this.config.projectRoot, 'scripts', 'gitcode-api.js'),
      REVIEW_BOT_TEMP_WORKTREE: usesWorktree ? 'true' : 'false',
    };
    console.log(`[agent:${backend}] 开始 ${taskName} ${pr.key} cwd=${workdir} timeout=${formatDuration(this.config.agent.timeoutMs)}`);
    const heartbeat = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, this.config.agent.timeoutMs - elapsed);
      console.log(`[agent:${backend}] 仍在运行 ${taskName} ${pr.key} elapsed=${formatDuration(elapsed)} remaining=${formatDuration(remaining)}`);
    }, 60_000);
    heartbeat.unref();

    try {
      const output = backend === 'codex'
        ? await this.#runCodex({ pr, prompt, workdir, env })
        : await this.#runOpenCode({ pr, prompt, workdir, env });
      validateAgentResult(output.result, pr);
      if (output.result.status !== 'success') {
        throw new Error(`${backend} 任务被阻塞: ${output.result.blockers.join('; ') || output.result.summary}`);
      }
      const durationMs = Date.now() - startedAt;
      const session = output.sessionId ? ` session=${output.sessionId}` : '';
      console.log(`[agent:${backend}] 完成 ${taskName} ${pr.key}${session} elapsed=${formatDuration(durationMs)}`
        + ` unresolved=${output.result.unresolvedCount}`
        + ` posted=${output.result.commentsPosted}`
        + ` replied=${output.result.commentsReplied}`
        + ` resolved=${output.result.commentsResolved}`);
      return { ...output, durationMs };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      console.error(`[agent:${backend}] 失败 ${taskName} ${pr.key} elapsed=${formatDuration(durationMs)} error=${oneLine(error.message)}`);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async #runCodex({ pr, prompt, workdir, env }) {
    const settings = this.config.agent.codex;
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-codex-'));
    const outputPath = path.join(tempDirectory, 'last-message.json');
    const schemaPath = path.join(this.config.projectRoot, 'schemas', 'agent-result.schema.json');
    const args = [
      'exec', // 非交互执行一次 Codex 任务，适合后台服务调用。
      '--json', // 输出结构化事件；服务只提取阶段，不打印 agent 的原始内容。
      '--skip-git-repo-check', // 没有本地 checkout 的只读 review 也允许从项目目录运行。
      '--cd', workdir, // 把 PR 对应的本地仓库设为 Codex 工作根目录。
      '--output-schema', schemaPath, // 约束最终消息必须符合 agent-result JSON Schema。
      '--output-last-message', outputPath, // 将最终消息单独写入文件，避免从过程日志中提取 JSON。
    ];
    // 无人值守模式会取消确认和沙箱；未开启时仅允许在工作区内写文件。
    if (settings.bypassApprovalsAndSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('--sandbox', 'workspace-write');
    // profile 和 model 均为可选项，分别来自 CODEX_PROFILE 与 CODEX_MODEL。
    if (settings.profile) args.push('--profile', settings.profile);
    if (settings.model) args.push('--model', settings.model);
    args.push('-'); // 从 stdin 读取 prompt，避免把长提示词放进进程命令行。
    const progress = createJsonEventProgress({
      prefix: `[agent:codex:${pr.key}]`,
      summarize: summarizeCodexEvent,
    });

    try {
      const logs = await runProcess({
        bin: settings.bin, args, cwd: workdir, env, stdin: prompt,
        timeoutMs: this.config.agent.timeoutMs,
        onStdout: progress.write,
      });
      return {
        ...logs,
        sessionId: progress.sessionId,
        result: JSON.parse(await fs.readFile(outputPath, 'utf8')),
      };
    } finally {
      progress.flush();
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  }

  async #runOpenCode({ pr, prompt, workdir, env }) {
    const settings = this.config.agent.opencode;
    const args = ['run', '--format', 'json', '--dir', workdir];
    if (settings.model) args.push('--model', settings.model);
    if (settings.agent) args.push('--agent', settings.agent);
    if (settings.variant) args.push('--variant', settings.variant);
    if (settings.autoApprove) args.push('--auto');
    args.push(prompt);
    const progress = createJsonEventProgress({
      prefix: `[agent:opencode:${pr.key}]`,
      summarize: summarizeOpenCodeEvent,
    });
    try {
      const logs = await runProcess({
        bin: settings.bin, args, cwd: workdir, env, timeoutMs: this.config.agent.timeoutMs,
        onStdout: progress.write,
      });
      const sessionId = progress.sessionId || extractOpenCodeSessionId(logs.stdout);
      try {
        return { ...logs, sessionId, result: parseOpenCodeResult(logs.stdout) };
      } catch (error) {
        if (!sessionId) throw error;
        const exported = await runProcess({
          bin: settings.bin,
          args: ['export', sessionId],
          cwd: workdir,
          env,
          timeoutMs: Math.min(this.config.agent.timeoutMs, 60_000),
        });
        return {
          stdout: logs.stdout,
          stderr: `${logs.stderr}${exported.stderr}`,
          sessionId,
          result: parseOpenCodeExport(exported.stdout),
        };
      }
    } finally {
      progress.flush();
    }
  }
}

function runProcess({ bin, args, cwd, env, stdin, timeoutMs, onStdout, onStderr }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forceKillTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[agent:process] ${path.basename(bin)} 超过 ${formatDuration(timeoutMs)}，正在终止进程组`);
      terminateProcessTree(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 10_000);
      forceKillTimer.unref();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = appendBounded(stdout, chunk);
      onStdout?.(chunk.toString());
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendBounded(stderr, chunk);
      onStderr?.(chunk.toString());
    });
    if (child.stdin) {
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') reject(error);
      });
    }
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      if (code === 0) return resolve({ stdout, stderr });
      if (timedOut) {
        return reject(new Error(`${path.basename(bin)} 运行超过 ${formatDuration(timeoutMs)}，已终止`));
      }
      reject(new Error(`${path.basename(bin)} 退出异常 code=${code} signal=${signal || '-'} stderr=${stderr.slice(-2000)}`));
    });
    if (child.stdin) child.stdin.end(stdin);
  });
}

function terminateProcessTree(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') console.warn(`[agent:process] 无法发送 ${signal}: ${error.message}`);
  }
}

function createJsonEventProgress({ prefix, summarize }) {
  let pending = '';
  let sessionId = null;
  const emitted = new Set();
  const consume = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const discoveredSessionId = extractAgentSessionId(event);
    if (!sessionId && discoveredSessionId) {
      sessionId = discoveredSessionId;
      console.log(`${prefix} 会话已保存 session=${sessionId}`);
    }
    const message = summarize(event);
    if (!message || emitted.has(message)) return;
    emitted.add(message);
    console.log(`${prefix} ${message}`);
  };
  return {
    get sessionId() {
      return sessionId;
    },
    write(chunk) {
      pending += String(chunk).replaceAll('\r', '\n');
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) consume(line);
    },
    flush() {
      if (pending) consume(pending);
      pending = '';
    },
  };
}

function extractAgentSessionId(event) {
  for (const value of [
    event?.thread_id,
    event?.sessionID,
    event?.sessionId,
    event?.part?.sessionID,
    event?.part?.sessionId,
  ]) {
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

export function summarizeCodexEvent(event) {
  if (event?.type === 'turn.started') return '模型开始处理';
  if (event?.type === 'turn.completed') return '模型处理完成，正在校验结果';
  if (event?.type === 'turn.failed' || event?.type === 'error') return '模型报告执行失败';
  if (!event?.type?.startsWith('item.') || !event.item) return null;
  const failed = ['failed', 'error'].includes(event.item.status);
  if (failed && event.item.type === 'command_execution') return '命令或测试执行失败';
  if (failed && event.item.type === 'mcp_tool_call') return '外部工具调用失败';
  if (event.type !== 'item.started') return null;
  const messages = {
    command_execution: '正在运行命令或测试',
    file_change: '正在修改代码',
    mcp_tool_call: '正在调用 GitCode 或其他工具',
    web_search: '正在检索资料',
    plan_update: '正在更新执行计划',
  };
  return messages[event.item.type] || null;
}

export function summarizeOpenCodeEvent(event) {
  const type = String(event?.type || event?.part?.type || '').replaceAll('-', '_').toLowerCase();
  if (type === 'step_start') return '模型开始处理';
  if (type === 'step_finish' || type === 'step_completed') return '模型处理完成，正在校验结果';
  if (type.includes('file') && (type.includes('change') || type.includes('edit'))) return '正在修改代码';
  if (type.includes('tool')) return '正在调用工具';
  if (type.includes('error') || type.includes('failed')) return '模型报告执行失败';
  return null;
}

function formatDuration(durationMs) {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m${remainder}s` : `${minutes}m`;
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function parseOpenCodeResult(stdout) {
  const textParts = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const text = event?.part?.text ?? event?.text ?? event?.content?.text;
      if (typeof text === 'string') textParts.push(text);
    } catch {
      textParts.push(line);
    }
  }
  const candidates = [...textParts].reverse();
  candidates.push(textParts.join(''));
  for (const candidate of candidates) {
    const parsed = parseJsonObject(candidate);
    if (parsed) return parsed;
  }
  throw new Error('OpenCode 没有返回可解析的 JSON 最终结果');
}

export function extractOpenCodeSessionId(stdout) {
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (typeof event.sessionID === 'string' && event.sessionID) return event.sessionID;
    } catch {}
  }
  return null;
}

export function parseOpenCodeExport(stdout) {
  let exported;
  try { exported = JSON.parse(stdout); } catch { throw new Error('OpenCode export 返回了无效 JSON'); }
  const texts = [];
  collectTextParts(exported, texts);
  for (const text of texts.reverse()) {
    const parsed = parseJsonObject(text);
    if (parsed) return parsed;
  }
  throw new Error('OpenCode session export 中没有可解析的 JSON 最终结果');
}

function collectTextParts(value, output) {
  if (Array.isArray(value)) {
    for (const item of value) collectTextParts(item, output);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.type === 'text' && typeof value.text === 'string') output.push(value.text);
  for (const child of Object.values(value)) collectTextParts(child, output);
}

function parseJsonObject(value) {
  const cleaned = String(value).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

function validateAgentResult(result, pr) {
  const allowedKeys = new Set([
    'status', 'action', 'prUrl', 'unresolvedCount', 'unresolvedReviewerLogins',
    'commentsPosted', 'commentsReplied', 'commentsResolved', 'commitSha', 'summary', 'blockers',
  ]);
  if (!result || typeof result !== 'object' || result.prUrl !== pr.url) {
    throw new Error('agent 返回结果中的 PR URL 不匹配');
  }
  if (Object.keys(result).some((key) => !allowedKeys.has(key)) || Object.keys(result).length !== allowedKeys.size) {
    throw new Error('agent 返回结果不符合约定字段集合');
  }
  if (!['success', 'blocked'].includes(result.status)) throw new Error('agent 返回了未知状态');
  if (!['inspect', 'review', 'address_feedback'].includes(result.action)) throw new Error('agent 返回了未知 action');
  for (const field of ['unresolvedCount', 'commentsPosted', 'commentsReplied', 'commentsResolved']) {
    if (!Number.isInteger(result[field]) || result[field] < 0) throw new Error(`agent 返回的 ${field} 无效`);
  }
  if (!Array.isArray(result.unresolvedReviewerLogins)
    || result.unresolvedReviewerLogins.some((item) => typeof item !== 'string')
    || !Array.isArray(result.blockers)
    || result.blockers.some((item) => typeof item !== 'string')) {
    throw new Error('agent 返回的列表字段无效');
  }
  if (typeof result.summary !== 'string' || (result.commitSha !== null && typeof result.commitSha !== 'string')) {
    throw new Error('agent 返回的摘要或 commitSha 无效');
  }
}

function appendBounded(current, chunk) {
  const next = current + chunk.toString();
  return next.length > 200_000 ? next.slice(-200_000) : next;
}
