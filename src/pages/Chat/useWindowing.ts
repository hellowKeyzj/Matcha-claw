import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useChatStore, type RawMessage } from '@/stores/chat';
import { trackUiEvent } from '@/lib/telemetry';
import { isRenderableChatMessage, type ChatRow } from './chat-row-model';

const CHAT_FIRST_PAINT_RENDERABLE_LIMIT = 8;
const CHAT_FIRST_PAINT_CONTENT_BUDGET = 7600;
const CHAT_RENDER_WINDOW_CONTENT_DENSITY_PER_ROW = CHAT_FIRST_PAINT_CONTENT_BUDGET / CHAT_FIRST_PAINT_RENDERABLE_LIMIT;
const SESSION_RENDER_WINDOW_MAX_SESSIONS = 40;
const SESSION_RENDER_WINDOW_EXPAND_STEP = 40;
const SESSION_RENDER_WINDOW_EXPAND_CONTENT_BUDGET_STEP = 5200;
const SESSION_RENDER_WINDOW_PREHEADROOM_BASE_PX = 320;
const SESSION_RENDER_WINDOW_PREHEADROOM_MIN_PX = 280;
const SESSION_RENDER_WINDOW_PREHEADROOM_MAX_PX = 1400;
const SESSION_RENDER_WINDOW_PREHEADROOM_LOOKAHEAD_MS = 260;
const SESSION_RENDER_WINDOW_PREHEADROOM_MIN_ROWS = 3.2;
const SESSION_RENDER_WINDOW_PREHEADROOM_VELOCITY_ALPHA = 0.4;
const SESSION_RENDER_WINDOW_PREHEADROOM_VELOCITY_IDLE_MS = 240;
const SESSION_RENDER_WINDOW_UNDERFILL_EPSILON_PX = 2;
const SESSION_RENDER_WINDOW_UNDERFILL_MIN_GAP_PX = 56;
const SESSION_RENDER_WINDOW_TOP_EXPAND_STEP_MIN = 6;
const SESSION_RENDER_WINDOW_TOP_EXPAND_STEP_MAX = 48;
const SESSION_RENDER_WINDOW_UNDERFILL_EXPAND_STEP_MIN = 4;
const SESSION_RENDER_WINDOW_UNDERFILL_EXPAND_STEP_MAX = 28;
const SESSION_RENDER_WINDOW_TOP_EXPAND_VIEWPORT_RESERVE = 0.85;
const SESSION_RENDER_WINDOW_UNDERFILL_EXPAND_VIEWPORT_RESERVE = 0.35;
const SESSION_RENDER_WINDOW_BUDGET_MIN_CONTENT_STEP = 900;
const SESSION_RENDER_WINDOW_BUDGET_MAX_CONTENT_STEP = 7600;
const SESSION_RENDER_WINDOW_FRAME_BUDGET_BASE_MS = 6;
const SESSION_RENDER_WINDOW_FRAME_BUDGET_MIN_MS = 3.5;
const SESSION_RENDER_WINDOW_FRAME_BUDGET_MAX_MS = 11;
const SESSION_RENDER_WINDOW_FRAME_BUDGET_PRESSURE_HIGH = 1.05;
const SESSION_RENDER_WINDOW_FRAME_BUDGET_PRESSURE_LOW = 0.55;
const SESSION_RENDER_WINDOW_FRAME_BUDGET_EMA_ALPHA = 0.32;
const SESSION_RENDER_WINDOW_FRAME_BUDGET_STEP_MULTIPLIER_MAX = 1.4;
const SESSION_RENDER_WINDOW_FRAME_BUDGET_STEP_MULTIPLIER_MIN = 0.45;
const SESSION_RENDER_WINDOW_MESSAGE_BASE_COST = 180;
const SESSION_RENDER_WINDOW_MESSAGE_TEXT_LINE_COST = 26;
const SESSION_RENDER_WINDOW_MESSAGE_TEXT_CHAR_COST = 5;
const SESSION_RENDER_WINDOW_MESSAGE_TEXT_CHAR_UNIT = 18;
const SESSION_RENDER_WINDOW_MESSAGE_IMAGE_BLOCK_COST = 980;
const SESSION_RENDER_WINDOW_MESSAGE_TOOL_BLOCK_COST = 520;
const SESSION_RENDER_WINDOW_MESSAGE_ATTACHMENT_COST = 320;
const SESSION_RENDER_WINDOW_MESSAGE_COST_MIN = 120;
const SESSION_RENDER_WINDOW_MESSAGE_COST_MAX = 3600;
const PREPEND_COMPENSATION_MAX_FRAME_ATTEMPTS = 3;

type RenderWindowBudgetPhase = 'cold' | 'primed' | 'expanded' | 'steady';
export type RenderWindowExpandReason = 'top-headroom' | 'underfill';

export interface RenderWindowExpandCommand {
  requestedStep: number;
  reason: RenderWindowExpandReason;
  observedRenderCostMs: number;
}

interface RenderWindowSliceBudget {
  renderableLimit: number;
  contentBudget: number;
}

interface SessionRenderWindowBudgetState {
  phase: RenderWindowBudgetPhase;
  budget: RenderWindowSliceBudget;
  frameBudgetMs: number;
  emaRenderCostMs: number;
}

const globalSessionRenderWindowBudgetState = new Map<string, SessionRenderWindowBudgetState>();
const globalRenderWindowSliceCache = new WeakMap<RawMessage[], Map<string, RenderWindowSliceResult>>();

interface RenderWindowSliceResult {
  messages: RawMessage[];
  hasOlderRenderableMessages: boolean;
}

type PrependWindowTxn =
  | { phase: 'idle' }
  | {
    phase: 'scheduled';
    id: number;
    sessionKey: string;
    rowKey: string;
    rowOffsetPx: number;
    previousScrollTop: number;
    previousScrollHeight: number;
  };

interface PreparedPrependWindowTxn {
  sessionKey: string;
  rowKey: string;
  rowOffsetPx: number;
  previousScrollTop: number;
  previousScrollHeight: number;
}

