import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawMessage } from '@/stores/chat';
import * as taskViz from '@/pages/Chat/task-viz';
import { useExecutionGraphs } from '@/pages/Chat/useExecutionGraphs';
import { buildTimelineEntriesFromMessages } from '@/stores/chat/timeline-message';
import type { SessionTimelineEntry } from '../../../runtime-host/shared/session-adapter-types';

const trackUiTimingMock = vi.hoisted(() => vi.fn());
const fetchChatTimelineMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock('@/lib/telemetry', () => ({
  trackUiTiming: (...args: unknown[]) => trackUiTimingMock(...args),
}));

vi.mock('@/services/openclaw/session-runtime', () => ({
  fetchChatTimeline: (...args: unknown[]) => fetchChatTimelineMock(...args),
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

const BASE_TIMELINE_ENTRIES = buildTimelineEntriesFromMessages('agent:main:session-1', BASE_MESSAGES);
const TWO_ANCHOR_TIMELINE_ENTRIES = buildTimelineEntriesFromMessages('agent:main:session-1', TWO_ANCHOR_MESSAGES);

function buildProps(timelineEntries: SessionTimelineEntry[]) {
  return {
    enabled: true,
    timelineEntries,
    currentSessionKey: 'agent:main:session-1',
    agents: [{ id: 'coder', name: 'Coder' }],
    isGatewayRunning: true,
    showThinking: true,
  };
}

describe('useExecutionGraphs incremental compute', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    trackUiTimingMock.mockReset();
    fetchChatTimelineMock.mockReset();
  });

  it('reuses unchanged anchor prefix when appending unrelated messages', async () => {
    vi.useFakeTimers();
    const deriveSpy = vi.spyOn(taskViz, 'deriveTaskSteps');
    const initialProps = buildProps(BASE_TIMELINE_ENTRIES);
    const { rerender, result } = renderHook((props: ReturnType<typeof buildProps>) => useExecutionGraphs(props), {
      initialProps,
    });

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    expect(result.current.length).toBe(1);
    const initialDeriveCalls = deriveSpy.mock.calls.length;
    expect(initialDeriveCalls).toBeGreaterThan(0);

    rerender(buildProps([
      ...BASE_TIMELINE_ENTRIES,
      buildTimelineEntriesFromMessages('agent:main:session-1', [{
        id: 'assistant-tail',
        role: 'assistant',
        content: '这是无关的尾部消息',
        timestamp: 4,
      }])[0]!,
    ]));

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    expect(result.current.length).toBe(1);
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

  it('does not restart the graph pipeline for token-only runtime changes when messages are unchanged', async () => {
    vi.useFakeTimers();
    const initialProps = buildProps(BASE_TIMELINE_ENTRIES);
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

    const nextProps = {
      ...buildProps(BASE_TIMELINE_ENTRIES),
      sending: true,
      pendingFinal: true,
      streamingMessage: {
        id: 'assistant-live',
        role: 'assistant',
        content: 'still streaming',
        timestamp: 999,
      },
      streamingTools: [{
        name: 'shell',
        status: 'running' as const,
        updatedAt: 999,
      }],
    };
    rerender(nextProps);

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
      ...buildProps(TWO_ANCHOR_TIMELINE_ENTRIES),
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
    expect(result.current.length).toBe(2);

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

    expect(result.current.length).toBe(2);
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
