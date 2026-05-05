import { useRef } from 'react';
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
const chatHostInstanceSeq = vi.hoisted(() => ({ current: 0 }));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

vi.mock('@/pages/Chat', () => ({
  Chat: ({ isActive = true }: { isActive?: boolean }) => {
    const instanceIdRef = useRef<number | null>(null);
    if (instanceIdRef.current == null) {
      chatHostInstanceSeq.current += 1;
      instanceIdRef.current = chatHostInstanceSeq.current;
    }
    return (
      <div
        data-testid="chat-host"
        data-active={String(isActive)}
        data-instance-id={String(instanceIdRef.current)}
      >
        chat-host
      </div>
    );
  },
  default: ({ isActive = true }: { isActive?: boolean }) => {
    const instanceIdRef = useRef<number | null>(null);
    if (instanceIdRef.current == null) {
      chatHostInstanceSeq.current += 1;
      instanceIdRef.current = chatHostInstanceSeq.current;
    }
    return (
      <div
        data-testid="chat-host"
        data-active={String(isActive)}
        data-instance-id={String(instanceIdRef.current)}
      >
        chat-host
      </div>
    );
  },
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
    chatHostInstanceSeq.current = 0;
    window.electron.platform = 'linux';
    i18n.changeLanguage('en');

    useSettingsStore.setState({
      setupComplete: true,
      language: 'en',
      devModeUnlocked: false,
      init: vi.fn().mockResolvedValue(undefined),
    } as never);
    useLayoutStore.setState({
      sidebarVisible: true,
      sidebarWidth: 256,
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

  it('keeps chat workspace active on chat route without route overlay', () => {
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
    expect(screen.getByTestId('agent-sessions-pane')).toBeInTheDocument();
    expect(screen.queryByTestId('layout-agent-sessions-resizer')).toBeNull();
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
