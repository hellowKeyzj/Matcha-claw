import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardRef, useImperativeHandle } from 'react';
import { MemoryRouter } from 'react-router-dom';
import Chat from '@/pages/Chat';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useLayoutStore } from '@/stores/layout';
import { useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { useSubagentsStore } from '@/stores/subagents';
import { useCapabilityRoutingStore } from '@/stores/capability-routing';
import { createReadyResourceStatusState } from '@/lib/resource-state';
import { createEmptySessionRecord, createEmptySessionViewportState } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { buildRuntimeScopeKey, buildSessionRecordKey } from '@/stores/chat/session-identity';
import type { RuntimeEndpointSummary } from '@/types/runtime-topology';
import type { SessionRenderItem } from '@/types/session/render-item';
import type { SessionRenderToolCard } from '@/types/session/tool-card';

const hostApiMocks = vi.hoisted(() => ({
  hostSessionPermissionGet: vi.fn(),
  hostSessionPermissionSet: vi.fn(),
  hostSessionPatch: vi.fn(),
  hostSessionWindowFetch: vi.fn(),
  hostApiFetch: vi.fn(),
}));

const agentSkillConfigMocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  resetSession: vi.fn(),
  toggleSkill: vi.fn(),
}));

vi.mock('@/lib/host-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/host-api')>();
  return {
    ...actual,
    hostApiFetch: (...args: unknown[]) => hostApiMocks.hostApiFetch(...args),
    hostSessionPatch: (...args: unknown[]) => hostApiMocks.hostSessionPatch(...args),
    hostSessionPermissionGet: (...args: unknown[]) => hostApiMocks.hostSessionPermissionGet(...args),
    hostSessionPermissionSet: (...args: unknown[]) => hostApiMocks.hostSessionPermissionSet(...args),
    hostSessionWindowFetch: (...args: unknown[]) => hostApiMocks.hostSessionWindowFetch(...args),
  };
});

vi.mock('@/hooks/use-workspace-availability', () => ({
  useWorkspaceAvailability: () => ({}),
}));

vi.mock('@/pages/Chat/useChatInit', () => ({
  useChatInit: () => undefined,
}));

vi.mock('@/pages/Chat/useAgentSkillConfig', () => ({
  useAgentSkillConfig: () => ({
    selectedSkillIds: [],
    allowedSkillIdsForChat: [],
    availableSkillOptions: [],
    skillsLoading: false,
    prepare: agentSkillConfigMocks.prepare,
    resetSession: agentSkillConfigMocks.resetSession,
    toggleSkill: agentSkillConfigMocks.toggleSkill,
  }),
}));

vi.mock('@/pages/Chat/useChatWindowDockController', () => ({
  useChatWindowDockController: ({
    panelOpen,
    preferredWidth,
    renderWidth,
    openPanel,
    closePanel,
    setPanelWidth,
  }: {
    panelOpen: boolean;
    preferredWidth: number;
    renderWidth: number;
    openPanel: () => void;
    closePanel: () => void;
    setPanelWidth: (width: number) => void;
  }) => ({
    phase: panelOpen ? 'open' : 'closed',
    sidePanelExpanded: panelOpen,
    sidePanelMode: 'docked',
    sidePanelWidth: panelOpen ? preferredWidth : renderWidth,
    sidePanelMainWidth: null,
    sidePanelVisible: panelOpen,
    toggleSidePanel: () => {
      if (panelOpen) {
        closePanel();
        return;
      }
      openPanel();
    },
    openSidePanel: openPanel,
    closeSidePanel: closePanel,
    resizeSidePanelWidth: setPanelWidth,
    commitSidePanelWidth: setPanelWidth,
  }),
}));

