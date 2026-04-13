import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore, type RawMessage } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';

function extractAssistantText(message: RawMessage): string {
  if (typeof message.content === 'string') {
    return message.content.trim();
  }
  if (!Array.isArray(message.content)) {
    return '';
  }
  return message.content
    .filter((block): block is { type: string; text?: string } => typeof block === 'object' && block != null)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!.trim())
    .filter(Boolean)
    .join('\n');
}

describe('chat.handleChatEvent 工具回合快照去重', () => {
  beforeEach(() => {
    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc: vi.fn(),
    } as never);

    useChatStore.setState({
      messages: [],
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      error: null,
      sending: true,
      activeRunId: 'run-1',
      streamingText: '',
      streamingMessage: {
        role: 'assistant',
        id: 'stream-tool-turn',
        content: [
          { type: 'text', text: '在。' },
          {
            type: 'tool_use',
            id: 'tool-call-1',
            name: 'task_decision',
            input: { decision: 'direct' },
          },
        ],
      },
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      approvalStatus: 'idle',
      sessions: [{ key: 'agent:main:main', displayName: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      sessionLabels: {},
      sessionLastActivity: {},
      sessionRuntimeByKey: {},
      showThinking: true,
      thinkingLevel: null,
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it('工具回合快照带有自然语言文本时，后续最终回复不应再出现同文案重复两条', () => {
    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'toolresult',
        toolCallId: 'tool-call-1',
        content: '',
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'assistant-final-1',
        content: '在。',
      },
    });

    const assistantMessages = useChatStore.getState().messages.filter((message) => message.role === 'assistant');
    const assistantTexts = assistantMessages.map(extractAssistantText);

    expect(assistantTexts.filter((text) => text === '在。')).toHaveLength(1);
    expect(assistantMessages[0]?.content).toEqual([
      {
        type: 'tool_use',
        id: 'tool-call-1',
        name: 'task_decision',
        input: { decision: 'direct' },
      },
    ]);
  });
});
