import { hostOpenClawVideoTaskRefresh } from '@/lib/host-api';
import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { OpenClawVideoTaskRefreshResult } from '@/types/openclaw-video-task';
import { findSessionRecordKey } from './session-catalog';
import { useChatStore } from './store';

export async function refreshVideoTask(
  identity: SessionIdentity,
  taskId: string,
): Promise<OpenClawVideoTaskRefreshResult> {
  try {
    return await hostOpenClawVideoTaskRefresh({ sessionIdentity: identity, taskId });
  } finally {
    const state = useChatStore.getState();
    const recordKey = findSessionRecordKey(state, identity);
    if (recordKey) {
      await state.loadHistory({ sessionKey: recordKey, mode: 'quiet',
        scope: state.currentSessionKey === recordKey ? 'foreground' : 'background', reason: 'manual_refresh' });
    }
  }
}
