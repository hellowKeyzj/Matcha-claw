import { hostSessionLoad, hostSessionWindowFetch, waitForRuntimeJobResult } from '@/lib/host-api';
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
    limit,
  }, {
    timeoutMs,
  });
  const data = initial.hydrationJob
    ? await waitForRuntimeJobResult(initial.hydrationJob.id, {
        timeoutMs,
      }).then(async () => {
        const window = await hostSessionWindowFetch({
          sessionKey: requestedSessionKey,
          mode: 'latest',
          limit,
        });
        return window.snapshot ? { snapshot: window.snapshot } : null;
      })
    : initial.snapshot
      ? initial as SessionLoadResult
      : null;
  if (!data) {
    throw new Error('session load did not return a snapshot');
  }
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
