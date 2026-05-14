import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Chat from '@/pages/Chat';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskCenterStore } from '@/stores/task-center-store';
import { createEmptySessionRecord, createEmptySessionViewportState } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import {
  hostSessionPatchMock,
  resetGatewayClientMocks,
} from './helpers/mock-gateway-client';

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
    resetGatewayClientMocks();
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

    hostSessionPatchMock.mockImplementation(async (payload: { sessionKey: string; model: string }) => ({
      success: true,
      snapshot: {
        sessionKey: payload.sessionKey,
        catalog: {
          key: payload.sessionKey,
          agentId: 'test',
          kind: 'main',
          preferred: true,
          displayName: payload.sessionKey,
          model: payload.model,
          updatedAt: 10,
        },
        items: messages,
        replayComplete: true,
          runtime: {
            revision: 1,
            runEpoch: 1,
            sending: false,
          activeRunId: null,
          runPhase: 'idle',
          activeTurnItemKey: null,
          pendingTurnKey: null,
          pendingTurnLaneKey: null,
          pendingFinal: false,
          lastUserMessageAt: null,
          lastError: null,
          lastIssue: null,
        },
        window: {
          totalItemCount: messages.length,
          windowStartOffset: 0,
          windowEndOffset: messages.length,
          hasMore: false,
          hasNewer: false,
          isAtLatest: true,
        },
      },
    }));

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
          providerLabel: 'openai',
          modelLabel: 'gpt-5.4',
          displayLabel: 'openai / gpt-5.4',
        },
        {
          id: 'anthropic/claude-opus-4-6',
          provider: 'anthropic',
          providerLabel: 'anthropic',
          modelLabel: 'claude-opus-4-6',
          displayLabel: 'anthropic / claude-opus-4-6',
        },
      ],
      modelsLoading: false,
      loadAvailableModels: vi.fn().mockResolvedValue(undefined),
      loadAgents: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
    } as never);

    useTaskCenterStore.setState({
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
            model: 'openai/gpt-5.4',
          },
        },
      },
    } as never);
  });

  it('switches the current session model via session patch', async () => {
    renderChat();

    const picker = await screen.findByTestId('chat-model-picker');
    expect(picker).toHaveTextContent('openai / gpt-5.4');

    fireEvent.click(picker);
    fireEvent.click(screen.getByRole('option', { name: 'anthropic / claude-opus-4-6' }));

    expect(screen.getByTestId('chat-model-picker')).toHaveTextContent('anthropic / claude-opus-4-6');
    expect(useChatStore.getState().loadedSessions['agent:test:main']?.meta.model).toBe('anthropic/claude-opus-4-6');

    await waitFor(() => {
      expect(hostSessionPatchMock).toHaveBeenCalledWith({
        sessionKey: 'agent:test:main',
        model: 'anthropic/claude-opus-4-6',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('chat-model-picker')).toHaveTextContent('anthropic / claude-opus-4-6');
    });

    expect(useChatStore.getState().loadedSessions['agent:test:main']?.meta.model).toBe('anthropic/claude-opus-4-6');
  });

  it('rolls back the optimistic session model when session patch fails', async () => {
    hostSessionPatchMock.mockRejectedValueOnce(new Error('patch failed'));

    renderChat();

    const picker = await screen.findByTestId('chat-model-picker');
    expect(picker).toHaveTextContent('openai / gpt-5.4');

    fireEvent.click(picker);
    fireEvent.click(screen.getByRole('option', { name: 'anthropic / claude-opus-4-6' }));

    expect(screen.getByTestId('chat-model-picker')).toHaveTextContent('anthropic / claude-opus-4-6');
    expect(useChatStore.getState().loadedSessions['agent:test:main']?.meta.model).toBe('anthropic/claude-opus-4-6');

    await waitFor(() => {
      expect(useChatStore.getState().loadedSessions['agent:test:main']?.meta.model).toBe('openai/gpt-5.4');
    });

    await waitFor(() => {
      expect(screen.getByTestId('chat-model-picker')).toHaveTextContent('openai / gpt-5.4');
    });
  });

  it('loads chat model options from the shared subagent model catalog instead of models.list', async () => {
    const loadAvailableModels = vi.fn().mockResolvedValue(undefined);
    useSubagentsStore.setState({
      loadAvailableModels,
    } as never);

    renderChat();

    await screen.findByTestId('chat-model-picker');

    expect(loadAvailableModels).toHaveBeenCalledTimes(1);
  });

  it('disables model switching while the current session has an active run', async () => {
    const sessionKey = 'agent:test:main';
    const current = useChatStore.getState().loadedSessions[sessionKey];
    useChatStore.setState({
      loadedSessions: {
        [sessionKey]: {
          ...current!,
          runtime: {
            ...current!.runtime,
            revision: 2,
            runEpoch: 2,
            sending: true,
            activeRunId: 'run-active-1',
          },
        },
      },
    } as never);

    renderChat();

    const picker = await screen.findByTestId('chat-model-picker');
    expect(picker).toBeDisabled();

    fireEvent.click(picker);
    expect(hostSessionPatchMock).not.toHaveBeenCalled();
  });
});