interface ExpandWindowWritePlan {
  reason: RenderWindowExpandReason;
  sessionKey: string;
  averageRowPx: number;
  topBudgetPx: number;
  rowsAboveViewport: number;
  viewportClientHeight: number;
  viewportScrollHeight: number;
  shouldExpand: boolean;
  shouldRequeueTopHeadroom: boolean;
  preparedPrependWindowTxn: PreparedPrependWindowTxn | null;
}

interface UseChatWindowSliceInput {
  currentSessionKey: string;
  messages: RawMessage[];
}

interface UseChatWindowSliceResult {
  rowSourceMessages: RawMessage[];
  hasOlderRenderableRows: boolean;
  rowSliceCostMs: number;
  increaseRenderableWindowLimit: (sessionKey: string, command: RenderWindowExpandCommand) => void;
}

interface ChatVirtualItemLike {
  index: number;
  start: number;
  size: number;
}

interface ChatVirtualizerLike {
  getVirtualItems: () => ChatVirtualItemLike[];
  getOffsetForIndex: (
    index: number,
    align?: 'start' | 'center' | 'end' | 'auto',
  ) => readonly [number, 'auto' | 'start' | 'center' | 'end'] | undefined;
  scrollToOffset: (toOffset: number, options?: { align?: 'start' | 'center' | 'end' | 'auto'; behavior?: 'auto' | 'smooth' | 'instant' }) => void;
}

interface UseChatWindowExpandInput {
  currentSessionKey: string;
  chatRows: ChatRow[];
  hasOlderRenderableRows: boolean;
  messageVirtualizer: ChatVirtualizerLike;
  messagesViewportRef: RefObject<HTMLDivElement | null>;
  scrollMode: string;
  scrollCommandType: string;
  runtimeRowsCostMs: number;
  handleViewportScroll: () => void;
  markScrollActivity: () => void;
  increaseRenderableWindowLimit: (sessionKey: string, command: RenderWindowExpandCommand) => void;
}

interface UseChatWindowExpandResult {
  handleViewportScrollWithWindowing: () => void;
  handleViewportWheelWithWindowing: () => void;
}

type ScheduledFrameHandle =
  | { kind: 'raf'; id: number }
  | { kind: 'timeout'; id: ReturnType<typeof setTimeout> };

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 100) / 100;
}

function scheduleFrame(task: () => void): ScheduledFrameHandle {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return { kind: 'raf', id: window.requestAnimationFrame(() => task()) };
  }
  return { kind: 'timeout', id: setTimeout(task, 16) };
}

function measureAverageVisibleRowPx(visibleItems: ChatVirtualItemLike[]): number {
  if (visibleItems.length === 0) {
    return 140;
  }
  let total = 0;
  for (const item of visibleItems) {
    total += item.size;
  }
  const average = total / visibleItems.length;
  return clampNumber(average, 72, 420);
}

interface ResolveExpandStepInput {
  reason: RenderWindowExpandReason;
  averageRowPx: number;
  topBudgetPx: number;
  rowsAboveViewport?: number;
  viewportClientHeight: number;
  viewportScrollHeight: number;
}

function resolveTopHeadroomTargetRows(input: {
  topBudgetPx: number;
  viewportClientHeight: number;
  normalizedRowPx: number;
}): number {
  const targetHeadroomPx = input.topBudgetPx + Math.max(
    input.viewportClientHeight * SESSION_RENDER_WINDOW_TOP_EXPAND_VIEWPORT_RESERVE,
    input.normalizedRowPx * 2,
  );
  return Math.ceil(targetHeadroomPx / input.normalizedRowPx);
}

function resolveViewportTopRowIndex(
  visibleItems: ChatVirtualItemLike[],
  viewportScrollTop: number,
): number {
  if (visibleItems.length === 0) {
    return 0;
  }
  const topItem = visibleItems.find((item) => (
    item.start <= viewportScrollTop
    && (item.start + item.size) > viewportScrollTop
  ));
  if (topItem) {
    return Math.max(0, topItem.index);
  }
  return Math.max(0, visibleItems[0].index);
}

export function resolveRenderableWindowExpandStep(input: ResolveExpandStepInput): number {
  const {
    reason,
    averageRowPx,
    topBudgetPx,
    rowsAboveViewport,
    viewportClientHeight,
    viewportScrollHeight,
  } = input;
  const normalizedRowPx = clampNumber(averageRowPx, 72, 420);
  if (reason === 'top-headroom') {
    const targetHeadroomRows = resolveTopHeadroomTargetRows({
      topBudgetPx,
      viewportClientHeight,
      normalizedRowPx,
    });
    const currentRowsAboveViewport = Math.max(0, Math.floor(rowsAboveViewport ?? 0));
    const missingRows = Math.max(0, targetHeadroomRows - currentRowsAboveViewport);
    const prewarmRows = Math.max(
      SESSION_RENDER_WINDOW_TOP_EXPAND_STEP_MIN,
      Math.ceil(targetHeadroomRows * 0.25),
    );
    const requestedRows = missingRows + prewarmRows;
    return Math.floor(clampNumber(
      requestedRows,
      SESSION_RENDER_WINDOW_TOP_EXPAND_STEP_MIN,
      SESSION_RENDER_WINDOW_TOP_EXPAND_STEP_MAX,
    ));
  }

  const underfillGapPx = Math.max(0, viewportClientHeight - viewportScrollHeight);
  const targetFillPx = underfillGapPx + Math.max(
    viewportClientHeight * SESSION_RENDER_WINDOW_UNDERFILL_EXPAND_VIEWPORT_RESERVE,
    normalizedRowPx * 2,
  );
  return Math.floor(clampNumber(
    Math.ceil(targetFillPx / normalizedRowPx),
    SESSION_RENDER_WINDOW_UNDERFILL_EXPAND_STEP_MIN,
    SESSION_RENDER_WINDOW_UNDERFILL_EXPAND_STEP_MAX,
  ));
}

