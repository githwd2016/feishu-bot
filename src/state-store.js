import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY = { version: 2, prs: {}, seenMessageIds: [] };

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
