import type { MouseEventHandler, RefObject, TouchEventHandler, WheelEventHandler } from 'react';
import { handleStableWheel } from '@/components/scroll/stable-scroll-core';
import {
  INITIAL_SCOPE_STATE,
  bottomScrollTop,
  hasScrollableOverflow,
  isAtBottom,
  ChatViewportGeometry,
  type ChatScrollPhase,
  type ChatScrollScopeState,
  type ViewportAnchor,
} from './chat-scroll-model';

export interface ChatScrollControllerConfig {
  enabled: boolean;
  scrollScopeKey: string;
  setChromePhase: (phase: ChatScrollPhase) => void;
  viewportRef: RefObject<HTMLDivElement | null>;
}

export interface ChatScrollController {
  setConfig: (config: ChatScrollControllerConfig) => void;
  /** scope key 变化时调用 */
  onScopeChanged: () => void;
  /** ResizeObserver 回调：唯一的"被动几何变化"入口 */
  onGeometryChanged: () => void;
  /** 视口原生 scroll 事件：phase 的几何真值同步器 */
  handleViewportScroll: () => void;
  handleViewportPointerDown: () => void;
  handleViewportTouchMove: TouchEventHandler<HTMLDivElement>;
  handleViewportWheel: WheelEventHandler<HTMLDivElement>;
  /** viewport click capture：在展开状态变化前采样局部锚点 */
  handleViewportClickCapture: MouseEventHandler<HTMLDivElement>;
  /** 来自外层（输入框浮层）的滚轮代理 */
  scrollViewportByWheelDelta: (deltaY: number) => void;
  /** 用户触发的局部展开/收起：保持触发元素在视口内的位置不变 */
  prepareElementAnchorRestore: (anchorElement: HTMLElement) => boolean;
  /** 同 scope 替页到位后恢复 exact 锚点；跨 scope 在切换前采样 */
  prepareScopeAnchorRestore: (nextScopeKey: string, anchor?: ViewportAnchor | null) => void;
  /** 显式让某 scope 进入 follow 并立即贴底（发送消息 / 跳到底部按钮） */
  prepareScopeBottomAlign: (nextScopeKey: string) => void;
  /** 当前 scope 直接贴底 */
  jumpToBottom: () => void;
  cleanup: () => void;
}

interface PendingTransition {
  scopeKey: string;
  mode: 'restore-anchor' | 'force-follow';
  anchor?: ViewportAnchor;
}

interface PendingElementAnchorRestore {
  scopeKey: string;
  anchorElement: HTMLElement;
  offsetWithinViewport: number;
}

interface ControllerState {
  scopeStateByScope: Map<string, ChatScrollScopeState>;
  lastScopeKey: string | null;
  pendingTransition: PendingTransition | null;
  pendingElementAnchorRestore: PendingElementAnchorRestore | null;
  userLeavingBottom: boolean;
  /** 触摸手势起始 y 坐标，用于在 touchmove 时判定手势方向 */
  touchStartY: number | null;
}

const DISABLED_VIEWPORT_REF: RefObject<HTMLDivElement | null> = { current: null };
const DISABLED_CONTROLLER_CONFIG: ChatScrollControllerConfig = {
  enabled: false,
  scrollScopeKey: '',
  setChromePhase: () => {},
  viewportRef: DISABLED_VIEWPORT_REF,
};

const NESTED_WHEEL_TARGET_SELECTOR = [
  'textarea',
  '[data-radix-scroll-area-viewport]',
  '[data-tool-output-scroll="true"]',
  '[data-chat-composer-wheel-local="true"]',
  'pre',
  'code',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="dialog"]',
].join(',');

function canElementScrollWheelDelta(element: HTMLElement, deltaY: number): boolean {
  if (deltaY > 0) {
    return element.scrollTop + element.clientHeight < element.scrollHeight - 1;
  }
  if (deltaY < 0) {
    return element.scrollTop > 1;
  }
  return false;
}

