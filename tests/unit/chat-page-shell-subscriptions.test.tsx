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

const chatShellRenderSpy = vi.fn();
const chatViewportPaneRenderSpy = vi.fn();
const chatInputRenderSpy = vi.fn();

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

vi.mock('@/pages/Chat/useChatActivation', () => ({
  useChatActivation: () => ({
    workspaceActive: false,
    externalSyncActive: false,
    layoutEffectsActive: false,
    viewportEffectsActive: false,
    telemetryEffectsActive: false,
  }),
}));

vi.mock('@/pages/Chat/useInboxLayout', () => ({
  useInboxLayout: () => ({
    taskInboxCollapsed: true,
    setTaskInboxCollapsed: vi.fn(),
    taskInboxWidth: 320,
    startTaskInboxResize: vi.fn(),
    taskInboxResizerWidth: 8,
  }),
}));

vi.mock('@/pages/Chat/useSkillConfig', () => ({
  useSkillConfig: () => ({
    open: false,
    saving: false,
    selectedSkillIds: [],
    availableSkillOptions: [],
    skillsLoading: false,
    openDialog: vi.fn(),
    closeDialog: vi.fn(),
    toggleSkill: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/pages/Chat/components/ChatShell', () => ({
  ChatShell: ({ stagePanel }: { stagePanel: ReactNode }) => {
    chatShellRenderSpy();
    return <div data-testid="chat-shell">{stagePanel}</div>;
  },
}));

vi.mock('@/pages/Chat/components/ChatViewportStage', () => ({
  ChatViewportStage: ({
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
  }) => (
    <div data-testid="chat-stage">
      {header}
      {viewportPane}
      {errorBanner}
      {approvalDock}
      {input}
    </div>
  ),
}));

vi.mock('@/pages/Chat/components/ChatHeaderBar', () => ({
  ChatHeaderBar: () => <div data-testid="chat-header-bar" />,
}));

vi.mock('@/pages/Chat/components/ChatRuntimeDock', () => ({
  ChatErrorBanner: () => <div data-testid="chat-error-banner" />,
  ChatApprovalDock: () => <div data-testid="chat-approval-dock" />,
}));

vi.mock('@/pages/Chat/ChatInput', () => ({
  ChatInput: () => {
    chatInputRenderSpy();
    return <div data-testid="chat-input" />;
  },
}));

vi.mock('@/pages/Chat/components/AgentSkillConfigDialog', () => ({
  AgentSkillConfigDialog: () => null,
}));

vi.mock('@/pages/Chat/components/ChatOffline', () => ({
  ChatOffline: () => <div data-testid="chat-offline" />,
}));

vi.mock('@/pages/Chat/components/ChatViewportPane', () => ({
  ChatViewportPane: forwardRef(function MockChatViewportPane(
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
        {props.currentSession.window.messages.length}
      </div>
    );
  }),
}));

function buildSessionRecord(overrides?: Partial<ReturnType<typeof createEmptySessionRecord>>) {
  const base = createEmptySessionRecord();
  return {
    meta: {
      ...base.meta,
      ...overrides?.meta,
    },
    runtime: {
      ...base.runtime,
      ...overrides?.runtime,
    },
    window: overrides?.window ?? base.window,
  };
}

describe('chat 顶层订阅收口', () => {
  beforeEach(() => {
    chatShellRenderSpy.mockClear();
    chatViewportPaneRenderSpy.mockClear();
    chatInputRenderSpy.mockClear();

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
          runtime: {
            sending: true,
          },
          window: createViewportWindowState({
            messages: [
              {
                id: 'assistant-1',
                role: 'assistant',
                content: 'first chunk',
                timestamp: 1,
                streaming: true,
              },
            ],
            totalMessageCount: 1,
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
      loadOlderMessages: vi.fn().mockResolvedValue(undefined),
      trimTopMessages: vi.fn(),
      jumpToLatest: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      abortRun: vi.fn().mockResolvedValue(undefined),
      clearError: vi.fn(),
      resolveApproval: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockResolvedValue(undefined),
      toggleThinking: vi.fn(),
    } as never);
  });

  it('流式消息增长时，只应重渲 viewport 链，不应重渲 chat shell 与 input shell', () => {
    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-shell')).toBeInTheDocument();
    expect(screen.getByTestId('chat-viewport-pane')).toBeInTheDocument();
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();

    const shellRenderCountAfterMount = chatShellRenderSpy.mock.calls.length;
    const viewportRenderCountAfterMount = chatViewportPaneRenderSpy.mock.calls.length;
    const inputRenderCountAfterMount = chatInputRenderSpy.mock.calls.length;

    act(() => {
      useChatStore.setState((state) => ({
        loadedSessions: {
          ...state.loadedSessions,
          'agent:main:main': buildSessionRecord({
            runtime: {
              ...state.loadedSessions['agent:main:main']!.runtime,
              sending: true,
            },
            window: createViewportWindowState({
              messages: [
                {
                  id: 'assistant-1',
                  role: 'assistant',
                  content: 'first chunk second chunk',
                  timestamp: 1,
                  streaming: true,
                },
              ],
              totalMessageCount: 1,
              windowStartOffset: 0,
              windowEndOffset: 1,
              isAtLatest: true,
            }),
          }),
        },
      }));
    });

    expect(chatViewportPaneRenderSpy).toHaveBeenCalledTimes(viewportRenderCountAfterMount + 1);
    expect(chatShellRenderSpy).toHaveBeenCalledTimes(shellRenderCountAfterMount);
    expect(chatInputRenderSpy).toHaveBeenCalledTimes(inputRenderCountAfterMount);
  });
});