vi.mock('@/pages/Chat/components/ChatShell', () => ({
  ChatShell: ({
    chatLayoutRef,
    sidePanelPhase,
    sidePanel,
    header,
    viewportPane,
  }: {
    chatLayoutRef: React.RefObject<HTMLDivElement | null>;
    sidePanelPhase: string;
    sidePanel: React.ReactNode;
    header: React.ReactNode;
    viewportPane: React.ReactNode;
  }) => (
    <div ref={chatLayoutRef} data-testid="chat-shell" data-side-panel-phase={sidePanelPhase}>
      {header}
      {viewportPane}
      {sidePanelPhase === 'open' ? sidePanel : null}
    </div>
  ),
}));

vi.mock('@/pages/Chat/components/ChatHeaderBar', () => ({
  ChatHeaderBar: ({
    sidePanelOpen,
    onToggleSidePanel,
  }: {
    sidePanelOpen: boolean;
    onToggleSidePanel: () => void;
  }) => (
    <button type="button" data-testid="side-panel-toggle" data-open={sidePanelOpen ? 'true' : 'false'} onClick={onToggleSidePanel}>
      side panel
    </button>
  ),
}));

vi.mock('@/pages/Chat/components/ChatSidePanel', () => ({
  ChatSidePanel: ({ activeTab, onClose }: { activeTab: string; onClose: () => void }) => (
    <aside data-testid="chat-side-panel" data-active-tab={activeTab}>
      <button type="button" data-testid="side-panel-collapse" onClick={onClose}>collapse</button>
    </aside>
  ),
}));

vi.mock('@/pages/Chat/components/ChatList', () => ({
  ChatList: forwardRef((_props, ref) => {
    useImperativeHandle(ref, () => ({
      prepareCurrentLatestBottomAlign: () => undefined,
      scrollByWheelDelta: () => undefined,
      notifyComposerGeometryChanged: () => undefined,
    }));
    return <div data-testid="chat-list" />;
  }),
}));

vi.mock('@/pages/Chat/ChatInput', () => ({
  ChatInput: () => <div data-testid="chat-input" />,
}));

vi.mock('@/pages/Chat/components/ChatStates', () => ({
  WelcomeScreen: () => <div data-testid="welcome-screen" />,
}));

vi.mock('@/pages/Chat/components/ChatRuntimeDock', () => ({
  ChatApprovalDock: () => null,
  ChatErrorBanner: () => null,
  ChatRuntimeStatusDock: () => null,
}));