function shouldLetNestedScrollableConsumeWheel(event: WheelEvent, viewport: HTMLElement): boolean {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target || target === viewport || !viewport.contains(target)) {
    return false;
  }
  for (let element: HTMLElement | null = target; element && element !== viewport; element = element.parentElement) {
    if (element.matches(NESTED_WHEEL_TARGET_SELECTOR) && canElementScrollWheelDelta(element, event.deltaY)) {
      return true;
    }
  }
  return false;
}

function handleStableWheelDelta(deltaY: number, viewport: HTMLElement): boolean {
  return handleStableWheel({
    ctrlKey: false,
    defaultPrevented: false,
    deltaMode: 0,
    deltaY,
    preventDefault: () => {},
    target: viewport.firstElementChild ?? viewport,
  } as unknown as WheelEvent, viewport);
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

export function createChatScrollController(): ChatScrollController {
  const state: ControllerState = {
    scopeStateByScope: new Map(),
    lastScopeKey: null,
    pendingTransition: null,
    pendingElementAnchorRestore: null,
    userLeavingBottom: false,
    touchStartY: null,
  };

  let config: ChatScrollControllerConfig = DISABLED_CONTROLLER_CONFIG;
  const getConfig = () => config;
  const setConfig = (nextConfig: ChatScrollControllerConfig) => {
    config = nextConfig;
    ensureScopeState(config.scrollScopeKey, state.scopeStateByScope);
  };

  const getScope = (key: string) => ensureScopeState(key, state.scopeStateByScope);

  const setPhase = (phase: ChatScrollPhase) => {
    const config = getConfig();
    const scope = getScope(config.scrollScopeKey);
    if (phase === 'follow') {
      state.userLeavingBottom = false;
    }
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
  const stickToBottom = (geometry: ChatViewportGeometry) => {
    if (!geometry.hasRenderableItems()) {
      return false;
    }
    const metrics = geometry.metrics;
    if (!metrics) {
      return false;
    }
    geometry.scrollTo(bottomScrollTop(metrics));
    getScope(config.scrollScopeKey).hasInitialAligned = true;
    return true;
  };

  const syncSyncContainerDataset = (geometry: ChatViewportGeometry) => {
    const sync = geometry.viewport?.closest<HTMLElement>('.chat-scroll-sync');
    if (!sync) {
      return;
    }
    const metrics = geometry.metrics;
    const scope = getScope(config.scrollScopeKey);
    const locked = scope.phase === 'follow' ? 'true' : 'false';
    const overflow = metrics != null && hasScrollableOverflow(metrics) ? 'true' : 'false';
    if (sync.dataset.chatScrollPhase !== scope.phase) sync.dataset.chatScrollPhase = scope.phase;
    if (sync.dataset.chatScrollLocked !== locked) sync.dataset.chatScrollLocked = locked;
    if (sync.dataset.chatScrollOverflow !== overflow) sync.dataset.chatScrollOverflow = overflow;
    if (sync.dataset.chatScrollScope !== config.scrollScopeKey) sync.dataset.chatScrollScope = config.scrollScopeKey;
  };

  /**
   * 用户点击展开/收起会触发局部高度变化；保持触发控件在视口内的位置不变。
   */
  const applyPendingElementAnchorRestore = (geometry: ChatViewportGeometry) => {
    const pending = state.pendingElementAnchorRestore;
    if (!pending) {
      return false;
    }
    const config = getConfig();
    if (pending.scopeKey !== config.scrollScopeKey) {
      state.pendingElementAnchorRestore = null;
      return false;
    }
    state.pendingElementAnchorRestore = null;
    return geometry.restoreElement(pending.anchorElement, pending.offsetWithinViewport);
  };

  /**
   * 切 scope 后的过渡：恢复阅读锚点 / 强制贴底。
   */
  const applyPendingTransition = (geometry: ChatViewportGeometry) => {
    const config = getConfig();
    const pending = state.pendingTransition;
    if (!pending || pending.scopeKey !== config.scrollScopeKey) {
      return false;
    }
    if (!geometry.hasRenderableItems()) {
      return false;
    }
    if (pending.mode === 'force-follow') {
      state.pendingTransition = null;
      setPhase('follow');
      stickToBottom(geometry);
      return true;
    }
    if (pending.anchor && geometry.restoreAnchor(pending.anchor)) {
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
      state.userLeavingBottom = true;
      setPhase('detached');
    }
  };

  const handleViewportWheel: WheelEventHandler<HTMLDivElement> = (event) => {
    const config = getConfig();
    const viewport = config.viewportRef.current;
    if (!config.enabled || !viewport || shouldLetNestedScrollableConsumeWheel(event.nativeEvent, viewport)) {
      return;
    }
    noteWheelIntent(event.nativeEvent.deltaY);
    handleStableWheel(event.nativeEvent, viewport);
  };

  function noteWheelIntent(deltaY: number) {
    const config = getConfig();
    if (!config.enabled || !Number.isFinite(deltaY) || deltaY === 0) {
      return;
    }
    if (deltaY < 0) {
      state.userLeavingBottom = true;
    }
    // deltaY > 0：不主动改 phase；如果滚到底部 scroll 事件会把它转回 follow。
  }

  const scrollViewportByWheelDelta = (deltaY: number) => {
    const config = getConfig();
    const viewport = config.viewportRef.current;
    if (!config.enabled || !viewport || !Number.isFinite(deltaY) || deltaY === 0) {
      return;
    }
    noteWheelIntent(deltaY);
    if (!handleStableWheelDelta(deltaY, viewport)) {
      viewport.scrollTop += deltaY;
      handleViewportScroll();
    }
  };

  const prepareElementAnchorRestore = (anchorElement: HTMLElement) => {
    const config = getConfig();
    const viewport = config.viewportRef.current;
    if (!config.enabled || !viewport || !viewport.contains(anchorElement)) {
      return false;
    }
    const viewportRect = viewport.getBoundingClientRect();
    const anchorRect = anchorElement.getBoundingClientRect();
    state.pendingElementAnchorRestore = {
      scopeKey: config.scrollScopeKey,
      anchorElement,
      offsetWithinViewport: anchorRect.top - viewportRect.top,
    };
    setPhase('detached');
    return true;
  };

  const handleViewportClickCapture: MouseEventHandler<HTMLDivElement> = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const anchorElement = target.closest<HTMLElement>(
      '[data-chat-local-geometry-anchor="true"],.chat-markdown details > summary',
    );
    if (anchorElement) {
      prepareElementAnchorRestore(anchorElement);
    }
  };

  /**
   * scroll 事件只确认两件事：
   *   到底                 → follow
   *   用户离底意图已成立   → detached
   * 被动几何变化造成的 not-at-bottom 不能反推用户意图。
   */
  const handleViewportScroll = () => {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }
    const geometry = new ChatViewportGeometry(config.viewportRef.current);
    const metrics = geometry.metrics;
    if (!metrics) {
      return;
    }
    if (isAtBottom(metrics) && !state.pendingElementAnchorRestore) {
      setPhase('follow');
    } else if (state.userLeavingBottom) {
      setPhase('detached');
    }
    syncSyncContainerDataset(geometry);
  };

  // ──────────────── 内容/几何被动变化：只读 phase ────────────────

  const onGeometryChanged = () => {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }
    const geometry = new ChatViewportGeometry(config.viewportRef.current);
    if (applyPendingTransition(geometry)) {
      syncSyncContainerDataset(geometry);
      return;
    }
    if (applyPendingElementAnchorRestore(geometry)) {
      syncSyncContainerDataset(geometry);
      return;
    }
    const scope = getScope(config.scrollScopeKey);
    if (!scope.hasInitialAligned && geometry.hasRenderableItems()) {
      stickToBottom(geometry);
      syncSyncContainerDataset(geometry);
      return;
    }
    if (scope.phase === 'follow') {
      stickToBottom(geometry);
    }
    // phase === 'detached'：保持 scrollTop 不变（append 不会让用户位置漂走）。
    syncSyncContainerDataset(geometry);
  };

  const onScopeChanged = () => {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }
    const geometry = new ChatViewportGeometry(config.viewportRef.current);
    const previousScopeKey = state.lastScopeKey;
    state.lastScopeKey = config.scrollScopeKey;
    if (previousScopeKey !== null && previousScopeKey !== config.scrollScopeKey) {
      state.pendingElementAnchorRestore = null;
    }
    const scope = getScope(config.scrollScopeKey);
    config.setChromePhase(scope.phase);

    if (applyPendingTransition(geometry)) {
      syncSyncContainerDataset(geometry);
      return;
    }

    // 首次进入（包括 enabled 由 false→true 的首次）：必须做一次首贴。
    const isFirstEnable = previousScopeKey === null
      || previousScopeKey !== config.scrollScopeKey
      || !scope.hasInitialAligned;

    if (!isFirstEnable) {
      syncSyncContainerDataset(geometry);
      return;
    }

    if (scope.phase === 'follow') {
      stickToBottom(geometry);
    } else if (scope.anchor) {
      geometry.restoreAnchor(scope.anchor);
    }
    syncSyncContainerDataset(geometry);
  };

  // ──────────────── 显式过渡命令 ────────────────

  const prepareScopeAnchorRestore = (nextScopeKey: string, anchor?: ViewportAnchor | null) => {
    if (!nextScopeKey) {
      return;
    }
    const config = getConfig();
    const viewport = config.viewportRef.current;
    if (!viewport) {
      return;
    }
    const geometry = new ChatViewportGeometry(viewport);
    const scope = getScope(config.scrollScopeKey);
    state.pendingElementAnchorRestore = null;
    if (nextScopeKey === config.scrollScopeKey) {
      // 替页只恢复相同展示身份，不借时间戳猜新页位置。
      const exactAnchor = anchor?.itemKey
        ? { itemKey: anchor.itemKey, offsetWithinViewport: anchor.offsetWithinViewport }
        : null;
      if (exactAnchor && geometry.restoreAnchor(exactAnchor)) {
        setPhase('detached');
        scope.hasInitialAligned = true;
        scope.anchor = exactAnchor;
        syncSyncContainerDataset(geometry);
      } else {
        setPhase('follow');
        stickToBottom(geometry);
        syncSyncContainerDataset(geometry);
      }
      return;
    }
    scope.anchor = geometry.sampleAnchor();
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
      const geometry = new ChatViewportGeometry(config.viewportRef.current);
      state.pendingElementAnchorRestore = null;
      setPhase('follow');
      stickToBottom(geometry);
      syncSyncContainerDataset(geometry);
      return;
    }
    state.pendingElementAnchorRestore = null;
    state.pendingTransition = { scopeKey: nextScopeKey, mode: 'force-follow' };
  };

  const jumpToBottom = () => {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }
    const geometry = new ChatViewportGeometry(config.viewportRef.current);
    state.pendingElementAnchorRestore = null;
    setPhase('follow');
    stickToBottom(geometry);
    syncSyncContainerDataset(geometry);
  };

  const cleanup = () => {
    state.pendingTransition = null;
    state.pendingElementAnchorRestore = null;
    state.userLeavingBottom = false;
    state.touchStartY = null;
  };

  return {
    setConfig,
    onScopeChanged,
    onGeometryChanged,
    handleViewportScroll,
    handleViewportPointerDown,
    handleViewportTouchMove,
    handleViewportWheel,
    handleViewportClickCapture,
    scrollViewportByWheelDelta,
    prepareElementAnchorRestore,
    prepareScopeAnchorRestore,
    prepareScopeBottomAlign,
    jumpToBottom,
    cleanup,
  };
}
