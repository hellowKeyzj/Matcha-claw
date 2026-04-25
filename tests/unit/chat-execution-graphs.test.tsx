import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawMessage } from '@/stores/chat';
import * as taskViz from '@/pages/Chat/task-viz';
import { useExecutionGraphs } from '@/pages/Chat/useExecutionGraphs';

const trackUiTimingMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/telemetry', () => ({
  trackUiTiming: (...args: unknown[]) => trackUiTimingMock(...args),
}));

const INTERNAL_COMPLETION_EVENT = `[Internal task completion event]
source: subagent
session_key: agent:coder:subagent:child-1
session_id: child-session-id
status: completed successfully`;
const INTERNAL_COMPLETION_EVENT_PLANNER = `[Internal task completion event]
source: subagent
session_key: agent:planner:subagent:child-2
session_id: child-session-id-2
status: completed successfully`;

const BASE_MESSAGES: RawMessage[] = [
  {
    id: 'user-1',
    role: 'user',
    content: '请执行任务',
    timestamp: 1,
  },
  {
    id: 'event-1',
    role: 'user',
    content: [{ type: 'text', text: INTERNAL_COMPLETION_EVENT }],
    timestamp: 2,
  },
  {
    id: 'assistant-1',
    role: 'assistant',
    content: '任务完成',
    timestamp: 3,
  },
];
const TWO_ANCHOR_MESSAGES: RawMessage[] = [
  {
    id: 'user-1',
    role: 'user',
    content: '请执行任务 1',
    timestamp: 1,
  },
  {
    id: 'event-1',
    role: 'user',
    content: [{ type: 'text', text: INTERNAL_COMPLETION_EVENT }],
    timestamp: 2,
  },
  {
    id: 'assistant-1',
    role: 'assistant',
    content: '任务 1 完成',
    timestamp: 3,
  },
  {
    id: 'user-2',
    role: 'user',
    content: '请执行任务 2',
    timestamp: 4,
  },
  {
    id: 'event-2',
    role: 'user',
    content: [{ type: 'text', text: INTERNAL_COMPLETION_EVENT_PLANNER }],
    timestamp: 5,
  },
  {
    id: 'assistant-2',
    role: 'assistant',
    content: '任务 2 完成',
    timestamp: 6,
  },
];

function buildProps(messages: RawMessage[]) {
  return {
    enabled: true,
    messages,
    currentSessionKey: 'agent:main:session-1',
    agents: [{ id: 'coder', name: 'Coder' }],
    isGatewayRunning: true,
    gatewayRpc: vi.fn(() => new Promise<Record<string, unknown>>(() => {})),
    sending: false,
    pendingFinal: false,
    showThinking: true,
    streamingMessage: null,
    streamingTools: [],
  };
}

describe('useExecutionGraphs incremental compute', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    trackUiTimingMock.mockReset();
  });

  it('reuses unchanged anchor prefix when appending unrelated messages', async () => {
    vi.useFakeTimers();
    const deriveSpy = vi.spyOn(taskViz, 'deriveTaskSteps');
    const initialProps = buildProps(BASE_MESSAGES);
    const { rerender, result } = renderHook((props: ReturnType<typeof buildProps>) => useExecutionGraphs(props), {
      initialProps,
    });

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    expect(result.current.executionGraphs.length).toBe(1);
    const initialDeriveCalls = deriveSpy.mock.calls.length;
    expect(initialDeriveCalls).toBeGreaterThan(0);

    rerender(buildProps([
      ...BASE_MESSAGES,
      {
        id: 'assistant-tail',
        role: 'assistant',
        content: '这是无关的尾部消息',
        timestamp: 4,
      },
    ]));

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    expect(result.current.executionGraphs.length).toBe(1);
    expect(deriveSpy.mock.calls.length).toBe(initialDeriveCalls);
    expect(trackUiTimingMock).toHaveBeenCalled();
    const [eventName, durationMs, payload] = trackUiTimingMock.mock.calls[trackUiTimingMock.mock.calls.length - 1];
    expect(eventName).toBe('chat.exec_graph_pipeline');
    expect(typeof durationMs).toBe('number');
    expect(payload).toEqual(expect.objectContaining({
      outcome: 'completed',
      anchors: 1,
      graphCount: 1,
    }));
  });

  it('reuses exact cache when inputs are semantically equal but refs change', async () => {
    vi.useFakeTimers();
    const initialProps = buildProps(BASE_MESSAGES);
    const { rerender } = renderHook((props: ReturnType<typeof buildProps>) => useExecutionGraphs(props), {
      initialProps,
    });

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    const initialPipelineCalls = trackUiTimingMock.mock.calls.filter(
      ([event]) => event === 'chat.exec_graph_pipeline',
    ).length;
    expect(initialPipelineCalls).toBeGreaterThan(0);

    rerender({
      ...buildProps(BASE_MESSAGES),
      streamingTools: [],
    });

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    const nextPipelineCalls = trackUiTimingMock.mock.calls.filter(
      ([event]) => event === 'chat.exec_graph_pipeline',
    ).length;
    expect(nextPipelineCalls).toBe(initialPipelineCalls);
  });

  it('reuses unchanged suffix anchors when early anchor signature changes', async () => {
    vi.useFakeTimers();
    const initialProps = {
      ...buildProps(TWO_ANCHOR_MESSAGES),
      agents: [
        { id: 'coder', name: 'Coder' },
        { id: 'planner', name: 'Planner' },
      ],
    };
    const { rerender, result } = renderHook((
      props: ReturnType<typeof buildProps> & {
        agents: Array<{ id: string; name: string }>;
      },
    ) => useExecutionGraphs(props), {
      initialProps,
    });

    await act(async () => {
      for (let round = 0; round < 4; round += 1) {
        vi.runOnlyPendingTimers();
        await Promise.resolve();
      }
    });
    expect(result.current.executionGraphs.length).toBe(2);

    rerender({
      ...initialProps,
      agents: [
        { id: 'coder', name: 'Coder v2' },
        { id: 'planner', name: 'Planner' },
      ],
    });

    await act(async () => {
      for (let round = 0; round < 4; round += 1) {
        vi.runOnlyPendingTimers();
        await Promise.resolve();
      }
    });

    expect(result.current.executionGraphs.length).toBe(2);
    const pipelineCalls = trackUiTimingMock.mock.calls.filter(
      ([event]) => event === 'chat.exec_graph_pipeline',
    );
    expect(pipelineCalls.length).toBeGreaterThanOrEqual(2);
    const [, , payload] = pipelineCalls[pipelineCalls.length - 1];
    expect(payload).toEqual(expect.objectContaining({
      anchors: 2,
      reusedAnchors: 1,
      computedAnchors: 1,
      graphCount: 2,
      outcome: 'completed',
    }));
  });
});
