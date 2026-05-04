import { describe, expect, it } from 'vitest';
import { selectViewportItems } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState, syncViewportState } from '@/stores/chat/viewport-state';
import { buildRenderItemsFromMessages, type RawMessage } from './helpers/timeline-fixtures';

function buildMessages(count: number): RawMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index + 1}`,
    timestamp: index + 1,
  }));
}

describe('viewport window state', () => {
  it('preserves only viewport metadata and derives the visible slice from items + offsets', () => {
    const items = buildRenderItemsFromMessages('agent:test:main', buildMessages(40));
    const window = createViewportWindowState({
      totalItemCount: 40,
      windowStartOffset: 10,
      windowEndOffset: 40,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });

    expect(window.windowStartOffset).toBe(10);
    expect(window.windowEndOffset).toBe(40);
    expect(window.totalItemCount).toBe(40);
    expect(window.hasMore).toBe(true);
    expect(window.isAtLatest).toBe(true);
    expect(selectViewportItems({ items, window }).map((item) => item.key)).toEqual(
      items.slice(10).map((item) => item.key),
    );
  });

  it('syncViewportState updates paging metadata without owning item instances', () => {
    const items = buildRenderItemsFromMessages('agent:test:main', buildMessages(6));
    const baseWindow = createViewportWindowState({
      totalItemCount: 6,
      windowStartOffset: 0,
      windowEndOffset: 6,
      isAtLatest: true,
    });

    const trimmedWindow = syncViewportState(baseWindow, createViewportWindowState({
      totalItemCount: 6,
      windowStartOffset: 2,
      windowEndOffset: 6,
      hasMore: true,
      isAtLatest: true,
    }));

    expect(trimmedWindow.windowStartOffset).toBe(2);
    expect(trimmedWindow.windowEndOffset).toBe(6);
    expect(trimmedWindow.hasMore).toBe(true);
    expect(selectViewportItems({ items, window: trimmedWindow }).map((item) => item.key)).toEqual([
      items[2]!.key,
      items[3]!.key,
      items[4]!.key,
      items[5]!.key,
    ]);
  });

  it('can select the viewport slice directly from authoritative items', () => {
    const items = buildRenderItemsFromMessages('agent:test:main', buildMessages(5));
    const window = createViewportWindowState({
      totalItemCount: 5,
      windowStartOffset: 1,
      windowEndOffset: 4,
      hasMore: true,
      hasNewer: true,
      isAtLatest: false,
    });

    const viewportItems = selectViewportItems({
      items,
      window,
    });

    expect(viewportItems.map((item) => item.key)).toEqual([
      items[1]!.key,
      items[2]!.key,
      items[3]!.key,
    ]);
    expect(viewportItems.every((item) => Boolean(item.key))).toBe(true);
  });
});
