import { logger } from '../../utils/logger';

const QUIT_DEADLINE_MS = 30_000;
const FORCE_CONFIRMATION_MS = 5_000;

export type QuitCleanupResult = Readonly<{ outcome: 'graceful' | 'forced' | 'unconfirmed' }>;

export async function completeQuitCleanup(
  cleanup: () => Promise<void>,
  force: () => Promise<void>,
  readStage: () => string,
): Promise<QuitCleanupResult> {
  const deadline = performance.now() + QUIT_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(cleanup).then(() => 'graceful' as const, (error: unknown) => {
        logger.warn('Application shutdown cleanup failed:', error);
        return 'cleanup-failed' as const;
      }),
      new Promise<'deadline'>((resolve) => {
        timer = setTimeout(() => resolve('deadline'), QUIT_DEADLINE_MS - FORCE_CONFIRMATION_MS);
      }),
    ]);
    clearTimeout(timer);
    if (result === 'graceful') {
      logger.info('[Shutdown]', { outcome: 'graceful' });
      return { outcome: 'graceful' };
    }
    const stage = readStage();
    logger.warn('[Shutdown]', { outcome: 'forcing', reason: result, stage });
    const confirmed = await Promise.race([
      Promise.resolve().then(force).then(() => true, (error: unknown) => {
        logger.error('Application shutdown force confirmation failed:', error);
        return false;
      }),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.min(FORCE_CONFIRMATION_MS, Math.max(0, deadline - performance.now())));
      }),
    ]);
    const outcome = confirmed ? 'forced' : 'unconfirmed';
    logger.warn('[Shutdown]', { outcome, reason: result, stage });
    return { outcome };
  } finally {
    clearTimeout(timer);
  }
}

export interface QuitLifecycleState {
  cleanupStarted: boolean;
  cleanupCompleted: boolean;
}

export type QuitLifecycleAction = 'start-cleanup' | 'cleanup-in-progress' | 'allow-quit';

export function createQuitLifecycleState(): QuitLifecycleState {
  return {
    cleanupStarted: false,
    cleanupCompleted: false,
  };
}

export function requestQuitLifecycleAction(state: QuitLifecycleState): QuitLifecycleAction {
  if (state.cleanupCompleted) {
    return 'allow-quit';
  }

  if (state.cleanupStarted) {
    return 'cleanup-in-progress';
  }

  state.cleanupStarted = true;
  return 'start-cleanup';
}

export function markQuitCleanupCompleted(state: QuitLifecycleState): void {
  state.cleanupCompleted = true;
}

