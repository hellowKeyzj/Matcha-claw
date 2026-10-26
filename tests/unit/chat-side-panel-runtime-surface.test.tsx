import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSidePanel } from '@/plugins/chat/components/ChatSidePanel';
import { useChatSidePanelController } from '@/plugins/chat/useChatSidePanelController';
import type { ChatPanelContent } from '@/plugins/chat/workspace-actions';
import {
  openChatRuntimeSurface,
  type ChatRuntimeSurfaceDescriptor,
} from '@/plugins/surfaces/chat/runtime-surfaces';
import { useGatewayStore } from '@/plugins/runtime/store';
import { useLayoutStore } from '@/stores/layout';
import { useChatStore } from '@/plugins/chat/store';
import { createEmptySessionRecord } from '@/plugins/chat/store/store-state-helpers';
import { createReadyResourceStatusState } from '@/lib/resource-state';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';
import { applicationShellPlugin } from '@/app/extensions';
import { createPluginHost } from '@/plugin-host/core';
import { PluginHostProvider } from '@/plugin-host/react';
import { chatPlugin } from '@/plugins/chat/plugin';
import { filesPlugin } from '@/plugins/files/plugin';
import { surfacesPlugin } from '@/plugins/surfaces/plugin';

const pluginHost = createPluginHost([applicationShellPlugin, filesPlugin, surfacesPlugin, chatPlugin]);

function PluginWrapper({ children }: { children: ReactNode }) {
  return <PluginHostProvider host={pluginHost}>{children}</PluginHostProvider>;
}

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

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const t = (key: string) => key === 'artifacts.sectionLabel' ? '产物' : key;
  return { ...actual, useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/plugins/files/FilePreviewBody', () => ({
  FilePreviewBody: () => <div data-testid="artifact-preview-body" />,
}));

vi.mock('@/plugins/files/WorkspaceBrowserBody', () => ({
  WorkspaceBrowserBody: () => <div data-testid="workspace-browser-body" />,
}));

const sessionIdentity = {
  ...createOpenClawTestSessionIdentity('agent:main:main'),
  endpoint: { kind: 'native-runtime' as const, runtimeAdapterId: 'openclaw' as const, runtimeInstanceId: 'local' },
};
const screenshotDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6vXkAAAAASUVORK5CYII=';
const sandboxUrl = 'https://mcp-preview.test/mcp-app-sandbox';

const browserSurface = {
  kind: 'browser-tab',
  sourceSessionIdentity: sessionIdentity,
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
  sessionIdentity,
} satisfies ChatRuntimeSurfaceDescriptor;

function createLayoutNode(width = 900): HTMLDivElement {
  const layoutNode = document.createElement('div');
  Object.defineProperty(layoutNode, 'clientWidth', {
    configurable: true,
    value: width,
  });
  return layoutNode;
}

function publishRuntimeSurface(surface: ChatRuntimeSurfaceDescriptor): ChatPanelContent | null {
  const { result, unmount } = renderHook(() => useChatSidePanelController(true, { current: createLayoutNode() }, sessionIdentity), { wrapper: PluginWrapper });
  act(() => {
    openChatRuntimeSurface(surface);
  });
  const accepted = result.current.panelContent;
  unmount();
  return accepted;
}

