import type { ChatSessionRuntimeState } from './types';

type StreamStateLike = Pick<
  ChatSessionRuntimeState,
  'activeTurnItemKey' | 'sending' | 'pendingFinal' | 'activeRunId'
>;

export function hasActiveStreamingRun(state: StreamStateLike): boolean {
  return (
    state.activeTurnItemKey != null
    && !state.pendingFinal
    && (state.sending || state.activeRunId != null)
  );
}
    
