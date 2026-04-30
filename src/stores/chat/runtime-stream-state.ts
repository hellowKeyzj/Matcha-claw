import type { ChatSessionRuntimeState } from './types';

type StreamStateLike = Pick<
  ChatSessionRuntimeState,
  'streamingMessageId' | 'sending' | 'pendingFinal' | 'activeRunId'
>;

export function hasActiveStreamingRun(state: StreamStateLike): boolean {
  return (
    state.streamingMessageId != null
    && !state.pendingFinal
    && (state.sending || state.activeRunId != null)
  );
}
    
