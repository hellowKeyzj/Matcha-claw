import { hostSessionLoad, hostSessionWindowFetch, resolveHydratedSessionSnapshot } from '@/lib/host-api';
import type {
  SessionStateSnapshot,
} from '../../../runtime-host/shared/session-adapter-types';
import { resolveSessionThinkingLevelFromList } from './session-helpers';
import type { SessionIdentity } from '../../../runtime-host/shared/runtime-address';
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
  recordKey: string;
  backendSessionKey: string;
  sessionIdentity: SessionIdentity;
  sessions: ChatSession[];
  limit: number;
  timeoutMs?: number;
}

export async function fetchHistoryWindow(
  input: FetchHistoryWindowInput,
): Promise<HistoryWindowResult> {
  const {
    recordKey,
    backendSessionKey,
    sessionIdentity,
    sessions,
    limit,
    timeoutMs,
  } = input;

  void limit;

  const initial = await hostSessionLoad({
    sessionKey: backendSessionKey,
    sessionIdentity,
    limit,
  }, {
    timeoutMs,
  });
  const snapshot = await resolveHydratedSessionSnapshot({
    initial,
    timeoutMs,
    refetch: async () => await hostSessionWindowFetch({
      sessionKey: backendSessionKey,
      sessionIdentity,
      mode: 'latest',
      limit,
    }),
  });
  if (!snapshot) {
    throw new Error('session load did not return a snapshot');
  }
  return {
    snapshot,
    thinkingLevel: resolveSessionThinkingLevelFromList(sessions, recordKey),
    totalItemCount: snapshot.window.totalItemCount,
    windowStartOffset: snapshot.window.windowStartOffset,
    windowEndOffset: snapshot.window.windowEndOffset,
    hasMore: snapshot.window.hasMore,
    hasNewer: snapshot.window.hasNewer,
    isAtLatest: snapshot.window.isAtLatest,
  };
}
