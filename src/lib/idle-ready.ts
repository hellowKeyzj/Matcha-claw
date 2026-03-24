interface IdleReadyOptions {
  idleTimeoutMs: number;
  fallbackDelayMs?: number;
  useAnimationFrame?: boolean;
}

interface ScheduledTask {
  cancelled: boolean;
  run: () => void;
}

const sharedTimeoutQueues = new Map<number, Set<ScheduledTask>>();
const sharedTimeoutHandles = new Map<number, number>();

function enqueueSharedTimeout(task: ScheduledTask, delayMs: number): () => void {
  const safeDelayMs = Number.isFinite(delayMs) && delayMs >= 0 ? Math.floor(delayMs) : 0;
  const queue = sharedTimeoutQueues.get(safeDelayMs) ?? new Set<ScheduledTask>();
  queue.add(task);
  sharedTimeoutQueues.set(safeDelayMs, queue);

  if (!sharedTimeoutHandles.has(safeDelayMs)) {
    const timerId = window.setTimeout(() => {
      sharedTimeoutHandles.delete(safeDelayMs);
      const pending = sharedTimeoutQueues.get(safeDelayMs);
      if (!pending || pending.size === 0) {
        sharedTimeoutQueues.delete(safeDelayMs);
        return;
      }
      sharedTimeoutQueues.delete(safeDelayMs);
      for (const queuedTask of pending) {
        if (!queuedTask.cancelled) {
          queuedTask.run();
        }
      }
    }, safeDelayMs);
    sharedTimeoutHandles.set(safeDelayMs, timerId);
  }

  return () => {
    const pending = sharedTimeoutQueues.get(safeDelayMs);
    if (!pending) {
      return;
    }
    pending.delete(task);
    if (pending.size > 0) {
      return;
    }
    sharedTimeoutQueues.delete(safeDelayMs);
    const timerId = sharedTimeoutHandles.get(safeDelayMs);
    if (typeof timerId === 'number') {
      window.clearTimeout(timerId);
      sharedTimeoutHandles.delete(safeDelayMs);
    }
  };
}

export function scheduleIdleReady(callback: () => void, options: IdleReadyOptions): () => void {
  const {
    idleTimeoutMs,
    fallbackDelayMs = 120,
    useAnimationFrame = true,
  } = options;

  let cancelled = false;
  let rafId: number | undefined;
  let idleId: number | undefined;
  let cancelFallback: (() => void) | undefined;

  const task: ScheduledTask = {
    cancelled: false,
    run: () => {
      if (!cancelled) {
        callback();
      }
    },
  };

  const scheduleIdle = () => {
    if ('requestIdleCallback' in window && typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(
        () => {
          task.run();
        },
        { timeout: idleTimeoutMs },
      );
      return;
    }
    cancelFallback = enqueueSharedTimeout(task, fallbackDelayMs);
  };

  if (useAnimationFrame) {
    rafId = window.requestAnimationFrame(() => {
      rafId = undefined;
      scheduleIdle();
    });
  } else {
    scheduleIdle();
  }

  return () => {
    cancelled = true;
    task.cancelled = true;
    if (typeof rafId === 'number') {
      window.cancelAnimationFrame(rafId);
    }
    if (typeof idleId === 'number' && 'cancelIdleCallback' in window && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleId);
    }
    if (cancelFallback) {
      cancelFallback();
      cancelFallback = undefined;
    }
  };
}

