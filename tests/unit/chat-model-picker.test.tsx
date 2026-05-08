import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Chat from '@/pages/Chat';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import { createEmptySessionRecord, createEmptySessionViewportState } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function renderChat() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <TooltipProvider>
        <Chat />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe('chat model picker', () => {
  beforeEach(() => {
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

    const sessionKey = 'agent:test:main';
    const messages = buildRenderItemsFromMessages(sessionKey, [
      {
        id: 'user-1',
        role: 'user',
        content: 'hello',
        timestamp: 1,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'hi',
        timestamp: 2,
      },
    ]);

    useGatewayStore.setState({
      status: {
        processState: 'running',
        port: 18789,
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
      rpc: vi.fn().mockResolvedValue({}),
    } as never);

    const updateAgent = vi.fn().mockImplementation(async (payload: { model?: string }) => {
      useSubagentsStore.setState((state) => ({
        agentsResource: {
          ...state.agentsResource,
          data: state.agentsResource.data.map((agent) => (
            agent.id === 'test'
              ? { ...agent, model: payload.model }
              : agent
          )),
        },
      }));
    });

    useSubagentsStore.setState({
      agents: [
        {
          id: 'test',
          name: 'Test Agent',
          workspace: '.',
          model: 'openai/gpt-5.4',
          skills: [],
          isDefault: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      availableModels: [
        {
          id: 'openai/gpt-5.4',
          provider: 'openai',
          providerLabel: 'OpenAI',
          modelLabel: 'gpt-5.4',
          displayLabel: 'OpenAI / gpt-5.4',
        },
        {
          id: 'anthropic/claude-opus-4-6',
          provider: 'anthropic',
          providerLabel: 'Anthropic',
          modelLabel: 'claude-opus-4-6',
          displayLabel: 'Anthropic / claude-opus-4-6',
        },
      ],
      modelsLoading: false,
      loadAvailableModels: vi.fn().mockResolvedValue(undefined),
      loadAgents: vi.fn().mockResolvedValue(undefined),
      updateAgent,
    } as never);

    useTaskInboxStore.setState({
      tasks: [],
      loading: false,
      initialized: true,
      error: null,
      workspaceDirs: [],
      workspaceLabel: null,
      submittingTaskIds: [],
      init: vi.fn().mockResolvedValue(undefined),
      refreshTasks: vi.fn().mockResolvedValue(undefined),
      submitDecision: vi.fn().mockResolvedValue(undefined),
      submitFreeText: vi.fn().mockResolvedValue(undefined),
      openTaskSession: vi.fn().mockReturnValue({ switched: false, reason: 'task_not_found' }),
      handleGatewayNotification: vi.fn(),
      clearError: vi.fn(),
    } as never);

    useChatStore.setState({
      currentSessionKey: sessionKey,
      currentSession: createEmptySessionRecord(),
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: null,
      sessionsLoading: false,
      mutating: false,
      runtimeError: null,
      showThinking: true,
      refresh: vi.fn().mockResolvedValue(undefined),
      toggleThinking: vi.fn(),
      loadOlderViewportItems: vi.fn().mockResolvedValue(undefined),
      jumpViewportToLatest: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      abortRun: vi.fn(),
      clearError: vi.fn(),
      resolveApproval: vi.fn().mockResolvedValue(undefined),
      switchSession: vi.fn(),
      openAgentConversation: vi.fn(),
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      cleanupEmptySession: vi.fn().mockResolvedValue(undefined),
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        [sessionKey]: {
          ...createEmptySessionRecord(),
          items: messages,
          window: createViewportWindowState({
            ...createEmptySessionViewportState(),
            totalItemCount: messages.length,
            windowStartOffset: 0,
            windowEndOffset: messages.length,
            hasMore: false,
            hasNewer: false,
            isAtLatest: true,
          }),
          meta: {
            ...createEmptySessionRecord().meta,
            historyStatus: 'ready',
            lastActivityAt: Date.now(),
          },
        },
      },
    } as never);
  });

  it('switches the current agent model via subagents store', async () => {
    renderChat();

    const select = await screen.findByTestId('chat-model-picker');
    fireEvent.change(select, { target: { value: 'anthropic/claude-opus-4-6' } });

    await waitFor(() => {
      const updateAgent = useSubagentsStore.getState().updateAgent as ReturnType<typeof vi.fn>;
      expect(updateAgent).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'test',
        model: 'anthropic/claude-opus-4-6',
      }));
    });

    await waitFor(() => {
      expect((screen.getByTestId('chat-model-picker') as HTMLSelectElement).value).toBe('anthropic/claude-opus-4-6');
    });
  });
});
