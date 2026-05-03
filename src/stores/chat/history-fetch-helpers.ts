import { hostSessionLoad } from '@/lib/host-api';
import type { SessionStateSnapshot } from '../../../runtime-host/shared/session-adapter-types';
import { resolveSessionThinkingLevelFromList } from './session-helpers';
import type { ChatSession } from './types';

export interface HistoryWindowResult {
  snapshot: SessionStateSnapshot | null;
  thinkingLevel: string | null;
  totalMessageCount: number;
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
}

export async function fetchHistoryWindow(
  input: FetchHistoryWindowInput,
): Promise<HistoryWindowResult> {
  const {
    requestedSessionKey,
    sessions,
    limit,
  } = input;

  void limit;

  const data = await hostSessionLoad({
    sessionKey: requestedSessionKey,
  });
  return {
    snapshot: data.snapshot,
    thinkingLevel: resolveSessionThinkingLevelFromList(sessions, requestedSessionKey),
    totalMessageCount: data.snapshot.window.totalEntryCount,
    windowStartOffset: data.snapshot.window.windowStartOffset,
    windowEndOffset: data.snapshot.window.windowEndOffset,
    hasMore: data.snapshot.window.hasMore,
    hasNewer: data.snapshot.window.hasNewer,
    isAtLatest: data.snapshot.window.isAtLatest,
  };
}
