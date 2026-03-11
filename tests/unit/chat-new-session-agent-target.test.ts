import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';

describe('chat store newSession agent targeting', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useChatStore.setState({
      messages: [],
      loading: false,
      error: null,
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      sessions: [
        { key: 'agent:main:main', displayName: 'agent:main:main' },
        { key: 'agent:test:main', displayName: 'agent:test:main' },
      ],
      currentSessionKey: 'agent:test:main',
      sessionLabels: {},
      sessionLastActivity: {},
      showThinking: true,
      thinkingLevel: null,
    } as never);
  });

  it('新会话应继承当前选中 agent，而不是 sessions 首项 agent', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_711_111_111_111);

    useChatStore.getState().newSession();

    expect(useChatStore.getState().currentSessionKey).toBe('agent:test:session-1711111111111');
    nowSpy.mockRestore();
  });
});

