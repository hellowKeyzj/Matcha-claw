import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSidePanelController } from '@/pages/Chat/useChatSidePanelController';
import { useRuntimeHostStore } from '@/stores/gateway';
import { useLayoutStore } from '@/stores/layout';
import { useChatStore } from '@/stores/chat';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { createReadyResourceStatusState } from '@/lib/resource-state';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

describe('chat side panel controller', () => {
  beforeEach(() => {
    window.localStorage.clear();

    useRuntimeHostStore.setState({
      runtimeHost: { lifecycle: 'running' },
    } as never);

    const mainSession = createEmptySessionRecord();
    const mainSessionIdentity = createOpenClawTestSessionIdentity('agent:main:main');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: createReadyResourceStatusState(1),
      loadedSessions: {
        'agent:main:main': {
          ...mainSession,
          meta: {
            ...mainSession.meta,
            runtimeScopeKey: 'native:openclaw:openclaw:default',
            agentId: 'main',
            sessionIdentity: mainSessionIdentity,
          },
        },
      },
    } as never);

    useLayoutStore.setState({
      chatTakeoverMode: 'none',
    });
  });

  it('does not load sessions before Chat initializes the fixed runtime catalog', async () => {
    const loadSessions = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      sessionCatalogStatus: {
        status: 'idle',
        error: null,
        hasLoadedOnce: false,
        lastLoadedAt: null,
      },
      sessionRuntimeCatalog: {
        status: 'idle',
        error: null,
        endpoints: [],
        defaultSessionPromptScope: null,
      },
      loadSessions,
    } as never);

    const layoutNode = document.createElement('div');
    Object.defineProperty(layoutNode, 'clientWidth', {
      configurable: true,
      value: 900,
    });

    renderHook(() => useChatSidePanelController(true, { current: layoutNode }));

    await Promise.resolve();

    expect(loadSessions).not.toHaveBeenCalled();
  });

  it('ignores the deprecated stored open flag while restoring and persisting side panel width', () => {
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

    expect(result.current.sidePanelOpen).toBe(false);
    expect(result.current.activeSidePanelTab).toBe('artifacts');
    expect(result.current.sidePanelWidth).toBe(520);

    act(() => {
      result.current.setSidePanelWidth(900);
    });

    expect(result.current.sidePanelWidth).toBe(720);
    expect(window.localStorage.getItem('chat:side-panel-artifact-width')).toBe('720');
    expect(window.localStorage.getItem('chat:side-panel-light-width')).toBe('360');
  });

  it('keeps separate remembered widths for runtime and artifacts', () => {
    window.localStorage.setItem('chat:side-panel-tab', 'runtime');
    window.localStorage.setItem('chat:side-panel-light-width', '360');
    window.localStorage.setItem('chat:side-panel-artifact-width', '640');

    const layoutNode = document.createElement('div');
    Object.defineProperty(layoutNode, 'clientWidth', {
      configurable: true,
      value: 1200,
    });

    const { result } = renderHook(() => useChatSidePanelController(false, { current: layoutNode }));

    expect(result.current.activeSidePanelTab).toBe('runtime');
    expect(result.current.sidePanelWidth).toBe(360);

    act(() => {
      result.current.setActiveSidePanelTab('artifacts');
    });

    expect(result.current.activeSidePanelTab).toBe('artifacts');
    expect(result.current.sidePanelWidth).toBe(640);

    act(() => {
      result.current.setActiveSidePanelTab('runtime');
    });

    expect(result.current.activeSidePanelTab).toBe('runtime');
    expect(result.current.sidePanelWidth).toBe(360);
  });

  it('falls back from the retired tasks tab to artifacts', () => {
    window.localStorage.setItem('chat:side-panel-tab', 'tasks');
    window.localStorage.setItem('chat:side-panel-light-width', '360');
    window.localStorage.setItem('chat:side-panel-artifact-width', '640');

    const layoutNode = document.createElement('div');
    Object.defineProperty(layoutNode, 'clientWidth', {
      configurable: true,
      value: 1200,
    });

    const { result } = renderHook(() => useChatSidePanelController(false, { current: layoutNode }));

    expect(result.current.activeSidePanelTab).toBe('artifacts');
    expect(result.current.sidePanelWidth).toBe(640);
  });

  it('keeps artifact fullscreen scoped to the artifacts tab and exits when switching away', async () => {
    window.localStorage.setItem('chat:side-panel-tab', 'artifacts');
    window.localStorage.setItem('chat:side-panel-light-width', '360');
    window.localStorage.setItem('chat:side-panel-artifact-width', '640');

    const layoutNode = document.createElement('div');
    Object.defineProperty(layoutNode, 'clientWidth', {
      configurable: true,
      value: 1200,
    });

    const { result } = renderHook(() => useChatSidePanelController(false, { current: layoutNode }));

    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    expect(result.current.artifactWorkbenchFullscreen).toBe(false);

    act(() => {
      result.current.toggleArtifactWorkbenchFullscreen();
    });

    expect(result.current.artifactWorkbenchFullscreen).toBe(true);
    expect(result.current.sidePanelWidth).toBe(1200);

    act(() => {
      result.current.setActiveSidePanelTab('runtime');
    });

    expect(result.current.activeSidePanelTab).toBe('runtime');
    expect(result.current.artifactWorkbenchFullscreen).toBe(false);
    expect(result.current.sidePanelWidth).toBe(360);
  });
});
