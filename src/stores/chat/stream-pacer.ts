import { buildFinalMessageCommitPatch } from './finalize-helpers';
import { requestFinalHistoryRefresh } from './final-history-refresh';
import { reduceRuntimeOverlay } from './overlay-reducer';
import type { ActiveStreamRuntime, ChatStoreState, RawMessage, ToolStatus } from './types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface PendingFinalCommit {
  finalMessage: RawMessage;
  messageId: string;
  updates: ToolStatus[];
  onBeginFinalToHistory: () => void;
}

type ScheduledFrameHandle =
  | { kind: 'raf'; id: number }
  | { kind: 'timeout'; id: ReturnType<typeof setTimeout> };

let activeFrameHandle: ScheduledFrameHandle | null = null;
let lastFrameAt = 0;
const pendingFinalCommitByRuntimeKey = new Map<string, PendingFinalCommit>();

function buildRuntimeKey(sessionKey: string, runId: string | null | undefined): string {
  return `${sessionKey}::${typeof runId === 'string' ? runId.trim() : ''}`;
}

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

function getRuntimeText(runtime: ActiveStreamRuntime): string {
  if (runtime.chunks.length === 0) {
    return '';
  }
  if (runtime.chunks.length === 1) {
    return runtime.chunks[0] ?? '';
  }
  return runtime.chunks.join('');
}

