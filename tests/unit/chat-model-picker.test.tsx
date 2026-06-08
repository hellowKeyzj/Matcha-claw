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
import { buildRuntimeScopeKey, buildSessionRecordKey } from '@/stores/chat/session-identity';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import {
  hostRuntimeEndpointsListMock,
  hostSessionPatchMock,
  resetGatewayClientMocks,
} from './helpers/mock-gateway-client';
import { createOpenClawTestSessionIdentity, openClawTestRuntimeIdentity } from './helpers/runtime-address-fixtures';

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

const TEST_SESSION_KEY = 'agent:test:main';
const TEST_SESSION_IDENTITY = createOpenClawTestSessionIdentity(TEST_SESSION_KEY, 'test');
const TEST_AGENT_SCOPE = {
  kind: 'agent' as const,
  endpoint: TEST_SESSION_IDENTITY.endpoint,
  agentId: 'test',
};
const TEST_RECORD_KEY = buildSessionRecordKey(TEST_SESSION_IDENTITY);

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

    const sessionKey = TEST_SESSION_KEY;
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

    hostSessionPatchMock.mockImplementation(async () => ({
      success: true,
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
      agentsResource: {
        status: 'ready',
        data: [
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
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
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
      clearError: vi.fn(),
    } as never);

    hostRuntimeEndpointsListMock.mockResolvedValue({
      endpoints: [{
        id: openClawTestRuntimeIdentity.runtimeEndpointId,
        protocolId: openClawTestRuntimeIdentity.protocolId,
        runtimeAdapterId: TEST_SESSION_IDENTITY.endpoint.runtimeAdapterId,
        runtimeInstanceId: TEST_SESSION_IDENTITY.endpoint.runtimeInstanceId,
        displayName: 'OpenClaw Local',
        agentIds: ['test'],
        acceptsDynamicAgents: true,
        capabilities: {
          chat: true,
          streaming: true,
          tools: true,
          approvals: true,
          replay: true,
          modelSelection: true,
        },
        capabilitySummaries: [{
          id: 'session.prompt',
          scopeKind: 'agent',
          scope: TEST_AGENT_SCOPE,
          targetKinds: ['session'],
          operations: [],
          availability: 'available',
        }],
        controlState: {
          connection: null,
          readiness: null,
          capabilities: null,
          updatedAt: null,
        },
      }],
    });

    useChatStore.setState({
      currentSessionKey: TEST_RECORD_KEY,
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
      sessionRuntimeCatalog: {
        status: 'ready',
        error: null,
        endpoints: [{
          endpointId: openClawTestRuntimeIdentity.runtimeEndpointId,
          protocolId: openClawTestRuntimeIdentity.protocolId,
          endpoint: TEST_SESSION_IDENTITY.endpoint,
          runtimeAdapterId: TEST_SESSION_IDENTITY.endpoint.runtimeAdapterId,
          runtimeInstanceId: TEST_SESSION_IDENTITY.endpoint.runtimeInstanceId,
          displayName: 'OpenClaw Local',
          agentIds: ['test'],
          acceptsDynamicAgents: true,
          sessionPromptScopes: [TEST_AGENT_SCOPE],
          defaultSessionPromptScope: TEST_AGENT_SCOPE,
        }],
        defaultSessionPromptScope: TEST_AGENT_SCOPE,
      },
      loadedSessions: {
        [TEST_RECORD_KEY]: {
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
            backendSessionKey: TEST_SESSION_KEY,
            runtimeScopeKey: buildRuntimeScopeKey(TEST_SESSION_IDENTITY.endpoint),
            agentId: 'test',
            protocolId: openClawTestRuntimeIdentity.protocolId,
            runtimeEndpointId: openClawTestRuntimeIdentity.runtimeEndpointId,
            sessionIdentity: TEST_SESSION_IDENTITY,
            kind: 'main',
            preferred: true,
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
    expect(useChatStore.getState().loadedSessions[TEST_RECORD_KEY]?.meta.model).toBe('anthropic/claude-opus-4-6');

    await waitFor(() => {
      expect(hostSessionPatchMock).toHaveBeenCalledWith({
        sessionKey: TEST_SESSION_KEY,
        sessionIdentity: TEST_SESSION_IDENTITY,
        runtimeModelRef: 'anthropic/claude-opus-4-6',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('chat-model-picker')).toHaveTextContent('anthropic / claude-opus-4-6');
    });

    expect(useChatStore.getState().loadedSessions[TEST_RECORD_KEY]?.meta.model).toBe('anthropic/claude-opus-4-6');
  });

  it('rolls back the optimistic session model when session patch fails', async () => {
    hostSessionPatchMock.mockRejectedValueOnce(new Error('patch failed'));

    renderChat();

    const picker = await screen.findByTestId('chat-model-picker');
    expect(picker).toHaveTextContent('openai / gpt-5.4');

    fireEvent.click(picker);
    fireEvent.click(screen.getByRole('option', { name: 'anthropic / claude-opus-4-6' }));

    expect(screen.getByTestId('chat-model-picker')).toHaveTextContent('anthropic / claude-opus-4-6');
    expect(useChatStore.getState().loadedSessions[TEST_RECORD_KEY]?.meta.model).toBe('anthropic/claude-opus-4-6');

    await waitFor(() => {
      expect(useChatStore.getState().loadedSessions[TEST_RECORD_KEY]?.meta.model).toBe('openai/gpt-5.4');
    });

    await waitFor(() => {
      expect(screen.getByTestId('chat-model-picker')).toHaveTextContent('openai / gpt-5.4');
    });
  });

  it('uses the first available model for sessions without a session or agent default model', async () => {
    const current = useChatStore.getState().loadedSessions[TEST_RECORD_KEY]!;
    useChatStore.setState({
      loadedSessions: {
        [TEST_RECORD_KEY]: {
          ...current,
          meta: {
            ...current.meta,
            model: null,
          },
        },
      },
    } as never);
    useSubagentsStore.setState({
      agentsResource: {
        status: 'ready',
        data: [
          {
            id: 'test',
            name: 'Test Agent',
            workspace: '.',
            skills: [],
            isDefault: false,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        error: null,
        loading: false,
        hasLoadedOnce: true,
        loadedAt: 1,
      },
      agents: [
        {
          id: 'test',
          name: 'Test Agent',
          workspace: '.',
          skills: [],
          isDefault: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    } as never);

    renderChat();

    expect(await screen.findByTestId('chat-model-picker')).toHaveTextContent('openai / gpt-5.4');
    await waitFor(() => {
      expect(hostSessionPatchMock).toHaveBeenCalledWith({
        sessionKey: TEST_SESSION_KEY,
        sessionIdentity: TEST_SESSION_IDENTITY,
        runtimeModelRef: 'openai/gpt-5.4',
      });
    });
  });

  it('replaces a stale session model with the current available model', async () => {
    const current = useChatStore.getState().loadedSessions[TEST_RECORD_KEY]!;
    useChatStore.setState({
      loadedSessions: {
        [TEST_RECORD_KEY]: {
          ...current,
          meta: {
            ...current.meta,
            model: 'custom-4ee8e78e/gpt-5.4',
          },
        },
      },
    } as never);
    useSubagentsStore.setState({
      agentsResource: {
        status: 'ready',
        data: [
          {
            id: 'test',
            name: 'Test Agent',
            workspace: '.',
            skills: [],
            isDefault: false,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        error: null,
        loading: false,
        hasLoadedOnce: true,
        loadedAt: 1,
      },
      agents: [
        {
          id: 'test',
          name: 'Test Agent',
          workspace: '.',
          skills: [],
          isDefault: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    } as never);

    renderChat();

    expect(await screen.findByTestId('chat-model-picker')).toHaveTextContent('openai / gpt-5.4');
    await waitFor(() => {
      expect(hostSessionPatchMock).toHaveBeenCalledWith({
        sessionKey: TEST_SESSION_KEY,
        sessionIdentity: TEST_SESSION_IDENTITY,
        runtimeModelRef: 'openai/gpt-5.4',
      });
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
    const current = useChatStore.getState().loadedSessions[TEST_RECORD_KEY];
    useChatStore.setState({
      loadedSessions: {
        [TEST_RECORD_KEY]: {
          ...current!,
          runtime: {
            ...current!.runtime,
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
