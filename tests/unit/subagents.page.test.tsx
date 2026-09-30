import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { SubAgents } from '@/pages/SubAgents';
import { useRuntimeHostStore } from '@/stores/gateway';
import { useAgentSkillConfigStore, __resetAgentSkillConfigStoreInternalCachesForTest } from '@/stores/agent-skill-config';
import { useAgentToolConfigStore, __resetAgentToolConfigStoreInternalCachesForTest } from '@/stores/agent-tool-config';
import { useSubagentsStore } from '@/stores/subagents';
import i18n from '@/i18n';
import { __resetSubagentTemplateCatalogCacheForTest } from '@/services/openclaw/subagent-template-catalog';
import type { AgentScope, RuntimeEndpointRef, RuntimeScope } from '../../src/types/desktop/runtime-address';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="router-location">{`${location.pathname}${location.search}`}</div>;
}

const runtimeEndpoint: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};
const runningGatewayStatus = {
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
} as const;
const stoppedGatewayStatus = {
  ...runningGatewayStatus,
  processState: 'stopped',
  gatewayReady: false,
  healthSummary: 'unresponsive',
  transportState: 'disconnected',
  portReachable: false,
  updatedAt: 0,
} as const;
const defaultAgentScope: AgentScope = {
  kind: 'agent',
  endpoint: runtimeEndpoint,
  agentId: 'default',
};
const workspaceScope: RuntimeScope = {
  kind: 'workspace',
  endpoint: runtimeEndpoint,
};
const OPENAI_GPT41_MINI_SELECTION_ID = 'model-selection:v1:1111111111111111111111111111111111111111111111111111111111111111';
const OPENAI_GPT41_MINI_RUNTIME_REF = 'openai/gpt-4.1-mini';
const ANTHROPIC_CLAUDE37_SELECTION_ID = 'model-selection:v1:2222222222222222222222222222222222222222222222222222222222222222';
const ANTHROPIC_CLAUDE37_RUNTIME_REF = 'anthropic/claude-3-7-sonnet';
const CUSTOM_GPT4O_SELECTION_ID = 'model-selection:v1:3333333333333333333333333333333333333333333333333333333333333333';
const CUSTOM_GPT4O_RUNTIME_REF = 'custom-dd749b2e/gpt-4o-mini';

function buildCapabilitiesListEnvelope() {
  return {
    ok: true,
    data: {
      status: 200,
      ok: true,
      json: {
        capabilities: [
          {
            id: 'subagent.management',
            kind: 'subagent.management',
            scopeKind: 'agent',
            scope: defaultAgentScope,
            targetKinds: ['subagent'],
            runtimeAdapterId: 'openclaw',
            runtimeInstanceId: 'local',
            targetAgentIds: ['default'],
            supportLevel: 'native',
            availability: 'available',
            operations: [],
            policyScope: 'subagent.management',
            ownerModuleId: 'openclaw',
            routeOwnerId: 'openclaw',
          },
          {
            id: 'workspace.file',
            kind: 'workspace.file',
            scopeKind: 'workspace',
            scope: workspaceScope,
            targetKinds: ['workspace-file'],
            runtimeAdapterId: 'openclaw',
            runtimeInstanceId: 'local',
            targetAgentIds: ['default'],
            supportLevel: 'native',
            availability: 'available',
            operations: [],
            policyScope: 'workspace.file',
            ownerModuleId: 'openclaw',
            routeOwnerId: 'openclaw',
          },
          {
            id: 'subagent.skills',
            kind: 'subagent-skills',
            scopeKind: 'agent',
            scope: defaultAgentScope,
            targetKinds: ['subagent'],
            runtimeAdapterId: 'openclaw',
            runtimeInstanceId: 'local',
            targetAgentIds: ['default'],
            supportLevel: 'native',
            availability: 'available',
            operations: [],
            policyScope: 'subagent.skills',
            ownerModuleId: 'openclaw',
            routeOwnerId: 'openclaw',
          },
          {
            id: 'subagent.tools',
            kind: 'subagent-tools',
            scopeKind: 'agent',
            scope: defaultAgentScope,
            targetKinds: ['subagent'],
            runtimeAdapterId: 'openclaw',
            runtimeInstanceId: 'local',
            targetAgentIds: ['default'],
            supportLevel: 'native',
            availability: 'available',
            operations: [],
            policyScope: 'subagent.tools',
            ownerModuleId: 'openclaw',
            routeOwnerId: 'openclaw',
          },
        ],
      },
    },
  };
}

function renderSubagentsPage(initialEntries: string[] = ['/subagents']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <LocationProbe />
      <SubAgents />
    </MemoryRouter>,
  );
}

