import type { RefObject, TouchEventHandler, WheelEventHandler } from 'react';
import {
  INITIAL_SCOPE_STATE,
  bottomScrollTop,
  hasScrollableOverflow,
  isAtBottom,
  readViewportMetrics,
  restoreViewportAnchor,
  sampleViewportAnchor,
  viewportHasRenderableItems,
  type ChatScrollPhase,
  type ChatScrollScopeState,
  type ViewportAnchor,
} from './chat-scroll-model';

export interface ChatScrollControllerConfig {
  enabled: boolean;
  scrollScopeKey: string;
  setChromePhase: (phase: ChatScrollPhase) => void;
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
}

export interface ChatScrollController {
  /** scope key 变化时调用 */
  onScopeChanged: () => void;
  /** ResizeObserver 回调：唯一的"被动几何变化"入口 */
  onGeometryChanged: () => void;
  /** 视口原生 scroll 事件：phase 的几何真值同步器 */
  handleViewportScroll: () => void;
  handleViewportPointerDown: () => void;
  handleViewportTouchMove: TouchEventHandler<HTMLDivElement>;
  handleViewportWheel: WheelEventHandler<HTMLDivElement>;
  /** 来自外层（输入框浮层）的滚轮代理 */
  scrollViewportByWheelDelta: (deltaY: number) => void;
  /** 加载更早消息前调用：先记下当前位置，加载完后会自动按 scrollHeight delta 补偿 */
  prepareScopeAnchorRestore: (nextScopeKey: string) => void;
  /** 显式让某 scope 进入 follow 并立即贴底（发送消息 / 跳到底部按钮） */
  prepareScopeBottomAlign: (nextScopeKey: string) => void;
  /** 当前 scope 直接贴底 */
  jumpToBottom: () => void;
  cleanup: () => void;
}

interface PendingPrepend {
  scopeKey: string;
  previousScrollHeight: number;
  previousScrollTop: number;
}

interface PendingTransition {
  scopeKey: string;
  mode: 'restore-anchor' | 'force-follow';
  anchor?: ViewportAnchor;
}

interface ControllerState {
  scopeStateByScope: Map<string, ChatScrollScopeState>;
  lastScopeKey: string | null;
  pendingPrepend: PendingPrepend | null;
  pendingTransition: PendingTransition | null;
  /** 触摸手势起始 y 坐标，用于在 touchmove 时判定手势方向 */
  touchStartY: number | null;
}

function ensureScopeState(
  scopeKey: string,
  byScope: Map<string, ChatScrollScopeState>,
): ChatScrollScopeState {
  const existing = byScope.get(scopeKey);
  if (existing) {
    return existing;
  }
  const next: ChatScrollScopeState = { ...INITIAL_SCOPE_STATE };
  byScope.set(scopeKey, next);
  return next;
}

