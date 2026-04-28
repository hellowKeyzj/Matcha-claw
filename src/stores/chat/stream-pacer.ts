import { reduceRuntimeOverlay } from './overlay-reducer';
import {
  getSessionViewportState,
  getSessionRuntime,
  patchSessionRecord,
  patchSessionViewportState,
} from './store-state-helpers';
import { selectStreamingRenderMessage } from './stream-overlay-message';
import type {
  AssistantMessageOverlay,
  ChatSessionRuntimeState,
  ChatStoreState,
} from './types';
import { upsertViewportMessage } from './viewport-state';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

type ScheduledFrameHandle =
  | { kind: 'raf'; id: number }
  | { kind: 'timeout'; id: ReturnType<typeof setTimeout> };

let activeFrameHandle: ScheduledFrameHandle | null = null;
let lastFrameAt = 0;

function scheduleFrame(task: () => void): ScheduledFrameHandle {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return { kind: 'raf', id: window.requestAnimationFrame(() => task()) };
  }
  return { kind: 'timeout', id: setTimeout(task, 16) };
}

function cancelFrame(handle: ScheduledFrameHandle): void {
  if (handle.kind === 'raf' && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(handle.id);
    return;
  }
  clearTimeout(handle.id);
}

function resolveChunkBoundary(text: string, start: number, limit: number): number {
  const max = Math.min(text.length, limit);
  if (max <= start) {
    return start;
  }
  const min = Math.min(text.length, Math.max(start + 1, start + 12));
  for (let index = max; index >= min; index -= 1) {
    const previous = text[index - 1];
    const next = text[index] ?? '';
    if (
      /\s/.test(previous)
      || /[，。！？；：、,.!?;:\)\]\}]/.test(previous)
      || previous === '\n'
      || (previous === '`' && next === '`')
      || (previous === '#' && (index === start + 1 || text[index - 2] === '\n'))
    ) {
      return index;
    }
  }
  return max;
}

function resolveNextCommittedText(overlay: AssistantMessageOverlay, frameElapsedMs: number): string {
  const remaining = Math.max(0, overlay.targetText.length - overlay.committedText.length);
  if (remaining <= 0) {
    return overlay.committedText;
  }
  const finalizing = overlay.status === 'finalizing';
  const backlog = remaining;
  const perSecond = finalizing
    ? (backlog > 800 ? 14_000 : 8_000)
    : (backlog > 1500 ? 9_000 : backlog > 500 ? 5_000 : 2_400);
  const minStep = finalizing ? 80 : 18;
  const maxStep = finalizing ? 360 : (backlog > 1500 ? 220 : backlog > 500 ? 120 : 56);
  const rawStep = Math.round((perSecond * Math.max(16, frameElapsedMs)) / 1000);
  const desiredStep = Math.min(remaining, Math.max(minStep, Math.min(maxStep, rawStep)));
  const targetIndex = resolveChunkBoundary(
    overlay.targetText,
    overlay.committedText.length,
    overlay.committedText.length + desiredStep,
  );
  return overlay.targetText.slice(0, targetIndex);
}

function setScheduledRafId(set: ChatStoreSetFn, get: ChatStoreGetFn, rafId: number | null): void {
  const state = get();
  const sessionKey = state.currentSessionKey;
  const runtime = getSessionRuntime(state, sessionKey);
  if (runtime.assistantOverlay?.rafId === rafId) {
    return;
  }
  const runtimePatch = reduceRuntimeOverlay(runtime, { type: 'stream_scheduler_updated', rafId });
  if (runtimePatch === runtime) {
    return;
  }
  set((current) => ({
    sessionsByKey: patchSessionRecord(current, sessionKey, {
      runtime: {
        ...runtime,
        ...runtimePatch,
      },
    }),
  }));
}

function clearActiveFrame(set?: ChatStoreSetFn, get?: ChatStoreGetFn): void {
  if (!activeFrameHandle) {
    return;
  }
  cancelFrame(activeFrameHandle);
  activeFrameHandle = null;
  if (set && get) {
    setScheduledRafId(set, get, null);
  }
}

function shouldSchedule(runtime: ChatSessionRuntimeState): boolean {
  const overlay = runtime.assistantOverlay;
  return Boolean(
    overlay
    && runtime.sending
    && overlay.committedText.length < overlay.targetText.length,
  );
}

function runTick(set: ChatStoreSetFn, get: ChatStoreGetFn): void {
  activeFrameHandle = null;
  setScheduledRafId(set, get, null);
  const state = get();
  const sessionKey = state.currentSessionKey;
  const currentRuntime = getSessionRuntime(state, sessionKey);
  const overlay = currentRuntime.assistantOverlay;
  if (!overlay) {
    return;
  }
  if (overlay.committedText.length >= overlay.targetText.length) {
    return;
  }

  const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
  const frameElapsedMs = lastFrameAt > 0 ? Math.max(16, now - lastFrameAt) : 16;
  lastFrameAt = now;

  const nextCommittedText = resolveNextCommittedText(overlay, frameElapsedMs);
  if (nextCommittedText.length <= overlay.committedText.length) {
    return;
  }

  const runtimePatch = reduceRuntimeOverlay(currentRuntime, {
    type: 'stream_view_advanced',
    committedText: nextCommittedText,
    status: overlay.status,
    rafId: null,
  });
  if (runtimePatch !== currentRuntime) {
    const nextRuntime = {
      ...currentRuntime,
      ...runtimePatch,
    };
    const streamingMessage = selectStreamingRenderMessage(nextRuntime);
    set((current) => ({
      sessionsByKey: patchSessionRecord(current, sessionKey, {
        runtime: {
          ...nextRuntime,
        },
      }),
      ...(streamingMessage
        ? {
            viewportBySession: patchSessionViewportState(
              current,
              sessionKey,
              upsertViewportMessage(
                getSessionViewportState(current, sessionKey),
                streamingMessage,
              ),
            ),
          }
        : {}),
    }));
  }
}

export function syncActiveStreamPacer(set: ChatStoreSetFn, get: ChatStoreGetFn): void {
  const state = get();
  const runtime = getSessionRuntime(state, state.currentSessionKey);
  if (!shouldSchedule(runtime)) {
    clearActiveFrame(set, get);
    lastFrameAt = 0;
    return;
  }
  if (activeFrameHandle) {
    return;
  }
  activeFrameHandle = scheduleFrame(() => {
    runTick(set, get);
    syncActiveStreamPacer(set, get);
  });
  const rafId = activeFrameHandle.kind === 'raf' ? activeFrameHandle.id : null;
  setScheduledRafId(set, get, rafId);
}

export function disposeActiveStreamPacer(set?: ChatStoreSetFn, get?: ChatStoreGetFn): void {
  clearActiveFrame(set, get);
  lastFrameAt = 0;
}
