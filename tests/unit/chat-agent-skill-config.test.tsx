import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentSkillConfigPanel } from '@/pages/Chat/components/AgentSkillConfigPanel';
import { ChatSidePanel } from '@/pages/Chat/components/ChatSidePanel';
import { hostApiFetch } from '@/lib/host-api';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskCenterStore } from '@/stores/task-center-store';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRuntimeScopeKey, buildSessionRecordKey } from '@/stores/chat/session-identity';
import i18n from '@/i18n';

type AgentSkillSelectionMode = 'inheritsDefaultSkills' | 'usesExplicitSkillAllowlist';

type AgentSkillConfigSupport =
  | { supportType: 'supported' }
  | { supportType: 'unsupported'; reason: 'runtimeDoesNotExposeAgentSkillConfig' | 'agentNotConfigured' };

interface AgentSkillMissingRequirements {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
}

interface AgentSkillConfigOption {
  skillKey: string;
  displayName: string;
  description: string;
  installed: boolean;
  selectable: boolean;
  unavailableReason?: 'globalSkillDisabled' | 'blockedByRuntimeAllowlist' | 'missingRequirements';
  missingRequirements?: AgentSkillMissingRequirements;
}

interface AgentSkillConfigView {
  agentId: string;
  support: AgentSkillConfigSupport;
  selectionMode: AgentSkillSelectionMode;
  explicitSkillKeys: string[];
  inheritedDefaultSkillKeys: string[];
  effectiveSkillKeys: string[];
  options: AgentSkillConfigOption[];
  revision: string;
  updatedAt: number | null;
}

type SetAgentSkillConfigSelection =
  | { selectionType: 'inheritDefaultSkills' }
  | { selectionType: 'setExplicitSkillAllowlist'; skillKeys: string[] };

interface SetAgentSkillConfigCommand {
  agentId: string;
  revision: string;
  selection: SetAgentSkillConfigSelection;
}

type SetAgentSkillConfigResult =
  | { resultType: 'updated'; view: AgentSkillConfigView }
  | { resultType: 'staleRevision'; latestView: AgentSkillConfigView }
  | { resultType: 'unsupported'; reason: 'runtimeDoesNotExposeAgentSkillConfig' | 'agentNotConfigured' }
  | { resultType: 'invalidSkillKeys'; unknownSkillKeys: string[]; nonCanonicalSkillKeys: string[] };

const skillRuntimeFixtures = vi.hoisted(() => {
  const testSessionKey = 'agent:test:main';
  const testSessionIdentity = {
    endpoint: {
      kind: 'native-runtime' as const,
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
    },
    agentId: 'test',
    sessionKey: testSessionKey,
  };
  const testAgentScope = {
    kind: 'agent' as const,
    endpoint: testSessionIdentity.endpoint,
    agentId: 'test',
  };
  const buildAgentSkillConfigView = (overrides: Partial<AgentSkillConfigView> = {}): AgentSkillConfigView => ({
    agentId: 'test',
    support: { supportType: 'supported' },
    selectionMode: 'usesExplicitSkillAllowlist',
    explicitSkillKeys: ['web-search', 'feishu-doc'],
    inheritedDefaultSkillKeys: ['web-search', 'feishu-doc', 'clawflow'],
    effectiveSkillKeys: ['web-search', 'feishu-doc'],
    options: [
      { skillKey: 'web-search', displayName: 'Web Search', description: 'web', installed: true, selectable: true },
      { skillKey: 'feishu-doc', displayName: 'Feishu Doc', description: 'doc', installed: true, selectable: true },
      { skillKey: 'clawflow', displayName: 'Clawflow', description: 'flow', installed: true, selectable: true },
      {
        skillKey: 'disabled-skill',
        displayName: 'Disabled Skill',
        description: 'disabled',
        installed: true,
        selectable: false,
        unavailableReason: 'blockedByRuntimeAllowlist',
      },
    ],
    revision: 'rev-1',
    updatedAt: 1,
    ...overrides,
  });
  let agentSkillConfigView = buildAgentSkillConfigView();
  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const resetAgentSkillConfigView = (overrides: Partial<AgentSkillConfigView> = {}) => {
    agentSkillConfigView = buildAgentSkillConfigView(overrides);
  };
  const hostApiFetch = vi.fn(async (url: string, options?: { body?: string }) => {
    if (url !== '/api/capabilities/execute') {
      return {};
    }

    const payload = JSON.parse(options?.body ?? '{}') as {
      operationId?: string;
      input?: Partial<SetAgentSkillConfigCommand>;
    };
    if (payload.operationId === 'agentSkillConfig.get') {
      return clone(agentSkillConfigView);
    }
    if (payload.operationId === 'agentSkillConfig.set') {
      const selection = payload.input?.selection;
      const nextExplicitSkillKeys = selection?.selectionType === 'setExplicitSkillAllowlist'
        ? selection.skillKeys.filter((item): item is string => typeof item === 'string')
        : [];
      const nextView = buildAgentSkillConfigView({
        agentId: payload.input?.agentId ?? agentSkillConfigView.agentId,
        selectionMode: selection?.selectionType === 'inheritDefaultSkills'
          ? 'inheritsDefaultSkills'
          : 'usesExplicitSkillAllowlist',
        explicitSkillKeys: nextExplicitSkillKeys,
        effectiveSkillKeys: selection?.selectionType === 'inheritDefaultSkills'
          ? agentSkillConfigView.inheritedDefaultSkillKeys
          : nextExplicitSkillKeys,
        inheritedDefaultSkillKeys: agentSkillConfigView.inheritedDefaultSkillKeys,
        options: agentSkillConfigView.options,
        revision: 'rev-2',
        updatedAt: 2,
      });
      agentSkillConfigView = nextView;
      return clone({ resultType: 'updated', view: nextView } satisfies SetAgentSkillConfigResult);
    }
    return {};
  });

  return {
    testSessionKey,
    testSessionIdentity,
    testAgentScope,
    hostApiFetch,
    resetAgentSkillConfigView,
    getAgentSkillConfigView: () => clone(agentSkillConfigView),
  };
});

