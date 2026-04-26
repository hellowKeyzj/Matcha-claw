import { describe, expect, it } from 'vitest';
import { summarizeChatStoreMemory } from '@/lib/chat-memory-diagnostics';
import { useChatStore, type ChatStoreState } from '@/stores/chat';

function createStateWithSessions(
  sessionsByKey: ChatStoreState['sessionsByKey'],
): ChatStoreState {
  return {
    ...useChatStore.getInitialState(),
    sessionsByKey,
  };
}

describe('chat memory diagnostics', () => {
  it('summarizes transcript, preview, and overlay memory by session', () => {
    const state = createStateWithSessions({
      'agent:main:main': {
        transcript: [
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
        meta: {
          label: 'main',
          lastActivityAt: 2000,
          ready: true,
          thinkingLevel: null,
        },
        runtime: {
          ...useChatStore.getInitialState().sessionsByKey['agent:main:main']!.runtime,
          pendingUserMessage: {
            clientMessageId: 'pending-user',
            createdAtMs: 3000,
            message: {
              role: 'user',
              id: 'pending-user',
              timestamp: 3,
              content: 'pending content',
            },
          },
          assistantOverlay: {
            runId: 'run-1',
            messageId: 'overlay-1',
            committedText: 'abc',
            targetText: 'abcdef',
            status: 'streaming',
            rafId: null,
            sourceMessage: {
              role: 'assistant',
              id: 'overlay-source',
              timestamp: 4,
              content: 'stream source',
            },
          },
        },
      },
      'agent:other:main': {
        transcript: [
          {
            role: 'assistant',
            id: 'assistant-2',
            timestamp: 5,
            content: 'short',
          },
        ],
        meta: {
          label: 'other',
          lastActivityAt: 1000,
          ready: false,
          thinkingLevel: null,
        },
        runtime: useChatStore.getInitialState().sessionsByKey['agent:main:main']!.runtime,
      },
    });

    const summary = summarizeChatStoreMemory(state);

    expect(summary.sessionCount).toBe(2);
    expect(summary.readySessionCount).toBe(1);
    expect(summary.totalMessageCount).toBe(3);
    expect(summary.totalAttachedFileCount).toBe(1);
    expect(summary.totalPreviewCharCount).toBe('data:image/png;base64,AAAA'.length);
    expect(summary.totalDataUrlPreviewCharCount).toBe('data:image/png;base64,AAAA'.length);
    expect(summary.totalOverlayCharCount).toBeGreaterThan(0);
    expect(summary.approxRetainedBytes).toBeGreaterThan(0);
    expect(summary.largestSessions[0]?.sessionKey).toBe('agent:main:main');
    expect(summary.largestSessions[0]?.messageCount).toBe(2);
    expect(summary.largestSessions[0]?.attachedFileCount).toBe(1);
    expect(summary.largestSessions[0]?.overlayCharCount).toBeGreaterThan(0);
  });
});
