import { logger } from '../../../utils/logger';
import {
  getDeferredRestartAction,
  shouldDeferRestart,
  type GatewayLifecycleState,
} from './process-policy';

type RestartDeferralState = {
  processState: GatewayLifecycleState;
};

type DeferredRestartContext = RestartDeferralState;

export class GatewayRestartController {
  private deferredRestartPending = false;
  private deferredRestartRequestedAt = 0;
  private lastRestartCompletedAt = 0;
  private restartDebounceTimer: NodeJS.Timeout | null = null;

  isRestartDeferred(context: RestartDeferralState): boolean {
    return shouldDeferRestart(context);
  }

  markDeferredRestart(reason: string, context: RestartDeferralState): void {
    if (!this.deferredRestartPending) {
      logger.info(
        `Deferring Gateway restart (${reason}) until startup/reconnect settles (processState=${context.processState})`,
      );
    } else {
      logger.debug(
        `Gateway restart already deferred; keeping pending request (${reason}, processState=${context.processState})`,
      );
    }
    this.deferredRestartPending = true;
    if (this.deferredRestartRequestedAt === 0) {
      this.deferredRestartRequestedAt = Date.now();
    }
  }

  flushDeferredRestart(
    trigger: string,
    context: DeferredRestartContext,
    executeRestart: () => void,
  ): void {
    const action = getDeferredRestartAction({
      hasPendingRestart: this.deferredRestartPending,
      processState: context.processState,
    });

    if (action === 'none') return;
    if (action === 'wait') {
      logger.debug(
        `Deferred Gateway restart still waiting (${trigger}, processState=${context.processState})`,
      );
      return;
    }

    const requestedAt = this.deferredRestartRequestedAt;
    this.deferredRestartPending = false;
    this.deferredRestartRequestedAt = 0;
    if (action === 'drop') {
      logger.info(
        `Dropping deferred Gateway restart (${trigger}) because gateway stopped before restart could run (processState=${context.processState})`,
      );
      return;
    }

    if (requestedAt > 0 && this.lastRestartCompletedAt >= requestedAt) {
      logger.info(
        `Dropping deferred Gateway restart (${trigger}): a restart already completed after the request (requested=${requestedAt}, completed=${this.lastRestartCompletedAt})`,
      );
      return;
    }

    logger.info(`Executing deferred Gateway restart now (${trigger})`);
    executeRestart();
  }

  recordRestartCompleted(completedAt = Date.now()): void {
    if (!Number.isFinite(completedAt) || completedAt <= 0) {
      return;
    }
    this.lastRestartCompletedAt = Math.max(this.lastRestartCompletedAt, completedAt);
  }

  debouncedRestart(delayMs: number, executeRestart: () => void): void {
    if (this.restartDebounceTimer) {
      clearTimeout(this.restartDebounceTimer);
    }
    logger.debug(`Gateway restart debounced (will fire in ${delayMs}ms)`);
    this.restartDebounceTimer = setTimeout(() => {
      this.restartDebounceTimer = null;
      executeRestart();
    }, delayMs);
  }

  clearDebounceTimer(): void {
    if (this.restartDebounceTimer) {
      clearTimeout(this.restartDebounceTimer);
      this.restartDebounceTimer = null;
    }
  }

  resetDeferredRestart(): void {
    this.deferredRestartPending = false;
    this.deferredRestartRequestedAt = 0;
  }
}