const { testSessionKey, testSessionIdentity, testAgentScope } = skillRuntimeFixtures;
const testRecordKey = buildSessionRecordKey(testSessionIdentity);
const hostApiFetchMock = vi.mocked(hostApiFetch);

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: skillRuntimeFixtures.hostApiFetch,
  hostSessionPatch: vi.fn().mockResolvedValue({ success: true }),
  hostRuntimeEndpointsList: vi.fn().mockResolvedValue({
    endpoints: [{
      id: 'openclaw-local',
      protocolId: 'openclaw-v4',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
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
        scope: skillRuntimeFixtures.testAgentScope,
        targetKinds: ['session'],
        operations: [],
        availability: 'available',
      }, {
        id: 'agent.skill-config',
        scopeKind: 'agent',
        scope: skillRuntimeFixtures.testAgentScope,
        targetKinds: ['subagent'],
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
  }),
  resolveSingleCapabilityScope: vi.fn().mockResolvedValue(skillRuntimeFixtures.testAgentScope),
  hostSessionList: vi.fn().mockResolvedValue({ ready: true, sessions: [] }),
  hostSessionLoad: vi.fn().mockResolvedValue({ snapshot: null }),
  hostSessionWindowFetch: vi.fn().mockResolvedValue({ snapshot: null }),
  resolveHydratedSessionSnapshot: vi.fn(async ({ initial }: { initial: { snapshot?: unknown } }) => initial.snapshot ?? null),
}));

interface CapabilityExecutePayload {
  id?: string;
  operationId?: string;
  target?: {
    kind?: string;
    agentId?: string;
    subagentId?: string;
  };
  input?: Partial<SetAgentSkillConfigCommand>;
}

function mapSkillConfigViewToPanelOptions(view: AgentSkillConfigView) {
  return view.options.map((option) => ({
    id: option.skillKey,
    name: option.displayName,
    description: option.description,
    selectable: option.selectable,
    unavailableReason: option.unavailableReason,
  }));
}

function readCapabilityExecutePayloads(operationId: string): CapabilityExecutePayload[] {
  return hostApiFetchMock.mock.calls.flatMap(([url, options]) => {
    if (url !== '/api/capabilities/execute') {
      return [];
    }
    const body = typeof options?.body === 'string' ? options.body : '{}';
    const payload = JSON.parse(body) as CapabilityExecutePayload;
    return payload.operationId === operationId ? [payload] : [];
  });
}

