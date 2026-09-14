import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Chat from '@/pages/Chat';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useRuntimeHostStore } from '@/stores/gateway';
import { useCapabilityRoutingStore } from '@/stores/capability-routing';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskCenterStore } from '@/stores/task-center-store';
import { createEmptySessionRecord, createEmptySessionViewportState } from '@/stores/chat/store-state-helpers';
import { buildRuntimeScopeKey, buildSessionRecordKey } from '@/stores/chat/session-identity';
import { buildCurrentConversationFromSessionRecord, buildSessionRuntimeGraph } from '@/stores/chat/session-runtime-graph';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import type { SessionRenderItem } from '../../src/types/session/render-item';

const { hostSessionPatchMock } = vi.hoisted(() => ({
  hostSessionPatchMock: vi.fn(),
}));

vi.mock('@/lib/host-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/host-api')>(),
  hostSessionPatch: hostSessionPatchMock,
}));

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
const TEST_SESSION_IDENTITY = {
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
  agentId: 'test',
  sessionKey: TEST_SESSION_KEY,
};
const OPENCLAW_TEST_RUNTIME_IDENTITY = {
  protocolId: 'openclaw-v4',
  runtimeEndpointId: 'local',
};
const TEST_AGENT_SCOPE = {
  kind: 'agent' as const,
  endpoint: TEST_SESSION_IDENTITY.endpoint,
  agentId: 'test',
};
const TEST_RECORD_KEY = buildSessionRecordKey(TEST_SESSION_IDENTITY);

