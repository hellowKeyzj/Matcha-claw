import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentSessionsPane } from '@/components/layout/AgentSessionsPane';
import Chat from '@/pages/Chat';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskCenterStore } from '@/stores/task-center-store';
import i18n from '@/i18n';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { buildRuntimeScopeKey, buildSessionRecordKey } from '@/stores/chat/session-identity';
import type { RawMessage } from './helpers/timeline-fixtures';

const runtimeFixtures = vi.hoisted(() => {
  const mainSessionKey = 'agent:main:main';
  const anotherSessionKey = 'agent:another:main';
  const runtimeEndpoint = {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  };
  const mainAgentScope = {
    kind: 'agent' as const,
    endpoint: runtimeEndpoint,
    agentId: 'main',
  };
  const anotherAgentScope = {
    kind: 'agent' as const,
    endpoint: runtimeEndpoint,
    agentId: 'another',
  };
  const mainSessionIdentity = {
    endpoint: runtimeEndpoint,
    agentId: 'main',
    sessionKey: mainSessionKey,
  };
  const anotherSessionIdentity = {
    endpoint: runtimeEndpoint,
    agentId: 'another',
    sessionKey: anotherSessionKey,
  };
  return {
    mainSessionKey,
    anotherSessionKey,
    runtimeEndpoint,
    mainAgentScope,
    anotherAgentScope,
    mainSessionIdentity,
    anotherSessionIdentity,
  };
});

const {
  mainSessionKey,
  anotherSessionKey,
  runtimeEndpoint,
  mainAgentScope,
  anotherAgentScope,
  mainSessionIdentity,
  anotherSessionIdentity,
} = runtimeFixtures;
const mainRecordKey = buildSessionRecordKey(mainSessionIdentity);
const anotherRecordKey = buildSessionRecordKey(anotherSessionIdentity);

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn().mockResolvedValue({}),
  hostSessionPatch: vi.fn().mockResolvedValue({ success: true }),
  hostRuntimeEndpointsList: vi.fn().mockResolvedValue({
    endpoints: [{
      id: 'openclaw-local',
      protocolId: 'openclaw-v4',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
      displayName: 'OpenClaw Local',
      agentIds: ['main', 'another'],
      acceptsDynamicAgents: true,
      capabilities: {
        chat: true,
        streaming: true,
        tools: true,
        approvals: true,
        replay: true,
        modelSelection: true,
      },
      capabilitySummaries: [
        { id: 'session.prompt', scope: runtimeFixtures.mainAgentScope },
        { id: 'session.prompt', scope: runtimeFixtures.anotherAgentScope },
      ],
      controlState: {
        connection: null,
        readiness: null,
        capabilities: null,
        updatedAt: null,
      },
    }],
  }),
  resolveSingleCapabilityScope: vi.fn().mockResolvedValue({
    kind: 'runtime-instance',
    endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
  }),
  hostSessionList: vi.fn().mockResolvedValue({ ready: true, sessions: [] }),
  hostSessionLoad: vi.fn().mockResolvedValue({ snapshot: null }),
  hostSessionWindowFetch: vi.fn().mockResolvedValue({ snapshot: null }),
  resolveHydratedSessionSnapshot: vi.fn(async ({ initial }: { initial: { snapshot?: unknown } }) => initial.snapshot ?? null),
}));

function buildSessionRecord(
  sessionKey: string,
  overrides?: Partial<ReturnType<typeof createEmptySessionRecord>> & { messages?: RawMessage[] },
) {
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
    items: overrides?.messages
      ? buildRenderItemsFromMessages(sessionKey, overrides.messages)
      : (overrides?.items ?? base.items),
    window: overrides?.window ?? base.window,
  };
}

function findClosestScrollViewport(node: HTMLElement | null): HTMLDivElement | null {
  let current = node?.parentElement ?? null;
  while (current) {
    if (typeof current.className === 'string' && current.className.includes('overflow-y-auto')) {
      return current as HTMLDivElement;
    }
    current = current.parentElement;
  }
  return null;
}

function installViewportMetrics(
  viewport: HTMLDivElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(viewport, 'scrollHeight', {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value: number) => {
      metrics.scrollTop = value;
    },
  });
}