function cancelScheduledFrame(handle: ScheduledFrameHandle): void {
  if (handle.kind === 'raf' && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(handle.id);
    return;
  }
  clearTimeout(handle.id);
}

function createSessionRenderWindowBudgetState(
  phase: RenderWindowBudgetPhase = 'cold',
): SessionRenderWindowBudgetState {
  return {
    phase,
    budget: {
      renderableLimit: CHAT_FIRST_PAINT_RENDERABLE_LIMIT,
      contentBudget: CHAT_FIRST_PAINT_CONTENT_BUDGET,
    },
    frameBudgetMs: SESSION_RENDER_WINDOW_FRAME_BUDGET_BASE_MS,
    emaRenderCostMs: 0,
  };
}

function normalizeRenderWindowSliceBudget(
  input: RenderWindowSliceBudget,
): RenderWindowSliceBudget {
  const normalizedRenderableLimit = Math.max(1, Math.floor(input.renderableLimit));
  const normalizedContentBudget = Math.max(1, Math.floor(input.contentBudget));
  const contentBudgetFloorByRenderableLimit = Math.floor(
    normalizedRenderableLimit * CHAT_RENDER_WINDOW_CONTENT_DENSITY_PER_ROW,
  );
  return {
    renderableLimit: normalizedRenderableLimit,
    contentBudget: Math.max(normalizedContentBudget, contentBudgetFloorByRenderableLimit),
  };
}

function getSessionRenderWindowBudgetState(sessionKey: string): SessionRenderWindowBudgetState {
  const cached = globalSessionRenderWindowBudgetState.get(sessionKey);
  if (cached) {
    return cached;
  }
  return createSessionRenderWindowBudgetState('cold');
}

function updateSessionRenderWindowBudgetState(
  sessionKey: string,
  nextState: SessionRenderWindowBudgetState,
): void {
  if (globalSessionRenderWindowBudgetState.has(sessionKey)) {
    globalSessionRenderWindowBudgetState.delete(sessionKey);
  }
  globalSessionRenderWindowBudgetState.set(sessionKey, nextState);
  while (globalSessionRenderWindowBudgetState.size > SESSION_RENDER_WINDOW_MAX_SESSIONS) {
    const oldestKey = globalSessionRenderWindowBudgetState.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    globalSessionRenderWindowBudgetState.delete(oldestKey);
  }
}

function estimateRenderableTextCost(text: string): number {
  if (!text) {
    return 0;
  }
  const logicalLines = Math.max(1, text.split(/\r?\n/).length);
  const wrappedLines = Math.max(1, Math.ceil(text.length / 72));
  const effectiveLines = Math.max(logicalLines, wrappedLines);
  return (
    (effectiveLines * SESSION_RENDER_WINDOW_MESSAGE_TEXT_LINE_COST)
    + (Math.ceil(text.length / SESSION_RENDER_WINDOW_MESSAGE_TEXT_CHAR_UNIT) * SESSION_RENDER_WINDOW_MESSAGE_TEXT_CHAR_COST)
  );
}

function estimateRenderableMessageCost(message: RawMessage): number {
  let textCost = 0;
  let imageBlockCount = 0;
  let toolBlockCount = 0;
  const { content } = message;
  if (typeof content === 'string') {
    textCost += estimateRenderableTextCost(content);
  } else if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      const type = typeof block.type === 'string' ? block.type : '';
      if (type === 'text' && typeof block.text === 'string') {
        textCost += estimateRenderableTextCost(block.text);
        continue;
      }
      if (type === 'thinking' && typeof block.thinking === 'string') {
        textCost += Math.floor(estimateRenderableTextCost(block.thinking) * 0.7);
        continue;
      }
      if (type === 'image') {
        imageBlockCount += 1;
        continue;
      }
      if (type === 'tool_use' || type === 'toolCall' || type === 'tool_result' || type === 'toolResult') {
        toolBlockCount += 1;
        continue;
      }
      if (typeof block.text === 'string') {
        textCost += estimateRenderableTextCost(block.text);
      }
    }
  }
  const attachmentCount = Array.isArray(message._attachedFiles)
    ? message._attachedFiles.length
    : 0;
  return Math.floor(clampNumber(
    SESSION_RENDER_WINDOW_MESSAGE_BASE_COST
      + textCost
      + (imageBlockCount * SESSION_RENDER_WINDOW_MESSAGE_IMAGE_BLOCK_COST)
      + (toolBlockCount * SESSION_RENDER_WINDOW_MESSAGE_TOOL_BLOCK_COST)
      + (attachmentCount * SESSION_RENDER_WINDOW_MESSAGE_ATTACHMENT_COST),
    SESSION_RENDER_WINDOW_MESSAGE_COST_MIN,
    SESSION_RENDER_WINDOW_MESSAGE_COST_MAX,
  ));
}

