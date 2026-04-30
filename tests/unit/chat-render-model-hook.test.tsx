import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useChatRenderModel } from '@/pages/Chat/chat-render-model';
import type { RawMessage } from '@/stores/chat';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';

vi.mock('@/pages/Chat/useExecutionGraphs', () => ({
  useExecutionGraphs: () => [{
    id: 'graph-1',
    anchorMessageKey: 'session:agent:main:main|id:message-2',
    triggerMessageKey: 'session:agent:main:main|id:message-2',
    agentLabel: 'main',
    sessionLabel: 'session',
    steps: [],
    active: false,
  }],
}));

function buildMessages(count: number): RawMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index + 1}`,
    timestamp: index + 1,
  }));
}

function buildRuntime() {
  return createEmptySessionRecord().runtime;
}

describe('useChatRenderModel', () => {
  it('builds stable message rows immediately and exposes anchored execution graph slots separately', () => {
    const initialMessages = buildMessages(40);
    const initialProps = {
      sessionKey: 'agent:main:main',
      messages: initialMessages,
      runtime: buildRuntime(),
      agents: [],
      isGatewayRunning: true,
      gatewayRpc: vi.fn(),
      showThinking: false,
    };

    const { result, rerender } = renderHook((props: typeof initialProps) => useChatRenderModel(props), {
      initialProps,
    });

    expect(result.current.rows).toHaveLength(initialMessages.length);
    expect(result.current.executionGraphSlots.anchoredGraphsByRowKey.get(result.current.rows[1]!.key)?.map((graph) => graph.id)).toEqual(['graph-1']);

    const nextMessages = [...initialMessages, {
      id: 'message-41',
      role: 'user' as const,
      content: 'message 41',
      timestamp: 41,
    }];

    rerender({
      ...initialProps,
      messages: nextMessages,
    });

    expect(result.current.rows).toHaveLength(nextMessages.length);
    expect(result.current.rows.every((row) => row.kind === 'message')).toBe(true);
    expect(result.current.executionGraphSlots.suppressedToolCardRowKeys.size).toBe(0);
  });

  it('exposes a single pending assistant shell when sending has started before the assistant stream lands', () => {
    const runtime = {
      ...buildRuntime(),
      sending: true,
      activeRunId: 'run-1',
      runPhase: 'submitted' as const,
    };

    const { result } = renderHook(() => useChatRenderModel({
      sessionKey: 'agent:main:main',
      messages: [],
      runtime,
      agents: [],
      isGatewayRunning: true,
      gatewayRpc: vi.fn(),
      showThinking: false,
    }));

    expect(result.current.rows).toHaveLength(0);
    expect(result.current.pendingAssistantShell).toMatchObject({
      state: 'typing',
    });
  });
});
