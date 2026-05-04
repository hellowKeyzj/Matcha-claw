import { describe, expect, it } from 'vitest';
import { selectViewportRows } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState, syncViewportState } from '@/stores/chat/viewport-state';
import { buildRenderRowsFromMessages, type RawMessage } from './helpers/timeline-fixtures';

function buildMessages(count: number): RawMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index + 1}`,
    timestamp: index + 1,
  }));
}

describe('viewport window state', () => {
  it('preserves only viewport metadata and derives the visible slice from rows + offsets', () => {
    const rows = buildRenderRowsFromMessages('agent:test:main', buildMessages(40));
    const window = createViewportWindowState({
      totalRowCount: 40,
      windowStartOffset: 10,
      windowEndOffset: 40,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });

    expect(window.windowStartOffset).toBe(10);
    expect(window.windowEndOffset).toBe(40);
    expect(window.totalRowCount).toBe(40);
    expect(window.hasMore).toBe(true);
    expect(window.isAtLatest).toBe(true);
    expect(selectViewportRows({ rows, window }).map((row) => row.rowId)).toEqual(
      rows.slice(10).map((row) => row.rowId),
    );
  });

  it('syncViewportState updates paging metadata without owning row instances', () => {
    const rows = buildRenderRowsFromMessages('agent:test:main', buildMessages(6));
    const baseWindow = createViewportWindowState({
      totalRowCount: 6,
      windowStartOffset: 0,
      windowEndOffset: 6,
      isAtLatest: true,
    });

    const trimmedWindow = syncViewportState(baseWindow, createViewportWindowState({
      totalRowCount: 6,
      windowStartOffset: 2,
      windowEndOffset: 6,
      hasMore: true,
      isAtLatest: true,
    }));

    expect(trimmedWindow.windowStartOffset).toBe(2);
    expect(trimmedWindow.windowEndOffset).toBe(6);
    expect(trimmedWindow.hasMore).toBe(true);
    expect(selectViewportRows({ rows, window: trimmedWindow }).map((row) => row.rowId)).toEqual([
      'message-3',
      'message-4',
      'message-5',
      'message-6',
    ]);
  });

  it('can select the viewport slice directly from authoritative rows', () => {
    const rows = buildRenderRowsFromMessages('agent:test:main', buildMessages(5));
    const window = createViewportWindowState({
      totalRowCount: 5,
      windowStartOffset: 1,
      windowEndOffset: 4,
      hasMore: true,
      hasNewer: true,
      isAtLatest: false,
    });

    const viewportRows = selectViewportRows({
      rows,
      window,
    });

    expect(viewportRows.map((row) => row.rowId)).toEqual([
      'message-2',
      'message-3',
      'message-4',
    ]);
    expect(viewportRows.every((row) => Boolean(row.rowId))).toBe(true);
  });
});
