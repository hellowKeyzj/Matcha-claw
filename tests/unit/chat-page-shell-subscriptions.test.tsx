import { act, render, screen } from '@testing-library/react';
import { forwardRef, type ReactNode, useImperativeHandle } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Chat from '@/pages/Chat';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

const chatViewportPaneRenderSpy = vi.fn();

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

vi.mock('@/pages/Chat/useChatInit', () => ({
  useChatInit: () => {},
}));

vi.mock('@/pages/Chat/useChatSidePanelController', () => ({
  useChatSidePanelController: () => ({
    sidePanelOpen: false,
    sidePanelMode: 'hidden',
    sidePanelWidth: 0,
    activeSidePanelTab: 'tasks',
    unfinishedTaskCount: 0,
    toggleSidePanel: vi.fn(),
    setActiveSidePanelTab: vi.fn(),
    closeSidePanel: vi.fn(),
  }),
}));

vi.mock('@/pages/Chat/useSkillConfig', () => ({
  useSkillConfig: () => ({
    saving: false,
    selectedSkillIds: [],
    availableSkillOptions: [],
    skillsLoading: false,
    prepare: vi.fn(),
    resetSession: vi.fn(),
    toggleSkill: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/pages/Chat/components/ChatShell', () => ({
  ChatShell: ({
    header,
    viewportPane,
    errorBanner,
    approvalDock,
    input,
  }: {
    header: ReactNode;
    viewportPane: ReactNode;
    errorBanner: ReactNode;
    approvalDock: ReactNode;
    input: ReactNode;
  }) => {
    return (
      <div data-testid="chat-shell">
        {header}
        {viewportPane}
        {errorBanner}
        {approvalDock}
        {input}
      </div>
    );
  },
}));

vi.mock('@/pages/Chat/components/ChatHeaderBar', () => ({
  ChatHeaderBar: () => <div data-testid="chat-header-bar" />,
}));

vi.mock('@/pages/Chat/components/ChatRuntimeDock', () => ({
  ChatErrorBanner: () => <div data-testid="chat-error-banner" />,
  ChatApprovalDock: () => <div data-testid="chat-approval-dock" />,
}));

vi.mock('@/pages/Chat/ChatInput', () => ({
  ChatInput: () => <div data-testid="chat-input" />,
}));

vi.mock('@/pages/Chat/components/ChatOffline', () => ({
  ChatOffline: () => <div data-testid="chat-offline" />,
}));

vi.mock('@/pages/Chat/components/ChatList', () => ({
  ChatList: forwardRef(function MockChatViewportPane(
    props: {
      currentSession: ReturnType<typeof createEmptySessionRecord>;
    },
    ref,
  ) {
    chatViewportPaneRenderSpy();
    useImperativeHandle(ref, () => ({
      prepareCurrentLatestBottomAlign: vi.fn(),
    }), []);
    return (
      <div data-testid="chat-viewport-pane">
        {props.currentSession.items.length}
      </div>
    );
  }),
}));

function buildSessionRecord(overrides?: Partial<ReturnType<typeof createEmptySessionRecord>> & {
  sessionKey?: string;
  messages?: Array<{ id?: string; role: 'user' | 'assistant' | 'system'; content: unknown; timestamp?: number; streaming?: boolean }>;
}) {
  const base = createEmptySessionRecord();
  const sessionKey = overrides?.sessionKey ?? 'agent:main:main';
  return {
    meta: {
      ...base.meta,
      ...overrides?.meta,
    },
    runtime: {
      ...base.runtime,
      ...overrides?.runtime,
    },
    items: overrides?.messages
      ? buildRenderItemsFromMessages(sessionKey, overrides.messages)
      : (overrides?.items ?? base.items),
    window: overrides?.window ?? base.window,
  };
}

describe('chat 顶层订阅收口', () => {
  beforeEach(() => {
    chatViewportPaneRenderSpy.mockClear();

    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc: vi.fn(),
    } as never);

    useSubagentsStore.setState({
      agentsResource: {
        status: 'ready',
        data: [
          { id: 'main', name: 'Main', workspace: '.', isDefault: true, createdAt: 1, updatedAt: 1 },
        ],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadAgents: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
    } as never);

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      loadedSessions: {
        'agent:main:main': buildSessionRecord({
          sessionKey: 'agent:main:main',
          messages: [
            {
              id: 'assistant-1',
              role: 'assistant',
              content: 'first chunk',
              timestamp: 1,
              streaming: true,
            },
          ],
          runtime: {
            sending: true,
          },
          window: createViewportWindowState({
            totalItemCount: 1,
            windowStartOffset: 0,
            windowEndOffset: 1,
            isAtLatest: true,
          }),
        }),
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: null,
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      mutating: false,
      error: null,
      showThinking: true,
      switchSession: vi.fn(),
      openAgentConversation: vi.fn(),
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      cleanupEmptySession: vi.fn(),
      loadOlderItems: vi.fn().mockResolvedValue(undefined),
      jumpToLatest: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      abortRun: vi.fn().mockResolvedValue(undefined),
      clearError: vi.fn(),
      resolveApproval: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockResolvedValue(undefined),
      toggleThinking: vi.fn(),
    } as never);
  });

  it('流式消息增长时，应继续通过当前页面壳把最新 viewport 内容渲染出来', () => {
    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-shell')).toBeInTheDocument();
    expect(screen.getByTestId('chat-viewport-pane')).toBeInTheDocument();
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();

    const viewportRenderCountAfterMount = chatViewportPaneRenderSpy.mock.calls.length;

    act(() => {
      useChatStore.setState((state) => ({
        loadedSessions: {
          ...state.loadedSessions,
          'agent:main:main': buildSessionRecord({
            sessionKey: 'agent:main:main',
            messages: [
              {
                id: 'assistant-1',
                role: 'assistant',
                content: 'first chunk second chunk',
                timestamp: 1,
                streaming: true,
              },
            ],
            runtime: {
              ...state.loadedSessions['agent:main:main']!.runtime,
              sending: true,
            },
            window: createViewportWindowState({
              totalItemCount: 1,
              windowStartOffset: 0,
              windowEndOffset: 1,
              isAtLatest: true,
            }),
          }),
        },
      }));
    });

    expect(chatViewportPaneRenderSpy).toHaveBeenCalledTimes(viewportRenderCountAfterMount + 1);
    expect(screen.getByTestId('chat-shell')).toBeInTheDocument();
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
  });
});
