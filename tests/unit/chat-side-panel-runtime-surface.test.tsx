import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSidePanel } from '@/pages/Chat/components/ChatSidePanel';
import {
  openChatRuntimeSurface,
  useChatSidePanelController,
  type ChatRuntimeSurfaceDescriptor,
} from '@/pages/Chat/useChatSidePanelController';
import { useGatewayStore } from '@/stores/gateway';
import { useLayoutStore } from '@/stores/layout';
import { useChatStore } from '@/stores/chat';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { createReadyResourceStatusState } from '@/lib/resource-state';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

const mocks = vi.hoisted(() => ({
  hostOpenClawBrowserRequest: vi.fn(),
  hostOpenClawMcpAppRequest: vi.fn(),
}));

vi.mock('@/lib/host-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/host-api')>();
  return {
    ...actual,
    hostOpenClawBrowserRequest: (...args: unknown[]) => mocks.hostOpenClawBrowserRequest(...args),
    hostOpenClawMcpAppRequest: (...args: unknown[]) => mocks.hostOpenClawMcpAppRequest(...args),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'artifacts.sectionLabel') {
        return '产物';
      }
      return key;
    },
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/components/file-preview/FilePreviewBody', () => ({
  FilePreviewBody: () => <div data-testid="artifact-preview-body" />,
}));

vi.mock('@/components/file-preview/WorkspaceBrowserBody', () => ({
  WorkspaceBrowserBody: () => <div data-testid="workspace-browser-body" />,
}));

const browserSurface = {
  kind: 'browser-tab',
  targetId: 'target-browser-1',
  profile: 'default',
  target: 'host',
  title: 'Browser Preview',
  url: 'https://example.test/',
} satisfies ChatRuntimeSurfaceDescriptor;

const mcpSurface = {
  kind: 'mcp-app',
  title: 'MCP Preview',
  viewId: 'view-1',
  mcpApp: {
    viewId: 'view-1',
    originSessionKey: 'agent:main:main',
    serverName: 'demo-server',
    toolName: 'demo__view',
  },
} satisfies ChatRuntimeSurfaceDescriptor;

function createLayoutNode(width = 900): HTMLDivElement {
  const layoutNode = document.createElement('div');
  Object.defineProperty(layoutNode, 'clientWidth', {
    configurable: true,
    value: width,
  });
  return layoutNode;
}

function publishRuntimeSurface(surface: ChatRuntimeSurfaceDescriptor): void {
  const { unmount } = renderHook(() => useChatSidePanelController(false, { current: createLayoutNode() }));
  act(() => {
    openChatRuntimeSurface(surface);
  });
  unmount();
}

function defaultSidePanelProps(): ComponentProps<typeof ChatSidePanel> {
  return {
    mode: 'docked',
    width: 520,
    activeTab: 'runtime',
    artifactWorkbenchFullscreen: false,
    onTabChange: vi.fn(),
    onClose: vi.fn(),
    onToggleArtifactWorkbenchFullscreen: vi.fn(),
    artifactGroups: [],
    artifactFocusedGroupFiles: [],
    artifactFocusedFile: null,
    artifactActiveSection: 'workspace',
    artifactViewMode: 'preview',
    artifactWorkspaceRoot: null,
    onArtifactFocusFile: vi.fn(),
    onOpenGeneratedArtifactFile: vi.fn(),
    onOpenArtifactGroup: vi.fn(),
    onArtifactSectionChange: vi.fn(),
    onArtifactViewModeChange: vi.fn(),
    onArtifactRevealInFileManager: vi.fn(),
  };
}

function resetChatRuntimeFixtures(): void {
  window.localStorage.clear();
  useGatewayStore.setState({
    status: {
      processState: 'running',
      port: 17621,
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
      diagnostics: { consecutiveHeartbeatMisses: 0, consecutiveRpcFailures: 0 },
      updatedAt: 0,
    },
    runtimeHost: { lifecycle: 'running', restartCount: 0 },
    isInitialized: true,
  } as never);
  useLayoutStore.setState({ chatTakeoverMode: 'none' });

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

  mocks.hostOpenClawBrowserRequest.mockReset();
  mocks.hostOpenClawBrowserRequest.mockImplementation(async (input: { path?: string }) => {
    if (input.path?.includes('/tabs')) {
      return {
        tabs: [{ targetId: browserSurface.targetId, title: browserSurface.title, url: browserSurface.url }],
      };
    }
    if (input.path?.includes('/screenshot')) {
      return { dataUrl: 'data:image/png;base64,aW1hZ2U=' };
    }
    return {};
  });
  mocks.hostOpenClawMcpAppRequest.mockReset();
  mocks.hostOpenClawMcpAppRequest.mockResolvedValue({
    standaloneUrl: 'https://mcp-preview.test/standalone',
    html: '<p>inline secret html</p>',
    toolInput: { token: 'input-secret' },
    toolResult: { token: 'result-secret' },
    private: { token: 'private-secret' },
  });
}

