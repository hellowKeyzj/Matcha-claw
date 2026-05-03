import { describe, expect, it } from 'vitest';
import { selectViewportTimelineEntries } from '@/stores/chat/store-state-helpers';
import { buildTimelineEntriesFromMessages, materializeTimelineMessages } from '@/stores/chat/timeline-message';
import { createViewportWindowState, syncViewportState } from '@/stores/chat/viewport-state';
import type { RawMessage } from '@/stores/chat';

function buildMessages(count: number): RawMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index + 1}`,
    timestamp: index + 1,
  }));
}

describe('viewport window state', () => {
  it('preserves only viewport metadata and derives the visible slice from messages + offsets', () => {
    const messages = buildMessages(40);
    const window = createViewportWindowState({
      totalMessageCount: 40,
      windowStartOffset: 10,
      windowEndOffset: 40,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });

    expect(window.windowStartOffset).toBe(10);
    expect(window.windowEndOffset).toBe(40);
    expect(window.totalMessageCount).toBe(40);
    expect(window.hasMore).toBe(true);
    expect(window.isAtLatest).toBe(true);
    expect(materializeTimelineMessages(selectViewportTimelineEntries({
      timelineEntries: buildTimelineEntriesFromMessages('agent:test:main', messages),
      window,
    })).map((message) => message.id)).toEqual(
      messages.slice(10).map((message) => message.id),
    );
  });

  it('syncViewportState updates paging metadata without owning message instances', () => {
    const messages = buildMessages(6);
    const baseWindow = createViewportWindowState({
      totalMessageCount: 6,
      windowStartOffset: 0,
      windowEndOffset: 6,
      isAtLatest: true,
    });

    const trimmedWindow = syncViewportState(baseWindow, createViewportWindowState({
      totalMessageCount: 6,
      windowStartOffset: 2,
      windowEndOffset: 6,
      hasMore: true,
      isAtLatest: true,
    }));

    expect(trimmedWindow.windowStartOffset).toBe(2);
    expect(trimmedWindow.windowEndOffset).toBe(6);
    expect(trimmedWindow.hasMore).toBe(true);
    expect(materializeTimelineMessages(selectViewportTimelineEntries({
      timelineEntries: buildTimelineEntriesFromMessages('agent:test:main', messages),
      window: trimmedWindow,
    })).map((message) => message.id)).toEqual([
      'message-3',
      'message-4',
      'message-5',
      'message-6',
    ]);
  });

  it('can materialize the viewport slice directly from authoritative timeline entries', () => {
    const messages = buildMessages(5);
    const timelineEntries = buildTimelineEntriesFromMessages('agent:test:main', messages);
    const window = createViewportWindowState({
      totalMessageCount: 5,
      windowStartOffset: 1,
      windowEndOffset: 4,
      hasMore: true,
      hasNewer: true,
      isAtLatest: false,
    });

    const viewportMessages = materializeTimelineMessages(selectViewportTimelineEntries({
      timelineEntries,
      window,
    }));

    expect(viewportMessages.map((message) => message.id)).toEqual([
      'message-2',
      'message-3',
      'message-4',
    ]);
    expect(viewportMessages.every((message) => Boolean(message._timeline?.entryId))).toBe(true);
  });
});
