import { useMemo } from 'react';
import type { ChatRow } from './chat-row-model';
import { getSessionCacheValue, rememberSessionCacheValue } from './chat-session-cache';

export type ChatRenderItem =
  | {
    kind: 'group';
    key: string;
    role: 'user' | 'assistant';
    rows: Array<Extract<ChatRow, { kind: 'message' }>>;
  }
  | {
    kind: 'row';
    key: string;
    row: ChatRow;
  };

interface SessionRenderItemsCache {
  rowsRef: ChatRow[];
  items: ChatRenderItem[];
}

const globalRenderItemsCache = new Map<string, SessionRenderItemsCache>();

function resolveGroupRole(row: Extract<ChatRow, { kind: 'message' }>): 'user' | 'assistant' | null {
  const role = typeof row.message.role === 'string' ? row.message.role.toLowerCase() : '';
  if (role === 'user') {
    return 'user';
  }
  if (role === 'assistant') {
    return 'assistant';
  }
  return null;
}

export function buildChatRenderItems(rows: ChatRow[]): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];
  let currentGroup: Extract<ChatRenderItem, { kind: 'group' }> | null = null;

  const flushCurrentGroup = () => {
    if (!currentGroup) {
      return;
    }
    items.push(currentGroup);
    currentGroup = null;
  };

  for (const row of rows) {
    if (row.kind !== 'message') {
      flushCurrentGroup();
      items.push({
        kind: 'row',
        key: row.key,
        row,
      });
      continue;
    }

    const nextRole = resolveGroupRole(row);
    if (!nextRole) {
      flushCurrentGroup();
      items.push({
        kind: 'row',
        key: row.key,
        row,
      });
      continue;
    }

    if (!currentGroup || currentGroup.role !== nextRole) {
      flushCurrentGroup();
      currentGroup = {
        kind: 'group',
        key: `group:${nextRole}:${row.key}`,
        role: nextRole,
        rows: [row],
      };
      continue;
    }

    currentGroup.rows.push(row);
  }

  flushCurrentGroup();
  return items;
}

export function useChatRenderItems(
  currentSessionKey: string,
  rows: ChatRow[],
): ChatRenderItem[] {
  return useMemo(() => {
    const cached = getSessionCacheValue(globalRenderItemsCache, currentSessionKey);
    if (cached && cached.rowsRef === rows) {
      return cached.items;
    }

    const items = buildChatRenderItems(rows);
    rememberSessionCacheValue(globalRenderItemsCache, currentSessionKey, {
      rowsRef: rows,
      items,
    });
    return items;
  }, [currentSessionKey, rows]);
}