export function createChatScrollController(
  getConfig: () => ChatScrollControllerConfig,
): ChatScrollController {
  const initialConfig = getConfig();
  const state: ControllerState = {
    scopeStateByScope: new Map(),
    lastScopeKey: null,
    pendingPrepend: null,
    pendingTransition: null,
    touchStartY: null,
  };
  ensureScopeState(initialConfig.scrollScopeKey, state.scopeStateByScope);

  const getScope = (key: string) => ensureScopeState(key, state.scopeStateByScope);

  const setPhase = (phase: ChatScrollPhase) => {
    const config = getConfig();
    const scope = getScope(config.scrollScopeKey);
    if (scope.phase !== phase) {
      scope.phase = phase;
      if (phase === 'follow') {
        scope.anchor = null;
      }
    }
    config.setChromePhase(phase);
  };

  /**
   * 不写 phase。仅"该贴底就贴底"，目标位置由纯函数算出。
   */
  const stickToBottom = () => {
    const config = getConfig();
    const viewport = config.viewportRef.current;
    if (!viewport || !viewportHasRenderableItems(viewport)) {
      return false;
    }
    const metrics = readViewportMetrics(viewport);
    if (!metrics) {
      return false;
    }
    viewport.scrollTop = bottomScrollTop(metrics);
    getScope(config.scrollScopeKey).hasInitialAligned = true;
    return true;
  };

  const syncSyncContainerDataset = () => {
    const config = getConfig();
    const viewport = config.viewportRef.current;
    const sync = viewport?.closest<HTMLElement>('.chat-scroll-sync');
    if (!sync) {
      return;
    }
    const metrics = readViewportMetrics(viewport);
    const scope = getScope(config.scrollScopeKey);
    sync.dataset.chatScrollPhase = scope.phase;
    sync.dataset.chatScrollLocked = scope.phase === 'follow' ? 'true' : 'false';
    sync.dataset.chatScrollOverflow = metrics != null && hasScrollableOverflow(metrics) ? 'true' : 'false';
    sync.dataset.chatScrollScope = config.scrollScopeKey;
  };

  /**
   * 应用历史 prepend 的位置补偿。
   *
   * 仅当：
   *   a. 当前 scope 有挂起的 pendingPrepend
   *   b. phase=detached（用户没主动回到底部）
   * 时才补偿。如果用户在加载完成前已经下滑到底，phase 已被 scroll 事件改成 follow，
   * 此时保留 follow 即可——pendingPrepend 在 scroll handler 转 follow 时已经被清。
   */
  const applyPendingPrepend = () => {
    const config = getConfig();
    const pending = state.pendingPrepend;
    const viewport = config.viewportRef.current;
    if (!pending || !viewport || pending.scopeKey !== config.scrollScopeKey) {
      return false;
    }
    const scope = getScope(config.scrollScopeKey);
    if (scope.phase !== 'detached') {
      state.pendingPrepend = null;
      return false;
    }
    const delta = viewport.scrollHeight - pending.previousScrollHeight;
    if (delta <= 0) {
      return false;
    }
    state.pendingPrepend = null;
    viewport.scrollTop = pending.previousScrollTop + delta;
    return true;
  };

  /**
   * 切 scope 后的过渡：恢复阅读锚点 / 强制贴底。
   */
  const applyPendingTransition = () => {
    const config = getConfig();
    const pending = state.pendingTransition;
    if (!pending || pending.scopeKey !== config.scrollScopeKey) {
      return false;
    }
    if (!viewportHasRenderableItems(config.viewportRef.current)) {
      return false;
    }
    if (pending.mode === 'force-follow') {
      state.pendingTransition = null;
      setPhase('follow');
      stickToBottom();
      return true;
    }
    if (pending.anchor && restoreViewportAnchor(config.viewportRef.current, pending.anchor)) {
      state.pendingTransition = null;
      setPhase('detached');
      const scope = getScope(config.scrollScopeKey);
      scope.hasInitialAligned = true;
      scope.anchor = pending.anchor;
      return true;
    }
    return false;
  };

  // ──────────────── 用户主动事件：预设 phase（最终由 scroll 事件兜底校正） ────────────────

  const handleViewportPointerDown = () => {
    // pointerdown 不改 phase；具体方向由后续 wheel/touchmove/scroll 决定。
    state.touchStartY = null;
  };

  const handleViewportTouchMove: TouchEventHandler<HTMLDivElement> = (event) => {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }
    const touch = event.touches[0];
    if (!touch) {
      return;
    }
    const previousY = state.touchStartY;
    state.touchStartY = touch.clientY;
    if (previousY == null) {
      return;
    }
    // 手指下移 = 视图上滑 = 用户在往回看历史。
    if (touch.clientY > previousY) {
      setPhase('detached');
    }
  };

  const handleViewportWheel: WheelEventHandler<HTMLDivElement> = (event) => {
    handleWheelDelta(event?.deltaY ?? 0);
  };

  function handleWheelDelta(deltaY: number) {
    const config = getConfig();
    if (!config.enabled || !Number.isFinite(deltaY) || deltaY === 0) {
      return;
    }
    if (deltaY < 0) {
      // 用户上滑：预设 detached。这条很关键——
      // 如果浏览器的 scroll 派发跟流式 token 重排撞在同一帧，
      // onGeometryChanged 会在 scroll 事件之前先看到 phase=detached，
      // 从而不再 stickToBottom，把用户的上滑意图保住。
      setPhase('detached');
    }
    // deltaY > 0：不主动改 phase；如果滚到底部 scroll 事件会把它转回 follow。
  }

  const scrollViewportByWheelDelta = (deltaY: number) => {
    const config = getConfig();
    const viewport = config.viewportRef.current;
    if (!config.enabled || !viewport || !Number.isFinite(deltaY) || deltaY === 0) {
      return;
    }
    handleWheelDelta(deltaY);
    viewport.scrollTop += deltaY;
    handleViewportScroll();
  };

  /**
   * scroll 事件 = phase 的几何真值同步器：
   *   到底  → follow
   *   未到底 → detached
   * 这是唯一一处"按几何把 phase 拉回 follow"的入口。
   */
  const handleViewportScroll = () => {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }
    const metrics = readViewportMetrics(config.viewportRef.current);
    if (!metrics) {
      return;
    }
    if (isAtBottom(metrics)) {
      // 用户主动滚到底部：清掉残留的 prepend 补偿，避免被它把位置拉回。
      state.pendingPrepend = null;
      setPhase('follow');
    } else {
      setPhase('detached');
    }
    syncSyncContainerDataset();
  };

  // ──────────────── 内容/几何被动变化：只读 phase ────────────────

  const onGeometryChanged = () => {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }
    if (applyPendingTransition()) {
      syncSyncContainerDataset();
      return;
    }
    if (applyPendingPrepend()) {
      syncSyncContainerDataset();
      return;
    }
    const scope = getScope(config.scrollScopeKey);
    if (!scope.hasInitialAligned && viewportHasRenderableItems(config.viewportRef.current)) {
      stickToBottom();
      syncSyncContainerDataset();
      return;
    }
    if (scope.phase === 'follow') {
      stickToBottom();
    }
    // phase === 'detached'：保持 scrollTop 不变（append 不会让用户位置漂走，
    // prepend 已由 pendingPrepend 单独补偿）。
    syncSyncContainerDataset();
  };

  const onScopeChanged = () => {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }
    const previousScopeKey = state.lastScopeKey;
    state.lastScopeKey = config.scrollScopeKey;
    const scope = getScope(config.scrollScopeKey);
    config.setChromePhase(scope.phase);

    if (applyPendingTransition()) {
      syncSyncContainerDataset();
      return;
    }

    // 首次进入（包括 enabled 由 false→true 的首次）：必须做一次首贴。
    const isFirstEnable = previousScopeKey === null
      || previousScopeKey !== config.scrollScopeKey
      || !scope.hasInitialAligned;

    if (!isFirstEnable) {
      syncSyncContainerDataset();
      return;
    }

    if (scope.phase === 'follow') {
      stickToBottom();
    } else if (scope.anchor) {
      restoreViewportAnchor(config.viewportRef.current, scope.anchor);
    }
    syncSyncContainerDataset();
  };

  // ──────────────── 显式过渡命令 ────────────────

  const prepareScopeAnchorRestore = (nextScopeKey: string) => {
    if (!nextScopeKey) {
      return;
    }
    const config = getConfig();
    const viewport = config.viewportRef.current;
    if (!viewport) {
      return;
    }
    const scope = getScope(config.scrollScopeKey);
    scope.anchor = sampleViewportAnchor(viewport);
    if (nextScopeKey === config.scrollScopeKey) {
      // 同 scope 加载更早：内容到位后用 scrollHeight delta 补偿。
      state.pendingPrepend = {
        scopeKey: nextScopeKey,
        previousScrollHeight: viewport.scrollHeight,
        previousScrollTop: viewport.scrollTop,
      };
      // 切 detached：避免被 follow 抢走用户当前位置。
      setPhase('detached');
      return;
    }
    state.pendingTransition = {
      scopeKey: nextScopeKey,
      mode: 'restore-anchor',
      anchor: scope.anchor ?? undefined,
    };
  };

  const prepareScopeBottomAlign = (nextScopeKey: string) => {
    if (!nextScopeKey) {
      return;
    }
    const config = getConfig();
    if (nextScopeKey === config.scrollScopeKey) {
      state.pendingPrepend = null;
      setPhase('follow');
      stickToBottom();
      syncSyncContainerDataset();
      return;
    }
    state.pendingTransition = { scopeKey: nextScopeKey, mode: 'force-follow' };
  };

  const jumpToBottom = () => {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }
    state.pendingPrepend = null;
    setPhase('follow');
    stickToBottom();
    syncSyncContainerDataset();
  };

  const cleanup = () => {
    state.pendingPrepend = null;
    state.pendingTransition = null;
    state.touchStartY = null;
  };

  return {
    onScopeChanged,
    onGeometryChanged,
    handleViewportScroll,
    handleViewportPointerDown,
    handleViewportTouchMove,
    handleViewportWheel,
    scrollViewportByWheelDelta,
    prepareScopeAnchorRestore,
    prepareScopeBottomAlign,
    jumpToBottom,
    cleanup,
  };
}