function renderSkillSidePanelHarness() {
  const Harness = () => {
    const [view, setView] = useState(skillRuntimeFixtures.getAgentSkillConfigView());
    const [loading, setLoading] = useState(false);
    const handleToggleSkill = async (skillId: string, checked: boolean) => {
      const baseSkillKeys = view.selectionMode === 'inheritsDefaultSkills'
        ? view.effectiveSkillKeys
        : view.explicitSkillKeys;
      const nextExplicitSkillKeys = checked
        ? (baseSkillKeys.includes(skillId) ? baseSkillKeys : [...baseSkillKeys, skillId])
        : baseSkillKeys.filter((id) => id !== skillId);
      setLoading(true);
      const result = await hostApiFetch('/api/capabilities/execute', {
        method: 'POST',
        body: JSON.stringify({
          id: 'agent.skill-config',
          operationId: 'agentSkillConfig.set',
          target: {
            kind: 'subagent',
            agentId: 'test',
            subagentId: 'test',
          },
          input: {
            agentId: 'test',
            revision: view.revision,
            selection: {
              selectionType: 'setExplicitSkillAllowlist',
              skillKeys: nextExplicitSkillKeys,
            },
          },
        }),
      }) as SetAgentSkillConfigResult;
      if (result.resultType === 'updated') {
        setView(result.view);
      }
      setLoading(false);
    };

    return (
      <ChatSidePanel
        mode="docked"
        width={320}
        activeTab="skills"
        artifactWorkbenchFullscreen={false}
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        onToggleArtifactWorkbenchFullscreen={vi.fn()}
        unfinishedTaskCount={0}
        taskInboxTasks={[]}
        taskInboxLoading={false}
        taskInboxError={null}
        onRefreshTaskInbox={vi.fn().mockResolvedValue(undefined)}
        onClearTaskInboxError={vi.fn()}
        derivedPlanStatus={null}
        skillConfigLabel="Skill Configuration"
        skillConfigTitle="Skill Configuration · Test Agent"
        skillOptions={mapSkillConfigViewToPanelOptions(view)}
        skillsLoading={loading}
        selectedSkillIds={view.effectiveSkillKeys}
        onToggleSkill={handleToggleSkill}
        skillPreview={null}
        onClearSkillPreview={vi.fn()}
        artifactGroups={[]}
        artifactFocusedFile={null}
        artifactActiveSection="changes"
        artifactViewMode="preview"
        artifactWorkspaceRoot={null}
        onArtifactFocusFile={vi.fn()}
        onOpenGeneratedArtifactFile={vi.fn()}
        onOpenArtifactGroup={vi.fn()}
        onArtifactSectionChange={vi.fn()}
        onArtifactViewModeChange={vi.fn()}
        onArtifactRevealInFileManager={vi.fn()}
      />
    );
  };

  return render(<Harness />);
}