vi.mock('@/pages/Chat/components/SessionTodoPanel', () => ({
  SessionTodoPanel: () => null,
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const TEST_SESSION_IDENTITY = {
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
  agentId: 'test',
  sessionKey: 'agent:test:main',
};
const TEST_RECORD_KEY = buildSessionRecordKey(TEST_SESSION_IDENTITY);
const TEST_RUNTIME_SCOPE_KEY = buildRuntimeScopeKey(TEST_SESSION_IDENTITY.endpoint);

const TEST_RUNTIME_ENDPOINT = {
  id: 'openclaw-local',
  protocolId: 'openclaw-v4',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  endpointRef: TEST_SESSION_IDENTITY.endpoint,
  source: {
    kind: 'runtime-adapter',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
    endpointId: 'local',
  },
  location: { kind: 'local' },
  lifecycle: { phase: 'ready', connected: true, ready: true, updatedAt: 1 },
  displayName: 'OpenClaw Local',
  agentIds: ['test'],
  defaultAgentId: 'test',
  agents: [{
    agentId: 'test',
    displayName: 'Test Agent',
    source: 'declared',
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      approvals: true,
      replay: true,
      modelSelection: true,
    },
  }],
  acceptsDynamicAgents: true,
  capabilities: {
    chat: true,
    streaming: true,
    tools: true,
    approvals: true,
    replay: true,
    modelSelection: true,
  },
  capabilityFamilies: [{ family: 'session', availability: 'supported' }],
  controlState: {
    connection: {
      state: 'connected',
      portReachable: true,
      gatewayReady: true,
      healthSummary: 'healthy',
      transportEpoch: 1,
      diagnostics: { consecutiveHeartbeatMisses: 0, consecutiveRpcFailures: 0 },
      updatedAt: 1,
    },
    readiness: { ready: true, phase: 'ready' },
    capabilities: { methods: [], updatedAt: 1 },
    updatedAt: 1,
  },
} satisfies RuntimeEndpointSummary;

function artifactToolCard(): SessionRenderToolCard {
  return {
    id: 'patch-1',
    toolCallId: 'patch-1',
    name: 'patch',
    displayTitle: 'patch',
    input: {
      patch: [
        'diff --git a/src/demo.ts b/src/demo.ts',
        '--- a/src/demo.ts',
        '+++ b/src/demo.ts',
        '@@ -1 +1 @@',
        '-const value = 1;',
        '+const value = 2;',
      ].join('\n'),
    },
    status: 'completed',
    result: { kind: 'none', surface: 'tool-card' },
  };
}

function artifactRenderItems(): SessionRenderItem[] {
  const tool = artifactToolCard();
  return [{
    key: 'assistant-tool-turn',
    kind: 'assistant-turn',
    role: 'assistant',
    sessionKey: TEST_SESSION_IDENTITY.sessionKey,
    identitySource: 'tool_call',
    identityMode: 'tool_call',
    identityConfidence: 'strong',
    status: 'final',
    segments: [{ kind: 'tool', key: 'segment-1', tool }],
    thinking: null,
    tools: [tool],
    text: '',
    images: [],
    attachedFiles: [],
  }];
}

function renderChat() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Chat />
    </MemoryRouter>,
  );
}

