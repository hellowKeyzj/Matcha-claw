/**
 * Chat 滚动模型
 *
 * 模型语义：
 * - 每个 scope（一个会话）持有一个 follow/detached 的二态 phase。
 * - phase 是“用户跟随最新消息的意图”，是唯一意图源。
 * - 仅以下语义事件能写 phase：
 *     a. 用户主动阅读（滚轮上滑 / 触摸下滑 / 局部展开收起）→ detached
 *     b. 视口几何到达底部                         → follow
 *     c. 显式 jumpToBottom / 切 scope 强制贴底     → follow
 * - 流式追加、布局重排、程序写 scrollTop 等被动几何变化不能把 follow 反推成 detached。
 *
 * 几何快照只在一次同步处理内共享；真实滚动写入后失效，不跨事件缓存。
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

export class ChatViewportGeometry {
  private metricsSnapshot: ChatViewportMetrics | null = null;
  private viewportRect: DOMRect | null = null;
  private itemsSnapshot: NodeListOf<HTMLElement> | null = null;
  private hasItems: boolean | undefined;

  constructor(readonly viewport: HTMLElement | null) {}

  get metrics(): ChatViewportMetrics | null {
    return this.metricsSnapshot ??= readViewportMetrics(this.viewport);
  }

  hasRenderableItems(): boolean {
    return this.hasItems ??= this.viewport?.querySelector('[data-chat-item-key]') != null;
  }

  private get items(): NodeListOf<HTMLElement> | undefined {
    if (!this.viewport) return undefined;
    this.itemsSnapshot ??= this.viewport.querySelectorAll<HTMLElement>('[data-chat-item-key]');
    this.hasItems = this.itemsSnapshot.length > 0;
    return this.itemsSnapshot;
  }

  scrollTo(scrollTop: number): void {
    if (!this.viewport || (this.metricsSnapshot?.scrollTop ?? this.viewport.scrollTop) === scrollTop) return;
    this.writeScrollTop(scrollTop);
  }

  private writeScrollTop(scrollTop: number): void {
    this.viewport!.scrollTop = scrollTop;
    // 浏览器可能 clamp；后续消费者必须读取实际落位，不能预测写后的 metrics。
    this.metricsSnapshot = null;
    this.viewportRect = null;
  }

  sampleAnchor(): ViewportAnchor | null {
    if (!this.viewport) return null;
    const viewportRect = this.viewportRect ??= this.viewport.getBoundingClientRect();
    const items = this.items!;
    for (const [index, item] of items.entries()) {
      const rect = item.getBoundingClientRect();
      if (rect.bottom <= viewportRect.top || rect.top >= viewportRect.bottom) continue;
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

  restoreElement(element: HTMLElement, offsetWithinViewport: number): boolean {
    if (!this.viewport || !element.isConnected || !this.viewport.contains(element)) return false;
    const viewportRect = this.viewportRect ??= this.viewport.getBoundingClientRect();
    const delta = element.getBoundingClientRect().top - viewportRect.top - offsetWithinViewport;
    if (delta !== 0) this.writeScrollTop((this.metricsSnapshot?.scrollTop ?? this.viewport.scrollTop) + delta);
    return true;
  }

  restoreAnchor(anchor: ViewportAnchor): boolean {
    const items = this.items;
    if (!items) return false;
    let target: HTMLElement | undefined;
    if (anchor.itemKey) {
      for (const [index, item] of items.entries()) {
        if (item.dataset.chatItemKey !== anchor.itemKey) continue;
        if (!anchor.followingItemKey || items[index + 1]?.dataset.chatItemKey === anchor.followingItemKey) {
          target = item;
        }
        break;
      }
    }
    if (!target && typeof anchor.timestamp === 'number') {
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const element of items) {
        const tsText = element.dataset.chatMessageTimestamp;
        const ts = tsText && tsText.trim() ? Number(tsText) : NaN;
        if (!Number.isFinite(ts)) continue;
        const distance = Math.abs(ts - anchor.timestamp);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          target = element;
        }
      }
    }
    return target ? this.restoreElement(target, anchor.offsetWithinViewport) : false;
  }
}

/** 取首条与视口相交的消息及其偏移，供替页到位后恢复。 */
export function sampleViewportAnchor(viewport: HTMLElement | null): ViewportAnchor | null {
  return new ChatViewportGeometry(viewport).sampleAnchor();
}
