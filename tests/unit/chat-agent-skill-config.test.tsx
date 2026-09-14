import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatInput } from '@/pages/Chat/ChatInput';
import { AgentSkillConfigPanel } from '@/pages/Chat/components/AgentSkillConfigPanel';
import { useAgentSkillConfig } from '@/pages/Chat/useAgentSkillConfig';
import { hostApiFetch } from '@/lib/host-api';
import { useChatStore } from '@/stores/chat';
import { useRuntimeHostStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskCenterStore } from '@/stores/task-center-store';
import { useSkillsStore } from '@/stores/skills';
import { useAgentSkillConfigStore, __resetAgentSkillConfigStoreInternalCachesForTest } from '@/stores/agent-skill-config';
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
      { skillKey: 'web-search', displayName: 'Web Search', description: 'web', selectable: true },
      { skillKey: 'feishu-doc', displayName: 'Feishu Doc', description: 'doc', selectable: true },
      { skillKey: 'clawflow', displayName: 'Clawflow', description: 'flow', selectable: true },
      {
        skillKey: 'disabled-skill',
        displayName: 'Disabled Skill',
        description: 'disabled',
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
    if (payload.operationId === 'subagentSkills.get') {
      return clone(agentSkillConfigView);
    }
    if (payload.operationId === 'subagentSkills.set') {
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
const readySendGate = {
  canSend: true as const,
  kind: 'session' as const,
  sessionKey: testSessionKey,
  endpointSessionId: undefined,
  sessionIdentity: testSessionIdentity,
};

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: skillRuntimeFixtures.hostApiFetch,
  hostSessionPatch: vi.fn().mockResolvedValue({ success: true }),
  resolveSingleCapabilityScope: vi.fn().mockResolvedValue(skillRuntimeFixtures.testAgentScope),
  hostSessionList: vi.fn().mockResolvedValue({ ready: true, sessions: [] }),
  hostSessionLoad: vi.fn().mockResolvedValue({ snapshot: null }),
  hostSessionWindowFetch: vi.fn().mockResolvedValue({ snapshot: null }),
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

function renderSkillConfigPanelHarness() {
  const Harness = () => {
    const {
      selectedSkillIds,
      availableSkillOptions,
      skillsLoading,
      toggleSkill,
    } = useAgentSkillConfig({ currentAgentId: 'test' });

    return (
      <AgentSkillConfigPanel
        title="Skill Configuration · Test Agent"
        skillOptions={availableSkillOptions}
        skillsLoading={skillsLoading}
        selectedSkillIds={selectedSkillIds}
        onToggleSkill={toggleSkill}
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
    __resetAgentSkillConfigStoreInternalCachesForTest();
    useAgentSkillConfigStore.setState({
      viewByAgentId: {
        test: skillRuntimeFixtures.getAgentSkillConfigView(),
      },
      loadingByAgentId: {},
      errorByAgentId: {},
    });
    useSkillsStore.setState({
      skills: [
        {
          id: 'web-search',
          slug: 'web-search',
          name: 'Web Search',
          description: 'web',
          icon: '🌐',
          enabled: true,
          eligible: true,
          source: 'bundled',
        },
        {
          id: 'feishu-doc',
          slug: 'feishu-doc',
          name: 'Feishu Doc',
          description: 'doc',
          icon: '📄',
          enabled: true,
          eligible: true,
          source: 'bundled',
        },
        {
          id: 'clawflow',
          slug: 'clawflow',
          name: 'Clawflow',
          description: 'flow',
          icon: '🧩',
          enabled: true,
          eligible: true,
          source: 'bundled',
        },
      ],
      snapshotReady: true,
      initialLoading: false,
      fetchSkills: vi.fn().mockResolvedValue(undefined),
    } as never);

    useRuntimeHostStore.setState({
      runtimeHost: { lifecycle: 'running' },
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

  it('updates current agent allowlist through capability execution from the skill config panel', async () => {
    renderSkillConfigPanelHarness();

    expect(screen.getByText('Skill Configuration · Test Agent')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Web Search' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Feishu Doc' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Clawflow' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Disabled Skill' })).toBeDisabled();

    fireEvent.click(screen.getByRole('switch', { name: 'Clawflow' }));

    await waitFor(() => {
      expect(readCapabilityExecutePayloads('subagentSkills.set')).toContainEqual(expect.objectContaining({
        id: 'subagent.skills',
        operationId: 'subagentSkills.set',
        target: expect.objectContaining({
          kind: 'subagent',
          subagentId: 'test',
        }),
        input: expect.objectContaining({
          agentId: 'test',
          revision: 'rev-1',
          selection: {
            selectionType: 'inheritDefaultSkills',
          },
        }),
      }));
    });
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('does not toggle a non-selectable capability option', () => {
    renderSkillConfigPanelHarness();

    const disabledSkillSwitch = screen.getByRole('switch', { name: 'Disabled Skill' });
    expect(disabledSkillSwitch).toBeDisabled();
    fireEvent.click(disabledSkillSwitch);

    expect(readCapabilityExecutePayloads('subagentSkills.set')).toHaveLength(0);
  });

  it('opens skill management from the composer button and toggles skills in the dialog', async () => {
    const onToggleSkill = vi.fn();
    render(
      <MemoryRouter>
        <ChatInput
          onSend={vi.fn()}
          sendGate={readySendGate}
          sessionIdentity={testSessionIdentity}
          skillManager={{
            label: 'Skill Configuration',
            title: 'Skill Configuration · Test Agent',
            options: [
              { id: 'web-search', name: 'Web Search', description: 'web', selectable: true },
              { id: 'clawflow', name: 'Clawflow', description: 'flow', selectable: true },
            ],
            loading: false,
            selectedSkillIds: ['web-search'],
            skillPreview: null,
            onToggleSkill,
            onPreviewSkill: vi.fn(),
            onClearSkillPreview: vi.fn(),
          }}
        />
      </MemoryRouter>,
    );

    const managerButton = screen.getByTestId('chat-skill-manager-button');
    expect(managerButton).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(managerButton);

    expect(screen.getByRole('dialog', { name: 'Skill Configuration' })).toBeInTheDocument();
    expect(screen.getByText('Skill Configuration · Test Agent')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Clawflow' }));
    expect(onToggleSkill).toHaveBeenCalledWith('clawflow', true);
  });

  it('opens selected skill preview inside the composer skill manager dialog', async () => {
    const onPreviewSkill = vi.fn();
    render(
      <MemoryRouter>
        <ChatInput
          onSend={vi.fn()}
          sendGate={readySendGate}
          sessionIdentity={testSessionIdentity}
          skillManager={{
            label: 'Skill Configuration',
            title: 'Skill Configuration · Test Agent',
            options: [],
            loading: false,
            selectedSkillIds: [],
            skillPreview: {
              skillId: 'clawflow',
              skillName: 'Clawflow',
              markdown: '# Clawflow\n\nPreview body',
              loading: false,
              error: null,
              filePath: '/skills/clawflow/SKILL.md',
            },
            onToggleSkill: vi.fn(),
            onPreviewSkill,
            onClearSkillPreview: vi.fn(),
          }}
          allowedSkillIds={['clawflow']}
        />
      </MemoryRouter>,
    );

    const input = screen.getByTestId('chat-composer-input');
    fireEvent.change(input, { target: { value: '/' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.click(screen.getByTestId('chat-selected-skill-preview'));

    expect(onPreviewSkill).toHaveBeenCalledWith(expect.objectContaining({ id: 'clawflow', name: 'Clawflow' }));
    expect(screen.getByRole('dialog', { name: 'Skill Configuration' })).toBeInTheDocument();
    const previewPanel = screen.getByTestId('chat-skill-preview-panel');
    expect(previewPanel).toBeInTheDocument();
    expect(within(previewPanel).getAllByText('Clawflow').length).toBeGreaterThan(0);
    expect(within(previewPanel).getByText('Preview body')).toBeInTheDocument();
  });

  it('sends only skills allowed by the current agent allowlist', async () => {
    const onSend = vi.fn().mockResolvedValue({ accepted: true });
    render(
      <MemoryRouter>
        <ChatInput
          onSend={onSend}
          sendGate={readySendGate}
          sessionIdentity={testSessionIdentity}
          allowedSkillIds={['feishu-doc']}
        />
      </MemoryRouter>,
    );

    const input = screen.getByTestId('chat-composer-input');
    fireEvent.change(input, { target: { value: '/' } });
    expect(await screen.findByRole('option', { name: /Feishu Doc/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Web Search/ })).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(screen.getByText('Feishu Doc')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'use this skill' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('[已选择技能: Feishu Doc]\nuse this skill', undefined);
    });
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
