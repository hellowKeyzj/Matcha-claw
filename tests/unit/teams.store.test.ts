import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openclaw/team-runtime-client', () => ({
  cancelTeamRun: vi.fn(),
  createTeamRun: vi.fn(),
  deleteTeamInstance: vi.fn(),
  deleteTeamRun: vi.fn(),
  exportTeamRunGraphYaml: vi.fn(),
  importTeamRunGraphYaml: vi.fn(),
  listTeamRuns: vi.fn(),
  provisionTeamAgents: vi.fn(),
  readTeamRunSnapshot: vi.fn(),
  resolveTeamApproval: vi.fn(),
  resumeTeam: vi.fn(),
  submitTeamRunDecision: vi.fn(),
  submitTeamRunGraphPatch: vi.fn(),
  submitTeamRunRoleMessage: vi.fn(),
}));

import { useChatStore } from '@/stores/chat';
import { buildSessionIdentityRecordIndex, buildSessionRecordKey } from '@/stores/chat/session-identity';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import {
  buildTeamRoleChatTargetByIdentityKey,
  buildTeamRoleChatTargetIndex,
  isKnownTeamRoleSession,
  resolveTeamRoleChatTarget,
  resolveTeamRoleChatTargetFromProbe,
  selectTeamRoleChatTargetIndex,
  useTeamsStore,
  type ManualTeamProvisionRecord,
  type TeamMeta,
  type TeamSkillCandidate,
  type TeamSkillPackage,
} from '@/stores/teams';
import {
  cancelTeamRun as beginTeamRunCancellation,
  createTeamRun as createTeamRunLifecycle,
  deleteTeamInstance as deleteTeamLifecycle,
  deleteTeamRun as tombstoneTeamRun,
  exportTeamRunGraphYaml as exportTeamGraphYaml,
  importTeamRunGraphYaml as importTeamGraphYaml,
  listTeamRuns as listTeamRunLifecycle,
  readTeamRunSnapshot,
  resolveTeamApproval as resolveTeamHumanDecision,
  resumeTeam as resumeTeamRunLifecycle,
  submitTeamRunGraphPatch as submitTeamGraphPatch,
  type TeamGraphPatchOperation,
  submitTeamRunRoleMessage as submitTeamRoleChat,
} from '@/services/openclaw/team-runtime-client';
import { createOpenClawTestSessionIdentity, openClawTestRuntimeEndpoint } from './helpers/runtime-address-fixtures';

const basePackage: TeamSkillPackage = {
  selectionId: 'teamskill:ascendc-team@1.0.0',
  name: 'ascendc-team',
  version: '1.0.0',
  kind: 'team-skill',
  description: 'AscendC team',
};

const manualTeam: ManualTeamProvisionRecord = {
  name: 'manual-ops',
  description: 'Manual operators',
  version: '2026.1',
  members: [{
    agentId: 'leader-agent',
    agentName: 'Leader Agent',
    workspace: '/agents/leader',
    roleId: 'leader',
    skills: ['planning'],
    tools: ['terminal'],
    model: 'claude-sonnet-4-5',
    isLeader: true,
  }],
};

function candidate(input: {
  displayName?: string;
  packagePath?: string;
  teamSkillPackage?: Partial<TeamSkillPackage>;
} = {}): TeamSkillCandidate {
  return {
    displayName: input.displayName ?? 'Team A',
    packagePath: input.packagePath ?? '.tmp/team-skill',
    teamSkillPackage: {
      ...basePackage,
      ...input.teamSkillPackage,
      kind: 'team-skill',
    },
  };
}

function lifecycleRun(runId: string, graphStatus: 'pending' | 'ready' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' = 'running') {
  return { state: 'available' as const, teamId: 'team-1', runId, teamRevision: 1, graphStatus, sessions: [] };
}

function teamMeta(input: Partial<TeamMeta> = {}): TeamMeta {
  return {
    id: 'team-1',
    name: 'Team A',
    teamSkillName: 'ascendc-team',
    teamSkillVersion: '1.0.0',
    teamSkillDescription: 'AscendC team',
    packagePath: '.tmp/team-skill',
    sourcePath: '.tmp/team-skill',
    sourceType: 'teamskill',
    activeRunId: 'team-1-run-1.0.0-1000',
    createdAt: 1000,
    updatedAt: 1000,
    ...input,
  };
}

function buildSnapshot(status: string = 'running', events = [{ eventId: 'e1', runId: 'team-1-run-1.0.0-1000', revision: 2, type: 'run:started', payload: {}, createdAt: 2 }]) {
  const runId = events[0]?.runId ?? 'team-1-run-1.0.0-1000';
  return {
    run: {
      runId,
      packageName: 'ascendc-team',
      packageVersion: '1.0.0',
      sourcePath: '.tmp/team-skill',
      status,
      currentStageId: 'stage-1',
      revision: 2,
      createdAt: 1,
      updatedAt: 2,
    },
    graph: null,
    nodeInputStates: [],
    nodeExecutions: [],
    nodeDeliveries: [],
    roles: [],
    stages: [{
      runId,
      stageId: 'stage-1',
      title: 'Stage 1',
      executor: 'Leader',
      status: 'running',
      attempt: 1,
      maxAttempts: 1,
      outputArtifactIds: [],
      createdAt: 1,
      updatedAt: 2,
    }],
    workflowPlan: null,
    dispatchGroups: [],
    dispatchTasks: [],
    approvals: [],
    artifacts: [],
    dispatches: [],
    dispatchExecutions: [],
    messages: [],
    nodePromptDeliveries: [],
    gates: [],
    kickbacks: [],
    decisions: [],
    diagnostics: {
      runId,
      recoveredFromStorage: true,
      storageRoot: '/tmp/team-1',
      budgets: { roleWallClockBudgetMs: {}, roleTokenBudget: {}, wallClockExceeded: false },
      limits: { maxArtifactContentBytes: 2097152, maxMessageBodyBytes: 262144, staleDispatchExecutionMs: 1800000 },
      staleDispatchExecutions: [],
      counts: { roles: 0, stages: 1, approvals: 0, artifacts: 0, dispatches: 0, dispatchExecutions: 0, messages: 0, gates: 0, kickbacks: 0, decisions: 0, events: events.length },
    },
    events,
    nextEventCursor: events.at(-1)?.revision ?? 0,
  };
}

function seedTeam(input: Partial<TeamMeta> = {}) {
  useTeamsStore.setState({
    teams: [teamMeta(input)],
  });
}

function sessionRecord(
  sessionKey: string,
  agentId: string,
  runPhase: 'idle' | 'streaming' = 'idle',
  identity = createOpenClawTestSessionIdentity(sessionKey, agentId),
) {
  const recordKey = buildSessionRecordKey(identity);
  return {
    recordKey,
    record: {
      ...createEmptySessionRecord(),
      meta: {
        ...createEmptySessionRecord().meta,
        agentId,
        sessionIdentity: identity,
        historyStatus: 'ready' as const,
      },
      runtime: {
        ...createEmptySessionRecord().runtime,
        runPhase,
      },
    },
  };
}

function teamRoleSessionBinding(input: {
  runId: string;
  roleId: string;
  agentId: string;
  localSessionId?: string;
  endpointSessionId?: string;
}) {
  const localSessionId = input.localSessionId ?? `local:${input.runId}:${input.roleId}`;
  const endpointSessionId = input.endpointSessionId ?? `endpoint:${input.runId}:${input.roleId}`;
  return {
    runId: input.runId,
    roleId: input.roleId,
    agentId: input.agentId,
    endpointRef: openClawTestRuntimeEndpoint,
    localSessionId,
    endpointSessionId,
    sessionIdentity: createOpenClawTestSessionIdentity(localSessionId, input.agentId),
  };
}