describe('chat agent skill configuration', () => {
  const updateAgent = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    i18n.changeLanguage('en');
    window.localStorage.removeItem('chat:side-panel-open');
    window.localStorage.removeItem('chat:side-panel-tab');
    updateAgent.mockClear();
    hostApiFetchMock.mockClear();
    skillRuntimeFixtures.resetAgentSkillConfigView();

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
      agents: [
        { id: 'main', name: 'Main', workspace: '/workspace/main', model: 'gpt-main', isDefault: true },
        { id: 'test', name: 'Test Agent', workspace: '/workspace/test', model: 'gpt-4.1-mini', isDefault: false },
      ],
      agentsResource: {
        status: 'ready',
        data: [
          { id: 'main', name: 'Main', workspace: '/workspace/main', model: 'gpt-main', isDefault: true },
          { id: 'test', name: 'Test Agent', workspace: '/workspace/test', model: 'gpt-4.1-mini', isDefault: false },
        ],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadAgents: vi.fn().mockResolvedValue(undefined),
      updateAgent,
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

    useSkillsStore.setState({
      skills: [
        { id: 'web-search', name: 'Web Search', description: 'web', enabled: true, installed: true, eligible: true, icon: '🌐' },
        { id: 'feishu-doc', name: 'Feishu Doc', description: 'doc', enabled: true, installed: true, eligible: true, icon: '📄' },
        { id: 'clawflow', name: 'Clawflow', description: 'flow', enabled: true, installed: true, eligible: true, icon: '🪝' },
      ],
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      fetchSkills: vi.fn().mockResolvedValue(undefined),
    });

    useChatStore.setState({
      mutating: false,
      error: null,
      foregroundHistorySessionKey: null,
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
          endpoint: testSessionIdentity.endpoint,
          runtimeAdapterId: 'openclaw',
          runtimeInstanceId: 'local',
          displayName: 'OpenClaw Local',
          agentIds: ['test'],
          acceptsDynamicAgents: true,
          sessionPromptScopes: [testAgentScope],
          defaultSessionPromptScope: testAgentScope,
        }],
        defaultSessionPromptScope: testAgentScope,
      },
      currentSessionKey: testRecordKey,
      loadedSessions: {
        [testRecordKey]: {
          ...createEmptySessionRecord(),
          meta: {
            ...createEmptySessionRecord().meta,
            backendSessionKey: testSessionKey,
            runtimeScopeKey: buildRuntimeScopeKey(testSessionIdentity.endpoint),
            agentId: 'test',
            protocolId: 'openclaw-v4',
            runtimeEndpointId: 'local',
            sessionIdentity: testSessionIdentity,
            kind: 'main',
            preferred: true,
            historyStatus: 'ready',
          },
        },
      },
      showThinking: true,
      pendingApprovalsBySession: {},
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      switchSession: vi.fn(),
      openAgentConversation: vi.fn(),
      sendMessage: vi.fn(),
      abortRun: vi.fn(),
      clearError: vi.fn(),
      cleanupEmptySession: vi.fn(),
      resolveApproval: vi.fn(),
      refresh: vi.fn(),
      toggleThinking: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn(),
    } as never);
  });

  it('opens the shared side panel on the skills tab and updates current agent allowlist through capability execution', async () => {
    renderSkillSidePanelHarness();

    expect(screen.getByRole('tab', { name: 'Skill Configuration' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Skill Configuration · Test Agent')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Web Search' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Feishu Doc' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Clawflow' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Disabled Skill' })).toBeDisabled();

    fireEvent.click(screen.getByRole('switch', { name: 'Web Search' }));

    await waitFor(() => {
      expect(readCapabilityExecutePayloads('agentSkillConfig.set')).toContainEqual(expect.objectContaining({
        id: 'agent.skill-config',
        operationId: 'agentSkillConfig.set',
        target: expect.objectContaining({
          kind: 'subagent',
        }),
        input: expect.objectContaining({
          agentId: 'test',
          revision: 'rev-1',
          selection: {
            selectionType: 'setExplicitSkillAllowlist',
            skillKeys: ['feishu-doc'],
          },
        }),
      }));
    });
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('does not toggle a non-selectable capability option', () => {
    renderSkillSidePanelHarness();

    const disabledSkillSwitch = screen.getByRole('switch', { name: 'Disabled Skill' });
    expect(disabledSkillSwitch).toBeDisabled();
    fireEvent.click(disabledSkillSwitch);

    expect(readCapabilityExecutePayloads('agentSkillConfig.set')).toHaveLength(0);
  });

  it('slash 只展示当前 agent effectiveSkillKeys 中的技能', () => {
    skillRuntimeFixtures.resetAgentSkillConfigView({
      effectiveSkillKeys: ['feishu-doc'],
      explicitSkillKeys: ['feishu-doc'],
    });

    const view = skillRuntimeFixtures.getAgentSkillConfigView();
    const slashSkillNames = view.options
      .filter((option) => view.effectiveSkillKeys.includes(option.skillKey))
      .map((option) => option.displayName);

    expect(slashSkillNames).toEqual(['Feishu Doc']);
    expect(slashSkillNames).not.toContain('Web Search');
  });

  it('renders the inline skill list as immediate switches without save actions', () => {
    const onToggleSkill = vi.fn();

    render(
      <AgentSkillConfigPanel
        title="Skill Configuration · Test Agent"
        skillOptions={[
          { id: 'web-search', name: 'Web Search', description: 'web', icon: '🌐', selectable: true },
          { id: 'feishu-doc', name: 'Feishu Doc', description: 'doc', icon: '📄', selectable: true },
          {
            id: 'disabled-skill',
            name: 'Disabled Skill',
            description: 'disabled',
            icon: '🚫',
            selectable: false,
            unavailableReason: 'Disabled by runtime policy',
          },
        ]}
        skillsLoading={false}
        selectedSkillIds={['feishu-doc']}
        onToggleSkill={onToggleSkill}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByText('Skill Configuration · Test Agent')).toBeInTheDocument();

    const webSearchSwitch = screen.getByRole('switch', { name: 'Web Search' });
    const feishuDocSwitch = screen.getByRole('switch', { name: 'Feishu Doc' });
    const disabledSkillSwitch = screen.getByRole('switch', { name: 'Disabled Skill' });
    expect(webSearchSwitch).not.toBeDisabled();
    expect(feishuDocSwitch).not.toBeDisabled();
    expect(disabledSkillSwitch).toBeDisabled();

    fireEvent.click(webSearchSwitch);
    fireEvent.click(disabledSkillSwitch);

    expect(onToggleSkill).toHaveBeenCalledTimes(1);
    expect(onToggleSkill).toHaveBeenCalledWith('web-search', true);
  });
});
