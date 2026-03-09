import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';

describe('chat store sessions', () => {
  beforeEach(() => {
    vi.mocked(window.electron.ipcRenderer.invoke).mockReset();
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
      sessions: [],
      currentSessionKey: 'agent:main:main',
      showThinking: true,
      thinkingLevel: null,
    });
  });

  function mockGatewayRpcWithMainSession() {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel: unknown, ...args: unknown[]) => {
      if (channel !== 'gateway:rpc') {
        return { success: false, error: `Unexpected channel: ${String(channel)}` };
      }
      const method = String(args[0] ?? '');
      if (method === 'sessions.list') {
        return {
          success: true,
          result: {
            sessions: [{ key: 'agent:main:main' }],
          },
        };
      }
      if (method === 'chat.history') {
        return {
          success: true,
          result: {
            messages: [],
          },
        };
      }
      return { success: true, result: {} };
    });
    return invoke;
  }

  it('keeps canonical agent session key even if not returned by sessions.list', async () => {
    mockGatewayRpcWithMainSession();
    useChatStore.setState({
      currentSessionKey: 'agent:ontology-expert:ontology-expert',
    });

    await useChatStore.getState().loadSessions();

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:ontology-expert:ontology-expert');
    expect(state.sessions.map((session) => session.key)).toEqual([
      'agent:main:main',
      'agent:ontology-expert:ontology-expert',
    ]);
  });

  it('still falls back to first known session for non-agent legacy keys', async () => {
    mockGatewayRpcWithMainSession();
    useChatStore.setState({
      currentSessionKey: 'legacy-session',
      messages: [{ role: 'user', content: 'hi' }],
    });

    await useChatStore.getState().loadSessions();

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:main:main');
    expect(state.sessions.map((session) => session.key)).toEqual([
      'agent:main:main',
    ]);
  });

  it('newSession follows the currently selected agent prefix', () => {
    useChatStore.setState({
      sessions: [
        { key: 'agent:main:main' },
        { key: 'agent:business-expert:main' },
      ],
      currentSessionKey: 'agent:business-expert:main',
      messages: [],
    });

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1772973600000);
    try {
      useChatStore.getState().newSession();
    } finally {
      nowSpy.mockRestore();
    }

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:business-expert:session-1772973600000');
    expect(state.sessions.map((session) => session.key)).toContain('agent:business-expert:session-1772973600000');
  });

});
