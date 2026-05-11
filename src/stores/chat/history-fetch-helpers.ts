import { hostSessionLoad, waitForRuntimeJobResult } from '@/lib/host-api';
import type {
  SessionLoadResult,
  SessionStateSnapshot,
} from '../../../runtime-host/shared/session-adapter-types';
import { resolveSessionThinkingLevelFromList } from './session-helpers';
import type { ChatSession } from './types';

export interface HistoryWindowResult {
  snapshot: SessionStateSnapshot | null;
  thinkingLevel: string | null;
  totalItemCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isAtLatest: boolean;
}

interface FetchHistoryWindowInput {
  requestedSessionKey: string;
  sessions: ChatSession[];
  limit: number;
  timeoutMs?: number;
}

export async function fetchHistoryWindow(
  input: FetchHistoryWindowInput,
): Promise<HistoryWindowResult> {
  const {
    requestedSessionKey,
    sessions,
    limit,
    timeoutMs,
  } = input;

  void limit;

  const initial = await hostSessionLoad({
    sessionKey: requestedSessionKey,
  }, {
    timeoutMs,
  });
  const data = initial.hydrationJob
    ? await waitForRuntimeJobResult<SessionLoadResult>(initial.hydrationJob.id, {
        timeoutMs,
      })
    : initial;
  return {
    snapshot: data.snapshot,
    thinkingLevel: resolveSessionThinkingLevelFromList(sessions, requestedSessionKey),
    totalItemCount: data.snapshot.window.totalItemCount,
    windowStartOffset: data.snapshot.window.windowStartOffset,
    windowEndOffset: data.snapshot.window.windowEndOffset,
    hasMore: data.snapshot.window.hasMore,
    hasNewer: data.snapshot.window.hasNewer,
    isAtLatest: data.snapshot.window.isAtLatest,
  };
}
