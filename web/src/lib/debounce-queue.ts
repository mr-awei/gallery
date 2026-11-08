/**
 * 可注入时钟的合并提交队列（纯逻辑，不依赖 React，便于单测）。
 * 连续 push 会把 patch 合并成一次提交；提交串行化，旧请求不会覆盖新值。
 */
export type Scheduler = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const DEFAULT_SCHEDULER: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createDebounceQueue<T extends object>(
  commit: (patch: Partial<T>) => void | Promise<void>,
  scheduler: Scheduler = DEFAULT_SCHEDULER
) {
  let merged: Partial<T> = {};
  let handle: unknown = null;
  let chain: Promise<unknown> = Promise.resolve();

  const flush = () => {
    if (handle !== null) {
      scheduler.clear(handle);
      handle = null;
    }
    const patch = merged;
    merged = {};
    if (!Object.keys(patch).length) return;
    chain = chain.then(() => commit(patch)).catch(() => {
      /* commit 内部负责提示；这里只保证后续提交不会被前一次失败打断 */
    });
  };

  return {
    push(patch: Partial<T>, delay: number) {
      merged = { ...merged, ...patch };
      if (handle !== null) scheduler.clear(handle);
      handle = scheduler.set(() => {
        handle = null;
        flush();
      }, Math.max(0, delay));
    },
    flush,
    /** 卸载时用：取消未触发的 timer 后把草稿补发一次 */
    dispose() {
      flush();
    },
  };
}