describe('teams store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    localStorage.removeItem('teams-runtime-store');

    useTeamsStore.setState({
      teams: [],
      activeTeamId: null,
      runIdsByTeamId: {},
      runListByTeamId: {},
      runsById: {},
      runByTeamId: {},
      rolesByTeamId: {},
      stagesByTeamId: {},
      graphByTeamId: {},
      workflowPlanByTeamId: {},
      dispatchGroupsByTeamId: {},
      dispatchTasksByTeamId: {},
      approvalsByTeamId: {},
      artifactsByTeamId: {},
      messagesByTeamId: {},
      nodeExecutionsByTeamId: {},
      nodePromptDeliveryAttemptsByTeamId: {},
      dispatchesByTeamId: {},
      dispatchExecutionsByTeamId: {},
      gatesByTeamId: {},
      kickbacksByTeamId: {},
      decisionsByTeamId: {},
      eventsByTeamId: {},
      eventsByRunId: {},
      eventCursorByTeamId: {},
      eventCursorByRunId: {},
      loadingByTeamId: {},
      errorByTeamId: {},
    });
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      loadedSessions: {},
      sessionRecordKeyByIdentityKey: {},
      pendingApprovalsBySession: {},
      dismissedRuntimeErrorBySession: {},
      foregroundHistorySessionKey: null,
      error: null,
    } as never);

    vi.mocked(createTeamRunLifecycle).mockResolvedValue({ runId: 'teamrun-generated', status: 'created', revision: 1 });
    vi.mocked(listTeamRunLifecycle).mockResolvedValue({ teamId: 'team-1', runs: [] });
    vi.mocked(deleteTeamLifecycle).mockResolvedValue({ teamId: 'team-1', deleted: true, deletedRunIds: [], deletedAgentIds: [] });
    vi.mocked(tombstoneTeamRun).mockResolvedValue({ runId: 'team-1-run-1.0.0-1000', deleted: true });
    vi.mocked(beginTeamRunCancellation).mockResolvedValue({ runId: 'team-1-run-1.0.0-1000', status: 'cancelled', revision: 1 });
    vi.mocked(exportTeamGraphYaml).mockResolvedValue({ runId: 'team-1-run-1.0.0-1000', fileName: 'team-1-run-1.0.0-1000.team-graph.yaml', yaml: 'nodes: []\n' });
    vi.mocked(importTeamGraphYaml).mockResolvedValue({ runId: 'team-1-run-1.0.0-1000', imported: true });
    vi.mocked(submitTeamRoleChat).mockResolvedValue({ success: true, submitted: true });
    vi.mocked(resumeTeamRunLifecycle).mockResolvedValue({ success: true, teamId: 'team-1', restoredRunIds: [], activeRunIds: [], skippedTerminalRunIds: [], runs: [] });
    vi.mocked(submitTeamGraphPatch).mockResolvedValue({ success: true, runId: 'team-1-run-1.0.0-1000', saved: true, outcome: 'available' });
    vi.mocked(readTeamRunSnapshot).mockImplementation(async ({ runId }) => buildSnapshot('running', [{ eventId: `event:${runId}`, runId, revision: 2, type: 'run:started', payload: {}, createdAt: 2 }]));
    vi.mocked(resolveTeamHumanDecision).mockResolvedValue({ success: true, status: 'approved' });
  });

  it('creates and selects a TeamSkill team from validated package identity', () => {
    const id = useTeamsStore.getState().createTeam(candidate({ displayName: 'Team A' }));

    const state = useTeamsStore.getState();
    expect(state.activeTeamId).toBe(id);
    expect(state.teams).toHaveLength(1);
    expect(state.teams[0]).toEqual(expect.objectContaining({
      id,
      name: 'Team A',
      teamSkillName: 'ascendc-team',
      teamSkillVersion: '1.0.0',
      teamSkillDescription: 'AscendC team',
      packagePath: '.tmp/team-skill',
      sourcePath: '.tmp/team-skill',
    }));
    expect(state.teams[0]?.activeRunId).toBeUndefined();
    expect(state.runIdsByTeamId[id]).toEqual([]);
  });

  it('records a materialized manual team with manual source identity', () => {
    const id = useTeamsStore.getState().createManualTeam({
      displayName: 'Manual Ops Team',
      manualTeam,
    });

    const state = useTeamsStore.getState();
    expect(state.activeTeamId).toBe(id);
    expect(state.teams).toHaveLength(1);
    expect(state.teams[0]).toEqual(expect.objectContaining({
      id,
      name: 'Manual Ops Team',
      teamSkillName: 'manual-ops',
      teamSkillVersion: '2026.1',
      teamSkillDescription: 'Manual operators',
      packagePath: `manual:${id}`,
      sourcePath: `manual:${id}`,
      sourceType: 'manual',
      manualTeam: {
        ...manualTeam,
        name: 'Manual Ops Team',
        members: manualTeam.members,
      },
    }));
    expect(state.teams[0]?.activeRunId).toBeUndefined();
    expect(state.runIdsByTeamId[id]).toEqual([]);
  });

  it('opens an existing TeamSkill team with the same name and version from a different path', () => {
    seedTeam();

    const plan = useTeamsStore.getState().planTeamSkillCreation(candidate({
      displayName: 'Duplicate Team',
      packagePath: '.tmp/other-copy',
    }));
    const id = useTeamsStore.getState().createTeam(candidate({
      displayName: 'Duplicate Team',
      packagePath: '.tmp/other-copy',
    }));

    const state = useTeamsStore.getState();
    expect(plan).toEqual({ action: 'open_existing', teamId: 'team-1' });
    expect(id).toBe('team-1');
    expect(state.activeTeamId).toBe('team-1');
    expect(state.teams).toEqual([teamMeta()]);
  });

  it('requires explicit replacement when the TeamSkill name matches but version changes', () => {
    seedTeam();

    const nextCandidate = candidate({ teamSkillPackage: { version: '1.1.0' } });

    expect(useTeamsStore.getState().planTeamSkillCreation(nextCandidate)).toEqual({
      action: 'replace_required',
      teamId: 'team-1',
      currentVersion: '1.0.0',
      incomingVersion: '1.1.0',
    });
    expect(() => useTeamsStore.getState().createTeam(nextCandidate)).toThrow('Replace it explicitly');
  });

  it('replaces TeamSkill metadata without clearing the old run projections before provisioning succeeds', () => {
    seedTeam();
    useTeamsStore.setState({
      teams: [teamMeta()],
      runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] },
      runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined },
      runByTeamId: { 'team-1': buildSnapshot().run ?? undefined },
      rolesByTeamId: { 'team-1': [teamRoleSessionBinding({ runId: 'old-run', roleId: 'leader', agentId: 'agent-1' })] },
    });

    const id = useTeamsStore.getState().replaceTeamSkillVersion({
      teamId: 'team-1',
      expectedCurrentVersion: '1.0.0',
      candidate: candidate({
        displayName: 'Team A Updated',
        packagePath: '.tmp/team-skill-1.1.0',
        teamSkillPackage: {
          version: '1.1.0',
          description: 'AscendC team v1.1',
        },
      }),
    });

    const state = useTeamsStore.getState();
    expect(id).toBe('team-1');
    expect(state.teams).toHaveLength(1);
    expect(state.teams[0]).toEqual(expect.objectContaining({
      id: 'team-1',
      name: 'Team A Updated',
      teamSkillName: 'ascendc-team',
      teamSkillVersion: '1.1.0',
      teamSkillDescription: 'AscendC team v1.1',
      packagePath: '.tmp/team-skill-1.1.0',
      sourcePath: '.tmp/team-skill-1.1.0',
    }));
    expect(state.teams[0]?.activeRunId).toBeUndefined();
    expect(state.runIdsByTeamId['team-1']).toEqual(['team-1-run-1.0.0-1000']);
    expect(state.runsById['team-1-run-1.0.0-1000']).toBeDefined();
    expect(state.runByTeamId['team-1']).toBeDefined();
    expect(state.rolesByTeamId['team-1']).toHaveLength(1);
  });

  it('rejects replacement when the expected current version is stale', () => {
    seedTeam({ teamSkillVersion: '1.1.0' });

    expect(() => useTeamsStore.getState().replaceTeamSkillVersion({
      teamId: 'team-1',
      expectedCurrentVersion: '1.0.0',
      candidate: candidate({ teamSkillPackage: { version: '1.2.0' } }),
    })).toThrow('TeamSkill version changed from 1.0.0 to 1.1.0');
  });

  it('removes a team only after deleting its backend Team instance', async () => {
    const runtimeRun = buildSnapshot('running', [{ eventId: 'e1', runId: 'runtime-run-1', revision: 2, type: 'run:started', payload: {}, createdAt: 2 }]).run;
    useTeamsStore.setState({
      teams: [teamMeta()],
      activeTeamId: 'team-1',
      runIdsByTeamId: { 'team-1': ['runtime-run-1'] },
      runsById: { 'runtime-run-1': runtimeRun ?? undefined },
      runByTeamId: { 'team-1': runtimeRun ?? undefined },
      rolesByTeamId: { 'team-1': [] },
      errorByTeamId: { 'team-1': 'previous error' },
    });
    let releaseDelete!: () => void;
    vi.mocked(deleteTeamLifecycle).mockReturnValueOnce(new Promise((resolve) => {
      releaseDelete = () => resolve({ teamId: 'team-1', outcome: 'deleted' });
    }));

    const deletion = useTeamsStore.getState().deleteTeam('team-1');

    expect(deleteTeamLifecycle).toHaveBeenCalledTimes(1);
    expect(deleteTeamLifecycle).toHaveBeenCalledWith({ teamId: 'team-1' });
    expect(useTeamsStore.getState().teams).toHaveLength(1);
    expect(useTeamsStore.getState().loadingByTeamId['team-1']).toBe(true);
    expect(useTeamsStore.getState().errorByTeamId['team-1']).toBeUndefined();

    releaseDelete();
    await deletion;

    const state = useTeamsStore.getState();
    expect(state.teams).toHaveLength(0);
    expect(state.activeTeamId).toBeNull();
    expect(state.runIdsByTeamId['team-1']).toBeUndefined();
    expect(state.runsById['runtime-run-1']).toBeUndefined();
    expect(state.runByTeamId['team-1']).toBeUndefined();
    expect(state.rolesByTeamId['team-1']).toBeUndefined();
    expect(state.loadingByTeamId['team-1']).toBeUndefined();
    expect(state.errorByTeamId['team-1']).toBeUndefined();
  });

  it('cleans local and backend-reported run state when deleting a team', async () => {
    const localRun = buildSnapshot('running', [{ eventId: 'local-event', runId: 'local-run', revision: 2, type: 'run:started', payload: {}, createdAt: 2 }]).run;
    const backendRun = buildSnapshot('completed', [{ eventId: 'backend-event', runId: 'backend-run', revision: 3, type: 'run:completed', payload: {}, createdAt: 3 }]).run;
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'local-run' })],
      activeTeamId: 'team-1',
      runIdsByTeamId: { 'team-1': ['local-run', 'backend-run'] },
      runsById: { 'local-run': localRun ?? undefined, 'backend-run': backendRun ?? undefined },
    });
    vi.mocked(deleteTeamLifecycle).mockResolvedValueOnce({ teamId: 'team-1', outcome: 'deleted' });

    await useTeamsStore.getState().deleteTeam('team-1');

    const state = useTeamsStore.getState();
    expect(state.runsById['local-run']).toBeUndefined();
    expect(state.runsById['backend-run']).toBeUndefined();
  });

  it('removes deleted TeamRun role sessions from the chat catalog when deleting a team', async () => {
    const leaderBinding = teamRoleSessionBinding({ runId: 'local-run', roleId: 'leader', agentId: 'leader-agent' });
    const analystBinding = teamRoleSessionBinding({ runId: 'backend-run', roleId: 'analyst', agentId: 'analyst-agent' });
    const otherTeamRoleBinding = teamRoleSessionBinding({ runId: 'other-run', roleId: 'leader', agentId: 'other-agent' });
    const leader = sessionRecord(leaderBinding.localSessionId, 'leader-agent', 'streaming', leaderBinding.sessionIdentity);
    const analyst = sessionRecord(analystBinding.localSessionId, 'analyst-agent', 'idle', analystBinding.sessionIdentity);
    const otherTeamRole = sessionRecord(otherTeamRoleBinding.localSessionId, 'other-agent', 'idle', otherTeamRoleBinding.sessionIdentity);
    const normalSession = sessionRecord('agent:main:main', 'main');
    const loadedSessions = {
      [leader.recordKey]: leader.record,
      [analyst.recordKey]: analyst.record,
      [otherTeamRole.recordKey]: otherTeamRole.record,
      [normalSession.recordKey]: normalSession.record,
    };
    useChatStore.setState({
      currentSessionKey: leader.recordKey,
      loadedSessions,
      sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
      pendingApprovalsBySession: { [leader.recordKey]: [{ id: 'approval-1' }] as never },
      dismissedRuntimeErrorBySession: { [leader.recordKey]: { updatedAt: 1, fingerprint: 'busy' } },
      foregroundHistorySessionKey: leader.recordKey,
    } as never);
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'local-run' })],
      runIdsByTeamId: { 'team-1': ['local-run', 'backend-run'] },
      runsById: {
        'local-run': buildSnapshot('running', [{ eventId: 'local-event', runId: 'local-run', revision: 2, type: 'run:started', payload: {}, createdAt: 2 }]).run ?? undefined,
        'backend-run': buildSnapshot('running', [{ eventId: 'backend-event', runId: 'backend-run', revision: 3, type: 'run:started', payload: {}, createdAt: 3 }]).run ?? undefined,
      },
      rolesByTeamId: {
        'team-1': [leaderBinding, analystBinding, otherTeamRoleBinding],
      },
    } as never);
    vi.mocked(deleteTeamLifecycle).mockResolvedValueOnce({ teamId: 'team-1', outcome: 'deleted' });

    await useTeamsStore.getState().deleteTeam('team-1');

    const chatState = useChatStore.getState();
    expect(chatState.loadedSessions[leader.recordKey]).toBeUndefined();
    expect(chatState.loadedSessions[analyst.recordKey]).toBeUndefined();
    expect(chatState.loadedSessions[otherTeamRole.recordKey]).toBeDefined();
    expect(chatState.loadedSessions[normalSession.recordKey]).toBeDefined();
    expect(chatState.currentSessionKey).toBe(otherTeamRole.recordKey);
    expect(chatState.sessionRecordKeyByIdentityKey).toEqual(buildSessionIdentityRecordIndex(chatState.loadedSessions));
    expect(chatState.pendingApprovalsBySession[leader.recordKey]).toBeUndefined();
    expect(chatState.dismissedRuntimeErrorBySession[leader.recordKey]).toBeUndefined();
    expect(chatState.foregroundHistorySessionKey).toBeNull();
  });

  it('keeps the team and records an error when backend Team instance deletion fails', async () => {
    seedTeam();
    useTeamsStore.setState({
      runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] },
      runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined },
      runByTeamId: { 'team-1': buildSnapshot().run ?? undefined },
    });
    vi.mocked(deleteTeamLifecycle).mockRejectedValueOnce(new Error('team lifecycle delete failed'));

    await expect(useTeamsStore.getState().deleteTeam('team-1')).rejects.toThrow('team lifecycle delete failed');

    const state = useTeamsStore.getState();
    expect(deleteTeamLifecycle).toHaveBeenCalledWith({ teamId: 'team-1' });
    expect(state.teams).toEqual([teamMeta()]);
    expect(state.runIdsByTeamId['team-1']).toEqual(['team-1-run-1.0.0-1000']);
    expect(state.runsById['team-1-run-1.0.0-1000']).toEqual(buildSnapshot().run);
    expect(state.runByTeamId['team-1']).toEqual(buildSnapshot().run);
    expect(state.loadingByTeamId['team-1']).toBe(false);
    expect(state.errorByTeamId['team-1']).toBe('team lifecycle delete failed');
  });

  it('drops persisted teams with unsafe legacy run ids', async () => {
    localStorage.setItem('teams-runtime-store', JSON.stringify({
      state: {
        teams: [teamMeta({ activeRunId: 'team-1:run:1.0.0:1000' })],
        activeTeamId: 'team-1',
      },
      version: 3,
    }));

    await useTeamsStore.persist.rehydrate();

    expect(useTeamsStore.getState().teams).toEqual([]);
    expect(useTeamsStore.getState().activeTeamId).toBeNull();
  });

  it('creates a new TeamRun with a frontend-generated teamrun id without starting it', async () => {
    seedTeam({ activeRunId: undefined });
    const createRunPromise = useTeamsStore.getState().createRun('team-1');
    const runId = vi.mocked(createTeamRunLifecycle).mock.calls[0]?.[0].runId;
    vi.mocked(listTeamRunLifecycle).mockResolvedValueOnce({ teamId: 'team-1', runs: [lifecycleRun(runId!, 'pending')] });
    await createRunPromise;

    expect(runId).toMatch(/^teamrun-/);
    expect(createTeamRunLifecycle).toHaveBeenCalledWith({
      teamId: 'team-1',
      packagePath: '.tmp/team-skill',
      runId,
      idempotencyKey: `team-1:create:${runId}`,
      sourceType: 'teamskill',
    });
    expect(listTeamRunLifecycle).toHaveBeenCalledWith({ teamId: 'team-1' });
    expect(readTeamRunSnapshot).toHaveBeenCalledWith({
      runId,
      eventCursor: undefined,
      eventLimit: 200,
    });
    expect(useTeamsStore.getState().teams[0]?.activeRunId).toBe(runId);
    expect(useTeamsStore.getState().runIdsByTeamId['team-1']).toEqual([runId]);
    expect(useTeamsStore.getState().runByTeamId['team-1']?.runId).toBe(runId);
  });

  it('creates a manual TeamRun through the sealed lifecycle transport', async () => {
    const id = useTeamsStore.getState().createManualTeam({
      displayName: 'Manual Ops Team',
      manualTeam,
    });
    const createRunPromise = useTeamsStore.getState().createRun(id);
    const runId = vi.mocked(createTeamRunLifecycle).mock.calls[0]?.[0].runId;
    vi.mocked(listTeamRunLifecycle).mockResolvedValueOnce({ teamId: id, runs: [{ ...lifecycleRun(runId!, 'pending'), teamId: id }] });

    await createRunPromise;

    expect(createTeamRunLifecycle).toHaveBeenCalledWith({
      teamId: id,
      packagePath: `manual:${id}`,
      runId,
      idempotencyKey: `${id}:create:${runId}`,
      sourceType: 'manual',
    });
  });

  it('creates a new TeamRun without renderer-side graph copying', async () => {
    seedTeam({ activeRunId: 'teamrun-source' });
    useTeamsStore.setState({
      runIdsByTeamId: { 'team-1': ['teamrun-source'] },
      graphByTeamId: {
        'team-1': {
          runId: 'teamrun-source',
          status: 'running',
          nodes: [{ nodeId: 'node-1', kind: 'work', title: 'Task 1' }],
          edges: [],
          updatedAt: 222,
        },
      },
    } as never);
    vi.mocked(createTeamRunLifecycle).mockImplementationOnce(async (payload) => ({ runId: payload.runId, outcome: 'created' }));
    const createRunPromise = useTeamsStore.getState().createRun('team-1');
    const runId = vi.mocked(createTeamRunLifecycle).mock.calls[0]?.[0].runId;
    vi.mocked(listTeamRunLifecycle).mockResolvedValueOnce({ teamId: 'team-1', runs: [lifecycleRun(runId!, 'pending')] });
    await createRunPromise;

    expect(readTeamRunSnapshot).toHaveBeenCalledWith({
      runId,
      eventCursor: undefined,
      eventLimit: 200,
    });
  });

  it('cancels the active TeamRun through the final lifecycle transport', async () => {
    const activeRun = buildSnapshot('running').run!;
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: activeRun.runId })],
      runsById: { [activeRun.runId]: activeRun },
      runByTeamId: { 'team-1': activeRun },
      runIdsByTeamId: { 'team-1': [activeRun.runId] },
    } as never);

    await useTeamsStore.getState().cancelRun('team-1');

    expect(beginTeamRunCancellation).toHaveBeenCalledWith({
      runId: activeRun.runId,
      idempotencyKey: `team-1:cancel:${activeRun.runId}`,
    });
  });

  it('deletes only the selected TeamRun and switches to the most recent remaining run', async () => {
    const olderRun = buildSnapshot('completed', [{ eventId: 'e1', runId: 'teamrun-old', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }]).run!;
    const newerRun = { ...buildSnapshot('running', [{ eventId: 'e2', runId: 'teamrun-new', revision: 2, type: 'run:created', payload: {}, createdAt: 2 }]).run!, updatedAt: 10 };
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'teamrun-new' })],
      runIdsByTeamId: { 'team-1': ['teamrun-old', 'teamrun-new'] },
      runsById: { 'teamrun-old': olderRun, 'teamrun-new': newerRun },
      runByTeamId: { 'team-1': newerRun },
    });

    await useTeamsStore.getState().deleteRun('team-1', 'teamrun-new');

    expect(tombstoneTeamRun).toHaveBeenCalledWith({ runId: 'teamrun-new' });
    expect(useTeamsStore.getState().teams[0]?.activeRunId).toBe('teamrun-old');
    expect(useTeamsStore.getState().runIdsByTeamId['team-1']).toEqual(['teamrun-old']);
    expect(useTeamsStore.getState().runsById['teamrun-new']).toBeUndefined();
    expect(useTeamsStore.getState().runByTeamId['team-1']?.runId).toBe('teamrun-old');
  });

  it('syncs the runtime run list and keeps the selected run active when present', async () => {
    const olderRun = buildSnapshot('completed', [{ eventId: 'e1', runId: 'teamrun-old', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }]).run!;
    const newerRun = { ...buildSnapshot('running', [{ eventId: 'e2', runId: 'teamrun-new', revision: 2, type: 'run:created', payload: {}, createdAt: 2 }]).run!, updatedAt: 10 };
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'teamrun-old' })],
      runIdsByTeamId: { 'team-1': ['stale-run'] },
      runListByTeamId: { 'team-1': [] },
      runsById: { 'stale-run': { ...olderRun, runId: 'stale-run' } },
      runByTeamId: { 'team-1': { ...olderRun, runId: 'stale-run' } },
      rolesByTeamId: { 'team-1': [] },
    });
    vi.mocked(listTeamRunLifecycle).mockResolvedValueOnce({
      teamId: 'team-1',
      runs: [
        lifecycleRun('teamrun-new', 'running'),
        lifecycleRun('teamrun-old', 'completed'),
      ],
    });

    await useTeamsStore.getState().syncRunList('team-1');

    const state = useTeamsStore.getState();
    expect(state.teams[0]?.activeRunId).toBe('teamrun-old');
    expect(state.runIdsByTeamId['team-1']).toEqual(['teamrun-new', 'teamrun-old']);
    expect(state.runListByTeamId['team-1']?.map((run) => run.runId)).toEqual(['teamrun-new', 'teamrun-old']);
    expect(state.runsById['stale-run']).toBeUndefined();
    expect(state.runByTeamId['team-1']?.runId).toBe('teamrun-old');
    expect(state.rolesByTeamId['team-1']).toEqual([]);
  });

  it('clears stale team projections when syncing selects a different active run', async () => {
    const olderRun = buildSnapshot('completed', [{ eventId: 'e1', runId: 'teamrun-old', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }]).run!;
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'teamrun-missing' })],
      runIdsByTeamId: { 'team-1': ['teamrun-missing'] },
      runListByTeamId: { 'team-1': [] },
      runsById: { 'teamrun-missing': { ...olderRun, runId: 'teamrun-missing' } },
      runByTeamId: { 'team-1': { ...olderRun, runId: 'teamrun-missing' } },
    } as never);
    vi.mocked(listTeamRunLifecycle).mockResolvedValueOnce({
      teamId: 'team-1',
      runs: [
        lifecycleRun('teamrun-old', 'completed'),
        lifecycleRun('teamrun-new', 'running'),
      ],
    });

    await useTeamsStore.getState().syncRunList('team-1');

    const state = useTeamsStore.getState();
    expect(state.teams[0]?.activeRunId).toBe('teamrun-new');
    expect(state.runByTeamId['team-1']?.runId).toBe('teamrun-new');
    expect(state.graphByTeamId['team-1']).toBeNull();
    expect(state.approvalsByTeamId['team-1']).toEqual([]);
  });

  it('switches active run and uses selected run-list sessions', () => {
    const olderRun = buildSnapshot('completed', [{ eventId: 'e1', runId: 'teamrun-old', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }]).run!;
    const newerRun = buildSnapshot('running', [{ eventId: 'e2', runId: 'teamrun-new', revision: 2, type: 'run:created', payload: {}, createdAt: 2 }]).run!;
    const roleChatBinding = teamRoleSessionBinding({ runId: 'teamrun-new', roleId: 'leader', agentId: 'leader-agent', localSessionId: 'team-role-session-new-leader' });
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'teamrun-new' })],
      runIdsByTeamId: { 'team-1': ['teamrun-old', 'teamrun-new'] },
      runListByTeamId: { 'team-1': [olderRun, { ...newerRun, sessions: [roleChatBinding] }] },
      runsById: { 'teamrun-old': olderRun, 'teamrun-new': newerRun },
      runByTeamId: { 'team-1': newerRun },
      rolesByTeamId: { 'team-1': [roleChatBinding] },
    });

    useTeamsStore.getState().setActiveRun('team-1', 'teamrun-old');

    const state = useTeamsStore.getState();
    expect(state.teams[0]?.activeRunId).toBe('teamrun-old');
    expect(state.runByTeamId['team-1']?.runId).toBe('teamrun-old');
    expect(state.rolesByTeamId['team-1']).toEqual([]);
  });

  it('does not clear unavailable snapshot sections', async () => {
    const roleBinding = teamRoleSessionBinding({ runId: 'team-1-run-1.0.0-1000', roleId: 'leader', agentId: 'leader-agent' });
    const stage = buildSnapshot().stages[0]!;
    const message = { runId: 'team-1-run-1.0.0-1000', messageId: 'message-1', kind: 'note', body: 'kept', createdAt: 1 };
    useTeamsStore.setState({
      teams: [teamMeta()],
      runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] },
      runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined },
      runByTeamId: { 'team-1': buildSnapshot().run ?? undefined },
      rolesByTeamId: { 'team-1': [roleBinding] },
      stagesByTeamId: { 'team-1': [stage] },
      messagesByTeamId: { 'team-1': [message] },
    } as never);
    vi.mocked(readTeamRunSnapshot).mockResolvedValueOnce({
      ...buildSnapshot('running', [{ eventId: 'e2', runId: 'team-1-run-1.0.0-1000', revision: 3, type: 'run:progress', payload: {}, createdAt: 3 }]),
      roles: [],
      stages: [],
      messages: [],
      unavailableSections: ['roles', 'stages', 'messages'],
    } as never);

    await useTeamsStore.getState().refreshSnapshot('team-1', { force: true });

    const state = useTeamsStore.getState();
    expect(state.rolesByTeamId['team-1']).toEqual([roleBinding]);
    expect(state.stagesByTeamId['team-1']).toEqual([stage]);
    expect(state.messagesByTeamId['team-1']).toEqual([message]);
    expect(state.eventsByTeamId['team-1']?.map((event) => event.eventId)).toEqual(['e2']);
  });

  it('refreshes selected active-run snapshot through the sealed projection', async () => {
    const olderRun = buildSnapshot('completed', [{ eventId: 'e1', runId: 'teamrun-old', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }]).run!;
    const newerRun = buildSnapshot('running', [{ eventId: 'e2', runId: 'teamrun-new', revision: 2, type: 'run:created', payload: {}, createdAt: 2 }]).run!;
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'teamrun-new' })],
      runIdsByTeamId: { 'team-1': ['teamrun-old', 'teamrun-new'] },
      runsById: { 'teamrun-old': olderRun, 'teamrun-new': newerRun },
      runByTeamId: { 'team-1': newerRun },
    });

    useTeamsStore.getState().setActiveRun('team-1', 'teamrun-old');
    await useTeamsStore.getState().refreshSnapshot('team-1', { force: true });

    expect(readTeamRunSnapshot).toHaveBeenCalledWith({
      runId: 'teamrun-old',
      eventCursor: undefined,
      eventLimit: 200,
    });
    expect(useTeamsStore.getState().teams[0]?.activeRunId).toBe('teamrun-old');
    expect(useTeamsStore.getState().runByTeamId['team-1']?.runId).toBe('teamrun-old');
  });

  it('does not let stale snapshot responses overwrite a newly selected run', async () => {
    const oldRun = buildSnapshot('running', [{ eventId: 'old-start', runId: 'teamrun-old', revision: 1, type: 'run:started', payload: {}, createdAt: 1 }]).run!;
    const newRun = buildSnapshot('created', [{ eventId: 'new-created', runId: 'teamrun-new', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }]).run!;
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'teamrun-old' })],
      runIdsByTeamId: { 'team-1': ['teamrun-old', 'teamrun-new'] },
      runsById: { 'teamrun-old': oldRun, 'teamrun-new': newRun },
      runByTeamId: { 'team-1': oldRun },
    });
    let releaseSnapshot!: () => void;
    vi.mocked(readTeamRunSnapshot).mockReturnValueOnce(new Promise((resolve) => {
      releaseSnapshot = () => resolve(buildSnapshot('completed', [{ eventId: 'old-complete', runId: 'teamrun-old', revision: 2, type: 'run:completed', payload: {}, createdAt: 2 }]));
    }));

    const refresh = useTeamsStore.getState().refreshSnapshot('team-1', { force: true });
    useTeamsStore.getState().setActiveRun('team-1', 'teamrun-new');
    releaseSnapshot();
    await refresh;

    const state = useTeamsStore.getState();
    expect(state.teams[0]?.activeRunId).toBe('teamrun-new');
    expect(state.runByTeamId['team-1']?.runId).toBe('teamrun-new');
    expect(state.runsById['teamrun-old']?.status).toBe('completed');
    expect(state.eventsByTeamId['team-1']).toEqual([]);
  });

  it('submits graph patch operations and updates the local graph projection', async () => {
    const currentGraph = {
      runId: 'team-1-run-1.0.0-1000',
      graphId: 'graph:team-1-run-1.0.0-1000',
      workflowPlanId: 'workflow:team-1-run-1.0.0-1000',
      nodes: [
        { nodeId: 'start', kind: 'start', title: 'Start', status: 'pending', maxAttempts: 1 },
        { nodeId: 'old', kind: 'work', title: 'Old', status: 'pending', maxAttempts: 1 },
      ],
      edges: [
        { edgeId: 'edge:start:old', sourceNodeId: 'start', targetNodeId: 'old', status: 'waiting' },
        { edgeId: 'edge:old:start', sourceNodeId: 'old', targetNodeId: 'start', status: 'waiting' },
      ],
      status: 'running',
    };
    const operations: TeamGraphPatchOperation[] = [
      { op: 'add_node', node: { nodeId: 'work', kind: 'work', title: 'Work', roleId: 'leader', taskId: 'work', status: 'pending', maxAttempts: 1, executor: { kind: 'team-role', roleId: 'leader' }, config: { prompt: 'Work' } } },
      { op: 'replace_node', node: { nodeId: 'start', kind: 'start', title: 'Start updated', status: 'ready', maxAttempts: 1 } },
      { op: 'add_edge', edge: { edgeId: 'edge:start:work', sourceNodeId: 'start', targetNodeId: 'work', sourcePort: 'out', targetPort: 'in', action: 'activate', payload: { includeUpstreamResult: true }, status: 'waiting' } },
      { op: 'replace_edge', edge: { edgeId: 'edge:start:old', sourceNodeId: 'start', targetNodeId: 'old', status: 'available', label: 'updated' } },
      { op: 'remove_edge', edgeId: 'edge:old:start' },
      { op: 'remove_node', nodeId: 'old' },
    ];
    useTeamsStore.setState({
      teams: [teamMeta()],
      runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] },
      runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined },
      runByTeamId: { 'team-1': buildSnapshot().run ?? undefined },
      graphByTeamId: { 'team-1': currentGraph },
    } as never);

    await useTeamsStore.getState().submitGraphPatch('team-1', operations);

    expect(submitTeamGraphPatch).toHaveBeenCalledWith({
      runId: 'team-1-run-1.0.0-1000',
      summary: 'graph_patch',
      patch: {
        baseGraphId: 'graph:team-1-run-1.0.0-1000',
        baseWorkflowPlanId: 'workflow:team-1-run-1.0.0-1000',
        operations,
      },
      idempotencyKey: expect.stringMatching(/^graph-patch:/),
    });
    expect(useTeamsStore.getState().graphByTeamId['team-1']?.nodes).toEqual([
      { nodeId: 'start', kind: 'start', title: 'Start updated', status: 'ready', maxAttempts: 1 },
      { nodeId: 'work', kind: 'work', title: 'Work', roleId: 'leader', taskId: 'work', status: 'pending', maxAttempts: 1, executor: { kind: 'team-role', roleId: 'leader' }, config: { prompt: 'Work' } },
    ]);
    expect(useTeamsStore.getState().graphByTeamId['team-1']?.edges).toEqual([
      { edgeId: 'edge:start:work', sourceNodeId: 'start', targetNodeId: 'work', sourcePort: 'out', targetPort: 'in', action: 'activate', payload: { includeUpstreamResult: true }, status: 'waiting' },
    ]);
  });

  it('exports graph YAML through the active TeamRun without mutating graph state', async () => {
    const graph = {
      runId: 'team-1-run-1.0.0-1000',
      nodes: [{ nodeId: 'node-1', kind: 'work', title: 'Task 1' }],
      edges: [],
      status: 'running',
      updatedAt: 222,
    };
    useTeamsStore.setState({
      teams: [teamMeta()],
      runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] },
      runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined },
      runByTeamId: { 'team-1': buildSnapshot().run ?? undefined },
      graphByTeamId: { 'team-1': graph },
    } as never);
    vi.mocked(exportTeamGraphYaml).mockResolvedValueOnce({
      runId: 'team-1-run-1.0.0-1000',
      yaml: 'nodes:\n  - id: node-1\n',
    });

    const result = await useTeamsStore.getState().exportGraphYaml('team-1');

    expect(exportTeamGraphYaml).toHaveBeenCalledWith({ runId: 'team-1-run-1.0.0-1000' });
    expect(result).toEqual({ runId: 'team-1-run-1.0.0-1000', yaml: 'nodes:\n  - id: node-1\n' });
    expect(useTeamsStore.getState().graphByTeamId['team-1']).toBe(graph);
  });

  it('imports graph YAML through the fixed Team graph delivery and refreshes active views', async () => {
    useTeamsStore.setState({
      teams: [teamMeta()],
      runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] },
      runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined },
      runByTeamId: { 'team-1': buildSnapshot().run ?? undefined },
    } as never);
    vi.mocked(importTeamGraphYaml).mockResolvedValueOnce({ runId: 'team-1-run-1.0.0-1000' });

    const result = await useTeamsStore.getState().importGraphYaml('team-1', 'nodes:\n  - id: node-1\n');

    expect(importTeamGraphYaml).toHaveBeenCalledWith({
      runId: 'team-1-run-1.0.0-1000',
      yaml: 'nodes:\n  - id: node-1\n',
      idempotencyKey: expect.stringMatching(/^team-1:graph-import-yaml:team-1-run-1\.0\.0-1000:yaml:/),
    });
    expect(readTeamRunSnapshot).not.toHaveBeenCalled();
    expect(result).toEqual({ runId: 'team-1-run-1.0.0-1000' });
  });


  it('shows TeamRun role chat user messages optimistically before runtime-host returns', async () => {
    const leaderBinding = teamRoleSessionBinding({ runId: 'team-1-run-1.0.0-1000', roleId: 'leader', agentId: 'leader-agent' });
    const leader = sessionRecord(leaderBinding.localSessionId, 'leader-agent', 'idle', leaderBinding.sessionIdentity);
    const loadedSessions = { [leader.recordKey]: leader.record };
    useChatStore.setState({
      currentSessionKey: leader.recordKey,
      loadedSessions,
      sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
    } as never);
    useTeamsStore.setState({
      teams: [teamMeta()],
      runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] },
      runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined },
      runByTeamId: { 'team-1': buildSnapshot().run ?? undefined },
      rolesByTeamId: {
        'team-1': [{
          runId: 'team-1-run-1.0.0-1000',
          roleId: 'leader',
          agentId: 'leader-agent',
          endpointRef: leaderBinding.endpointRef,
          localSessionId: leaderBinding.localSessionId,
          endpointSessionId: leaderBinding.endpointSessionId,
          sessionIdentity: leaderBinding.sessionIdentity,
        }],
      },
    });
    let releaseSubmit!: () => void;
    vi.mocked(submitTeamRoleChat).mockReturnValueOnce(new Promise((resolve) => {
      releaseSubmit = () => resolve({ success: true, outcome: 'accepted' });
    }));

    const submit = useTeamsStore.getState().submitTeamRoleMessageFromChat('team-1', 'leader', '立刻显示这句');

    const optimisticRecord = useChatStore.getState().loadedSessions[leader.recordKey];
    const optimisticItems = optimisticRecord?.items ?? [];
    expect(optimisticItems).toEqual([
      expect.objectContaining({
        kind: 'user-message',
        role: 'user',
        text: '立刻显示这句',
        status: 'sending',
        messageId: expect.stringMatching(/^team-1:role-message:team-1-run-1\.0\.0-1000:leader:message:/),
      }),
      expect.objectContaining({
        kind: 'assistant-turn',
        role: 'assistant',
        status: 'streaming',
        pendingState: 'typing',
      }),
    ]);
    expect(optimisticRecord?.runtime.runPhase).toBe('submitted');
    expect(optimisticRecord?.runtime.activeRunId).toBe(optimisticItems[0]?.messageId);
    expect(optimisticRecord?.runtime.activeTurnItemKey).toBe(optimisticItems[1]?.key);
    expect(submitTeamRoleChat).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'team-1-run-1.0.0-1000',
      roleId: 'leader',
      text: '立刻显示这句',
      idempotencyKey: optimisticItems[0]?.messageId,
    }));

    releaseSubmit();
    await submit;
  });

  it('submits a Team role chat message to the requested run instead of the active run', async () => {
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'team-1-run-active' })],
      runIdsByTeamId: { 'team-1': ['team-1-run-active', 'team-1-run-requested'] },
      runsById: {
        'team-1-run-active': buildSnapshot('running', [{ eventId: 'active-event', runId: 'team-1-run-active', revision: 2, type: 'run:started', payload: {}, createdAt: 2 }]).run ?? undefined,
        'team-1-run-requested': buildSnapshot('running', [{ eventId: 'requested-event', runId: 'team-1-run-requested', revision: 2, type: 'run:started', payload: {}, createdAt: 2 }]).run ?? undefined,
      },
      runByTeamId: { 'team-1': buildSnapshot('running', [{ eventId: 'active-event', runId: 'team-1-run-active', revision: 2, type: 'run:started', payload: {}, createdAt: 2 }]).run ?? undefined },
    });
    vi.mocked(submitTeamRoleChat).mockResolvedValueOnce({ success: true, outcome: 'accepted' });

    await useTeamsStore.getState().submitTeamRoleMessageFromChat('team-1', 'leader', '  Analyze Anthropic Series B  ', 'team-1-run-requested');

    expect(submitTeamRoleChat).toHaveBeenCalledWith({
      runId: 'team-1-run-requested',
      roleId: 'leader',
      text: '  Analyze Anthropic Series B  ',
      idempotencyKey: expect.stringMatching(/^team-1:role-message:team-1-run-requested:leader:message:/),
    });
    expect(useTeamsStore.getState().loadingByTeamId['team-1']).toBe(false);
  });

  it('resolves Team role chat targets only from its binding owner', () => {
    const bindingAnalyst = teamRoleSessionBinding({ runId: 'run-from-bindings', roleId: 'analyst', agentId: 'analyst-agent' });
    const targetsByIdentityKey = buildTeamRoleChatTargetByIdentityKey({
      teams: [teamMeta({ activeRunId: 'different-active-run' })],
      runListByTeamId: {},
      rolesByTeamId: { 'team-1': [bindingAnalyst] },
    });

    expect(resolveTeamRoleChatTarget(targetsByIdentityKey, bindingAnalyst.sessionIdentity)).toMatchObject({
      teamId: 'team-1',
      runId: 'run-from-bindings',
      roleId: 'analyst',
      agentId: 'analyst-agent',
      localSessionId: bindingAnalyst.localSessionId,
      endpointSessionId: bindingAnalyst.endpointSessionId,
      sessionIdentity: bindingAnalyst.sessionIdentity,
    });
    expect(resolveTeamRoleChatTarget(targetsByIdentityKey, createOpenClawTestSessionIdentity('ordinary-session', 'ordinary-agent'))).toBeNull();
  });

  it('exposes Team role chat target resolution through its binding store contract', () => {
    const bindingAnalyst = teamRoleSessionBinding({ runId: 'run-from-bindings', roleId: 'analyst', agentId: 'analyst-agent' });
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'different-active-run' })],
      runListByTeamId: {},
      rolesByTeamId: { 'team-1': [bindingAnalyst] },
    } as never);

    expect(useTeamsStore.getState().resolveTeamRoleChatTargetBySession({ sessionIdentity: bindingAnalyst.sessionIdentity })).toMatchObject({
      teamId: 'team-1',
      runId: 'run-from-bindings',
      roleId: 'analyst',
      endpointSessionId: bindingAnalyst.endpointSessionId,
    });
    expect(useTeamsStore.getState().isTeamRoleSession({ sessionIdentity: bindingAnalyst.sessionIdentity })).toBe(true);
    expect(useTeamsStore.getState().resolveTeamRoleChatTargetBySession({ sessionIdentity: createOpenClawTestSessionIdentity('ordinary-session', 'ordinary-agent') })).toBeNull();
  });

  it('resolves Team role targets from run-list session bindings', () => {
    const leader = teamRoleSessionBinding({ runId: 'run-1', roleId: 'leader', agentId: 'leader-agent' });
    const index = buildTeamRoleChatTargetIndex({
      teams: [teamMeta()],
      runListByTeamId: { 'team-1': [{ ...lifecycleRun('run-1'), sessions: [leader] }] },
      rolesByTeamId: {},
    });

    expect(resolveTeamRoleChatTargetFromProbe(index, { sessionIdentity: leader.sessionIdentity })).toMatchObject({
      teamId: 'team-1',
      runId: 'run-1',
      roleId: 'leader',
      endpointSessionId: leader.endpointSessionId,
    });
    expect(isKnownTeamRoleSession(index, { sessionKey: leader.localSessionId })).toBe(true);
  });

  it('resolves Team role probes by local, endpoint, and materialized session keys', () => {
    const leader = teamRoleSessionBinding({
      runId: 'run-1',
      roleId: 'leader',
      agentId: 'leader-agent',
      localSessionId: 'team-role-session-run-1-leader',
      endpointSessionId: 'team-endpoint-session-run-1-leader',
    });
    const index = buildTeamRoleChatTargetIndex({
      teams: [teamMeta()],
      runListByTeamId: {},
      rolesByTeamId: { 'team-1': [leader] },
    });
    const materializedSessionKey = `agent:leader-agent:${leader.endpointSessionId}`;

    expect(resolveTeamRoleChatTargetFromProbe(index, { sessionKey: leader.localSessionId })).toMatchObject({
      teamId: 'team-1',
      runId: 'run-1',
      roleId: 'leader',
      endpointSessionId: leader.endpointSessionId,
    });
    expect(resolveTeamRoleChatTargetFromProbe(index, { endpointSessionId: leader.endpointSessionId })).toMatchObject({
      endpointSessionId: leader.endpointSessionId,
    });
    expect(resolveTeamRoleChatTargetFromProbe(index, { sessionKey: materializedSessionKey })).toMatchObject({
      endpointSessionId: leader.endpointSessionId,
    });
    expect(isKnownTeamRoleSession(index, { sessionKey: materializedSessionKey })).toBe(true);
    expect(isKnownTeamRoleSession(index, { sessionKey: 'agent:leader-agent:ordinary-session' })).toBe(false);
  });

  it('keeps the Teams store role index stable and reserves Team role local session keys', () => {
    const leader = teamRoleSessionBinding({ runId: 'run-1', roleId: 'leader', agentId: 'leader-agent', localSessionId: 'team-role-session-run-1-leader' });
    const input = {
      teams: [teamMeta()],
      runListByTeamId: {},
      rolesByTeamId: { 'team-1': [leader] },
    };
    const firstIndex = selectTeamRoleChatTargetIndex(input);
    const secondIndex = selectTeamRoleChatTargetIndex(input);
    const emptyIndex = buildTeamRoleChatTargetIndex({ teams: [], runListByTeamId: {}, rolesByTeamId: {} });

    expect(secondIndex).toBe(firstIndex);
    expect(isKnownTeamRoleSession(firstIndex, { sessionIdentity: leader.sessionIdentity })).toBe(true);
    expect(isKnownTeamRoleSession(emptyIndex, {
      sessionIdentity: createOpenClawTestSessionIdentity('team-role-session-run-1-leader', 'leader-agent'),
    })).toBe(true);
    expect(isKnownTeamRoleSession(firstIndex, {
      sessionIdentity: createOpenClawTestSessionIdentity('team-role-session-orphan-leader', 'leader-agent'),
      sessionKey: 'team-role-session-orphan-leader',
    })).toBe(true);
    expect(isKnownTeamRoleSession(firstIndex, {
      sessionIdentity: createOpenClawTestSessionIdentity('agent:leader-agent:main', 'leader-agent'),
      sessionKey: 'agent:leader-agent:main',
    })).toBe(false);
  });

  it('stores team role message submit errors from runtime-host', async () => {
    useTeamsStore.setState({
      teams: [teamMeta()],
      runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] },
      runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined },
      runByTeamId: { 'team-1': buildSnapshot().run ?? undefined },
    });
    vi.mocked(submitTeamRoleChat).mockRejectedValueOnce(new Error('Team role session runtime is unavailable'));

    const leaderBinding = teamRoleSessionBinding({ runId: 'team-1-run-1.0.0-1000', roleId: 'leader', agentId: 'leader-agent' });
    const leader = sessionRecord(leaderBinding.localSessionId, 'leader-agent', 'idle', leaderBinding.sessionIdentity);
    const loadedSessions = { [leader.recordKey]: leader.record };
    useChatStore.setState({
      currentSessionKey: leader.recordKey,
      loadedSessions,
      sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
    } as never);

    await expect(useTeamsStore.getState().submitTeamRoleMessageFromChat('team-1', 'leader', 'hello')).rejects.toThrow('Team role session runtime is unavailable');

    expect(useChatStore.getState().loadedSessions[leader.recordKey]?.items).toEqual([]);
    expect(useChatStore.getState().loadedSessions[leader.recordKey]?.runtime.runPhase).toBe('idle');
    expect(useTeamsStore.getState().errorByTeamId['team-1']).toBe('Team role session runtime is unavailable');
    expect(useTeamsStore.getState().loadingByTeamId['team-1']).toBe(false);
  });

  it('refreshes the active snapshot after role message submit', async () => {
    useTeamsStore.setState({
      teams: [teamMeta()],
      runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] },
      runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined },
      runByTeamId: { 'team-1': buildSnapshot().run ?? undefined },
    });
    vi.mocked(submitTeamRoleChat).mockResolvedValueOnce({ success: true, outcome: 'accepted' });

    await useTeamsStore.getState().submitTeamRoleMessageFromChat('team-1', 'leader', 'hello');

    expect(readTeamRunSnapshot).toHaveBeenCalledWith({
      runId: 'team-1-run-1.0.0-1000',
      eventCursor: undefined,
      eventLimit: 200,
    });
  });

  it('guards duplicate in-flight resume actions while sending the sealed request only once', async () => {
    useTeamsStore.setState({ teams: [teamMeta()], runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] } });
    let releaseFirstResume!: () => void;
    vi.mocked(resumeTeamRunLifecycle)
      .mockReturnValueOnce(new Promise((resolve) => {
        releaseFirstResume = () => resolve({ success: true, teamId: 'team-1', restoredRunIds: [], activeRunIds: [], skippedTerminalRunIds: [], runs: [] });
      }))
      .mockResolvedValueOnce({ success: true, teamId: 'team-1', restoredRunIds: [], activeRunIds: [], skippedTerminalRunIds: [], runs: [] });

    const firstResume = useTeamsStore.getState().resumeRun('team-1');
    const duplicateResume = useTeamsStore.getState().resumeRun('team-1');
    releaseFirstResume();
    await Promise.all([firstResume, duplicateResume]);
    await useTeamsStore.getState().resumeRun('team-1');

    expect(resumeTeamRunLifecycle).toHaveBeenCalledTimes(2);
    expect(resumeTeamRunLifecycle).toHaveBeenCalledWith({
      teamId: 'team-1',
      idempotencyKey: expect.stringMatching(/^team-1:resume:/),
    });
  });

  it('resumes the Team through the sealed lifecycle transport', async () => {
    useTeamsStore.setState({ teams: [teamMeta()] });

    await useTeamsStore.getState().resumeRun('team-1');

    expect(resumeTeamRunLifecycle).toHaveBeenCalledWith({
      teamId: 'team-1',
      idempotencyKey: expect.stringMatching(/^team-1:resume:/),
    });
  });

  it('selects an active resumed run before refreshing its snapshot', async () => {
    useTeamsStore.setState({ teams: [teamMeta({ activeRunId: undefined })] });
    vi.mocked(resumeTeamRunLifecycle).mockResolvedValueOnce({
      success: true,
      teamId: 'team-1',
      restoredRunIds: ['run-restored'],
      activeRunIds: ['run-restored'],
      skippedTerminalRunIds: [],
      runs: [lifecycleRun('run-restored', 'running')],
    });

    await useTeamsStore.getState().resumeRun('team-1');

    expect(readTeamRunSnapshot).toHaveBeenCalledWith({
      runId: 'run-restored',
      eventCursor: undefined,
      eventLimit: 200,
    });
    const state = useTeamsStore.getState();
    expect(state.teams.find((team) => team.id === 'team-1')?.activeRunId).toBe('run-restored');
  });

  it('resolves human decisions through the sealed approval transport', async () => {
    useTeamsStore.setState({ teams: [teamMeta()], runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] }, runsById: { 'team-1-run-1.0.0-1000': buildSnapshot('waiting_for_user').run ?? undefined }, runByTeamId: { 'team-1': buildSnapshot('waiting_for_user').run ?? undefined } });

    await useTeamsStore.getState().resolveApproval('team-1', 'approval-1', 'approve', 'Approved');

    expect(resolveTeamHumanDecision).toHaveBeenCalledWith({
      runId: 'team-1-run-1.0.0-1000',
      approvalId: 'approval-1',
      decision: 'approve',
      note: 'Approved',
      idempotencyKey: 'team-1:approval:team-1-run-1.0.0-1000:approval-1:approve',
    });
  });
});