describe('chat side panel runtime surface', () => {
  beforeEach(() => {
    resetChatRuntimeFixtures();
  });

  it('ignores the deprecated stored open flag while restoring side panel preferences', () => {
    window.localStorage.setItem('chat:side-panel-open', '1');
    window.localStorage.setItem('chat:side-panel-tab', 'artifacts');
    window.localStorage.setItem('chat:side-panel-light-width', '480');
    window.localStorage.setItem('chat:side-panel-artifact-width', '700');

    const { result } = renderHook(() => useChatSidePanelController(false, { current: createLayoutNode(1200) }));

    expect(result.current.sidePanelOpen).toBe(false);
    expect(result.current.activeSidePanelTab).toBe('artifacts');
    expect(result.current.sidePanelWidthPolicy).toBe('artifacts');
    expect(result.current.sidePanelPreferredWidth).toBe(700);

    act(() => {
      openChatRuntimeSurface(browserSurface);
    });

    expect(result.current.sidePanelOpen).toBe(true);
    expect(result.current.activeSidePanelTab).toBe('runtime');
    expect(result.current.sidePanelWidthPolicy).toBe('light');
    expect(result.current.sidePanelPreferredWidth).toBe(480);
  });

  it.each([
    ['browser', browserSurface],
    ['mcp', mcpSurface],
  ])('opens the runtime tab when openChatRuntimeSurface receives a %s descriptor', (_label, surface) => {
    const { result } = renderHook(() => useChatSidePanelController(false, { current: createLayoutNode() }));

    expect(result.current.sidePanelOpen).toBe(false);

    act(() => {
      openChatRuntimeSurface(surface);
    });

    expect(result.current.sidePanelOpen).toBe(true);
    expect(result.current.activeSidePanelTab).toBe('runtime');
  });

  it('loads Browser runtime surface tabs and screenshot through the OpenClaw browser host request', async () => {
    publishRuntimeSurface(browserSurface);

    render(
      <ChatSidePanel
        {...defaultSidePanelProps()}
      />,
    );

    await waitFor(() => expect(mocks.hostOpenClawBrowserRequest).toHaveBeenCalled());

    const requestPaths = mocks.hostOpenClawBrowserRequest.mock.calls.map(([input]) => (
      typeof input === 'object' && input !== null && 'path' in input ? String(input.path) : ''
    ));
    expect(requestPaths.some((path) => path.includes('/tabs'))).toBe(true);
    expect(requestPaths.some((path) => path.includes('/screenshot'))).toBe(true);
  });

  it('loads MCP runtime surface as a standalone iframe without exposing private view fields', async () => {
    publishRuntimeSurface(mcpSurface);

    const { container } = render(
      <ChatSidePanel
        {...defaultSidePanelProps()}
      />,
    );

    await waitFor(() => expect(mocks.hostOpenClawMcpAppRequest).toHaveBeenCalled());
    expect(mocks.hostOpenClawMcpAppRequest.mock.calls.map(([input]) => input)).toContainEqual({
      operationId: 'mcp.app.view',
      sessionKey: 'agent:main:main',
      viewId: 'view-1',
      standalone: true,
    });

    const iframe = await waitFor(() => {
      const frame = container.querySelector('iframe');
      expect(frame).not.toBeNull();
      return frame as HTMLIFrameElement;
    });
    expect(iframe.getAttribute('src')).toBe('https://mcp-preview.test/standalone');
    expect(iframe.getAttribute('srcdoc')).toBeNull();
    expect(container.innerHTML).not.toContain('inline secret html');
    expect(container.innerHTML).not.toContain('input-secret');
    expect(container.innerHTML).not.toContain('result-secret');
    expect(container.innerHTML).not.toContain('private-secret');
    expect(screen.queryByText('toolInput')).not.toBeInTheDocument();
    expect(screen.queryByText('toolResult')).not.toBeInTheDocument();
    expect(screen.queryByText('private')).not.toBeInTheDocument();
  });
});
