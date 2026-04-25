import type { ChatSessionRuntimeState } from './types';

type StreamStateLike = Pick<ChatSessionRuntimeState, 'assistantOverlay'>;

export function hasActiveStreamingRun(state: StreamStateLike): boolean {
  return state.assistantOverlay != null;
}
    