async function openCreateDialog(): Promise<void> {
  const button = await screen.findByRole('button', { name: 'New Agent' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

async function openAgentActionMenu(agentId: string): Promise<void> {
  const button = await screen.findByRole('button', { name: `More actions ${agentId}` });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
}

async function clickAgentAction(agentId: string, action: 'Export' | 'Delete'): Promise<void> {
  await openAgentActionMenu(agentId);
  fireEvent.click(await screen.findByRole('menuitem', { name: action }));
}

async function openEditDialog(agentId: string): Promise<void> {
  const button = await screen.findByRole('button', { name: `Edit ${agentId}` });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await screen.findByRole('dialog', { name: 'Edit Subagent' });
}

describe('subagents page', () => {
  const createAgent = vi.fn().mockResolvedValue({ agentId: 'writer' });
  const createAgentFromTemplate = vi.fn().mockResolvedValue({ agentId: 'brand-guardian' });
  const updateAgent = vi.fn().mockResolvedValue(undefined);
  const deleteAgent = vi.fn().mockResolvedValue(undefined);
  const exportAgentConfig = vi.fn().mockResolvedValue({
    schema: 'matchaclaw.agent-config',
    version: 1,
    agent: {
      name: 'Alpha',
      skills: ['web-search'],
      skillBundles: [
        {
          skillKey: 'web-search',
          files: [{ path: 'SKILL.md', content: 'web skill' }],
        },
      ],
      files: {},
    },
  });
  const exportAgentPackage = vi.fn().mockResolvedValue({
    agentId: 'agent-alpha',
    fileName: 'agent-alpha.matcha-agentpkg',
    size: 1024,
    exportedAtMs: 1,
  });
  const uploadAgentPackageToCloud = vi.fn().mockResolvedValue({
    agentId: 'agent-alpha',
    packageId: 'pkg-alpha',
    fileName: 'agent-alpha.matcha-agentpkg',
    size: 1024,
    uploadedAtMs: 1,
  });
  const installAgentPackageFromCloud = vi.fn().mockResolvedValue({
    agentId: 'agent-alpha',
    packageId: 'pkg-alpha',
  });
  const importAgentConfig = vi.fn().mockResolvedValue({ agentId: 'imported-agent' });
  const loadAgents = vi.fn().mockResolvedValue(undefined);
  const loadAvailableModels = vi.fn().mockResolvedValue(undefined);
  const generateDraftFromPrompt = vi.fn().mockResolvedValue(undefined);
  const cancelDraft = vi.fn().mockResolvedValue(undefined);
  const loadPersistedFilesForAgent = vi.fn().mockResolvedValue({});

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
    });
    __resetSubagentTemplateCatalogCacheForTest();
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockReset();
    invoke.mockImplementation(async (channel, payload) => {
      const path = (payload as { path?: string } | undefined)?.path;
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/subagent-templates') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              sourceDir: '/repo/integrations/openclaw',
              templates: [],
            },
          },
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/workspace-dir') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: '/home/dev/.openclaw/workspace',
          },
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/config-dir') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: '/home/dev/.openclaw',
          },
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/capabilities/list') {
        return buildCapabilitiesListEnvelope();
      }
      return undefined;
    });
    createAgent.mockClear();
    createAgentFromTemplate.mockClear();
    updateAgent.mockClear();
    deleteAgent.mockClear();
    exportAgentConfig.mockClear();
    exportAgentPackage.mockClear();
    uploadAgentPackageToCloud.mockClear();
    installAgentPackageFromCloud.mockClear();
    __resetAgentSkillConfigStoreInternalCachesForTest();
    __resetAgentToolConfigStoreInternalCachesForTest();
    importAgentConfig.mockClear();
    loadAgents.mockClear();
    loadAvailableModels.mockClear();
    generateDraftFromPrompt.mockClear();
    cancelDraft.mockClear();
    loadPersistedFilesForAgent.mockClear();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.warning).mockReset();
    vi.mocked(toast.error).mockReset();

    i18n.changeLanguage('en');
    useRuntimeHostStore.setState({
      status: runningGatewayStatus,
      runtimeHost: { lifecycle: 'running' },
      health: null,
      isInitialized: true,
      lastError: null,
    });
    useSubagentsStore.setState({
      agents: [
        {
          id: 'main',
          name: 'Main',
          workspace: '/home/dev/.openclaw/workspace',
          model: 'gpt-main',
          avatarSeed: 'agent:main',
          avatarStyle: 'pixelArt',
          isDefault: true,
        },
        {
          id: 'agent-alpha',
          name: 'Alpha',
          description: 'Handles supplier research and sourcing workflows.',
          workspace: '/home/dev/.openclaw/workspace-subagents/alpha',
          model: 'gpt-4o-mini',
          avatarSeed: 'agent:agent-alpha',
          avatarStyle: 'bottts',
          isDefault: false,
        },
      ],
      availableModels: [
        {
          id: OPENAI_GPT41_MINI_SELECTION_ID,
          provider: 'openai',
          providerLabel: 'OpenAI',
          modelLabel: 'gpt-4.1-mini',
          displayLabel: 'OpenAI / gpt-4.1-mini',
          modelReferences: [OPENAI_GPT41_MINI_RUNTIME_REF],
        },
        {
          id: ANTHROPIC_CLAUDE37_SELECTION_ID,
          provider: 'anthropic',
          providerLabel: 'Anthropic',
          modelLabel: 'claude-3-7-sonnet',
          displayLabel: 'Anthropic / claude-3-7-sonnet',
          modelReferences: [ANTHROPIC_CLAUDE37_RUNTIME_REF],
        },
      ],
      modelsLoading: false,
      agentsResource: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      cloudPackages: [
        {
          packageId: 'pkg-alpha',
          packageVersionId: 'version-alpha',
          name: 'agent-alpha',
          packageType: 'agent',
          version: 'v1',
          status: 'published',
          downloadable: true,
        },
      ],
      mutating: false,
      error: null,
      managedAgentId: null,
      draftPromptByAgent: {},
      draftGeneratingByAgent: {},
      draftApplyingByAgent: {},
      draftApplySuccessByAgent: {},
      draftIncludeCurrentFilesByAgent: {},
      persistedFilesByAgent: {
        'agent-alpha': {
          'AGENTS.md': 'saved agents',
          'SOUL.md': 'saved soul',
          'USER.md': 'saved user',
          'MEMORY.md': 'saved memory',
        },
      },
      draftByFile: {},
      draftError: null,
      previewDiffByFile: {},
      selectedAgentId: null,
      loadAgents,
      loadCloudPackages: vi.fn().mockResolvedValue(undefined),
      loadMyCloudPackages: vi.fn().mockResolvedValue(undefined),
      myCloudPackages: [],
      myCloudLoading: false,
      myCloudError: null,
      installedCloudPackages: [],
      cloudLoading: false,
      cloudError: null,
      cloudInstallingByVersionId: {},
      cloudPublishingByVersionId: {},
      loadAvailableModels,
      loadPersistedFilesForAgent,
      selectAgent: vi.fn(),
      createAgent,
      createAgentFromTemplate,
      updateAgent,
      deleteAgent,
      exportAgentConfig,
      exportAgentPackage,
      uploadAgentPackageToCloud,
      installAgentPackageFromCloud,
      importAgentConfig,
      generateDraftFromPrompt,
      cancelDraft,
    });
    useAgentSkillConfigStore.setState({
      viewByAgentId: {
        main: {
          agentId: 'main',
          support: { supportType: 'supported' },
          selectionMode: 'inheritsDefaultSkills',
          explicitSkillKeys: [],
          inheritedDefaultSkillKeys: [],
          effectiveSkillKeys: [],
          options: [],
          revision: 'skill-main',
          updatedAt: null,
        },
        'agent-alpha': {
          agentId: 'agent-alpha',
          support: { supportType: 'supported' },
          selectionMode: 'inheritsDefaultSkills',
          explicitSkillKeys: [],
          inheritedDefaultSkillKeys: [],
          effectiveSkillKeys: [],
          options: [],
          revision: 'skill-alpha',
          updatedAt: null,
        },
        writer: {
          agentId: 'writer',
          support: { supportType: 'supported' },
          selectionMode: 'inheritsDefaultSkills',
          explicitSkillKeys: [],
          inheritedDefaultSkillKeys: [],
          effectiveSkillKeys: [],
          options: [],
          revision: 'skill-writer',
          updatedAt: null,
        },
      },
      loadingByAgentId: {},
      errorByAgentId: {},
    });
    useAgentToolConfigStore.setState({
      viewByAgentId: {
        main: {
          agentId: 'main',
          support: { supportType: 'supported' },
          selectionMode: 'inheritsDefaultTools',
          toolPolicy: null,
          toolProfiles: [],
          toolGroups: [],
          toolOptions: [],
          revision: 'tool-main',
          updatedAt: null,
        },
        'agent-alpha': {
          agentId: 'agent-alpha',
          support: { supportType: 'supported' },
          selectionMode: 'inheritsDefaultTools',
          toolPolicy: null,
          toolProfiles: [
            { profileKey: 'coding', displayName: 'Coding' },
            { profileKey: 'full', displayName: 'Full' },
          ],
          toolGroups: [
            {
              groupKey: 'fs',
              displayName: 'Files',
              source: 'core',
              toolOptions: [
                { toolKey: 'read', displayName: 'Read', optionType: 'tool', description: 'Read files', source: 'core', groupKey: 'fs', groupDisplayName: 'Files', defaultProfiles: ['minimal', 'coding'], deniedByGlobalPolicy: false },
                { toolKey: 'write', displayName: 'Write', optionType: 'tool', description: 'Write files', source: 'core', groupKey: 'fs', groupDisplayName: 'Files', defaultProfiles: ['coding'], deniedByGlobalPolicy: true },
              ],
            },
            {
              groupKey: 'web',
              displayName: 'Web',
              source: 'core',
              toolOptions: [
                { toolKey: 'web_search', displayName: 'Web Search', optionType: 'tool', description: 'Search web content', source: 'core', groupKey: 'web', groupDisplayName: 'Web', defaultProfiles: ['coding'], deniedByGlobalPolicy: false },
              ],
            },
          ],
          toolOptions: [
            { toolKey: 'group:fs', displayName: 'Files tools', optionType: 'group', source: 'core', groupKey: 'fs', groupDisplayName: 'Files', deniedByGlobalPolicy: false },
            { toolKey: 'read', displayName: 'Read', optionType: 'tool', description: 'Read files', source: 'core', groupKey: 'fs', groupDisplayName: 'Files', defaultProfiles: ['minimal', 'coding'], deniedByGlobalPolicy: false },
            { toolKey: 'write', displayName: 'Write', optionType: 'tool', description: 'Write files', source: 'core', groupKey: 'fs', groupDisplayName: 'Files', defaultProfiles: ['coding'], deniedByGlobalPolicy: true },
            { toolKey: 'group:web', displayName: 'Web tools', optionType: 'group', source: 'core', groupKey: 'web', groupDisplayName: 'Web', deniedByGlobalPolicy: false },
            { toolKey: 'web_search', displayName: 'Web Search', optionType: 'tool', description: 'Search web content', source: 'core', groupKey: 'web', groupDisplayName: 'Web', defaultProfiles: ['coding'], deniedByGlobalPolicy: false },
          ],
          revision: 'tool-alpha',
          updatedAt: null,
        },
        writer: {
          agentId: 'writer',
          support: { supportType: 'supported' },
          selectionMode: 'inheritsDefaultTools',
          toolPolicy: null,
          toolProfiles: [],
          toolGroups: [],
          toolOptions: [],
          revision: 'tool-writer',
          updatedAt: null,
        },
      },
      loadingByAgentId: {},
      errorByAgentId: {},
    });
  });

  it('renders agents in a card grid', () => {
    renderSubagentsPage();

    expect(screen.getByTestId('subagent-card-grid')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('agent-alpha')).toBeInTheDocument();
    expect(screen.getByText('gpt-main')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    expect(screen.getByText('Handles supplier research and sourcing workflows.')).toBeInTheDocument();
    expect(screen.queryByText('Open edit to configure basic info, persona, and capabilities.')).toBeNull();
    expect(screen.getByTestId('agent-avatar-main')).toBeInTheDocument();
    expect(screen.getByTestId('agent-avatar-agent-alpha')).toBeInTheDocument();
  });

  it('挂载时等待网关 ready 后再加载模型和 agents', () => {
    useRuntimeHostStore.setState({
      status: stoppedGatewayStatus,
      runtimeHost: { lifecycle: 'stopped' },
    });
    useSubagentsStore.setState({
      agents: [],
      availableModels: [],
    });
    renderSubagentsPage();
    expect(loadAgents).not.toHaveBeenCalled();
    expect(loadAvailableModels).not.toHaveBeenCalled();
  });

  it('网关恢复到 running 后会自动重载数据', async () => {
    useRuntimeHostStore.setState({
      status: stoppedGatewayStatus,
      runtimeHost: { lifecycle: 'stopped' },
    });
    renderSubagentsPage();
    expect(loadAgents).not.toHaveBeenCalled();
    expect(loadAvailableModels).not.toHaveBeenCalled();

    act(() => {
      useRuntimeHostStore.setState({
        status: runningGatewayStatus,
        runtimeHost: { lifecycle: 'running' },
      });
    });

    await waitFor(() => {
      expect(loadAgents).toHaveBeenCalledTimes(1);
    });
    expect(loadAvailableModels).toHaveBeenCalledTimes(1);
  });

  it('shows top guide when there is no available model', () => {
    useSubagentsStore.setState({
      availableModels: [],
      modelsLoading: false,
    });

    renderSubagentsPage(['/subagents']);

    expect(screen.getByText('Please go to Models to add a model first.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Models' }));
    expect(screen.getByTestId('router-location')).toHaveTextContent('/providers');
  });

  it('opens create dialog when clicking add button', async () => {
    renderSubagentsPage();

    await openCreateDialog();

    expect(screen.getByRole('dialog', { name: 'Create Subagent' })).toBeInTheDocument();
  });

  it('submits create form and calls createAgent', async () => {
    renderSubagentsPage();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Writes vendor briefs.' } });
    expect(screen.getByLabelText('Workspace')).toHaveValue(
      '/home/dev/.openclaw/workspace-subagents/writer'
    );
    expect(screen.getByLabelText('Model')).toHaveValue(OPENAI_GPT41_MINI_SELECTION_ID);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
        name: 'writer',
        description: 'Writes vendor briefs.',
        workspace: '/home/dev/.openclaw/workspace-subagents/writer',
        model: OPENAI_GPT41_MINI_RUNTIME_REF,
        avatarSeed: expect.any(String),
        avatarStyle: 'pixelArt',
      }));
    });
  });

  it('createAgent 失败时保持弹窗打开，不进入管理态', async () => {
    createAgent.mockRejectedValueOnce(new Error('RPC timeout: agents.create'));
    renderSubagentsPage();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
        name: 'writer',
        workspace: '/home/dev/.openclaw/workspace-subagents/writer',
        model: OPENAI_GPT41_MINI_RUNTIME_REF,
        avatarSeed: expect.any(String),
        avatarStyle: 'pixelArt',
      }));
    });

    expect(screen.getByRole('dialog', { name: 'Create Subagent' })).toBeInTheDocument();
    expect(screen.queryByText('Managing: writer')).toBeNull();
  });

  it('create dialog no longer renders emoji input', async () => {
    renderSubagentsPage();

    await openCreateDialog();

    expect(screen.queryByLabelText('Emoji')).toBeNull();
    expect(screen.getByText('Avatar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'avatar-style-pixelArt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'avatar-style-bottts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'avatar-style-botttsNeutral' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /pick-avatar-/ })).toHaveLength(15);
  });

  it('supports selecting an avatar option and avatar style when creating subagent', async () => {
    renderSubagentsPage();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    fireEvent.click(screen.getByRole('button', { name: 'avatar-style-bottts' }));
    const avatarButtons = screen.getAllByRole('button', { name: /pick-avatar-/ });
    fireEvent.click(avatarButtons[3]);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
        name: 'writer',
        workspace: '/home/dev/.openclaw/workspace-subagents/writer',
        model: OPENAI_GPT41_MINI_RUNTIME_REF,
        avatarSeed: expect.stringContaining('picker:writer'),
        avatarStyle: 'bottts',
      }));
    });
  });

  it('prefills manage prompt from create dialog initial prompt', async () => {
    renderSubagentsPage();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    fireEvent.change(screen.getByLabelText('System Prompt'), {
      target: { value: 'act as a finance analyst' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
        name: 'writer',
        workspace: '/home/dev/.openclaw/workspace-subagents/writer',
        model: OPENAI_GPT41_MINI_RUNTIME_REF,
        avatarSeed: expect.any(String),
        avatarStyle: 'pixelArt',
      }));
    });

    expect(screen.getByRole('dialog', { name: 'Edit Subagent' })).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt')).toHaveValue('act as a finance analyst');
  });

  it('create 返回 warning 时仍进入管理态，并显示 warning toast', async () => {
    createAgent.mockResolvedValueOnce({
      agentId: 'writer',
      warning: '智能体 "writer" 已创建，但模型配置写入失败：RPC timeout: agents.update。请在编辑中重新确认',
    });
    renderSubagentsPage();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
        name: 'writer',
        workspace: '/home/dev/.openclaw/workspace-subagents/writer',
        model: OPENAI_GPT41_MINI_RUNTIME_REF,
      }));
    });

    await waitFor(() => {
    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      '智能体 "writer" 已创建，但模型配置写入失败：RPC timeout: agents.update。请在编辑中重新确认',
    );
    });
    expect(screen.getByRole('dialog', { name: 'Edit Subagent' })).toBeInTheDocument();
  });

  it('opens persona tab through edit dialog', async () => {
    renderSubagentsPage();

    await openEditDialog('agent-alpha');
    fireEvent.click(screen.getByRole('tab', { name: 'Persona' }));

    expect(loadPersistedFilesForAgent).toHaveBeenCalledWith('agent-alpha');
    expect(screen.getByRole('dialog', { name: 'Edit Subagent' })).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt')).toBeInTheDocument();
  });

  it('submits prompt to generate subagent draft', async () => {
    useRuntimeHostStore.setState({
      runtimeHost: { lifecycle: 'running' },
    });
    renderSubagentsPage();

    await openEditDialog('agent-alpha');
    fireEvent.click(screen.getByRole('tab', { name: 'Persona' }));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'draft policy docs' } });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Generate Draft' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate Draft' }));

    await waitFor(() => {
      expect(generateDraftFromPrompt).toHaveBeenCalledWith({
        agentId: 'agent-alpha',
        prompt: 'draft policy docs',
        includeCurrentFiles: false,
      });
    });
  });

  it('passes current-file baseline option when draft switch is enabled', async () => {
    useRuntimeHostStore.setState({
      runtimeHost: { lifecycle: 'running' },
    });
    renderSubagentsPage();

    await openEditDialog('agent-alpha');
    fireEvent.click(screen.getByRole('tab', { name: 'Persona' }));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'draft policy docs' } });
    fireEvent.click(screen.getByRole('switch', { name: /Use current files/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Generate Draft' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate Draft' }));

    await waitFor(() => {
      expect(generateDraftFromPrompt).toHaveBeenCalledWith({
        agentId: 'agent-alpha',
        prompt: 'draft policy docs',
        includeCurrentFiles: true,
      });
    });
  });

  it('does not show applying label while only generating draft', async () => {
    useSubagentsStore.setState({
      managedAgentId: 'agent-alpha',
      draftGeneratingByAgent: { 'agent-alpha': true },
      draftApplyingByAgent: { 'agent-alpha': false },
      draftByFile: {
        'AGENTS.md': {
          name: 'AGENTS.md',
          content: 'content',
          reason: 'reason',
          confidence: 0.9,
          needsReview: false,
        },
      },
      previewDiffByFile: {},
      draftError: null,
    });

    renderSubagentsPage();
    await screen.findByRole('dialog', { name: 'Edit Subagent' });

    expect(screen.getByRole('button', { name: 'Generating...' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Apply Draft' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Applying...' })).toBeNull();
  });

  it('calls edit/delete actions for non-main agent', async () => {
    const { container } = renderSubagentsPage();

    await openEditDialog('agent-alpha');
    expect(screen.getByText('Avatar')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('avatar-style-botttsNeutral'));
    const avatarButtons = container.querySelectorAll<HTMLButtonElement>('button[aria-label^="pick-avatar-"]');
    fireEvent.click(avatarButtons[2]);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alpha v2' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Handles international sourcing.' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: ANTHROPIC_CLAUDE37_SELECTION_ID } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(updateAgent).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByText('Edit Subagent')).toBeNull();
    });

    await clickAgentAction('agent-alpha', 'Delete');
    await screen.findByText('Delete agent-alpha');
    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => {
      expect(updateAgent).toHaveBeenCalledWith({
        agentId: 'agent-alpha',
        name: 'Alpha v2',
        description: 'Handles international sourcing.',
        workspace: '/home/dev/.openclaw/workspace-subagents/alpha',
        model: ANTHROPIC_CLAUDE37_RUNTIME_REF,
        avatarSeed: expect.stringContaining('picker:alpha'),
        avatarStyle: 'botttsNeutral',
      });
    });
    expect(deleteAgent).toHaveBeenCalledWith('agent-alpha');
  });

  it('exports selected agent config to a picked json path', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel, payload) => {
      const path = (payload as { path?: string } | undefined)?.path;
      if (channel === 'dialog:save') {
        return { canceled: false, filePath: '/tmp/alpha.matchaclaw-agent.json' };
      }
      if (channel === 'hostapi:fetch' && path === '/api/capabilities/list') {
        return buildCapabilitiesListEnvelope();
      }
      if (channel === 'hostapi:fetch' && path === '/api/capabilities/execute') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: { ok: true, path: '/tmp/alpha.matchaclaw-agent.json' },
          },
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/subagent-templates') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              sourceDir: '/repo/integrations/openclaw',
              templates: [],
            },
          },
        };
      }
      return undefined;
    });
    useRuntimeHostStore.setState({
      runtimeHost: { lifecycle: 'running' },
    });
    renderSubagentsPage();
    await openAgentActionMenu('agent-alpha');
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Export' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export' }));

    await waitFor(() => {
      expect(exportAgentConfig).toHaveBeenCalledWith('agent-alpha');
    });
    const writeCall = invoke.mock.calls.find(([channel]) => channel === 'dialog:writeSelectedTextFile');
    expect(writeCall).toBeTruthy();
    expect(writeCall?.[1]).toEqual(expect.objectContaining({
      defaultPath: expect.stringContaining('alpha.matchaclaw-agent.json'),
    }));
    expect(JSON.parse(String(writeCall?.[2] ?? '{}'))).toEqual(expect.objectContaining({
      schema: 'matchaclaw.agent-config',
      version: 1,
    }));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Agent config exported.');
    });
  });

  it('sealed agent disables edit and editable json export but allows cloud upload', async () => {
    useSubagentsStore.setState({
      agents: [
        ...useSubagentsStore.getState().agents,
        {
          id: 'sealed-agent',
          name: 'Sealed Agent',
          workspace: '/home/dev/.openclaw/workspace-subagents/sealed-agent',
          model: 'gpt-4o-mini',
          sealed: true,
          isDefault: false,
        },
      ],
    });
    renderSubagentsPage();

    expect(screen.getByText('Sealed')).toBeInTheDocument();
    expect(screen.getAllByText('Package').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Edit sealed-agent' })).toBeDisabled();
    await openAgentActionMenu('sealed-agent');
    expect(screen.getByRole('menuitem', { name: 'Export' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Upload to Cloud' })).not.toHaveAttribute('data-disabled');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Upload to Cloud' }));

    await waitFor(() => {
      expect(uploadAgentPackageToCloud).toHaveBeenCalledWith('sealed-agent');
    });
    expect(exportAgentConfig).not.toHaveBeenCalledWith('sealed-agent');
    expect(exportAgentPackage).not.toHaveBeenCalledWith('sealed-agent');
  });

  it('adds cloud package actions for normal agents', async () => {
    renderSubagentsPage();

    await openAgentActionMenu('agent-alpha');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Upload to Cloud' }));
    await waitFor(() => {
      expect(uploadAgentPackageToCloud).toHaveBeenCalledWith('agent-alpha');
    });
    expect(toast.success).toHaveBeenCalledWith('Agent package uploaded: agent-alpha.matcha-agentpkg');

    await openAgentActionMenu('agent-alpha');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cloud Packages' }));
    await screen.findByRole('button', { name: 'Install' });
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => {
      expect(installAgentPackageFromCloud).toHaveBeenCalledWith('version-alpha');
    });
    expect(loadPersistedFilesForAgent).toHaveBeenCalledWith('agent-alpha');
    expect(toast.success).toHaveBeenCalledWith('Agent package installed: agent-alpha');
  });

  it('publishes mine drafts separately from entitled market packages', async () => {
    const publishCloudAgentPackage = vi.fn().mockResolvedValue(undefined);
    useSubagentsStore.setState({
      myCloudPackages: [{ packageId: 'mine', packageVersionId: 'draft-id', name: 'My Draft', packageType: 'agent', version: 'a'.repeat(64), status: 'draft', downloadable: false }],
      publishCloudAgentPackage,
      cloudPackages: [{ packageId: 'pkg-alpha', packageVersionId: 'version-alpha', name: 'Cloud Agent', packageType: 'agent', version: 'b'.repeat(64), status: 'published', entitlementStatus: 'active', downloadable: true }],
    });
    renderSubagentsPage();
    await openAgentActionMenu('agent-alpha');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cloud Packages' }));
    expect(await screen.findByText('My Draft')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled();
    expect(screen.queryByText('Installed')).not.toBeInTheDocument();
    expect(publishCloudAgentPackage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(publishCloudAgentPackage).toHaveBeenCalledWith('draft-id'));
    act(() => useSubagentsStore.setState({ installedCloudPackages: [{ packageVersionId: 'version-alpha', packageType: 'agent', packageSha256: 'b'.repeat(64), fileName: 'agent.matcha-agentpkg' }] }));
    expect(screen.getByText('Installed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
  });

  it('shows market loading and retry instead of hiding failures', async () => {
    const loadCloudPackages = vi.fn().mockResolvedValue(undefined);
    useSubagentsStore.setState({ cloudLoading: true, loadCloudPackages });
    renderSubagentsPage();
    await openAgentActionMenu('agent-alpha');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cloud Packages' }));
    expect(await screen.findByText('Loading packages...')).toBeInTheDocument();
    act(() => useSubagentsStore.setState({ cloudLoading: false, cloudError: 'cloudUnavailable' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to load packages. Please retry.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(loadCloudPackages).toHaveBeenCalledTimes(2);
  });

  it('does not open prompt editor for managed sealed agent', async () => {
    useSubagentsStore.setState({
      agents: [
        ...useSubagentsStore.getState().agents,
        {
          id: 'sealed-agent',
          name: 'Sealed Agent',
          workspace: '/home/dev/.openclaw/workspace-subagents/sealed-agent',
          model: 'gpt-4o-mini',
          sealed: true,
          isDefault: false,
        },
      ],
      managedAgentId: 'sealed-agent',
    });
    renderSubagentsPage();

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Sealed agents cannot be edited.');
    });
    expect(screen.queryByRole('dialog', { name: 'Edit Subagent' })).toBeNull();
    expect(screen.queryByLabelText('Prompt')).toBeNull();
  });

  it('imports agent config from a picked json file', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel, payload) => {
      const path = (payload as { path?: string } | undefined)?.path;
      if (channel === 'dialog:readSelectedTextFile') {
        return {
          canceled: false,
          filePath: '/tmp/shared.matchaclaw-agent.json',
          content: JSON.stringify({
            schema: 'matchaclaw.agent-config',
            version: 1,
            agent: {
              name: 'Shared Agent',
              files: {
                'AGENTS.md': 'shared agents',
              },
            },
          }),
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/capabilities/list') {
        return buildCapabilitiesListEnvelope();
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/subagent-templates') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              sourceDir: '/repo/integrations/openclaw',
              templates: [],
            },
          },
        };
      }
      return undefined;
    });
    useRuntimeHostStore.setState({
      runtimeHost: { lifecycle: 'running' },
    });
    renderSubagentsPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Import Agent' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Import Agent' }));

    await waitFor(() => {
      expect(importAgentConfig).toHaveBeenCalledWith(expect.objectContaining({
        schema: 'matchaclaw.agent-config',
        version: 1,
      }));
    });
    expect(loadPersistedFilesForAgent).toHaveBeenCalledWith('imported-agent');
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Agent config imported.');
    });
  });

  it('renders skill and tool configuration in separate edit dialog tabs', async () => {
    renderSubagentsPage();

    await openEditDialog('agent-alpha');
    expect(screen.queryByText('Skill Configuration')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }));

    expect(screen.getByText('Skill Configuration')).toBeInTheDocument();
    expect(screen.queryByText(/Choose the skills visible to this agent/i)).toBeNull();
    expect(screen.queryByText('Tool Configuration')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }));

    expect(screen.queryByText('Skill Configuration')).toBeNull();
    expect(screen.getByText('Tool Configuration')).toBeInTheDocument();
    expect(screen.getByText(/Full.*config preview/i)).toBeInTheDocument();
    const toolPanel = screen.getByText('Tool Configuration').closest('section') as HTMLElement;
    const toolListScrollRegion = toolPanel.querySelector('.min-h-0.flex-1.overflow-y-auto') as HTMLElement;
    expect(toolPanel).toHaveClass('flex-col');
    expect(toolListScrollRegion).toBeInTheDocument();
    expect(toolListScrollRegion).not.toContainElement(screen.getByText('Tool Profile').closest('div'));
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Write')).toBeInTheDocument();
    expect(screen.getByText('Globally denied')).toBeInTheDocument();
    const writeRow = screen.getByText('Write').closest('.grid') as HTMLElement;
    writeRow.querySelectorAll('button').forEach((button) => expect(button).toBeDisabled());
    expect(screen.getByText('Web')).toBeInTheDocument();
    expect(screen.queryByText('Web Search')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Web.*enabled/i }));
    expect(screen.getByText('Web Search')).toBeInTheDocument();
    expect(screen.queryByText(/OpenClaw tool profile/i)).toBeNull();
  });

  it('编辑时保留未解析模型，不自动替换为唯一可选模型', async () => {
    useSubagentsStore.setState({
      agents: [
        {
          id: 'main',
          name: 'Main',
          workspace: '/home/dev/.openclaw/workspace',
          model: 'gpt-main',
          avatarSeed: 'agent:main',
          avatarStyle: 'pixelArt',
          isDefault: true,
        },
        {
          id: 'agent-alpha',
          name: 'Alpha',
          workspace: '/home/dev/.openclaw/workspace-subagents/alpha',
          model: 'legacy/removed-model',
          avatarSeed: 'agent:agent-alpha',
          avatarStyle: 'bottts',
          isDefault: false,
        },
      ],
      availableModels: [
        {
          id: OPENAI_GPT41_MINI_SELECTION_ID,
          provider: 'openai',
          providerLabel: 'OpenAI',
          modelLabel: 'gpt-4.1-mini',
          displayLabel: 'OpenAI / gpt-4.1-mini',
          modelReferences: [OPENAI_GPT41_MINI_RUNTIME_REF],
        },
      ],
      modelsLoading: false,
    });

    renderSubagentsPage();
    await openEditDialog('agent-alpha');

    const modelSelect = screen.getByLabelText('Model');
    expect(screen.getByRole('option', { name: 'legacy/removed-model' })).toBeInTheDocument();
    expect(modelSelect).toHaveValue('legacy/removed-model');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Keep legacy model.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateAgent).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'agent-alpha',
        description: 'Keep legacy model.',
        model: 'legacy/removed-model',
      }));
    });
  });

  it('编辑子 Agent 时模型下拉优先显示 provider 自定义名称', async () => {
    useSubagentsStore.setState({
      availableModels: [
        {
          id: CUSTOM_GPT4O_SELECTION_ID,
          provider: 'custom-dd749b2e',
          accountId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
          providerLabel: '自定义',
          modelLabel: 'gpt-4o-mini',
          displayLabel: '自定义 / gpt-4o-mini',
          modelReferences: [CUSTOM_GPT4O_RUNTIME_REF],
        },
      ],
      modelsLoading: false,
    });

    renderSubagentsPage();
    await openEditDialog('agent-alpha');

    expect(
      screen.getByRole('option', { name: '自定义 / gpt-4o-mini' })
    ).toBeInTheDocument();
  });

  it('Agent 卡片按模型清单引用显示模型名，找不到映射时回退原始模型 id', () => {
    useSubagentsStore.setState({
      agents: [
        {
          id: 'main',
          name: 'Main',
          workspace: '/home/dev/.openclaw/workspace',
          model: CUSTOM_GPT4O_RUNTIME_REF,
          avatarSeed: 'agent:main',
          avatarStyle: 'pixelArt',
          isDefault: true,
        },
        {
          id: 'agent-alpha',
          name: 'Alpha',
          workspace: '/home/dev/.openclaw/workspace-subagents/alpha',
          model: 'legacy/removed-model',
          avatarSeed: 'agent:agent-alpha',
          avatarStyle: 'bottts',
          isDefault: false,
        },
      ],
      availableModels: [
        {
          id: CUSTOM_GPT4O_SELECTION_ID,
          provider: 'custom-dd749b2e',
          accountId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
          providerLabel: '前端专家',
          modelLabel: 'gpt-4o-mini',
          displayLabel: '前端专家 / gpt-4o-mini',
          modelReferences: [CUSTOM_GPT4O_RUNTIME_REF],
        },
      ],
    });

    renderSubagentsPage();

    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    expect(screen.queryByText('custom-dd749b2e/gpt-4o-mini')).toBeNull();
    expect(screen.getByText('legacy/removed-model')).toBeInTheDocument();
  });

  it('模板加载弹窗里的模型下拉也使用统一展示文案', async () => {
    useSubagentsStore.setState({
      availableModels: [
        {
          id: CUSTOM_GPT4O_SELECTION_ID,
          provider: 'custom-dd749b2e',
          accountId: 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
          providerLabel: '前端专家',
          modelLabel: 'gpt-4o-mini',
          displayLabel: '前端专家 / gpt-4o-mini',
          modelReferences: [CUSTOM_GPT4O_RUNTIME_REF],
        },
      ],
      modelsLoading: false,
    });

    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel, payload) => {
      const path = (payload as { path?: string } | undefined)?.path;
      if (channel === 'hostapi:fetch' && path === '/api/capabilities/list') {
        return buildCapabilitiesListEnvelope();
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/subagent-templates') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              sourceDir: '/repo/integrations/openclaw',
              templates: [
                {
                  id: 'brand-guardian',
                  name: 'Brand Guardian',
                  summary: 'Brand guard template',
                  files: ['AGENTS.md'],
                },
              ],
            },
          },
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/subagent-templates/brand-guardian') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              sourceDir: '/repo/integrations/openclaw',
              template: {
                id: 'brand-guardian',
                name: 'Brand Guardian',
                summary: 'Brand guard template',
                files: ['AGENTS.md'],
                fileContents: {
                  'AGENTS.md': 'agents',
                },
              },
            },
          },
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/workspace-dir') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: '/home/dev/.openclaw/workspace',
          },
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/config-dir') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: '/home/dev/.openclaw',
          },
        };
      }
      return undefined;
    });

    renderSubagentsPage();

    fireEvent.mouseDown(screen.getByRole('tab', { name: /^Template Library/ }), { button: 0, ctrlKey: false });
    const loadTemplateButton = await screen.findByRole('button', { name: 'View template' });
    await waitFor(() => expect(loadTemplateButton).toBeEnabled());
    fireEvent.click(loadTemplateButton);

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Load Template: Brand Guardian' })).toBeInTheDocument();
    });

    expect(
      screen.getByRole('option', { name: '前端专家 / gpt-4o-mini' })
    ).toBeInTheDocument();
  });

  it('does not render set-default action buttons', () => {
    renderSubagentsPage();

    expect(screen.queryByRole('button', { name: 'Set default main' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set default agent-alpha' })).toBeNull();
  });

  it('blocks create when name conflicts with existing slug', async () => {
    renderSubagentsPage();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'agent alpha' } });

    expect(screen.getByText('Agent name is duplicated.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('keeps main editable but blocks delete for protected default agent', async () => {
    renderSubagentsPage();

    expect(screen.queryByRole('button', { name: 'Manage main' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Chat main' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Edit main' })).toBeEnabled();
    await openAgentActionMenu('main');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute('data-disabled');
  });

  it('keeps edit available and disables chat when model is missing', async () => {
    useSubagentsStore.setState({
      agents: [
        {
          id: 'main',
          name: 'Main',
          workspace: '/home/dev/.openclaw/workspace',
          model: 'gpt-main',
          avatarSeed: 'agent:main',
          avatarStyle: 'pixelArt',
          isDefault: true,
        },
        {
          id: 'agent-no-model',
          name: 'NoModel',
          workspace: '/home/dev/.openclaw/workspace-subagents/no-model',
          model: undefined,
          avatarSeed: 'agent:agent-no-model',
          avatarStyle: 'botttsNeutral',
          isDefault: false,
        },
      ],
    });

    renderSubagentsPage();

    expect(screen.getByRole('button', { name: 'Chat agent-no-model' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit agent-no-model' })).toBeEnabled();

    await openEditDialog('agent-no-model');
    fireEvent.click(screen.getByRole('tab', { name: 'Persona' }));
    expect(loadPersistedFilesForAgent).toHaveBeenCalledWith('agent-no-model');
    expect(screen.getByRole('dialog', { name: 'Edit Subagent' })).toBeInTheDocument();
  });

  it('keeps persona tab visible after page remount', async () => {
    const { unmount } = renderSubagentsPage();

    await openEditDialog('agent-alpha');
    fireEvent.click(screen.getByRole('tab', { name: 'Persona' }));
    expect(screen.getByLabelText('Prompt')).toBeInTheDocument();

    unmount();
    renderSubagentsPage();

    expect(await screen.findByLabelText('Prompt')).toBeInTheDocument();
  });

  it('shows apply success feedback and hides apply buttons when draft is cleared', async () => {
    useSubagentsStore.setState({
      managedAgentId: 'agent-alpha',
      draftApplySuccessByAgent: { 'agent-alpha': true },
      draftByFile: {},
      previewDiffByFile: {},
      draftError: null,
    });

    renderSubagentsPage();
    await screen.findByRole('dialog', { name: 'Edit Subagent' });

    expect(screen.getByText('Draft applied successfully.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate Diff Preview' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm Apply Draft' })).toBeNull();
  });

  it('closes edit dialog via top-right close button and triggers cancel action', async () => {
    useRuntimeHostStore.setState({
      runtimeHost: { lifecycle: 'running' },
    });
    useSubagentsStore.setState({
      managedAgentId: 'agent-alpha',
      draftByFile: {
        'AGENTS.md': {
          name: 'AGENTS.md',
          content: 'content',
          reason: 'reason',
          confidence: 0.9,
          needsReview: false,
        },
      },
      previewDiffByFile: {},
    });

    renderSubagentsPage();

    expect(await screen.findByRole('dialog', { name: 'Edit Subagent' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(cancelDraft).toHaveBeenCalledWith('agent-alpha');
    });
    expect(screen.queryByRole('dialog', { name: 'Edit Subagent' })).toBeNull();
  });

  it('navigates to chat with selected agent when clicking chat button', () => {
    renderSubagentsPage(['/subagents']);

    fireEvent.click(screen.getByRole('button', { name: 'Chat agent-alpha' }));

    expect(screen.getByTestId('router-location')).toHaveTextContent('/?agent=agent-alpha');
  });

  it('loads a template and creates subagent with template defaults', async () => {
    useSubagentsStore.setState({
      availableModels: [
        {
          id: OPENAI_GPT41_MINI_SELECTION_ID,
          provider: 'openai',
          providerLabel: 'OpenAI',
          modelLabel: 'gpt-4.1-mini',
          displayLabel: 'OpenAI / gpt-4.1-mini',
          modelReferences: [OPENAI_GPT41_MINI_RUNTIME_REF],
        },
      ],
      modelsLoading: false,
    });
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel, payload) => {
      const path = (payload as { path?: string } | undefined)?.path;
      if (channel === 'hostapi:fetch' && path === '/api/capabilities/list') {
        return buildCapabilitiesListEnvelope();
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/subagent-templates') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              sourceDir: '/repo/integrations/openclaw',
              templates: [
                {
                  id: 'brand-guardian',
                  name: 'Brand Guardian',
                  summary: 'Brand guard template',
                  files: ['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md'],
                },
              ],
            },
          },
        };
      }
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/subagent-templates/brand-guardian') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              sourceDir: '/repo/integrations/openclaw',
              template: {
                id: 'brand-guardian',
                name: 'Brand Guardian',
                summary: 'Brand guard template',
                files: ['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md'],
                fileContents: {
                  'AGENTS.md': 'agents',
                  'SOUL.md': 'soul',
                  'USER.md': 'user',
                  'MEMORY.md': 'memory',
                },
              },
            },
          },
        };
      }
      return undefined;
    });

    renderSubagentsPage();

    fireEvent.mouseDown(screen.getByRole('tab', { name: /^Template Library/ }), { button: 0, ctrlKey: false });
    const loadTemplateButton = await screen.findByRole('button', { name: 'View template' });
    await waitFor(() => expect(loadTemplateButton).toBeEnabled());
    fireEvent.click(loadTemplateButton);

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Load Template: Brand Guardian' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    await waitFor(() => {
      expect(createAgentFromTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: OPENAI_GPT41_MINI_RUNTIME_REF,
          template: expect.objectContaining({
            id: 'brand-guardian',
            name: 'Brand Guardian',
          }),
        }),
      );
    });
  });

  it('大模板列表展开后仍保持直接响应式 grid 容器，避免虚拟行破坏自适应布局', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel, payload) => {
      const path = (payload as { path?: string } | undefined)?.path;
      if (channel === 'hostapi:fetch' && path === '/api/openclaw/subagent-templates') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              sourceDir: '/repo/integrations/openclaw',
              templates: Array.from({ length: 30 }, (_, index) => ({
                id: `template-${index + 1}`,
                name: `Template ${index + 1}`,
                summary: `Template summary ${index + 1}`,
                files: ['AGENTS.md'],
              })),
            },
          },
        };
      }
      return undefined;
    });

    renderSubagentsPage();

    fireEvent.mouseDown(screen.getByRole('tab', { name: /^Template Library/ }), { button: 0, ctrlKey: false });

    const firstTemplateTitle = await screen.findByText('Template 1');
    const templateGrid = firstTemplateTitle.closest('.grid');

    expect(templateGrid).not.toBeNull();
    expect(templateGrid?.className).toContain('grid-cols-1');
    expect(templateGrid?.className).toContain('md:grid-cols-2');
    expect(templateGrid?.className).toContain('xl:grid-cols-3');
    expect(firstTemplateTitle.closest('article')?.parentElement).toBe(templateGrid);
    expect(templateGrid?.children).toHaveLength(9);
  });
});
