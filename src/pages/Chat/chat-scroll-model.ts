/**
 * Chat 滚动模型
 *
 * 模型语义：
 * - 每个 scope（一个会话）持有一个 follow/detached 的二态 phase。
 * - phase 是“用户跟随最新消息的意图”，是唯一意图源。
 * - 仅以下语义事件能写 phase：
 *     a. 用户明确离开底部（滚轮上滑 / 触摸下滑）→ detached
 *     b. 视口几何到达底部                         → follow
 *     c. 显式 jumpToBottom / 切 scope 强制贴底     → follow
 * - 流式追加、布局重排、程序写 scrollTop 等被动几何变化不能把 follow 反推成 detached。
 *
 * 几何工具是纯函数；reducer 也是纯函数。所有 DOM 副作用都在 controller。
 */

export interface ChatViewportMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  clientWidth: number;
}

export type ChatScrollPhase = 'follow' | 'detached';

export interface ViewportAnchor {
  itemKey?: string;
  followingItemKey?: string;
  timestamp?: number;
  offsetWithinViewport: number;
}

export interface ChatScrollScopeState {
  phase: ChatScrollPhase;
  hasInitialAligned: boolean;
  anchor: ViewportAnchor | null;
}

export const INITIAL_SCOPE_STATE: Readonly<ChatScrollScopeState> = Object.freeze({
  phase: 'follow',
  hasInitialAligned: false,
  anchor: null,
});

/**
 * 判定视口几何是否"真的在底部"。
 * 默认 epsilon=0.5px，仅吸收浮点/亚像素抖动；不参与"是否跟随"的语义判断。
 */
export const BOTTOM_EPSILON_PX = 0.5;

export function isAtBottom(
  metrics: ChatViewportMetrics,
  epsilon: number = BOTTOM_EPSILON_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= epsilon;
}

export function bottomScrollTop(metrics: ChatViewportMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

export function hasScrollableOverflow(metrics: ChatViewportMetrics): boolean {
  return metrics.scrollHeight > metrics.clientHeight;
}

export function readViewportMetrics(
  viewport: HTMLElement | null,
): ChatViewportMetrics | null {
  if (!viewport) {
    return null;
  }
  return {
    scrollTop: viewport.scrollTop,
    scrollHeight: viewport.scrollHeight,
    clientHeight: viewport.clientHeight,
    clientWidth: viewport.clientWidth,
  };
}

/**
 * 从视口 DOM 抽取一个跨刷新可恢复的阅读锚点：
 * 取首条与视口相交的消息，记下它的位置偏移。
 */
export function sampleViewportAnchor(viewport: HTMLElement | null): ViewportAnchor | null {
  if (!viewport) {
    return null;
  }
  const viewportRect = viewport.getBoundingClientRect();
  const items = Array.from(viewport.querySelectorAll<HTMLElement>('[data-chat-item-key]'));
  for (const [index, item] of items.entries()) {
    const rect = item.getBoundingClientRect();
    if (rect.bottom <= viewportRect.top || rect.top >= viewportRect.bottom) {
      continue;
    }
    const itemKey = item.dataset.chatItemKey?.trim() || undefined;
    const timestampText = item.dataset.chatMessageTimestamp;
    const timestamp = timestampText && timestampText.trim() ? Number(timestampText) : undefined;
    return {
      itemKey,
      timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
      followingItemKey: items[index + 1]?.dataset.chatItemKey,
      offsetWithinViewport: rect.top - viewportRect.top,
    };
  }
  return null;
}

/**
 * 把视口滚回 anchor 当时的位置。返回是否真正落位。
 */
export function restoreViewportAnchor(
  viewport: HTMLElement | null,
  anchor: ViewportAnchor,
): boolean {
  if (!viewport) {
    return false;
  }
  const items = Array.from(viewport.querySelectorAll<HTMLElement>('[data-chat-item-key]'));
  let target: HTMLElement | undefined;
  if (anchor.itemKey) {
    target = items.find((element) => element.dataset.chatItemKey === anchor.itemKey);
    if (target && anchor.followingItemKey) {
      const nextItem = items[items.indexOf(target) + 1];
      if (nextItem?.dataset.chatItemKey !== anchor.followingItemKey) {
        target = undefined;
      }
    }
  }
  if (!target && typeof anchor.timestamp === 'number') {
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const element of items) {
      const tsText = element.dataset.chatMessageTimestamp;
      const ts = tsText && tsText.trim() ? Number(tsText) : NaN;
      if (!Number.isFinite(ts)) {
        continue;
      }
      const distance = Math.abs(ts - anchor.timestamp);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        target = element;
      }
    }
  }
  if (!target) {
    return false;
  }
  const viewportRect = viewport.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  viewport.scrollTop += (targetRect.top - viewportRect.top) - anchor.offsetWithinViewport;
  return true;
}

export function viewportHasRenderableItems(viewport: HTMLElement | null): boolean {
  return viewport?.querySelector('[data-chat-item-key]') != null;
}
