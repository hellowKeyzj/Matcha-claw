import type { ChatSessionRuntimeState } from './types';

type StreamStateLike = Pick<
  ChatSessionRuntimeState,
  'assistantOverlay' | 'sending' | 'pendingFinal' | 'activeRunId'
>;

export function hasActiveStreamingRun(state: StreamStateLike): boolean {
  return (
    state.assistantOverlay != null
    && !state.pendingFinal
    && (state.sending || state.activeRunId != null)
  );
}
    
