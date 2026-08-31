import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY = {
  version: 4,
  prs: {},
  externalReviewCycles: {},
  externalReviewRequests: {},
  automationTasks: {},
  seenMessageIds: [],
};
const FAILED_REVIEW_RESULT_PATTERN = /\[review-bot action=result mode=(?:initial|rereview) cycle=\d+ status=failed\]/i;

export class StateStore {
  #file;
  #state = structuredClone(EMPTY);
  #lock = Promise.resolve();

  constructor(file) {
    this.#file = file;
  }

  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      this.#state = {
        version: EMPTY.version,
        prs: saved.prs || {},
        externalReviewCycles: saved.externalReviewCycles || {},
        externalReviewRequests: saved.externalReviewRequests || {},
        automationTasks: saved.automationTasks || {},
        seenMessageIds: saved.seenMessageIds || [],
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  getPr(key) {
    const value = this.#state.prs[key];
    return value ? structuredClone(value) : null;
  }

  listPrs() {
    return Object.values(this.#state.prs).map((value) => structuredClone(value));
  }

  findActivePr(chatId) {
    const matches = Object.values(this.#state.prs).filter(
      (item) => item.chatId === chatId && !['completed', 'failed'].includes(item.phase),
    );
    return matches.length === 1 ? structuredClone(matches[0]) : null;
  }

  async claimMessage(messageId) {
    return this.#mutate((state) => {
      if (state.seenMessageIds.includes(messageId)) return false;
      state.seenMessageIds.push(messageId);
      state.seenMessageIds = state.seenMessageIds.slice(-500);
      return true;
    });
  }

  async claimExternalReviewCycle({ prKey, chatId, requesterOpenId, mode, cycle }) {
    return this.#mutate((state) => {
      const key = JSON.stringify([prKey, chatId, requesterOpenId]);
      const current = state.externalReviewCycles[key];
      const next = Number.isInteger(cycle)
        ? cycle
        : mode === 'rereview'
          ? Math.max(1, (Number.isInteger(current) ? current : 0) + 1)
          : 0;
      state.externalReviewCycles[key] = next;
      return next;
    });
  }

  async claimExternalReviewRequest({ prKey, prUrl, chatId, requesterOpenId, mode, cycle }) {
    return this.#mutate((state) => {
      const key = JSON.stringify([prKey, requesterOpenId, mode, cycle]);
      const current = state.externalReviewRequests[key];
      const retryableFailure = current?.status === 'failed'
        || (current?.status === 'completed' && FAILED_REVIEW_RESULT_PATTERN.test(current.resultMessage || ''));
      if (current && !retryableFailure) return { claimed: false, record: structuredClone(current) };
      const record = {
        key,
        prKey,
        prUrl,
        chatId,
        requesterOpenId,
        mode,
        cycle,
        status: 'running',
        attempts: (current?.attempts || 0) + 1,
        resultMessage: '',
        updatedAt: new Date().toISOString(),
      };
      state.externalReviewRequests[key] = record;
      const entries = Object.entries(state.externalReviewRequests).slice(-2000);
      state.externalReviewRequests = Object.fromEntries(entries);
      return { claimed: true, record: structuredClone(record) };
    });
  }

  listRunningExternalReviewRequests() {
    return Object.values(this.#state.externalReviewRequests)
      .filter((item) => item && typeof item === 'object' && item.status === 'running')
      .map((item) => structuredClone(item));
  }

  async completeExternalReviewRequest(
    { prKey, chatId, requesterOpenId, mode, cycle }, resultMessage, { success = true } = {},
  ) {
    return this.#mutate((state) => {
      const key = JSON.stringify([prKey, requesterOpenId, mode, cycle]);
      const current = state.externalReviewRequests[key];
      if (!current || typeof current !== 'object') throw new Error(`外部审查请求状态不存在: ${key}`);
      const next = {
        ...current,
        status: success ? 'completed' : 'failed',
        resultMessage,
        updatedAt: new Date().toISOString(),
      };
      state.externalReviewRequests[key] = next;
      return structuredClone(next);
    });
  }

  getAutomationTask(key) {
    const value = this.#state.automationTasks[key];
    return value ? structuredClone(value) : null;
  }

  async claimAutomationTask(key, { maxAttempts, staleAfterMs }) {
    return this.#mutate((state) => {
      const now = Date.now();
      const current = state.automationTasks[key];
      if (current?.status === 'succeeded' || current?.status === 'exhausted') return null;
      if (current?.status === 'running') {
        const updatedAt = Date.parse(current.updatedAt || '');
        if (Number.isFinite(updatedAt) && now - updatedAt < staleAfterMs) return null;
      }
      const attempts = (current?.attempts || 0) + 1;
      if (attempts > maxAttempts) {
        state.automationTasks[key] = {
          ...current,
          status: 'exhausted',
          updatedAt: new Date(now).toISOString(),
        };
        return null;
      }
      const next = {
        status: 'running',
        attempts,
        lastError: '',
        updatedAt: new Date(now).toISOString(),
      };
      delete state.automationTasks[key];
      state.automationTasks[key] = next;
      state.automationTasks = Object.fromEntries(Object.entries(state.automationTasks).slice(-5000));
      return structuredClone(next);
    });
  }

  async completeAutomationTask(key) {
    return this.#mutate((state) => {
      const current = state.automationTasks[key];
      if (!current) throw new Error(`自动任务状态不存在: ${key}`);
      const next = { ...current, status: 'succeeded', updatedAt: new Date().toISOString() };
      state.automationTasks[key] = next;
      return structuredClone(next);
    });
  }

  async failAutomationTask(key, error, { maxAttempts }) {
    return this.#mutate((state) => {
      const current = state.automationTasks[key];
      if (!current) throw new Error(`自动任务状态不存在: ${key}`);
      const next = {
        ...current,
        status: current.attempts >= maxAttempts ? 'exhausted' : 'failed',
        lastError: String(error?.message || error).slice(0, 1000),
        updatedAt: new Date().toISOString(),
      };
      state.automationTasks[key] = next;
      return structuredClone(next);
    });
  }

  async putPr(prState) {
    return this.#mutate((state) => {
      const next = { ...prState, updatedAt: new Date().toISOString() };
      state.prs[next.key] = next;
      return structuredClone(next);
    });
  }

  async updatePr(key, updater) {
    return this.#mutate((state) => {
      const current = state.prs[key];
      if (!current) throw new Error(`PR 状态不存在: ${key}`);
      const next = { ...updater(structuredClone(current)), updatedAt: new Date().toISOString() };
      state.prs[key] = next;
      return structuredClone(next);
    });
  }

  async #mutate(operation) {
    let result;
    this.#lock = this.#lock.then(async () => {
      result = operation(this.#state);
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const temp = `${this.#file}.${process.pid}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, this.#file);
    });
    await this.#lock;
    return result;
  }
}
