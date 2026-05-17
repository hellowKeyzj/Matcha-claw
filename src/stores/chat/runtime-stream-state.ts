import type { ChatSessionRuntimeState } from './types';
import { isWaitingTool, isRunActive } from './types';

type StreamStateLike = Pick<
  ChatSessionRuntimeState,
  'activeTurnItemKey' | 'runPhase' | 'activeRunId'
>;

export function hasActiveStreamingRun(state: StreamStateLike): boolean {
  return (
    state.activeTurnItemKey != null
    && !isWaitingTool(state)
    && (isRunActive(state) || state.activeRunId != null)
  );
}
