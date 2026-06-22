import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { TeamsPage } from '@/pages/Teams';
import { TeamChat } from '@/pages/Teams/TeamChat';
import { useGatewayStore } from '@/stores/gateway';
import { useTeamsStore, type TeamMeta } from '@/stores/teams';
import { useSkillsStore } from '@/stores/skills';
import { capabilityExecuteMock, hostApiFetchMock, resetGatewayClientMocks } from './helpers/mock-gateway-client';
import i18n from '@/i18n';

const TEAM_SKILL_PACKAGE_PATH = '.tmp/ascendc-operator-dev-optimize-team_1.0.0';

const invokeIpcMock = vi.hoisted(() => vi.fn());
const pickLocalSkillSourceMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
  };
});

vi.mock('@/lib/host-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/host-api')>();
  return {
    ...actual,
    waitForRuntimeJobResult: vi.fn(async () => ({ execution: { enabledPluginIds: ['team-runtime'] } })),
  };
});

vi.mock('@/services/local-path-picker', () => ({
  pickLocalArchive: vi.fn(),
  pickLocalDirectory: vi.fn(),
  pickLocalSkillSource: (...args: unknown[]) => pickLocalSkillSourceMock(...args),
}));

function teamMeta(input: Partial<TeamMeta> = {}): TeamMeta {
  return {
    id: 'team-1',
    name: 'Design Team',
    teamSkillName: 'ascendc-team',
    teamSkillVersion: '1.0.0',
    teamSkillDescription: 'AscendC team',
    packagePath: TEAM_SKILL_PACKAGE_PATH,
    sourcePath: `${TEAM_SKILL_PACKAGE_PATH}/SKILL.md`,
    activeRunId: 'team-1-run-1.0.0-1000',
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}

function validationResult(input: { version?: string; sourcePath?: string } = {}) {
  return {
    valid: true,
    package: {
      name: 'ascendc-team',
      version: input.version ?? '1.0.0',
      kind: 'team-skill',
      description: `AscendC team ${input.version ?? '1.0.0'}`,
      dependencies: { skills: [], tools: [] },
      sourcePath: input.sourcePath ?? `${TEAM_SKILL_PACKAGE_PATH}/SKILL.md`,
    },
    errors: [],
    warnings: [],
  };
}

function dependencyPlan(input: {
  version?: string;
  canProceed?: boolean;
  items?: unknown[];
} = {}) {
  return {
    packageName: 'ascendc-team',
    packageVersion: input.version ?? '1.0.0',
    sourcePath: `${TEAM_SKILL_PACKAGE_PATH}/SKILL.md`,
    items: input.items ?? [],
    missingRequiredSkills: [],
    missingOptionalSkills: [],
    missingRequiredTools: [],
    missingOptionalTools: [],
    canProceed: input.canProceed ?? true,
  };
}

function mockTeamRuntimeResponses(responses: unknown[]) {
  capabilityExecuteMock.mockImplementation(async (payload) => {
    if (payload.id === 'plugin.runtime') {
      return { success: true, job: { id: 'job-1', type: 'plugins.setEnabled', status: 'succeeded', queuedAt: 1, attempts: 1, maxAttempts: 1 } };
    }
    if (payload.id === 'team.runtime') {
      const response = responses.shift();
      if (!response) {
        throw new Error(`Unexpected team runtime call: ${payload.operationId}`);
      }
      return response;
    }
    return {};
  });
}

function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location-echo">{location.pathname}</div>;
}

function renderTeamsPage() {
  return render(
    <MemoryRouter initialEntries={['/teams']}>
      <TeamsPage />
      <LocationEcho />
    </MemoryRouter>,
  );
}

async function openCreateDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Create Team' }));
  return await screen.findByLabelText('TeamSkill Package Path');
}

function setGatewayRunning() {
  act(() => {
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
        updatedAt: 2,
      },
    });
  });
}

async function checkTeamSkill(path = TEAM_SKILL_PACKAGE_PATH) {
  fireEvent.change(screen.getByLabelText('TeamSkill Package Path'), { target: { value: path } });
  fireEvent.click(screen.getByRole('button', { name: 'Check TeamSkill' }));
  await screen.findByText('Dependency preparation');
}