export function advanceSessionRenderWindowBudgetState(
  previous: SessionRenderWindowBudgetState,
  command: RenderWindowExpandCommand,
): SessionRenderWindowBudgetState {
  const normalizedStep = Math.max(1, Math.floor(command.requestedStep));
  const observedCostMs = Number.isFinite(command.observedRenderCostMs) && command.observedRenderCostMs > 0
    ? Math.max(0.1, command.observedRenderCostMs)
    : 0;
  const nextEmaRenderCostMs = observedCostMs > 0
    ? (
      previous.emaRenderCostMs > 0
        ? (
          (previous.emaRenderCostMs * (1 - SESSION_RENDER_WINDOW_FRAME_BUDGET_EMA_ALPHA))
          + (observedCostMs * SESSION_RENDER_WINDOW_FRAME_BUDGET_EMA_ALPHA)
        )
        : observedCostMs
    )
    : previous.emaRenderCostMs;
  const pressureCostMs = nextEmaRenderCostMs > 0
    ? nextEmaRenderCostMs
    : (observedCostMs > 0 ? observedCostMs : previous.frameBudgetMs);
  const pressureRatio = pressureCostMs / Math.max(0.1, previous.frameBudgetMs);

  const normalizedPressure = clampNumber(
    (pressureRatio - SESSION_RENDER_WINDOW_FRAME_BUDGET_PRESSURE_LOW)
    / Math.max(0.01, SESSION_RENDER_WINDOW_FRAME_BUDGET_PRESSURE_HIGH - SESSION_RENDER_WINDOW_FRAME_BUDGET_PRESSURE_LOW),
    0,
    1,
  );
  const stepMultiplier = clampNumber(
    SESSION_RENDER_WINDOW_FRAME_BUDGET_STEP_MULTIPLIER_MAX
      - (normalizedPressure * (SESSION_RENDER_WINDOW_FRAME_BUDGET_STEP_MULTIPLIER_MAX - SESSION_RENDER_WINDOW_FRAME_BUDGET_STEP_MULTIPLIER_MIN)),
    SESSION_RENDER_WINDOW_FRAME_BUDGET_STEP_MULTIPLIER_MIN,
    SESSION_RENDER_WINDOW_FRAME_BUDGET_STEP_MULTIPLIER_MAX,
  );
  const adjustedStep = Math.max(1, Math.floor(normalizedStep * stepMultiplier));

  let nextFrameBudgetMs = previous.frameBudgetMs;
  if (pressureRatio >= SESSION_RENDER_WINDOW_FRAME_BUDGET_PRESSURE_HIGH) {
    nextFrameBudgetMs = Math.max(
      SESSION_RENDER_WINDOW_FRAME_BUDGET_MIN_MS,
      previous.frameBudgetMs * 0.92,
    );
  } else if (pressureRatio <= SESSION_RENDER_WINDOW_FRAME_BUDGET_PRESSURE_LOW) {
    nextFrameBudgetMs = Math.min(
      SESSION_RENDER_WINDOW_FRAME_BUDGET_MAX_MS,
      previous.frameBudgetMs * 1.06,
    );
  }

  const contentStep = Math.floor(clampNumber(
    (adjustedStep / SESSION_RENDER_WINDOW_EXPAND_STEP) * SESSION_RENDER_WINDOW_EXPAND_CONTENT_BUDGET_STEP,
    SESSION_RENDER_WINDOW_BUDGET_MIN_CONTENT_STEP,
    SESSION_RENDER_WINDOW_BUDGET_MAX_CONTENT_STEP,
  ));

  const nextPhase: RenderWindowBudgetPhase = previous.phase === 'cold'
    ? 'primed'
    : (previous.phase === 'primed' ? 'expanded' : 'steady');

  return {
    phase: nextPhase,
    budget: {
      renderableLimit: Math.max(
        CHAT_FIRST_PAINT_RENDERABLE_LIMIT,
        previous.budget.renderableLimit + adjustedStep,
      ),
      contentBudget: Math.max(
        CHAT_FIRST_PAINT_CONTENT_BUDGET,
        previous.budget.contentBudget + contentStep,
      ),
    },
    frameBudgetMs: clampNumber(
      nextFrameBudgetMs,
      SESSION_RENDER_WINDOW_FRAME_BUDGET_MIN_MS,
      SESSION_RENDER_WINDOW_FRAME_BUDGET_MAX_MS,
    ),
    emaRenderCostMs: nextEmaRenderCostMs,
  };
}

export function sliceMessagesForFirstPaint(
  messages: RawMessage[],
  renderWindowBudgetInput: RenderWindowSliceBudget,
): RenderWindowSliceResult {
  if (messages.length === 0) {
    return { messages, hasOlderRenderableMessages: false };
  }
  const renderWindowBudget = normalizeRenderWindowSliceBudget(renderWindowBudgetInput);
  let renderableCount = 0;
  let renderableCost = 0;
  let startIndex = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRenderableChatMessage(message)) {
      continue;
    }
    const nextCost = estimateRenderableMessageCost(message);
    const nextRenderableCount = renderableCount + 1;
    const nextRenderableCost = renderableCost + nextCost;
    const overCountBudget = nextRenderableCount > renderWindowBudget.renderableLimit;
    const overContentBudget = nextRenderableCost > renderWindowBudget.contentBudget && renderableCount > 0;
    if (overCountBudget || overContentBudget) {
      break;
    }
    startIndex = index;
    renderableCount = nextRenderableCount;
    renderableCost = nextRenderableCost;
    if (
      renderableCount >= renderWindowBudget.renderableLimit
      || renderableCost >= renderWindowBudget.contentBudget
    ) {
      break;
    }
  }
  if (startIndex <= 0 || startIndex === messages.length) {
    return { messages, hasOlderRenderableMessages: false };
  }
  let hasOlderRenderableMessages = false;
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    if (!isRenderableChatMessage(messages[index])) {
      continue;
    }
    hasOlderRenderableMessages = true;
    break;
  }
  return {
    messages: messages.slice(startIndex),
    hasOlderRenderableMessages,
  };
}

function getCachedRenderWindowSlice(
  messages: RawMessage[],
  renderWindowBudgetInput: RenderWindowSliceBudget,
): RenderWindowSliceResult {
  if (messages.length === 0) {
    return { messages, hasOlderRenderableMessages: false };
  }
  const normalizedBudget = normalizeRenderWindowSliceBudget(renderWindowBudgetInput);
  const cacheKey = `${normalizedBudget.renderableLimit}:${normalizedBudget.contentBudget}`;
  const byLimit = globalRenderWindowSliceCache.get(messages);
  const cached = byLimit?.get(cacheKey);
  if (cached) {
    return cached;
  }
  const computed = sliceMessagesForFirstPaint(messages, normalizedBudget);
  if (byLimit) {
    byLimit.set(cacheKey, computed);
  } else {
    globalRenderWindowSliceCache.set(messages, new Map([[cacheKey, computed]]));
  }
  return computed;
}

