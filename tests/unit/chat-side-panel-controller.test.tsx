import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSidePanelController } from '@/pages/Chat/useChatSidePanelController';
import { useGatewayStore } from '@/stores/gateway';
import { useLayoutStore } from '@/stores/layout';
import { useTaskCenterStore } from '@/stores/task-center-store';
import { useTaskSnapshotStore } from '@/stores/chat/task-snapshot-store';

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

    useTaskCenterStore.setState({
      tasks: [],
      initialized: true,
      loading: false,
      error: null,
      init: vi.fn().mockResolvedValue(undefined),
      refreshTasks: vi.fn().mockResolvedValue(undefined),
    } as never);
    useTaskSnapshotStore.getState().cleanup('agent:main:main');

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

    const { result } = renderHook(() => useChatSidePanelController(true, { current: layoutNode }));

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

    const { result } = renderHook(() => useChatSidePanelController(true, { current: layoutNode }));

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

    const { result } = renderHook(() => useChatSidePanelController(true, { current: layoutNode }));

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

  it('counts only pending and in-progress tasks for the header badge', () => {
    useTaskSnapshotStore.getState().reportTaskData('agent:main:main', [
      { id: '1', subject: '待做', description: '', status: 'pending', blocks: [], blockedBy: [] },
      { id: '2', subject: '进行中', description: '', status: 'in_progress', blocks: [], blockedBy: [] },
      { id: '3', subject: '已完成', description: '', status: 'completed', blocks: [], blockedBy: [] },
      { id: '4', subject: '已删除', description: '', status: 'deleted', blocks: [], blockedBy: [] },
    ], { source: 'replay' });

    const layoutNode = document.createElement('div');
    Object.defineProperty(layoutNode, 'clientWidth', {
      configurable: true,
      value: 900,
    });

    const { result } = renderHook(() => useChatSidePanelController(true, { current: layoutNode }));

    expect(result.current.unfinishedTaskCount).toBe(2);
  });

  it('does not count session todos as task inbox tasks', () => {
    useTaskSnapshotStore.getState().reportTodos('agent:main:main', [
      { content: '分析页面结构', status: 'pending' },
      { content: '实现任务状态', status: 'in_progress' },
    ]);
    useTaskSnapshotStore.getState().notifyChatStarted('agent:main:main');

    const layoutNode = document.createElement('div');
    Object.defineProperty(layoutNode, 'clientWidth', {
      configurable: true,
      value: 900,
    });

    const { result } = renderHook(() => useChatSidePanelController(true, { current: layoutNode }));

    expect(result.current.unfinishedTaskCount).toBe(0);
    expect(result.current.derivedPlanStatus).toBeNull();
  });

  it('exposes derived plan status from the task snapshot store', () => {
    useTaskSnapshotStore.getState().reportTaskData('agent:main:main', [
      { id: '1', subject: '进行中', description: '', status: 'in_progress', blocks: [], blockedBy: [] },
    ], { source: 'replay' });
    useTaskSnapshotStore.getState().notifyChatStarted('agent:main:main');

    const layoutNode = document.createElement('div');
    Object.defineProperty(layoutNode, 'clientWidth', {
      configurable: true,
      value: 900,
    });

    const { result } = renderHook(() => useChatSidePanelController(true, { current: layoutNode }));

    expect(result.current.derivedPlanStatus).toBe('building');
  });
});