function defaultSidePanelProps(): ComponentProps<typeof ChatSidePanel> {
  return {
    mode: 'docked',
    sessionIdentity,
    width: 520,
    activeTab: 'runtime',
    content: null,
    layout: { position: 'right', fullscreen: false },
    onLayoutChange: vi.fn(),
    artifactWorkbenchFullscreen: false,
    onTabChange: vi.fn(),
    onClose: vi.fn(),
    onToggleArtifactWorkbenchFullscreen: vi.fn(),
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
  useChatStore.setState({
    currentSessionKey: 'agent:main:main',
    sessionCatalogStatus: createReadyResourceStatusState(1),
    loadedSessions: {
      'agent:main:main': {
        ...mainSession,
        meta: {
          ...mainSession.meta,
          runtimeScopeKey: 'native:openclaw:openclaw:local',
          agentId: 'main',
          sessionIdentity,
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
      return { dataUrl: screenshotDataUrl };
    }
    return { enabled: true, running: true };
  });
  mocks.hostOpenClawMcpAppRequest.mockReset();
  mocks.hostOpenClawMcpAppRequest.mockResolvedValue({
    sessionIdentity,
    viewId: 'view-1',
    sandboxUrl,
    html: '<p>inline secret html</p>',
    toolInput: { token: 'input-secret' },
    toolResult: { token: 'result-secret' },
    private: { token: 'private-secret' },
    readOnly: false,
    messageSupported: true,
    updateModelContextSupported: false,
  });
}

describe('chat side panel runtime surface', () => {
  beforeEach(() => {
    resetChatRuntimeFixtures();
  });

  it('ignores the deprecated stored open flag while restoring side panel preferences', () => {
    window.localStorage.setItem('chat:side-panel-open', '1');
    window.localStorage.setItem('chat:side-panel-tab', 'artifacts');
    window.localStorage.setItem('chat:side-panel-width', '700');

    const { result } = renderHook(() => useChatSidePanelController(true, { current: createLayoutNode(1200) }, sessionIdentity), { wrapper: PluginWrapper });

    expect(result.current.sidePanelOpen).toBe(false);
    expect(result.current.activeSidePanelTab).toBe('artifacts');
    expect(result.current.sidePanelPreferredWidth).toBe(700);

    act(() => {
      openChatRuntimeSurface(browserSurface);
    });

    expect(result.current.sidePanelOpen).toBe(true);
    expect(result.current.activeSidePanelTab).toBe('runtime');
    expect(result.current.sidePanelPreferredWidth).toBe(700);
  });

  it.each([
    ['browser', browserSurface],
    ['mcp', mcpSurface],
  ])('opens the runtime tab when openChatRuntimeSurface receives a %s descriptor', (_label, surface) => {
    const { result } = renderHook(() => useChatSidePanelController(true, { current: createLayoutNode() }, sessionIdentity), { wrapper: PluginWrapper });

    expect(result.current.sidePanelOpen).toBe(false);

    act(() => {
      openChatRuntimeSurface(surface);
    });

    expect(result.current.sidePanelOpen).toBe(true);
    expect(result.current.activeSidePanelTab).toBe('runtime');
  });

  it('loads Browser runtime surface tabs and screenshot through the OpenClaw browser host request', async () => {
    const panelContent = publishRuntimeSurface(browserSurface);

    render(
      <ChatSidePanel
        {...defaultSidePanelProps()}
        content={panelContent}
      />,
      { wrapper: PluginWrapper },
    );

    expect(await screen.findByTestId('chat-runtime-browser-screenshot')).toHaveAttribute('src', screenshotDataUrl);

    const requestPaths = mocks.hostOpenClawBrowserRequest.mock.calls.map(([input]) => (
      typeof input === 'object' && input !== null && 'path' in input ? String(input.path) : ''
    ));
    expect(requestPaths.some((path) => path.includes('/tabs'))).toBe(true);
    expect(requestPaths.some((path) => path.includes('/screenshot'))).toBe(true);
  });

  it('loads MCP runtime surface through its isolated sandbox without exposing private view fields', async () => {
    const panelContent = publishRuntimeSurface(mcpSurface);

    const { container } = render(
      <ChatSidePanel
        {...defaultSidePanelProps()}
        content={panelContent}
      />,
      { wrapper: PluginWrapper },
    );

    await waitFor(() => expect(mocks.hostOpenClawMcpAppRequest).toHaveBeenCalled());
    expect(mocks.hostOpenClawMcpAppRequest.mock.calls.map(([input]) => input)).toContainEqual({
      operationId: 'mcp.app.view',
      sessionIdentity,
      viewId: 'view-1',
    });

    const iframe = await waitFor(() => {
      const frame = container.querySelector('iframe');
      expect(frame).toHaveAttribute('src', sandboxUrl);
      return frame as HTMLIFrameElement;
    });
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