export function useChatWindowSlice(
  input: UseChatWindowSliceInput,
): UseChatWindowSliceResult {
  const {
    currentSessionKey,
    messages,
  } = input;
  const [, setRenderWindowVersion] = useState(0);
  const [initializedSessionKey, setInitializedSessionKey] = useState<string | null>(null);

  const isSessionWindowBudgetFirstPass = initializedSessionKey !== currentSessionKey;
  const sessionRenderWindowBudget = isSessionWindowBudgetFirstPass
    ? createSessionRenderWindowBudgetState('cold')
    : getSessionRenderWindowBudgetState(currentSessionKey);

  const renderWindowResult = useMemo(
    () => {
      const startedAt = nowMs();
      const slice = getCachedRenderWindowSlice(messages, sessionRenderWindowBudget.budget);
      return {
        slice,
        rowSliceCostMs: Math.max(0, nowMs() - startedAt),
      };
    },
    [messages, sessionRenderWindowBudget.budget.contentBudget, sessionRenderWindowBudget.budget.renderableLimit],
  );

  useEffect(() => {
    setInitializedSessionKey(currentSessionKey);
    updateSessionRenderWindowBudgetState(
      currentSessionKey,
      createSessionRenderWindowBudgetState('primed'),
    );
  }, [currentSessionKey]);

  useEffect(() => {
    return () => {
      globalSessionRenderWindowBudgetState.clear();
    };
  }, []);

  const increaseRenderableWindowLimit = useCallback((sessionKey: string, command: RenderWindowExpandCommand) => {
    const currentBudgetState = getSessionRenderWindowBudgetState(sessionKey);
    const nextBudgetState = advanceSessionRenderWindowBudgetState(currentBudgetState, command);
    updateSessionRenderWindowBudgetState(sessionKey, nextBudgetState);
    trackUiEvent('chat.render_window_budget_advance', {
      sessionKey,
      reason: command.reason,
      phaseBefore: currentBudgetState.phase,
      phaseAfter: nextBudgetState.phase,
      requestedStep: Math.max(1, Math.floor(command.requestedStep)),
      observedRenderCostMs: roundMetric(command.observedRenderCostMs),
      frameBudgetMsBefore: roundMetric(currentBudgetState.frameBudgetMs),
      frameBudgetMsAfter: roundMetric(nextBudgetState.frameBudgetMs),
      emaRenderCostMsAfter: roundMetric(nextBudgetState.emaRenderCostMs),
      renderableLimitBefore: currentBudgetState.budget.renderableLimit,
      renderableLimitAfter: nextBudgetState.budget.renderableLimit,
      contentBudgetBefore: currentBudgetState.budget.contentBudget,
      contentBudgetAfter: nextBudgetState.budget.contentBudget,
    });
    setRenderWindowVersion((value) => value + 1);
  }, []);

  return {
    rowSourceMessages: renderWindowResult.slice.messages,
    hasOlderRenderableRows: renderWindowResult.slice.hasOlderRenderableMessages,
    rowSliceCostMs: renderWindowResult.rowSliceCostMs,
    increaseRenderableWindowLimit,
  };
}