describe('chat 左侧点击链路回归', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');

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
    } as never);

    useSubagentsStore.setState({
      agentsResource: {
        status: 'ready',
        data: [
          { id: 'main', name: 'main', workspace: '.', isDefault: true, createdAt: 1, updatedAt: 1 },
          { id: 'another', name: 'another', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
        ],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: Date.now(),
      },
      loadAgents: vi.fn().mockResolvedValue(undefined),
    } as never);

    useTaskCenterStore.setState({
      tasks: [],
      loading: false,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      initialized: true,
      error: null,
      init: vi.fn().mockResolvedValue(undefined),
      refreshTasks: vi.fn().mockResolvedValue(undefined),
      openTaskSession: vi.fn().mockReturnValue({ switched: false, reason: 'task_not_found' }),
      clearError: vi.fn(),
    } as never);

    useChatStore.setState({
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      error: null,
      pendingApprovalsBySession: {},
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
          endpointId: 'openclaw-local',
          protocolId: 'openclaw-v4',
          endpoint: runtimeEndpoint,
          runtimeAdapterId: 'openclaw',
          runtimeInstanceId: 'local',
          displayName: 'OpenClaw Local',
          agentIds: ['main', 'another'],
          acceptsDynamicAgents: true,
          sessionPromptScopes: [mainAgentScope, anotherAgentScope],
          defaultSessionPromptScope: mainAgentScope,
        }],
        defaultSessionPromptScope: mainAgentScope,
      },
      currentSessionKey: mainRecordKey,
      loadedSessions: {
        [mainRecordKey]: buildSessionRecord(mainSessionKey, {
          messages: [
            {
              role: 'user',
              content: 'current session user message',
              timestamp: 1,
              id: 'current-msg-1',
            },
            {
              role: 'assistant',
              content: 'current session mid message',
              timestamp: 2,
              id: 'current-msg-2',
            },
            {
              role: 'assistant',
              content: 'current session old message',
              timestamp: 3,
              id: 'current-msg-3',
            },
          ],
          window: createViewportWindowState({
            totalItemCount: 3,
            windowStartOffset: 0,
            windowEndOffset: 3,
            isAtLatest: true,
          }),
          meta: {
            backendSessionKey: mainSessionKey,
            runtimeScopeKey: buildRuntimeScopeKey(runtimeEndpoint),
            agentId: 'main',
            protocolId: null,
            runtimeEndpointId: 'local',
            sessionIdentity: mainSessionIdentity,
            kind: 'main',
            preferred: true,
            historyStatus: 'ready',
          },
        }),
        [anotherRecordKey]: buildSessionRecord(anotherSessionKey, {
          messages: [
            {
              role: 'user',
              content: 'another user message',
              timestamp: 1,
              id: 'another-msg-1',
            },
            {
              role: 'assistant',
              content: 'another assistant mid message',
              timestamp: 2,
              id: 'another-msg-2',
            },
            {
              role: 'assistant',
              content: 'another assistant latest message',
              timestamp: 3,
              id: 'another-msg-3',
            },
          ],
          window: createViewportWindowState({
            totalItemCount: 3,
            windowStartOffset: 0,
            windowEndOffset: 3,
            isAtLatest: true,
          }),
          meta: {
            backendSessionKey: anotherSessionKey,
            runtimeScopeKey: buildRuntimeScopeKey(runtimeEndpoint),
            agentId: 'another',
            protocolId: null,
            runtimeEndpointId: 'local',
            sessionIdentity: anotherSessionIdentity,
            kind: 'main',
            preferred: true,
            label: 'another latest session',
            lastActivityAt: 3,
            historyStatus: 'ready',
          },
        }),
      },
      showThinking: true,
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it('用户先上翻当前会话，再点击左侧 AGENT 时，仍应落到目标会话最新消息底部', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <div className="flex h-screen">
            <AgentSessionsPane />
            <div className="min-h-0 flex-1">
              <Chat />
            </div>
          </div>
        </TooltipProvider>
      </MemoryRouter>,
    );

    const currentMessage = screen.getByText('current session old message');
    const viewport = findClosestScrollViewport(currentMessage as HTMLElement);
    expect(viewport).toBeTruthy();
    if (!viewport) {
      return;
    }

    const metrics = {
      scrollHeight: 2200,
      clientHeight: 320,
      scrollTop: 0,
    };
    installViewportMetrics(viewport, metrics);

    fireEvent.scroll(viewport);

    metrics.scrollHeight = 760;
    fireEvent.click(screen.getByTestId('agent-item-another'));

    await waitFor(() => {
      expect(screen.getByText('another assistant latest message')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(440);
    });
  });
});
