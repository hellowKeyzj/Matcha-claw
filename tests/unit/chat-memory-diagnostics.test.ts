import { describe, expect, it } from 'vitest';
import { summarizeChatStoreMemory } from '@/lib/chat-memory-diagnostics';
import { useChatStore, type ChatStoreState } from '@/stores/chat';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

function createStateWithSessions(
  loadedSessions: ChatStoreState['loadedSessions'],
): ChatStoreState {
  return {
    ...useChatStore.getInitialState(),
    loadedSessions,
  };
}

describe('chat memory diagnostics', () => {
  it('summarizes window, preview, and runtime-state memory by session', () => {
    const state = createStateWithSessions({
      'agent:main:main': {
        messages: [
          {
            role: 'user',
            id: 'user-1',
            timestamp: 1,
            content: 'hello world',
            _attachedFiles: [
              {
                fileName: 'shot.png',
                mimeType: 'image/png',
                fileSize: 12,
                preview: 'data:image/png;base64,AAAA',
                filePath: 'C:/shot.png',
              },
            ],
          },
          {
            role: 'assistant',
            id: 'assistant-1',
            timestamp: 2,
            content: [{ type: 'text', text: 'answer body' }],
          },
        ],
        window: createViewportWindowState({
          totalMessageCount: 2,
          windowStartOffset: 0,
          windowEndOffset: 2,
          isAtLatest: true,
        }),
        meta: {
          label: 'main',
          lastActivityAt: 2000,
          historyStatus: 'ready',
          thinkingLevel: null,
        },
        runtime: {
          ...useChatStore.getInitialState().loadedSessions['agent:main:main']!.runtime,
          streamingMessageId: 'overlay-1',
        },
      },
      'agent:other:main': {
        messages: [
          {
            role: 'assistant',
            id: 'assistant-2',
            timestamp: 5,
            content: 'short',
          },
        ],
        window: createViewportWindowState({
          totalMessageCount: 1,
          windowStartOffset: 0,
          windowEndOffset: 1,
          isAtLatest: true,
        }),
        meta: {
          label: 'other',
          lastActivityAt: 1000,
          historyStatus: 'idle',
          thinkingLevel: null,
        },
        runtime: useChatStore.getInitialState().loadedSessions['agent:main:main']!.runtime,
      },
    });

    const summary = summarizeChatStoreMemory(state);

    expect(summary.sessionCount).toBe(2);
    expect(summary.readySessionCount).toBe(1);
    expect(summary.totalMessageCount).toBe(3);
    expect(summary.totalAttachedFileCount).toBe(1);
    expect(summary.totalPreviewCharCount).toBe('data:image/png;base64,AAAA'.length);
    expect(summary.totalDataUrlPreviewCharCount).toBe('data:image/png;base64,AAAA'.length);
    expect(summary.totalRuntimeStateCharCount).toBeGreaterThan(0);
    expect(summary.approxRetainedBytes).toBeGreaterThan(0);
    expect(summary.largestSessions[0]?.sessionKey).toBe('agent:main:main');
    expect(summary.largestSessions[0]?.messageCount).toBe(2);
    expect(summary.largestSessions[0]?.attachedFileCount).toBe(1);
    expect(summary.largestSessions[0]?.runtimeStateCharCount).toBeGreaterThan(0);
  });
});
