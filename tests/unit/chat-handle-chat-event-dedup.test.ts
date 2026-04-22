import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore, type RawMessage } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { disposeActiveStreamPacer } from '@/stores/chat/stream-pacer';
import { resetToolSnapshotTxnState } from '@/stores/chat/tool-snapshot-txn';

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

function getAssistantMessages(): RawMessage[] {
  return useChatStore.getState().messages.filter((message) => message.role === 'assistant');
}

async function drainStreamPacer(): Promise<void> {
  await vi.runAllTimersAsync();
}

function resetChatState(partial: Record<string, unknown> = {}): void {
  useChatStore.setState({
    messages: [],
    snapshotReady: true,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    error: null,
    sending: true,
    activeRunId: 'run-1',
    runPhase: 'streaming',
    streamingMessage: null,
    streamRuntime: null,
    streamingTools: [],
    pendingFinal: false,
    lastUserMessageAt: Date.now(),
    pendingToolImages: [],
    approvalStatus: 'idle',
    pendingApprovalsBySession: {},
    sessions: [{ key: 'agent:main:main', displayName: 'agent:main:main' }],
    currentSessionKey: 'agent:main:main',
    sessionLabels: {},
    sessionLastActivity: {},
    sessionReadyByKey: {},
    sessionRuntimeByKey: {},
    showThinking: true,
    thinkingLevel: null,
    loadHistory: vi.fn().mockResolvedValue(undefined),
    ...partial,
  } as never);
}

describe('chat.handleChatEvent 工具回合快照去重', () => {
  beforeEach(() => {
    disposeActiveStreamPacer();
    resetToolSnapshotTxnState();
    vi.useRealTimers();
    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc: vi.fn(),
    } as never);
    resetChatState();
  });

  afterEach(() => {
    disposeActiveStreamPacer();
    resetToolSnapshotTxnState();
    vi.useRealTimers();
  });

  it('工具回合快照带有自然语言文本时，后续最终回复不应再出现同文案重复两条', async () => {
    vi.useFakeTimers();
    resetChatState({
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
      streamRuntime: {
        sessionKey: 'agent:main:main',
        runId: 'run-1',
        chunks: ['在。'],
        rawChars: 2,
        displayedChars: 2,
        status: 'streaming',
        rafId: null,
      },
    });

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

    await drainStreamPacer();

    const assistantMessages = getAssistantMessages();
    const assistantTexts = assistantMessages.map(extractAssistantText);

    expect(assistantMessages).toHaveLength(2);
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

  it('tool-only delta 不生成可见 streamView 时，toolresult final 也不能丢工具回合快照', () => {
    resetChatState({
      activeRunId: 'run-frame-flush',
      runPhase: 'submitted',
    });

    useChatStore.getState().handleChatEvent({
      state: 'delta',
      runId: 'run-frame-flush',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'stream-tool-turn',
        content: [
          {
            type: 'tool_use',
            id: 'tool-call-flush',
            name: 'task_decision',
            input: { decision: 'direct' },
          },
        ],
      },
    });

    expect(useChatStore.getState().streamingMessage).toBeNull();

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-frame-flush',
      sessionKey: 'agent:main:main',
      message: {
        role: 'toolresult',
        toolCallId: 'tool-call-flush',
        content: '',
      },
    });

    const assistantMessages = getAssistantMessages();
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toEqual([
      {
        type: 'tool_use',
        id: 'tool-call-flush',
        name: 'task_decision',
        input: { decision: 'direct' },
      },
    ]);
  });

  it('authoritative user final 到达时，应与 optimistic user 合并而不是新增一条', () => {
    const sentAtMs = Date.now();
    resetChatState({
      messages: [
        {
          role: 'user',
          id: 'optimistic-user-1',
          content: '你能做什么',
          timestamp: sentAtMs / 1000,
        },
      ],
      activeRunId: 'run-user-merge-1',
      lastUserMessageAt: sentAtMs,
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-user-merge-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'user',
        id: 'gateway-user-1',
        content: '[Tue 2026-04-14 20:11 GMT+8]你能做什么 [message_id: u-1]',
        timestamp: (sentAtMs + 1200) / 1000,
      },
    });

    const userMessages = useChatStore.getState().messages.filter((message) => message.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.id).toBe('optimistic-user-1');
  });

  it('toolresult final 不应把纯文本 streaming assistant 快照进 messages，避免后续 assistant final 重复', async () => {
    vi.useFakeTimers();
    resetChatState({
      activeRunId: 'run-toolresult-no-toolcall',
      streamingMessage: {
        role: 'assistant',
        id: 'stream-plain-assistant',
        content: '好的，我来处理。',
      },
      streamRuntime: {
        sessionKey: 'agent:main:main',
        runId: 'run-toolresult-no-toolcall',
        chunks: ['好的，我来处理。'],
        rawChars: 8,
        displayedChars: 8,
        status: 'streaming',
        rafId: null,
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-toolresult-no-toolcall',
      sessionKey: 'agent:main:main',
      message: {
        role: 'toolresult',
        toolCallId: 'tool-call-noop',
        content: '',
      },
    });

    expect(getAssistantMessages()).toHaveLength(0);

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-toolresult-no-toolcall',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'assistant-final-no-dup',
        content: '好的，我来处理。',
      },
    });

    await drainStreamPacer();

    const assistantMessages = getAssistantMessages();
    const assistantTexts = assistantMessages.map(extractAssistantText);

    expect(assistantTexts.filter((text) => text === '好的，我来处理。')).toHaveLength(1);
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.id).toBe('assistant-final-no-dup');
  });

  it('同一轮 assistant final 文本一致但 id 不同，应按语义去重只保留一条', () => {
    resetChatState({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-existing',
          content: '你好呀，我在。',
        },
      ],
      activeRunId: 'run-assistant-semantic-dedup',
      pendingFinal: true,
      streamingMessage: {
        role: 'assistant',
        id: 'stream-assistant',
        content: '你好呀，我在。',
      },
      streamRuntime: {
        sessionKey: 'agent:main:main',
        runId: 'run-assistant-semantic-dedup',
        chunks: ['你好呀，我在。'],
        rawChars: 7,
        displayedChars: 7,
        status: 'streaming',
        rafId: null,
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-assistant-semantic-dedup',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'assistant-final-b',
        content: '你好呀，我在。',
      },
    });

    const assistantMessages = getAssistantMessages();
    const assistantTexts = assistantMessages.map(extractAssistantText);

    expect(assistantTexts.filter((text) => text === '你好呀，我在。')).toHaveLength(1);
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.id).toBe('assistant-existing');
  });
});
