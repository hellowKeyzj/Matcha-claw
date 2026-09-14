import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { useChatStore } from '@/stores/chat';
import { useLayoutStore } from '@/stores/layout';
import { useSettingsStore } from '@/stores/settings';
import { useSubagentsStore } from '@/stores/subagents';
import i18n from '@/i18n';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

function MockChat({ isActive = true }: { isActive?: boolean }) {
  return (
    <div
      data-testid="chat-host"
      data-active={String(isActive)}
      data-instance-id="chat"
    >
      chat-host
    </div>
  );
}

vi.mock('@/pages/Chat', () => ({
  Chat: MockChat,
  default: MockChat,
}));

function RouteSwitcher() {
  const navigate = useNavigate();
  return (
    <div>
      <button type="button" onClick={() => navigate('/')}>go-chat</button>
      <button type="button" onClick={() => navigate('/tasks')}>go-tasks</button>
    </div>
  );
}

describe('main layout chat workspace host', () => {
  beforeEach(() => {
    invokeIpcMock.mockReset();
    invokeIpcMock.mockResolvedValue(false);
    window.electron.platform = 'linux';
    i18n.changeLanguage('en');

    useSettingsStore.setState({
      language: 'en',
      devModeUnlocked: false,
      init: vi.fn().mockResolvedValue(undefined),
    } as never);
    useLayoutStore.setState({
      sidebarVisible: true,
      sidebarWidth: 256,
      chatTakeoverMode: 'none',
      chatWindowRightDockLayout: null,
    });

    useSubagentsStore.setState({
      agents: [
        { id: 'main', name: 'main', isDefault: true, avatarSeed: 'agent:main', avatarStyle: 'pixelArt' },
      ],
      agentsResource: {
        status: 'ready',
        data: [{ id: 'main', name: 'main', isDefault: true, avatarSeed: 'agent:main', avatarStyle: 'pixelArt' }],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadAgents: vi.fn().mockResolvedValue(undefined),
    } as never);

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      loadedSessions: {
        'agent:main:main': {
          ...createEmptySessionRecord(),
          meta: {
            ...createEmptySessionRecord().meta,
            label: null,
            lastActivityAt: null,
            historyStatus: 'ready',
          },
          runtime: {
            ...createEmptySessionRecord().runtime,
          },
          window: createViewportWindowState({
            totalItemCount: 0,
            windowStartOffset: 0,
            windowEndOffset: 0,
            isAtLatest: true,
          }),
        },
      },
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      switchSession: vi.fn(),
      openAgentConversation: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it('keeps chat workspace active without a resident agent sessions pane width', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<MainLayout />}>
            <Route index element={null} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-workspace-host')).toBeInTheDocument();
    expect(screen.getByTestId('chat-host')).toHaveAttribute('data-active', 'true');
    const agentSessionsPane = screen.getByTestId('agent-sessions-pane');
    expect(agentSessionsPane).toHaveClass('w-0');
    expect(screen.getByTestId('agent-session-identity-beacon')).toBeInTheDocument();
    expect(screen.queryByTestId('layout-agent-sessions-resizer')).toBeNull();
  });

  it('lets artifact workbench takeover hide the app sidebar and agent sessions pane', () => {
    useLayoutStore.setState({
      chatTakeoverMode: 'artifact-workbench',
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<MainLayout />}>
            <Route index element={null} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-workspace-host')).toHaveAttribute('data-takeover-mode', 'artifact-workbench');
    expect(screen.getByTestId('chat-host')).toHaveAttribute('data-active', 'true');
    expect(screen.queryByTestId('agent-sessions-pane')).toBeNull();
    expect(screen.queryByTestId('layout-left-resizer')).toBeNull();
    expect(screen.queryByRole('button', { name: /new chat/i })).toBeNull();
  });

  it('sizes the chat route from the right dock layout base and dock widths', () => {
    useLayoutStore.setState({
      chatWindowRightDockLayout: {
        phase: 'open',
        dockWidth: 726,
        baseWidth: 1200,
      },
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<MainLayout />}>
            <Route index element={null} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const main = screen.getByTestId('chat-workspace-host').parentElement as HTMLElement;
    expect(main.style.flex).toBe('0 0 1664px');
  });

  it('does not mount chat workspace on non-chat routes', () => {
    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <Routes>
          <Route element={<MainLayout />}>
            <Route index element={null} />
            <Route path="/tasks" element={<div data-testid="tasks-outlet">tasks</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('chat-workspace-host')).toBeNull();
    expect(screen.queryByTestId('chat-host')).toBeNull();
    expect(screen.queryByTestId('agent-sessions-pane')).toBeNull();
    expect(screen.getByTestId('tasks-outlet')).toBeInTheDocument();
  });

  it('switching routes mounts chat only when entering the chat route', () => {
    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <RouteSwitcher />
        <Routes>
          <Route element={<MainLayout />}>
            <Route index element={null} />
            <Route path="/tasks" element={<div data-testid="tasks-outlet">tasks</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('chat-host')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'go-chat' }));
    const activeInstanceId = screen.getByTestId('chat-host').getAttribute('data-instance-id');
    expect(activeInstanceId).toBeTruthy();
    expect(screen.getByTestId('chat-host')).toHaveAttribute('data-active', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'go-tasks' }));
    expect(screen.queryByTestId('chat-host')).toBeNull();
  });
});
