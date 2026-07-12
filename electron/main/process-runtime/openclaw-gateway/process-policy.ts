export type GatewayLifecycleState = 'stopped' | 'starting' | 'control_connecting' | 'running' | 'error' | 'reconnecting';

export interface RestartDeferralContext {
  processState: GatewayLifecycleState;
}

/**
 * Restart requests should not interrupt an in-flight startup/reconnect flow.
 * Doing so can kill a just-spawned process and leave the manager stopped.
 */
export function shouldDeferRestart(context: RestartDeferralContext): boolean {
  return context.processState === 'starting'
    || context.processState === 'control_connecting'
    || context.processState === 'reconnecting';
}

export interface DeferredRestartActionContext extends RestartDeferralContext {
  hasPendingRestart: boolean;
}

export type DeferredRestartAction = 'none' | 'wait' | 'drop' | 'execute';

/**
 * Decide what to do with a pending deferred restart once lifecycle changes.
 *
 * A deferred restart is an explicit restart() call that was postponed because
 * the gateway was mid-startup/reconnect. Once the in-flight state settles, a
 * stopped gateway drops the request; running/error states execute it unless a
 * later completed restart already covered it in GatewayRestartController.
 */
export function getDeferredRestartAction(context: DeferredRestartActionContext): DeferredRestartAction {
  if (!context.hasPendingRestart) return 'none';
  if (shouldDeferRestart(context)) return 'wait';
  if (context.processState === 'stopped') return 'drop';
  return 'execute';
}
