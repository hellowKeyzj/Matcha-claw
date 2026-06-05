import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSidePanelController } from '@/pages/Chat/useChatSidePanelController';
import { useGatewayStore } from '@/stores/gateway';
import { useLayoutStore } from '@/stores/layout';
import { useTaskSnapshotStore } from '@/stores/chat/task-snapshot-store';
import { useChatStore } from '@/stores/chat';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { createReadyResourceStatusState } from '@/lib/resource-state';
import { createOpenClawTestRuntimeAddress } from './helpers/runtime-address-fixtures';

const listTaskSnapshotMock = vi.fn();

vi.mock('@/services/openclaw/task-manager-client', () => ({
  listTaskSnapshot: (...args: unknown[]) => listTaskSnapshotMock(...args),
}));

describe('chat side panel controller', () => {
  beforeEach(() => {
    window.localStorage.clear();

    useGatewayStore.setState({
      status: {
        processState: 'running',
        gatewayReady: true,
        healthSummary: 'healthy',
        transportState: 'connected',
        portReachable: true,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 1,
      },
    } as never);
    useTaskSnapshotStore.getState().cleanup('agent:main:main');
    useTaskSnapshotStore.getState().cleanup('agent:worker:session-1');

    listTaskSnapshotMock.mockReset();
    listTaskSnapshotMock.mockResolvedValue({ tasks: [], todos: [] });

    const mainSession = createEmptySessionRecord();
    const mainRuntimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: createReadyResourceStatusState(1),
      loadedSessions: {
        'agent:main:main': {
          ...mainSession,
          meta: {
            ...mainSession.meta,
            backendSessionKey: 'agent:main:main',
            agentId: 'main',
            runtimeAddress: mainRuntimeAddress,
          },
        },
      },
    } as never);

    useLayoutStore.setState({
      chatTakeoverMode: 'none',
    });
  });

  it('restores and persists side panel width with container clamping', () => {
    window.localStorage.setItem('chat:side-panel-open', '1');
    window.localStorage.setItem('chat:side-panel-tab', 'artifacts');
    window.localStorage.setItem('chat:side-panel-light-width', '360');
    window.localStorage.setItem('chat:side-panel-artifact-width', '520');

    const layoutNode = document.createElement('div');
    Object.defineProperty(layoutNode, 'clientWidth', {
      configurable: true,
      value: 900,
    });

    const { result } = renderHook(() => useChatSidePanelController(false, { current: layoutNode }));

    expect(result.current.sidePanelOpen).toBe(true);
    expect(result.current.activeSidePanelTab).toBe('artifacts');
    expect(result.current.sidePanelWidth).toBe(520);

    act(() => {
      result.current.setSidePanelWidth(900);
    });

    expect(result.current.sidePanelWidth).toBe(720);
    expect(window.localStorage.getItem('chat:side-panel-artifact-width')).toBe('720');
    expect(window.localStorage.getItem('chat:side-panel-light-width')).toBe('360');
  });

  it('keeps separate remembered widths for light tabs and artifacts', () => {
    window.localStorage.setItem('chat:side-panel-open', '1');
    window.localStorage.setItem('chat:side-panel-tab', 'tasks');
    window.localStorage.setItem('chat:side-panel-light-width', '360');
    window.localStorage.setItem('chat:side-panel-artifact-width', '640');

    const layoutNode = document.createElement('div');
    Object.defineProperty(layoutNode, 'clientWidth', {
      configurable: true,
      value: 1200,
    });

    const { result } = renderHook(() => useChatSidePanelController(false, { current: layoutNode }));

    expect(result.current.activeSidePanelTab).toBe('tasks');
    expect(result.current.sidePanelWidth).toBe(360);

    act(() => {
      result.current.setActiveSidePanelTab('artifacts');
    });

    expect(result.current.activeSidePanelTab).toBe('artifacts');
    expect(result.current.sidePanelWidth).toBe(640);

    act(() => {
      result.current.setActiveSidePanelTab('skills');
    });

    expect(result.current.activeSidePanelTab).toBe('skills');
    expect(result.current.sidePanelWidth).toBe(360);
  });

  it('keeps artifact fullscreen scoped to the artifacts tab and exits when switching away', () => {
    window.localStorage.setItem('chat:side-panel-open', '1');
    window.localStorage.setItem('chat:side-panel-tab', 'artifacts');
    window.localStorage.setItem('chat:side-panel-artifact-width', '640');

    const layoutNode = document.createElement('div');
    Object.defineProperty(layoutNode, 'clientWidth', {
      configurable: true,
      value: 1200,
    });

    const { result } = renderHook(() => useChatSidePanelController(false, { current: layoutNode }));

    expect(result.current.artifactWorkbenchFullscreen).toBe(false);

    act(() => {
      result.current.toggleArtifactWorkbenchFullscreen();
    });

    expect(result.current.artifactWorkbenchFullscreen).toBe(true);
    expect(result.current.sidePanelWidth).toBe(1200);

    act(() => {
      result.current.setActiveSidePanelTab('tasks');
    });

    expect(result.current.activeSidePanelTab).toBe('tasks');
    expect(result.current.artifactWorkbenchFullscreen).toBe(false);
    expect(result.current.sidePanelWidth).toBe(360);
  });

  it('aggregates unfinished task inbox tasks from the snapshot store across loaded sessions', () => {
    useChatStore.setState((state) => ({
      loadedSessions: {
        ...state.loadedSessions,
        'agent:worker:session-1': {
          ...state.loadedSessions['agent:main:main'],
          meta: {
            ...state.loadedSessions['agent:main:main'].meta,
            backendSessionKey: 'agent:worker:session-1',
            agentId: 'worker',
            runtimeAddress: createOpenClawTestRuntimeAddress('agent:worker:session-1', 'worker'),
          },
        },
      },
    }) as never);
    useTaskSnapshotStore.getState().reportTaskCenterData('agent:worker:session-1', [
      { id: '1', subject: '待做', description: '', status: 'pending', blockedBy: [], blocks: [], createdAt: 1, updatedAt: 3 },
      { id: '2', subject: '已完成', description: '', status: 'completed', blockedBy: [], blocks: [], createdAt: 1, updatedAt: 4 },
    ], { source: 'replay' });
    useTaskSnapshotStore.getState().reportTaskCenterData('agent:main:main', [
      { id: '3', subject: '进行中', description: '', status: 'in_progress', blockedBy: [], blocks: [], createdAt: 1, updatedAt: 2 },
    ], { source: 'replay' });

    const layoutNode = document.createElement('div');
    Object.defineProperty(layoutNode, 'clientWidth', {
      configurable: true,
      value: 900,
    });

    const { result } = renderHook(() => useChatSidePanelController(true, { current: layoutNode }));

    expect(result.current.unfinishedTaskCount).toBe(2);
    expect(result.current.taskInboxTasks.map((task) => task.subject)).toEqual(['待做', '进行中']);
    expect(result.current.taskInboxTasks.map((task) => task.sourceSessionKey)).toEqual(['agent:worker:session-1', 'agent:main:main']);
    expect(listTaskSnapshotMock).not.toHaveBeenCalled();
  });

  it('manual refresh writes task snapshots into the store without automatic polling', async () => {
    listTaskSnapshotMock.mockResolvedValue({
      scope: { type: 'session', key: 'agent:main:main', label: 'main', sessionKey: 'agent:main:main' },
      tasks: [
        { id: '1', subject: '手动刷新任务', description: '', status: 'pending', blockedBy: [], blocks: [], createdAt: 1, updatedAt: 2 },
      ],
      todos: [],
    });

    const layoutNode = document.createElement('div');
    Object.defineProperty(layoutNode, 'clientWidth', {
      configurable: true,
      value: 900,
    });

    const { result } = renderHook(() => useChatSidePanelController(true, { current: layoutNode }));

    expect(listTaskSnapshotMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.refreshTaskInbox();
    });

    expect(listTaskSnapshotMock).toHaveBeenCalledTimes(1);
    expect(listTaskSnapshotMock).toHaveBeenCalledWith({
      sessionKey: 'agent:main:main',
      runtimeAddress: createOpenClawTestRuntimeAddress('agent:main:main'),
    });
    expect(result.current.taskInboxTasks.map((task) => task.subject)).toEqual(['手动刷新任务']);
  });

  it('does not start overlapping manual task inbox refreshes', async () => {
    let resolveSnapshot: (value: unknown) => void = () => undefined;
    listTaskSnapshotMock.mockReturnValue(new Promise((resolve) => {
      resolveSnapshot = resolve;
    }));

    const layoutNode = document.createElement('div');
    Object.defineProperty(layoutNode, 'clientWidth', {
      configurable: true,
      value: 900,
    });

    const { result } = renderHook(() => useChatSidePanelController(true, { current: layoutNode }));

    let firstRefresh: Promise<void> | undefined;
    let secondRefresh: Promise<void> | undefined;
    act(() => {
      firstRefresh = result.current.refreshTaskInbox();
      secondRefresh = result.current.refreshTaskInbox();
    });

    expect(listTaskSnapshotMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSnapshot({
        scope: { type: 'session', key: 'agent:main:main', label: 'main', sessionKey: 'agent:main:main' },
        tasks: [
          { id: '1', subject: '单批刷新', description: '', status: 'pending', blockedBy: [], blocks: [], createdAt: 1, updatedAt: 2 },
        ],
        todos: [],
      });
      await Promise.all([firstRefresh, secondRefresh]);
    });

    expect(result.current.taskInboxTasks.map((task) => task.subject)).toEqual(['单批刷新']);
  });

  it('does not count session todos as task inbox tasks', async () => {
    listTaskSnapshotMock.mockResolvedValue({ tasks: [], todos: [
      { content: '分析页面结构', status: 'pending' },
      { content: '实现任务状态', status: 'in_progress' },
    ] });
    useTaskSnapshotStore.getState().notifyChatStarted('agent:main:main');

    const layoutNode = document.createElement('div');
    Object.defineProperty(layoutNode, 'clientWidth', {
      configurable: true,
      value: 900,
    });

    const { result } = renderHook(() => useChatSidePanelController(true, { current: layoutNode }));

    await waitFor(() => expect(result.current.taskInboxLoading).toBe(false));
    expect(result.current.unfinishedTaskCount).toBe(0);
    expect(result.current.derivedPlanStatus).toBeNull();
  });

  it('exposes derived plan status from the task snapshot store', () => {
    useTaskSnapshotStore.getState().reportTaskCenterData('agent:main:main', [
      { id: '1', subject: '进行中', description: '', status: 'in_progress', blocks: [], blockedBy: [] },
    ], { source: 'replay' });
    useTaskSnapshotStore.getState().notifyChatStarted('agent:main:main');

    const layoutNode = document.createElement('div');
    Object.defineProperty(layoutNode, 'clientWidth', {
      configurable: true,
      value: 900,
    });

    const { result } = renderHook(() => useChatSidePanelController(false, { current: layoutNode }));

    expect(result.current.derivedPlanStatus).toBe('building');
  });
});