export function useChatWindowExpand(
  input: UseChatWindowExpandInput,
): UseChatWindowExpandResult {
  const {
    currentSessionKey,
    chatRows,
    hasOlderRenderableRows,
    messageVirtualizer,
    messagesViewportRef,
    scrollMode,
    scrollCommandType,
    runtimeRowsCostMs,
    handleViewportScroll,
    markScrollActivity,
    increaseRenderableWindowLimit,
  } = input;

  const expandReadFrameRef = useRef<ScheduledFrameHandle | null>(null);
  const expandWriteFrameRef = useRef<ScheduledFrameHandle | null>(null);
  const pendingExpandWritePlanRef = useRef<ExpandWindowWritePlan | null>(null);
  const expandRequestReasonRef = useRef<RenderWindowExpandReason | null>(null);
  const underfillRequestQueuedRef = useRef(false);
  const flushExpandReadPhaseRef = useRef<() => void>(() => {});
  const flushExpandWritePhaseRef = useRef<() => void>(() => {});
  const prependWindowTxnRef = useRef<PrependWindowTxn>({ phase: 'idle' });
  const prependWindowTxnSeqRef = useRef(0);
  const prependCompensationFrameRef = useRef<ScheduledFrameHandle | null>(null);
  const lastUnderfillExpandRef = useRef<{ sessionKey: string; rowCount: number } | null>(null);
  const topPreheadroomBudgetRef = useRef(SESSION_RENDER_WINDOW_PREHEADROOM_BASE_PX);
  const upwardScrollVelocityRef = useRef(0);
  const lastScrollSampleRef = useRef<{ atMs: number; scrollTop: number } | null>(null);
  const currentSessionKeyRef = useRef(currentSessionKey);
  const chatRowsRef = useRef(chatRows);
  const hasOlderRenderableRowsRef = useRef(hasOlderRenderableRows);
  const scrollModeRef = useRef(scrollMode);
  const scrollCommandTypeRef = useRef(scrollCommandType);
  const runtimeRowsCostMsRef = useRef(runtimeRowsCostMs);

  useLayoutEffect(() => {
    currentSessionKeyRef.current = currentSessionKey;
    chatRowsRef.current = chatRows;
    hasOlderRenderableRowsRef.current = hasOlderRenderableRows;
    scrollModeRef.current = scrollMode;
    scrollCommandTypeRef.current = scrollCommandType;
    runtimeRowsCostMsRef.current = runtimeRowsCostMs;
  }, [
    chatRows,
    currentSessionKey,
    hasOlderRenderableRows,
    runtimeRowsCostMs,
    scrollCommandType,
    scrollMode,
  ]);

  const cancelExpandReadFrame = useCallback(() => {
    const frame = expandReadFrameRef.current;
    if (frame == null) {
      return;
    }
    cancelScheduledFrame(frame);
    expandReadFrameRef.current = null;
  }, []);

  const cancelExpandWriteFrame = useCallback(() => {
    const frame = expandWriteFrameRef.current;
    if (frame == null) {
      return;
    }
    cancelScheduledFrame(frame);
    expandWriteFrameRef.current = null;
  }, []);

  const cancelPrependCompensationFrame = useCallback(() => {
    const frame = prependCompensationFrameRef.current;
    if (frame == null) {
      return;
    }
    cancelScheduledFrame(frame);
    prependCompensationFrameRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      cancelExpandReadFrame();
      cancelExpandWriteFrame();
      cancelPrependCompensationFrame();
      expandRequestReasonRef.current = null;
      underfillRequestQueuedRef.current = false;
      pendingExpandWritePlanRef.current = null;
      prependWindowTxnRef.current = { phase: 'idle' };
      lastUnderfillExpandRef.current = null;
      topPreheadroomBudgetRef.current = SESSION_RENDER_WINDOW_PREHEADROOM_BASE_PX;
      upwardScrollVelocityRef.current = 0;
      lastScrollSampleRef.current = null;
    };
  }, [cancelExpandReadFrame, cancelExpandWriteFrame, cancelPrependCompensationFrame]);

  useEffect(() => {
    cancelExpandReadFrame();
    cancelExpandWriteFrame();
    cancelPrependCompensationFrame();
    expandRequestReasonRef.current = null;
    underfillRequestQueuedRef.current = false;
    pendingExpandWritePlanRef.current = null;
    prependWindowTxnRef.current = { phase: 'idle' };
    lastUnderfillExpandRef.current = null;
    topPreheadroomBudgetRef.current = SESSION_RENDER_WINDOW_PREHEADROOM_BASE_PX;
    upwardScrollVelocityRef.current = 0;
    lastScrollSampleRef.current = null;
  }, [cancelExpandReadFrame, cancelExpandWriteFrame, cancelPrependCompensationFrame, currentSessionKey]);

  const resolvePrependWindowTxn = useCallback((viewport: HTMLDivElement): PreparedPrependWindowTxn | null => {
    const activeChatRows = chatRowsRef.current;
    const activeSessionKey = currentSessionKeyRef.current;
    const visibleItems = messageVirtualizer.getVirtualItems();
    let anchorItem = visibleItems.find((item) => (
      item.start <= viewport.scrollTop
      && (item.start + item.size) > viewport.scrollTop
    ));
    if (!anchorItem) {
      anchorItem = visibleItems[0];
    }
    const anchorRow = anchorItem ? activeChatRows[anchorItem.index] : activeChatRows[0];
    const anchorRowKey = anchorRow?.key ?? null;
    if (!anchorRowKey) {
      return null;
    }
    return {
      sessionKey: activeSessionKey,
      rowKey: anchorRowKey,
      rowOffsetPx: Math.max(0, viewport.scrollTop - (anchorItem?.start ?? 0)),
      previousScrollTop: viewport.scrollTop,
      previousScrollHeight: viewport.scrollHeight,
    };
  }, [messageVirtualizer]);

  const armPrependWindowTxn = useCallback((preparedTxn: PreparedPrependWindowTxn | null) => {
    if (!preparedTxn) {
      prependWindowTxnRef.current = { phase: 'idle' };
      return;
    }
    prependWindowTxnSeqRef.current += 1;
    prependWindowTxnRef.current = {
      phase: 'scheduled',
      id: prependWindowTxnSeqRef.current,
      sessionKey: preparedTxn.sessionKey,
      rowKey: preparedTxn.rowKey,
      rowOffsetPx: preparedTxn.rowOffsetPx,
      previousScrollTop: preparedTxn.previousScrollTop,
      previousScrollHeight: preparedTxn.previousScrollHeight,
    };
  }, []);

  const resolveTopPreheadroomBudgetPx = useCallback((viewport: HTMLDivElement, sampleScrollVelocity: boolean): number => {
    const visibleItems = messageVirtualizer.getVirtualItems();
    const averageRowPx = measureAverageVisibleRowPx(visibleItems);
    const now = nowMs();

    if (sampleScrollVelocity) {
      const previousSample = lastScrollSampleRef.current;
      if (previousSample) {
        const deltaMs = now - previousSample.atMs;
        if (deltaMs > 0) {
          const deltaUpPx = previousSample.scrollTop - viewport.scrollTop;
          if (deltaMs > SESSION_RENDER_WINDOW_PREHEADROOM_VELOCITY_IDLE_MS) {
            upwardScrollVelocityRef.current = 0;
          } else if (deltaUpPx > 0) {
            const sampledVelocity = deltaUpPx / deltaMs;
            const currentVelocity = upwardScrollVelocityRef.current;
            upwardScrollVelocityRef.current = currentVelocity <= 0
              ? sampledVelocity
              : (
                (currentVelocity * (1 - SESSION_RENDER_WINDOW_PREHEADROOM_VELOCITY_ALPHA))
                + (sampledVelocity * SESSION_RENDER_WINDOW_PREHEADROOM_VELOCITY_ALPHA)
              );
          } else {
            upwardScrollVelocityRef.current *= 0.7;
          }
        }
      }
      lastScrollSampleRef.current = {
        atMs: now,
        scrollTop: viewport.scrollTop,
      };
    } else if (lastScrollSampleRef.current && (now - lastScrollSampleRef.current.atMs) > SESSION_RENDER_WINDOW_PREHEADROOM_VELOCITY_IDLE_MS) {
      upwardScrollVelocityRef.current = 0;
    }

    const velocityLookaheadPx = upwardScrollVelocityRef.current * SESSION_RENDER_WINDOW_PREHEADROOM_LOOKAHEAD_MS;
    const rowWarmupPx = averageRowPx * SESSION_RENDER_WINDOW_PREHEADROOM_MIN_ROWS;
    const nextBudgetPx = clampNumber(
      Math.max(
        SESSION_RENDER_WINDOW_PREHEADROOM_BASE_PX,
        rowWarmupPx,
        velocityLookaheadPx + averageRowPx,
      ),
      SESSION_RENDER_WINDOW_PREHEADROOM_MIN_PX,
      SESSION_RENDER_WINDOW_PREHEADROOM_MAX_PX,
    );
    topPreheadroomBudgetRef.current = nextBudgetPx;
    return nextBudgetPx;
  }, [messageVirtualizer]);

  const shouldExpandForUnderfill = useCallback((viewport: HTMLDivElement): boolean => {
    if (!hasOlderRenderableRowsRef.current) {
      return false;
    }
    if (
      viewport.clientHeight <= SESSION_RENDER_WINDOW_UNDERFILL_EPSILON_PX
      || viewport.scrollHeight <= SESSION_RENDER_WINDOW_UNDERFILL_EPSILON_PX
    ) {
      return false;
    }
    const underfillGapPx = viewport.clientHeight - viewport.scrollHeight;
    if (underfillGapPx <= SESSION_RENDER_WINDOW_UNDERFILL_MIN_GAP_PX) {
      return false;
    }
    if (viewport.scrollHeight > viewport.clientHeight + SESSION_RENDER_WINDOW_UNDERFILL_EPSILON_PX) {
      return false;
    }
    const alreadyExpandedForCurrentRows = (
      lastUnderfillExpandRef.current?.sessionKey === currentSessionKeyRef.current
      && lastUnderfillExpandRef.current.rowCount === chatRowsRef.current.length
    );
    return !alreadyExpandedForCurrentRows;
  }, []);

  const queueNextExpandReadPhase = useCallback(() => {
    if (expandReadFrameRef.current != null || expandWriteFrameRef.current != null) {
      return;
    }
    if (expandRequestReasonRef.current == null && underfillRequestQueuedRef.current) {
      underfillRequestQueuedRef.current = false;
      expandRequestReasonRef.current = 'underfill';
    }
    if (expandRequestReasonRef.current == null) {
      return;
    }
    expandReadFrameRef.current = scheduleFrame(() => {
      flushExpandReadPhaseRef.current();
    });
  }, []);

  const flushExpandWritePhase = useCallback(() => {
    expandWriteFrameRef.current = null;

    const writePlan = pendingExpandWritePlanRef.current;
    pendingExpandWritePlanRef.current = null;

    if (writePlan && useChatStore.getState().currentSessionKey === writePlan.sessionKey) {
      if (writePlan.shouldExpand) {
        if (writePlan.reason === 'underfill') {
          lastUnderfillExpandRef.current = {
            sessionKey: writePlan.sessionKey,
            rowCount: chatRowsRef.current.length,
          };
        }

        armPrependWindowTxn(writePlan.preparedPrependWindowTxn);
        const expandStep = resolveRenderableWindowExpandStep({
          reason: writePlan.reason,
          averageRowPx: writePlan.averageRowPx,
          topBudgetPx: writePlan.topBudgetPx,
          rowsAboveViewport: writePlan.rowsAboveViewport,
          viewportClientHeight: writePlan.viewportClientHeight,
          viewportScrollHeight: writePlan.viewportScrollHeight,
        });
        increaseRenderableWindowLimit(writePlan.sessionKey, {
          requestedStep: expandStep,
          reason: writePlan.reason,
          observedRenderCostMs: runtimeRowsCostMsRef.current,
        });
        if (writePlan.shouldRequeueTopHeadroom) {
          expandRequestReasonRef.current = 'top-headroom';
        }
      } else if (writePlan.shouldRequeueTopHeadroom) {
        expandRequestReasonRef.current = 'top-headroom';
      }
    }

    queueNextExpandReadPhase();
  }, [
    armPrependWindowTxn,
    increaseRenderableWindowLimit,
    queueNextExpandReadPhase,
  ]);

  const flushExpandReadPhase = useCallback(() => {
    expandReadFrameRef.current = null;
    const requestReason = expandRequestReasonRef.current;
    if (!requestReason) {
      queueNextExpandReadPhase();
      return;
    }
    expandRequestReasonRef.current = null;

    const activeSessionKey = currentSessionKeyRef.current;
    if (useChatStore.getState().currentSessionKey !== activeSessionKey) {
      queueNextExpandReadPhase();
      return;
    }

    const viewport = messagesViewportRef.current;
    if (!viewport) {
      queueNextExpandReadPhase();
      return;
    }

    if (prependWindowTxnRef.current.phase === 'scheduled') {
      expandRequestReasonRef.current = requestReason;
      queueNextExpandReadPhase();
      return;
    }

    const hasOlderRows = hasOlderRenderableRowsRef.current;
    const visibleItems = messageVirtualizer.getVirtualItems();
    const averageRowPx = measureAverageVisibleRowPx(visibleItems);
    const viewportTopRowIndex = resolveViewportTopRowIndex(visibleItems, viewport.scrollTop);
    const topBudgetPx = requestReason === 'top-headroom'
      ? resolveTopPreheadroomBudgetPx(viewport, false)
      : 0;
    const topHeadroomTargetRows = requestReason === 'top-headroom'
      ? resolveTopHeadroomTargetRows({
        topBudgetPx,
        viewportClientHeight: viewport.clientHeight,
        normalizedRowPx: clampNumber(averageRowPx, 72, 420),
      })
      : 0;
    const topHeadroomMissingRows = requestReason === 'top-headroom'
      ? Math.max(0, topHeadroomTargetRows - viewportTopRowIndex)
      : 0;
    const shouldExpand = requestReason === 'top-headroom'
      ? (viewport.scrollTop <= topBudgetPx
        && hasOlderRows
        && topHeadroomMissingRows > 0)
      : shouldExpandForUnderfill(viewport);
    const preparedPrependWindowTxn = shouldExpand
      ? resolvePrependWindowTxn(viewport)
      : null;
    const shouldRequeueTopHeadroom = requestReason === 'top-headroom'
      && shouldExpand
      && preparedPrependWindowTxn == null
      && hasOlderRows;

    pendingExpandWritePlanRef.current = {
      reason: requestReason,
      sessionKey: activeSessionKey,
      averageRowPx,
      topBudgetPx,
      rowsAboveViewport: viewportTopRowIndex,
      viewportClientHeight: viewport.clientHeight,
      viewportScrollHeight: viewport.scrollHeight,
      shouldExpand,
      shouldRequeueTopHeadroom,
      preparedPrependWindowTxn,
    };

    if (expandWriteFrameRef.current == null) {
      expandWriteFrameRef.current = scheduleFrame(() => {
        flushExpandWritePhaseRef.current();
      });
    }
  }, [
    messageVirtualizer,
    messagesViewportRef,
    queueNextExpandReadPhase,
    resolvePrependWindowTxn,
    resolveTopPreheadroomBudgetPx,
    shouldExpandForUnderfill,
  ]);

  useLayoutEffect(() => {
    flushExpandReadPhaseRef.current = flushExpandReadPhase;
    flushExpandWritePhaseRef.current = flushExpandWritePhase;
  }, [flushExpandReadPhase, flushExpandWritePhase]);

  const queueExpandRequest = useCallback((reason: RenderWindowExpandReason) => {
    const currentReason = expandRequestReasonRef.current;
    if (reason === 'underfill' && currentReason === 'top-headroom') {
      underfillRequestQueuedRef.current = true;
    } else if (currentReason !== 'top-headroom' || reason === 'top-headroom') {
      expandRequestReasonRef.current = reason;
    }
    queueNextExpandReadPhase();
  }, [queueNextExpandReadPhase]);

  const maybeQueueTopHeadroomExpand = useCallback(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }
    const hasOlderRows = hasOlderRenderableRowsRef.current;
    if (!hasOlderRows) {
      return;
    }
    const topBudgetPx = resolveTopPreheadroomBudgetPx(viewport, true);
    if (viewport.scrollTop > topBudgetPx) {
      return;
    }
    queueExpandRequest('top-headroom');
  }, [
    messagesViewportRef,
    queueExpandRequest,
    resolveTopPreheadroomBudgetPx,
  ]);

  useLayoutEffect(() => {
    const txn = prependWindowTxnRef.current;
    if (txn.phase !== 'scheduled' || txn.sessionKey !== currentSessionKey) {
      return;
    }
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }

    cancelPrependCompensationFrame();
    const targetIndex = chatRows.findIndex((row) => row.key === txn.rowKey);
    if (targetIndex < 0) {
      prependWindowTxnRef.current = { phase: 'idle' };
      return;
    }

    const tryCompensateToAnchor = (activeViewport: HTMLDivElement): boolean => {
      const offsetInfo = messageVirtualizer.getOffsetForIndex(targetIndex, 'start');
      if (!offsetInfo) {
        return false;
      }
      const desiredScrollTop = Math.max(0, offsetInfo[0] + txn.rowOffsetPx);
      messageVirtualizer.scrollToOffset(desiredScrollTop, { align: 'start', behavior: 'auto' });
      if (Math.abs(activeViewport.scrollTop - desiredScrollTop) > 0.5) {
        activeViewport.scrollTop = desiredScrollTop;
      }
      prependWindowTxnRef.current = { phase: 'idle' };
      queueExpandRequest('top-headroom');
      return true;
    };

    // If virtualizer has already materialized target row in this layout pass, complete immediately.
    if (tryCompensateToAnchor(viewport)) {
      return;
    }

    let attempts = 0;
    const retryAnchorCompensation = () => {
      const latestTxn = prependWindowTxnRef.current;
      if (
        latestTxn.phase !== 'scheduled'
        || latestTxn.id !== txn.id
        || latestTxn.sessionKey !== currentSessionKey
      ) {
        prependCompensationFrameRef.current = null;
        return;
      }

      const activeViewport = messagesViewportRef.current;
      if (!activeViewport) {
        prependCompensationFrameRef.current = null;
        prependWindowTxnRef.current = { phase: 'idle' };
        return;
      }

      if (tryCompensateToAnchor(activeViewport)) {
        prependCompensationFrameRef.current = null;
        return;
      }

      attempts += 1;
      if (attempts <= PREPEND_COMPENSATION_MAX_FRAME_ATTEMPTS) {
        prependCompensationFrameRef.current = scheduleFrame(retryAnchorCompensation);
        return;
      }

      const totalHeightDelta = activeViewport.scrollHeight - txn.previousScrollHeight;
      if (Number.isFinite(totalHeightDelta) && Math.abs(totalHeightDelta) > 0.5) {
        activeViewport.scrollTop = Math.max(0, txn.previousScrollTop + totalHeightDelta);
      }
      prependCompensationFrameRef.current = null;
      prependWindowTxnRef.current = { phase: 'idle' };
      queueExpandRequest('top-headroom');
    };

    prependCompensationFrameRef.current = scheduleFrame(retryAnchorCompensation);
    return () => {
      cancelPrependCompensationFrame();
    };
  }, [
    cancelPrependCompensationFrame,
    chatRows,
    currentSessionKey,
    messageVirtualizer,
    messagesViewportRef,
    queueExpandRequest,
    scrollCommandType,
    scrollMode,
  ]);

  useLayoutEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }
    if (shouldExpandForUnderfill(viewport)) {
      queueExpandRequest('underfill');
    }
  }, [messagesViewportRef, queueExpandRequest, shouldExpandForUnderfill]);

  useLayoutEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport || typeof ResizeObserver !== 'function') {
      return;
    }
    const observer = new ResizeObserver(() => {
      const activeViewport = messagesViewportRef.current;
      if (!activeViewport) {
        return;
      }
      if (shouldExpandForUnderfill(activeViewport)) {
        queueExpandRequest('underfill');
      }
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [messagesViewportRef, queueExpandRequest, shouldExpandForUnderfill]);

  const handleViewportScrollWithWindowing = useCallback(() => {
    handleViewportScroll();
    maybeQueueTopHeadroomExpand();
    markScrollActivity();
  }, [handleViewportScroll, markScrollActivity, maybeQueueTopHeadroomExpand]);

  const handleViewportWheelWithWindowing = useCallback(() => {
    maybeQueueTopHeadroomExpand();
    markScrollActivity();
  }, [markScrollActivity, maybeQueueTopHeadroomExpand]);

  return {
    handleViewportScrollWithWindowing,
    handleViewportWheelWithWindowing,
  };
}