describe('teams page', () => {
  const provisionTeamAgentsMock = vi.fn().mockResolvedValue(undefined);
  const createRunMock = vi.fn().mockResolvedValue(undefined);
  const refreshSnapshotMock = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    i18n.changeLanguage('en');
    resetGatewayClientMocks();
    invokeIpcMock.mockReset();
    invokeIpcMock.mockResolvedValue(undefined);
    pickLocalSkillSourceMock.mockReset();
    localStorage.removeItem('teams-runtime-store');
    hostApiFetchMock.mockResolvedValue({ execution: { enabledPluginIds: ['team-runtime'] } });
    provisionTeamAgentsMock.mockReset();
    provisionTeamAgentsMock.mockResolvedValue(undefined);
    createRunMock.mockReset();
    createRunMock.mockResolvedValue(undefined);
    refreshSnapshotMock.mockReset();
    refreshSnapshotMock.mockResolvedValue(undefined);

    useGatewayStore.setState({
      status: {
        processState: 'stopped',
        port: 18789,
        gatewayReady: false,
        healthSummary: 'unresponsive',
        transportState: 'disconnected',
        portReachable: false,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 1,
      },
      health: null,
      isInitialized: true,
      lastError: null,
    });

    useTeamsStore.setState({
      teams: [],
      activeTeamId: null,
      runByTeamId: {},
      rolesByTeamId: {},
      stagesByTeamId: {},
      approvalsByTeamId: {},
      artifactsByTeamId: {},
      messagesByTeamId: {},
      dispatchesByTeamId: {},
      dispatchExecutionsByTeamId: {},
      gatesByTeamId: {},
      kickbacksByTeamId: {},
      decisionsByTeamId: {},
      eventsByTeamId: {},
      eventCursorByTeamId: {},
      loadingByTeamId: {},
      errorByTeamId: {},
      provisionTeamAgents: provisionTeamAgentsMock,
      createRun: createRunMock,
      deleteRun: vi.fn().mockResolvedValue(undefined),
      refreshSnapshot: refreshSnapshotMock,
    } as never);

    useSkillsStore.setState({
      installSkill: vi.fn().mockResolvedValue(undefined),
      importLocalSkill: vi.fn().mockResolvedValue('skill-key'),
      fetchSkills: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it('renders TeamSkill create controls and existing team list', async () => {
    useTeamsStore.setState({
      teams: [teamMeta()],
      rolesByTeamId: {
        'team-1': [
          {
            runId: 'team-1-run-1.0.0-1000',
            roleId: 'operator-designer',
            agentId: 'matchaclaw-team:team-1:operator-designer',
            agentName: 'operator-designer',
            workspaceDir: '/workspace',
            agentDir: '/agent',
            skills: [],
            tools: [],
            status: 'idle',
          },
        ],
      },
    } as never);

    renderTeamsPage();

    expect(await screen.findByRole('heading', { name: 'Agents Workspace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Team' })).toBeInTheDocument();
    await openCreateDialog();
    expect(screen.getByRole('button', { name: 'Select Directory' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select Archive' })).toBeInTheDocument();
    expect(screen.getByText('Team Overview')).toBeInTheDocument();
    expect(screen.getByText('TeamSkill-defined team')).toBeInTheDocument();
    expect(screen.getByText('Design Team')).toBeInTheDocument();
    expect(screen.getByText('ascendc-team@1.0.0')).toBeInTheDocument();
    expect(screen.queryByText(`Package: ${TEAM_SKILL_PACKAGE_PATH}`)).not.toBeInTheDocument();
    expect(screen.getByText('Managed roles: 1')).toBeInTheDocument();
  });

  it('requires gateway readiness and package check before create is enabled', async () => {
    renderTeamsPage();

    await openCreateDialog();
    expect(screen.getByRole('button', { name: 'Check TeamSkill' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Create Team' }).at(-1)).toBeDisabled();

    fireEvent.change(screen.getByLabelText('TeamSkill Package Path'), { target: { value: TEAM_SKILL_PACKAGE_PATH } });
    expect(screen.getByRole('button', { name: 'Check TeamSkill' })).toBeDisabled();

    setGatewayRunning();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check TeamSkill' })).toBeEnabled());
    expect(screen.getAllByRole('button', { name: 'Create Team' }).at(-1)).toBeDisabled();
  });

  it('checks package dependencies, creates a new TeamSkill team, provisions its Team agents, then creates its first run', async () => {
    setGatewayRunning();
    mockTeamRuntimeResponses([validationResult(), dependencyPlan()]);

    renderTeamsPage();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('Team Name'), { target: { value: 'Growth Team' } });
    await checkTeamSkill();
    expect(screen.getByText('ascendc-team@1.0.0')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Create Team' }).at(-1)!);

    await waitFor(() => {
      const state = useTeamsStore.getState();
      expect(state.teams.length).toBe(1);
      expect(state.activeTeamId).toBe(state.teams[0]?.id);
      expect(state.teams[0]?.name).toBe('Growth Team');
      expect(state.teams[0]?.teamSkillName).toBe('ascendc-team');
      expect(provisionTeamAgentsMock).toHaveBeenCalledWith(state.teams[0]?.id);
      expect(createRunMock).toHaveBeenCalledWith(state.teams[0]?.id);
      expect(provisionTeamAgentsMock.mock.invocationCallOrder[0]).toBeLessThan(createRunMock.mock.invocationCallOrder[0]!);
      expect(screen.getByTestId('location-echo')).toHaveTextContent(`/teams/${state.teams[0]?.id}`);
    });
  });

  it('keeps the create dialog open and removes the local team when Team agent provisioning fails', async () => {
    provisionTeamAgentsMock.mockRejectedValueOnce(new Error('team-runtime plugin is not enabled'));
    setGatewayRunning();
    mockTeamRuntimeResponses([validationResult(), dependencyPlan(), { runId: 'team-174', deleted: false }]);

    renderTeamsPage();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('Team Name'), { target: { value: 'Broken Team' } });
    await checkTeamSkill();
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Team' }).at(-1)!);

    await waitFor(() => {
      expect(provisionTeamAgentsMock).toHaveBeenCalledTimes(1);
      expect(createRunMock).not.toHaveBeenCalled();
      expect(useTeamsStore.getState().teams).toHaveLength(0);
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/teams');
      expect(screen.getByText('team-runtime plugin is not enabled')).toBeInTheDocument();
    });
  });

  it('opens an existing TeamSkill team with the same name and version without creating duplicate role agents', async () => {
    setGatewayRunning();
    mockTeamRuntimeResponses([validationResult(), dependencyPlan()]);
    useTeamsStore.setState({
      teams: [teamMeta()],
      activeTeamId: null,
    } as never);

    renderTeamsPage();

    await openCreateDialog();
    await checkTeamSkill('.tmp/other-copy-of-same-team-skill');
    expect(screen.getByText('This TeamSkill version already has a team. Open the existing team instead of creating a duplicate.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Existing Team' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().teams).toHaveLength(1);
      expect(useTeamsStore.getState().activeTeamId).toBe('team-1');
      expect(provisionTeamAgentsMock).not.toHaveBeenCalled();
      expect(createRunMock).not.toHaveBeenCalled();
      expect(refreshSnapshotMock).toHaveBeenCalledWith('team-1');
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/teams/team-1');
    });
  });

  it('blocks creation when a required tool is missing', async () => {
    setGatewayRunning();
    mockTeamRuntimeResponses([
      validationResult(),
      dependencyPlan({
        canProceed: false,
        items: [{
          name: 'browser-mcp',
          required: true,
          purpose: 'Browser automation',
          kind: 'tool',
          status: 'missing',
          severity: 'blocker',
          installable: false,
        }],
      }),
    ]);

    renderTeamsPage();

    await openCreateDialog();
    await checkTeamSkill();

    expect(screen.getByText('browser-mcp · Tool · Required missing')).toBeInTheDocument();
    expect(screen.getByText('Required dependencies are missing. Resolve required skills or configure required tools before continuing.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Create Team' }).at(-1)).toBeDisabled();
  });

  it('opens a non-ClawHub skill source and imports a downloaded local skill before replanning dependencies', async () => {
    const installSkill = vi.fn().mockResolvedValue(undefined);
    const importLocalSkill = vi.fn().mockResolvedValue('investment-memo');
    pickLocalSkillSourceMock.mockResolvedValue('C:/Downloads/investment-memo/SKILL.md');
    useSkillsStore.setState({ installSkill, importLocalSkill } as never);
    setGatewayRunning();
    mockTeamRuntimeResponses([
      validationResult(),
      dependencyPlan({
        canProceed: false,
        items: [{
          name: 'investment-memo',
          required: true,
          purpose: 'Memo structure',
          source: 'https://skills.sh/?q=investment-memo',
          kind: 'skill',
          status: 'missing',
          severity: 'blocker',
          installable: true,
        }],
      }),
      dependencyPlan(),
    ]);

    renderTeamsPage();

    await openCreateDialog();
    await checkTeamSkill();
    expect(screen.queryByRole('button', { name: 'Install Skill' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import Local Skill' }));

    await waitFor(() => {
      expect(invokeIpcMock).toHaveBeenCalledWith('shell:openExternal', 'https://skills.sh/?q=investment-memo');
      expect(installSkill).not.toHaveBeenCalled();
      expect(importLocalSkill).toHaveBeenCalledWith('C:/Downloads/investment-memo/SKILL.md');
      expect(screen.queryByText('investment-memo · Skill · Required missing')).not.toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Create Team' }).at(-1)).toBeEnabled();
    });
  });

  it('requires explicit confirmation before replacing an existing TeamSkill version', async () => {
    setGatewayRunning();
    mockTeamRuntimeResponses([validationResult({ version: '1.1.0' }), dependencyPlan({ version: '1.1.0' })]);
    useTeamsStore.setState({
      teams: [teamMeta()],
      activeTeamId: null,
    } as never);

    renderTeamsPage();

    await openCreateDialog();
    await checkTeamSkill(`${TEAM_SKILL_PACKAGE_PATH}-1.1.0`);

    expect(screen.getByText('TeamSkill version change detected')).toBeInTheDocument();
    const replaceButton = screen.getByRole('button', { name: 'Replace Team' });
    expect(replaceButton).toBeDisabled();

    fireEvent.click(screen.getByLabelText('I understand this will replace the current TeamSkill version for this team.'));
    await waitFor(() => expect(replaceButton).toBeEnabled());
    fireEvent.click(replaceButton);

    await waitFor(() => {
      const state = useTeamsStore.getState();
      expect(state.teams).toHaveLength(1);
      expect(state.teams[0]?.id).toBe('team-1');
      expect(state.teams[0]?.teamSkillVersion).toBe('1.1.0');
      expect(provisionTeamAgentsMock).toHaveBeenCalledWith('team-1');
      expect(createRunMock).toHaveBeenCalledWith('team-1');
      expect(provisionTeamAgentsMock.mock.invocationCallOrder[0]).toBeLessThan(createRunMock.mock.invocationCallOrder[0]!);
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/teams/team-1');
    });
  });

  it('shows Resume Run for a newly created TeamRun without coupling New Run to resume', async () => {
    const createdRun = {
      runId: 'teamrun-created',
      status: 'created' as const,
      revision: 1,
      packageName: 'ascendc-team',
      packageVersion: '1.0.0',
      sourcePath: TEAM_SKILL_PACKAGE_PATH,
      createdAt: 1,
      updatedAt: 1,
    };
    const resumeRunMock = vi.fn().mockResolvedValue(undefined);
    const syncRunListMock = vi.fn().mockResolvedValue(undefined);
    setGatewayRunning();
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'teamrun-created' })],
      activeTeamId: 'team-1',
      runListByTeamId: { 'team-1': [{ ...createdRun, sessions: [] }] },
      runsById: { 'teamrun-created': createdRun },
      runByTeamId: { 'team-1': createdRun },
      resumeRun: resumeRunMock,
      syncRunList: syncRunListMock,
    } as never);

    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Run status: created · rev 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume Run' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'New Run' }));

    await waitFor(() => {
      expect(provisionTeamAgentsMock).not.toHaveBeenCalled();
      expect(createRunMock).toHaveBeenCalledWith('team-1');
      expect(resumeRunMock).not.toHaveBeenCalled();
    });
  });

  it('deletes an existing team', async () => {
    setGatewayRunning();
    mockTeamRuntimeResponses([{ runId: 'team-1-run-1.0.0-1000', deleted: true }]);
    useTeamsStore.setState({
      teams: [teamMeta()],
      activeTeamId: 'team-1',
    } as never);

    renderTeamsPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(capabilityExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.delete',
        input: { kind: 'team', teamId: 'team-1' },
      }), expect.objectContaining({ timeoutMs: 60000 }));
      expect(useTeamsStore.getState().teams).toHaveLength(0);
      expect(useTeamsStore.getState().activeTeamId).toBeNull();
    });
  });

  it('disables delete when gateway is unavailable and keeps failed delete errors visible', async () => {
    useTeamsStore.setState({
      teams: [teamMeta()],
      errorByTeamId: { 'team-1': 'backend delete failed' },
    } as never);

    renderTeamsPage();

    expect(await screen.findByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(screen.getByText('backend delete failed')).toBeInTheDocument();
  });
});