describe('chat artifact side panel remount', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('chat:side-panel-tab', 'artifacts');
    hostApiMocks.hostSessionPermissionGet.mockReset();
    hostApiMocks.hostSessionPermissionGet.mockResolvedValue({
      supported: false,
      options: [],
      pending: false,
      canSelectFull: false,
      mode: null,
    });
    hostApiMocks.hostSessionPermissionSet.mockReset();
    hostApiMocks.hostSessionPatch.mockReset();
    hostApiMocks.hostSessionWindowFetch.mockReset();
    hostApiMocks.hostApiFetch.mockReset();
    agentSkillConfigMocks.prepare.mockClear();
    agentSkillConfigMocks.resetSession.mockClear();
    agentSkillConfigMocks.toggleSkill.mockClear();

    useGatewayStore.setState({
      status: {
        processState: 'running',
        port: 18789,
        gatewayReady: true,
        healthSummary: 'healthy',
        transportState: 'connected',
        portReachable: true,
        diagnostics: { consecutiveHeartbeatMisses: 0, consecutiveRpcFailures: 0 },
        updatedAt: 1,
      },
      runtimeHost: { lifecycle: 'running' },
      isInitialized: true,
    } as never);

    useRuntimeEndpointsStore.setState({
      status: 'ready',
      error: null,
      endpoints: [TEST_RUNTIME_ENDPOINT],
      hasLoadedOnce: true,
      revision: 1,
      changedRuntimeScopeKeys: [],
      revisionByRuntimeScopeKey: {},
    } as never);

    useCapabilityRoutingStore.setState({
      routing: { chat: { primary: null, fallbacks: [] } },
      revision: 1,
      ready: true,
      loading: false,
      saving: false,
      error: null,
    } as never);

    useSubagentsStore.setState({
      agents: [{ id: 'test', name: 'Test Agent', workspace: '.', model: null, skills: [], isDefault: true }],
      agentsResource: {
        status: 'ready',
        data: [{ id: 'test', name: 'Test Agent', workspace: '.', model: null, skills: [], isDefault: true }],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      availableModels: [],
      modelsLoading: false,
      loadAvailableModels: vi.fn().mockResolvedValue(undefined),
      loadAgents: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
    } as never);

    useLayoutStore.setState({
      chatTakeoverMode: 'none',
      chatWindowRightDockLayout: null,
    });

    const items = artifactRenderItems();
    const emptySession = createEmptySessionRecord();
    useChatStore.setState({
      currentSessionKey: TEST_RECORD_KEY,
      currentConversation: {
        kind: 'session',
        runtimeScopeKey: TEST_RUNTIME_SCOPE_KEY,
        endpoint: TEST_SESSION_IDENTITY.endpoint,
        agentId: TEST_SESSION_IDENTITY.agentId,
        sessionRecordKey: TEST_RECORD_KEY,
        endpointSessionId: 'main',
        sessionIdentity: TEST_SESSION_IDENTITY,
      },
      pendingApprovalsBySession: {},
      dismissedRuntimeErrorBySession: {},
      foregroundHistorySessionKey: null,
      sessionCatalogStatus: createReadyResourceStatusState(1),
      sessionRuntimeCatalog: {
        status: 'ready',
        error: null,
        endpoints: [{
          endpointId: 'local',
          protocolId: 'openclaw-v4',
          endpoint: TEST_SESSION_IDENTITY.endpoint,
          runtimeAdapterId: 'openclaw',
          runtimeInstanceId: 'local',
          displayName: 'OpenClaw Local',
          agentIds: ['test'],
          acceptsDynamicAgents: true,
          agentCatalog: { source: 'runtime-endpoint', agents: [{ id: 'test', name: 'Test Agent' }] },
          sessionPromptScopes: [{ kind: 'agent', endpoint: TEST_SESSION_IDENTITY.endpoint, agentId: 'test' }],
          defaultSessionPromptScope: { kind: 'agent', endpoint: TEST_SESSION_IDENTITY.endpoint, agentId: 'test' },
        }],
        defaultSessionPromptScope: { kind: 'agent', endpoint: TEST_SESSION_IDENTITY.endpoint, agentId: 'test' },
      },
      loadedSessions: {
        [TEST_RECORD_KEY]: {
          ...emptySession,
          items,
          window: createViewportWindowState({
            ...createEmptySessionViewportState(),
            totalItemCount: items.length,
            windowStartOffset: 0,
            windowEndOffset: items.length,
            hasMore: false,
            hasNewer: false,
            isAtLatest: true,
          }),
          meta: {
            ...emptySession.meta,
            endpointSessionId: 'main',
            runtimeScopeKey: TEST_RUNTIME_SCOPE_KEY,
            agentId: 'test',
            protocolId: 'openclaw-v4',
            runtimeEndpointId: 'local',
            sessionIdentity: TEST_SESSION_IDENTITY,
            kind: 'main',
            preferred: true,
            historyStatus: 'ready',
            lastActivityAt: 1,
          },
        },
      },
      showThinking: true,
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
      newSession: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
      toggleThinking: vi.fn(),
    } as never);
  });

  it('does not reopen remembered artifact workspace on chat remount after collapse', async () => {
    const view = renderChat();

    await waitFor(() => {
      expect(screen.getByTestId('chat-shell')).toHaveAttribute('data-side-panel-phase', 'closed');
    });
    expect(screen.queryByTestId('chat-side-panel')).toBeNull();

    fireEvent.click(screen.getByTestId('side-panel-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('chat-side-panel')).toHaveAttribute('data-active-tab', 'artifacts');
    });

    fireEvent.click(screen.getByTestId('side-panel-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('chat-shell')).toHaveAttribute('data-side-panel-phase', 'closed');
    });
    expect(screen.queryByTestId('chat-side-panel')).toBeNull();

    view.unmount();
    renderChat();

    await waitFor(() => {
      expect(screen.getByTestId('chat-shell')).toHaveAttribute('data-side-panel-phase', 'closed');
    });
    expect(screen.queryByTestId('chat-side-panel')).toBeNull();
  });
});
