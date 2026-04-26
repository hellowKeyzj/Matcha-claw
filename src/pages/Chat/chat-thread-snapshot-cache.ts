import type { ChatRenderItem } from './chat-render-items';
import type { ChatRow } from './chat-row-model';
import { getSessionCacheValue, rememberSessionCacheValue } from './chat-session-cache';

export interface ChatThreadRenderSnapshot {
  scopeKey: string;
  chatRows: ChatRow[];
  chatItems: ChatRenderItem[];
  suppressedToolCardRowKeys: Set<string>;
  hiddenHistoryCount: number;
  showBlockingLoading: boolean;
  isEmptyState: boolean;
  rowSliceCostMs: number;
  runtimeRowsCostMs: number;
}

const globalChatThreadSnapshotCache = new Map<string, ChatThreadRenderSnapshot>();

export function peekChatThreadRenderSnapshot(scopeKey: string): ChatThreadRenderSnapshot | undefined {
  const cached = getSessionCacheValue(globalChatThreadSnapshotCache, scopeKey);
  if (!cached || cached.scopeKey !== scopeKey) {
    return undefined;
  }
  return cached;
}

export function rememberChatThreadRenderSnapshot(snapshot: ChatThreadRenderSnapshot): void {
  rememberSessionCacheValue(globalChatThreadSnapshotCache, snapshot.scopeKey, snapshot);
}
