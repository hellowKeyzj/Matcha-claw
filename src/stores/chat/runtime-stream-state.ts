import type { ChatSessionRuntimeState } from './types';

type StreamStateLike = Pick<
  ChatSessionRuntimeState,
  'streamingAnchorKey' | 'sending' | 'pendingFinal' | 'activeRunId'
>;

export function hasActiveStreamingRun(state: StreamStateLike): boolean {
  return (
    state.streamingAnchorKey != null
    && !state.pendingFinal
    && (state.sending || state.activeRunId != null)
  );
}
    
