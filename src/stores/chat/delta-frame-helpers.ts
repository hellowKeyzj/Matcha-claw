import { reduceRuntimeOverlay } from './overlay-reducer';
import type { ChatStoreState, ToolStatus } from './types';

const CHAT_DELTA_FRAME_FALLBACK_MS = 33;

interface PendingDeltaBatch {
  sessionKey: string;
  runId: string;
  hasMessage: boolean;
  message: unknown;
  updates: ToolStatus[];
}

let pendingDeltaBatch: PendingDeltaBatch | null = null;
let pendingDeltaFlushQueued = false;
let pendingDeltaFlushRafId: number | null = null;
let pendingDeltaFlushTimeout: ReturnType<typeof setTimeout> | null = null;

type ChatSet = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState>),
) => void;
type ChatGet = () => ChatStoreState;

function clearPendingDeltaFlushSchedule(): void {
  if (pendingDeltaFlushRafId != null) {
    if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(pendingDeltaFlushRafId);
    }
    pendingDeltaFlushRafId = null;
  }
  if (pendingDeltaFlushTimeout) {
    clearTimeout(pendingDeltaFlushTimeout);
    pendingDeltaFlushTimeout = null;
  }
  pendingDeltaFlushQueued = false;
}

export function clearPendingDeltaBatch(): void {
  pendingDeltaBatch = null;
  clearPendingDeltaFlushSchedule();
}

export function flushPendingDeltaBatch(set: ChatSet, get: ChatGet): void {
  const batch = pendingDeltaBatch;
  if (!batch) {
    clearPendingDeltaFlushSchedule();
    return;
  }

  pendingDeltaBatch = null;
  clearPendingDeltaFlushSchedule();

  const currentState = get();
  if (currentState.currentSessionKey !== batch.sessionKey) {
    return;
  }
  if (batch.runId && currentState.activeRunId && batch.runId !== currentState.activeRunId) {
    return;
  }

  const hasUpdates = batch.updates.length > 0;
  if (!batch.hasMessage && !hasUpdates) {
    return;
  }

  set((state) => reduceRuntimeOverlay(state, {
    type: 'delta_committed',
    ...(batch.hasMessage ? { message: batch.message } : {}),
    ...(hasUpdates ? { updates: batch.updates } : {}),
  }));
}

function schedulePendingDeltaFlush(set: ChatSet, get: ChatGet): void {
  if (pendingDeltaFlushQueued) {
    return;
  }
  pendingDeltaFlushQueued = true;

  const flush = () => {
    flushPendingDeltaBatch(set, get);
  };

  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    pendingDeltaFlushRafId = window.requestAnimationFrame(() => {
      pendingDeltaFlushRafId = null;
      flush();
    });
    pendingDeltaFlushTimeout = setTimeout(() => {
      if (!pendingDeltaFlushQueued) {
        return;
      }
      if (pendingDeltaFlushRafId != null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(pendingDeltaFlushRafId);
      }
      pendingDeltaFlushRafId = null;
      flush();
    }, CHAT_DELTA_FRAME_FALLBACK_MS);
    return;
  }

  pendingDeltaFlushTimeout = setTimeout(flush, 16);
}

export function queueDeltaForFrame(
  set: ChatSet,
  get: ChatGet,
  sessionKey: string,
  runId: string,
  message: unknown,
  updates: ToolStatus[],
): void {
  const normalizedRunId = runId.trim();
  if (
    pendingDeltaBatch
    && (
      pendingDeltaBatch.sessionKey !== sessionKey
      || pendingDeltaBatch.runId !== normalizedRunId
    )
  ) {
    flushPendingDeltaBatch(set, get);
  }

  if (!pendingDeltaBatch) {
    pendingDeltaBatch = {
      sessionKey,
      runId: normalizedRunId,
      hasMessage: false,
      message: null,
      updates: [],
    };
  }

  if (message !== undefined) {
    pendingDeltaBatch.message = message;
    pendingDeltaBatch.hasMessage = true;
  }
  if (updates.length > 0) {
    pendingDeltaBatch.updates.push(...updates);
  }

  schedulePendingDeltaFlush(set, get);
}

