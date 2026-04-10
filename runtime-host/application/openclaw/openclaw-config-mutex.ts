import { AsyncLocalStorage } from 'node:async_hooks';

const lockContext = new AsyncLocalStorage<symbol>();
let lockQueue: Promise<void> = Promise.resolve();
let activeToken: symbol | null = null;

/**
 * 对 openclaw.json 的读改写入口做进程内串行化，避免并发覆盖。
 * 支持同一调用链的可重入，避免嵌套调用时死锁。
 */
export async function withOpenClawConfigLock<T>(
  task: () => Promise<T> | T,
): Promise<T> {
  const inheritedToken = lockContext.getStore();
  if (inheritedToken && inheritedToken === activeToken) {
    return await task();
  }

  const token = Symbol('openclaw-config-lock');
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const previous = lockQueue.catch(() => undefined);
  lockQueue = previous.then(() => gate);

  await previous;
  activeToken = token;

  try {
    return await lockContext.run(token, async () => await task());
  } finally {
    activeToken = null;
    release();
  }
}