function buildVisibleText(runtime: ActiveStreamRuntime, displayedChars: number): string {
  if (displayedChars <= 0 || runtime.chunks.length === 0) {
    return '';
  }
  let remaining = displayedChars;
  let text = '';
  for (const chunk of runtime.chunks) {
    if (remaining <= 0) {
      break;
    }
    if (chunk.length <= remaining) {
      text += chunk;
      remaining -= chunk.length;
      continue;
    }
    text += chunk.slice(0, remaining);
    break;
  }
  return text;
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

function resolveNextDisplayedChars(runtime: ActiveStreamRuntime, frameElapsedMs: number): number {
  const remaining = Math.max(0, runtime.rawChars - runtime.displayedChars);
  if (remaining <= 0) {
    return runtime.displayedChars;
  }
  const draining = runtime.status !== 'streaming';
  const backlog = remaining;
  const perSecond = draining
    ? (backlog > 800 ? 14_000 : 8_000)
    : (backlog > 1500 ? 9_000 : backlog > 500 ? 5_000 : 2_400);
  const minStep = draining ? 80 : 18;
  const maxStep = draining ? 360 : (backlog > 1500 ? 220 : backlog > 500 ? 120 : 56);
  const rawStep = Math.round((perSecond * Math.max(16, frameElapsedMs)) / 1000);
  const desiredStep = Math.min(remaining, Math.max(minStep, Math.min(maxStep, rawStep)));
  const text = getRuntimeText(runtime);
  const target = Math.min(text.length, runtime.displayedChars + desiredStep);
  return resolveChunkBoundary(text, runtime.displayedChars, target);
}

function buildStreamViewMessage(
  runtime: ActiveStreamRuntime,
  state: ChatStoreState,
  pendingFinalCommit: PendingFinalCommit | null,
): RawMessage | null {
  const content = buildVisibleText(runtime, runtime.displayedChars);
  if (!content && state.streamingTools.length === 0) {
    return null;
  }
  return {
    id: pendingFinalCommit?.messageId ?? `stream:${runtime.sessionKey}:${runtime.runId}`,
    role: 'assistant',
    content,
    timestamp: state.lastUserMessageAt != null ? (state.lastUserMessageAt / 1000) : (Date.now() / 1000),
  };
}

function clearPendingFinalCommit(state: ChatStoreState): void {
  if (!state.streamRuntime) {
    return;
  }
  pendingFinalCommitByRuntimeKey.delete(buildRuntimeKey(state.streamRuntime.sessionKey, state.streamRuntime.runId));
}

function resolvePendingFinalCommit(state: ChatStoreState): PendingFinalCommit | null {
  if (!state.streamRuntime) {
    return null;
  }
  return pendingFinalCommitByRuntimeKey.get(
    buildRuntimeKey(state.streamRuntime.sessionKey, state.streamRuntime.runId),
  ) ?? null;
}

function setScheduledRafId(set: ChatStoreSetFn, get: ChatStoreGetFn, rafId: number | null): void {
  if (get().streamRuntime?.rafId === rafId) {
    return;
  }
  set((state) => reduceRuntimeOverlay(state, {
    type: 'stream_scheduler_updated',
    rafId,
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

function commitPendingFinal(set: ChatStoreSetFn, get: ChatStoreGetFn): void {
  const state = get();
  const pendingCommit = resolvePendingFinalCommit(state);
  if (!pendingCommit) {
    return;
  }
  set((current) => buildFinalMessageCommitPatch({
    state: current,
    finalMessage: pendingCommit.finalMessage,
    messageId: pendingCommit.messageId,
    updates: pendingCommit.updates,
    hasOutput: true,
    toolOnly: false,
  }));
  clearPendingFinalCommit(state);
  requestFinalHistoryRefresh(set, get, pendingCommit.onBeginFinalToHistory);
}

function shouldSchedule(state: ChatStoreState): boolean {
  if (!state.streamRuntime || !state.sending) {
    return false;
  }
  if (state.streamRuntime.displayedChars < state.streamRuntime.rawChars) {
    return true;
  }
  return resolvePendingFinalCommit(state) != null;
}

function runTick(set: ChatStoreSetFn, get: ChatStoreGetFn): void {
  activeFrameHandle = null;
  setScheduledRafId(set, get, null);
  const state = get();
  const runtime = state.streamRuntime;
  if (!runtime) {
    return;
  }

  const pendingFinalCommit = resolvePendingFinalCommit(state);
  if (runtime.displayedChars >= runtime.rawChars) {
    if (pendingFinalCommit) {
      commitPendingFinal(set, get);
    }
    return;
  }

  const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
  const frameElapsedMs = lastFrameAt > 0 ? Math.max(16, now - lastFrameAt) : 16;
  lastFrameAt = now;

  const nextDisplayedChars = resolveNextDisplayedChars(runtime, frameElapsedMs);
  if (nextDisplayedChars <= runtime.displayedChars) {
    return;
  }

  const nextStatus = nextDisplayedChars >= runtime.rawChars && pendingFinalCommit
    ? 'finalizing'
    : runtime.status;
  const nextRuntime: ActiveStreamRuntime = {
    ...runtime,
    displayedChars: nextDisplayedChars,
    status: nextStatus,
    rafId: null,
  };
  set((current) => reduceRuntimeOverlay(current, {
    type: 'stream_view_advanced',
    message: buildStreamViewMessage(nextRuntime, current, pendingFinalCommit),
    displayedChars: nextDisplayedChars,
    status: nextStatus,
    rafId: null,
  }));

  const afterAdvance = get();
  if (afterAdvance.streamRuntime && afterAdvance.streamRuntime.displayedChars >= afterAdvance.streamRuntime.rawChars) {
    if (resolvePendingFinalCommit(afterAdvance)) {
      commitPendingFinal(set, get);
    }
  }
}

export function queuePendingStreamFinalCommit(
  sessionKey: string,
  runId: string | null | undefined,
  pendingFinalCommit: PendingFinalCommit,
): void {
  pendingFinalCommitByRuntimeKey.set(buildRuntimeKey(sessionKey, runId), pendingFinalCommit);
}

export function clearPendingStreamFinalCommit(
  sessionKey: string,
  runId: string | null | undefined,
): void {
  pendingFinalCommitByRuntimeKey.delete(buildRuntimeKey(sessionKey, runId));
}

export function syncActiveStreamPacer(set: ChatStoreSetFn, get: ChatStoreGetFn): void {
  const state = get();
  if (!shouldSchedule(state)) {
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
  pendingFinalCommitByRuntimeKey.clear();
}