function buildRenderItemsFromMessages(
  sessionKey: string,
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
  }>,
): SessionRenderItem[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      return {
        key: message.id,
        kind: 'user-message',
        sessionKey,
        role: 'user',
        text: message.content,
        images: [],
        attachedFiles: [],
        messageId: message.id,
        createdAt: message.timestamp,
        updatedAt: message.timestamp,
      };
    }

    return {
      key: message.id,
      kind: 'assistant-turn',
      sessionKey,
      role: 'assistant',
      identitySource: 'message',
      identityMode: 'message',
      identityConfidence: 'strong',
      status: 'final',
      segments: [],
      thinking: null,
      tools: [],
      text: message.content,
      images: [],
      attachedFiles: [],
      turnKey: message.id,
      createdAt: message.timestamp,
      updatedAt: message.timestamp,
    };
  });
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
    hostSessionPatchMock.mockReset();
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

    hostSessionPatchMock.mockResolvedValue({ outcome: 'succeeded' });

    useRuntimeHostStore.setState({
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
      runtimeHost: { lifecycle: 'running' },
      isInitialized: true,
      rpc: vi.fn().mockResolvedValue({}),
    } as never);

    useCapabilityRoutingStore.setState({
      routing: {
        chat: {
          primary: { accountId: 'openai', modelId: 'gpt-5.4' },
          fallbacks: [],
        },
      },
      revision: 1,
      ready: true,
      loading: false,
      saving: false,
      error: null,
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

    const loadedSessionRecord = {
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
        endpointSessionId: 'main',
        runtimeScopeKey: buildRuntimeScopeKey(TEST_SESSION_IDENTITY.endpoint),
        agentId: 'test',
        protocolId: OPENCLAW_TEST_RUNTIME_IDENTITY.protocolId,
        runtimeEndpointId: OPENCLAW_TEST_RUNTIME_IDENTITY.runtimeEndpointId,
        sessionIdentity: TEST_SESSION_IDENTITY,
        kind: 'main',
        preferred: true,
        historyStatus: 'ready',
        lastActivityAt: Date.now(),
        model: 'openai/gpt-5.4',
      },
    };
    const sessionRuntimeCatalog = {
      status: 'ready' as const,
      error: null,
      endpoints: [{
        endpointId: OPENCLAW_TEST_RUNTIME_IDENTITY.runtimeEndpointId,
        protocolId: OPENCLAW_TEST_RUNTIME_IDENTITY.protocolId,
        endpoint: TEST_SESSION_IDENTITY.endpoint,
        runtimeAdapterId: TEST_SESSION_IDENTITY.endpoint.runtimeAdapterId,
        runtimeInstanceId: TEST_SESSION_IDENTITY.endpoint.runtimeInstanceId,
        displayName: 'OpenClaw Local',
        agentIds: ['test'],
        acceptsDynamicAgents: true,
        agentCatalog: { source: 'runtime-endpoint' as const, agents: [{ id: 'test', name: 'Test Agent' }] },
        sessionPromptScopes: [TEST_AGENT_SCOPE],
        defaultSessionPromptScope: TEST_AGENT_SCOPE,
      }],
      defaultSessionPromptScope: TEST_AGENT_SCOPE,
    };
    const loadedSessions = { [TEST_RECORD_KEY]: loadedSessionRecord };

    useChatStore.setState({
      currentSessionKey: TEST_RECORD_KEY,
      currentConversation: buildCurrentConversationFromSessionRecord(loadedSessionRecord),
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
      bootstrapSessionRuntime: vi.fn().mockResolvedValue(undefined),
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      cleanupEmptySession: vi.fn().mockResolvedValue(undefined),
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      sessionRuntimeCatalog,
      sessionRuntimeGraph: buildSessionRuntimeGraph(sessionRuntimeCatalog, loadedSessions),
      loadedSessions,
      sessionRecordKeyByIdentityKey: {
        [TEST_RECORD_KEY]: TEST_RECORD_KEY,
      },
    } as never);
  });

  it('switches the current session model via session patch', async () => {
    renderChat();

    const picker = await screen.findByTestId('chat-model-picker');
    expect(picker).toHaveTextContent('gpt-5.4');

    fireEvent.click(picker);
    fireEvent.keyDown(screen.getByRole('option', { name: 'anthropic / claude-opus-4-6' }), { key: 'Enter' });

    expect(screen.getByTestId('chat-model-picker')).toHaveTextContent('gpt-5.4');
    expect(useChatStore.getState().loadedSessions[TEST_RECORD_KEY]?.meta.model).toBe('openai/gpt-5.4');

    await waitFor(() => {
      expect(hostSessionPatchMock).toHaveBeenCalledWith({
        endpointSessionId: 'main',
        sessionIdentity: TEST_SESSION_IDENTITY,
        modelSelectionId: 'anthropic/claude-opus-4-6',
      }, { traceId: null });
    });

    await waitFor(() => {
      expect(screen.getByTestId('chat-model-picker')).toHaveTextContent('claude-opus-4-6');
    });
    expect(useChatStore.getState().loadedSessions[TEST_RECORD_KEY]?.meta.model).toBe('anthropic/claude-opus-4-6');
  });

  it.each(['target_rejected', 'outcome_unknown'] as const)(
    'keeps the peer snapshot projection unchanged when patch returns %s',
    async (outcome) => {
      hostSessionPatchMock.mockResolvedValueOnce({ outcome });

      renderChat();

      const picker = await screen.findByTestId('chat-model-picker');
      expect(picker).toHaveTextContent('gpt-5.4');

      fireEvent.click(picker);
      fireEvent.keyDown(screen.getByRole('option', { name: 'anthropic / claude-opus-4-6' }), { key: 'Enter' });

      expect(screen.getByTestId('chat-model-picker')).toHaveTextContent('gpt-5.4');
      expect(useChatStore.getState().loadedSessions[TEST_RECORD_KEY]?.meta.model).toBe('openai/gpt-5.4');

      await waitFor(() => {
        expect(hostSessionPatchMock).toHaveBeenCalledWith({
          endpointSessionId: 'main',
          sessionIdentity: TEST_SESSION_IDENTITY,
          modelSelectionId: 'anthropic/claude-opus-4-6',
        }, { traceId: null });
      });
    },
  );

  it('keeps the peer snapshot projection unchanged when session patch fails', async () => {
    hostSessionPatchMock.mockRejectedValueOnce(new Error('patch failed'));

    renderChat();

    const picker = await screen.findByTestId('chat-model-picker');
    fireEvent.click(picker);
    fireEvent.keyDown(screen.getByRole('option', { name: 'anthropic / claude-opus-4-6' }), { key: 'Enter' });

    await waitFor(() => {
      expect(hostSessionPatchMock).toHaveBeenCalledWith({
        endpointSessionId: 'main',
        sessionIdentity: TEST_SESSION_IDENTITY,
        modelSelectionId: 'anthropic/claude-opus-4-6',
      }, { traceId: null });
    });
    expect(useChatStore.getState().loadedSessions[TEST_RECORD_KEY]?.meta.model).toBe('openai/gpt-5.4');
  });

  it('shows the first available model for sessions without a session or agent default model without patching', async () => {
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

    expect(await screen.findByTestId('chat-model-picker')).toHaveTextContent('gpt-5.4');
    expect(hostSessionPatchMock).not.toHaveBeenCalled();
  });

  it('shows the current available model for stale session model metadata without patching', async () => {
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

    expect(await screen.findByTestId('chat-model-picker')).toHaveTextContent('gpt-5.4');
    expect(hostSessionPatchMock).not.toHaveBeenCalled();
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
