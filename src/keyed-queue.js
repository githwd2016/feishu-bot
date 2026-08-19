export class KeyedQueue {
  #tails = new Map();

  enqueue(key, task) {
    const prior = this.#tails.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(task);
    this.#tails.set(key, next);
    next.finally(() => {
      if (this.#tails.get(key) === next) this.#tails.delete(key);
    }).catch(() => {});
    return next;
  }
}
