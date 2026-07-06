import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openclaw/team-runtime-client', () => ({
  createTeamRun: vi.fn(),
  deleteTeamInstance: vi.fn(),
  deleteTeamRun: vi.fn(),
  exportTeamRunGraphYaml: vi.fn(),
  importTeamRunGraphYaml: vi.fn(),
  submitTeamRunRoleMessage: vi.fn(),
  listTeamRuns: vi.fn(),
  provisionTeamAgents: vi.fn(),
  readTeamRunSnapshot: vi.fn(),
  resumeTeam: vi.fn(),
  cancelTeamRun: vi.fn(),
  resolveTeamApproval: vi.fn(),
  saveTeamRunGraphProjection: vi.fn(),
  submitTeamRunDecision: vi.fn(),
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
  type TeamMeta,
  type TeamSkillCandidate,
} from '@/stores/teams';
import {
  createTeamRun,
  deleteTeamInstance,
  deleteTeamRun,
  exportTeamRunGraphYaml,
  importTeamRunGraphYaml,
  submitTeamRunRoleMessage,
  listTeamRuns,
  provisionTeamAgents,
  readTeamRunSnapshot,
  resumeTeam,
  saveTeamRunGraphProjection,
  submitTeamRunDecision,
  type ManualTeamProvisionRecord,
  type TeamGraphSnapshotRecord,
  type TeamRunSnapshot,
  type TeamRunStatus,
  type TeamSkillPackage,
} from '@/services/openclaw/team-runtime-client';
import { createOpenClawTestSessionIdentity, openClawTestRuntimeEndpoint } from './helpers/runtime-address-fixtures';

const basePackage: TeamSkillPackage = {
  name: 'ascendc-team',
  version: '1.0.0',
  kind: 'team-skill',
  description: 'AscendC team',
  dependencies: { skills: [], tools: [] },
  sourcePath: '.tmp/team-skill/SKILL.md',
};

const manualTeam: ManualTeamProvisionRecord = {
  name: 'manual-ops',
  description: 'Manual operators',
  version: '2026.1',
  members: [{
    agentId: 'leader-agent',
    agentName: 'Leader Agent',
    workspace: '/work/manual-team',
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
      dependencies: input.teamSkillPackage?.dependencies ?? basePackage.dependencies,
      kind: 'team-skill',
    },
  };
}

function teamMeta(input: Partial<TeamMeta> = {}): TeamMeta {
  return {
    id: 'team-1',
    name: 'Team A',
    teamSkillName: 'ascendc-team',
    teamSkillVersion: '1.0.0',
    teamSkillDescription: 'AscendC team',
    packagePath: '.tmp/team-skill',
    sourcePath: '.tmp/team-skill/SKILL.md',
    sourceType: 'teamskill',
    activeRunId: 'team-1-run-1.0.0-1000',
    createdAt: 1000,
    updatedAt: 1000,
    ...input,
  };
}

function buildSnapshot(status: TeamRunStatus = 'running', events = [{ eventId: 'e1', runId: 'team-1-run-1.0.0-1000', revision: 2, type: 'run:started', payload: {}, createdAt: 2 }]): TeamRunSnapshot {
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
  backendSessionKey: string,
  agentId: string,
  runPhase: 'idle' | 'streaming' = 'idle',
  identity = createOpenClawTestSessionIdentity(backendSessionKey, agentId),
) {
  const recordKey = buildSessionRecordKey(identity);
  return {
    recordKey,
    record: {
      ...createEmptySessionRecord(),
      meta: {
        ...createEmptySessionRecord().meta,
        backendSessionKey,
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

    vi.mocked(createTeamRun).mockResolvedValue({ runId: 'teamrun-generated', status: 'created', revision: 1 });
    vi.mocked(listTeamRuns).mockResolvedValue({ teamId: 'team-1', runs: [] });
    vi.mocked(readTeamRunSnapshot).mockResolvedValue(buildSnapshot());
    vi.mocked(deleteTeamInstance).mockResolvedValue({ teamId: 'team-1', deleted: true, deletedRunIds: [], deletedAgentIds: [] });
    vi.mocked(deleteTeamRun).mockResolvedValue({ runId: 'team-1-run-1.0.0-1000', deleted: true });
    vi.mocked(exportTeamRunGraphYaml).mockResolvedValue({ fileName: 'team-run-graph.yaml', yaml: 'nodes: []\n' });
    vi.mocked(importTeamRunGraphYaml).mockResolvedValue({ success: true, imported: true, snapshot: buildSnapshot() });
    vi.mocked(submitTeamRunRoleMessage).mockResolvedValue({ success: true, submitted: true, snapshot: buildSnapshot() });
    vi.mocked(provisionTeamAgents).mockResolvedValue({ teamId: 'team-1', managedAgentCount: 2 });
    vi.mocked(resumeTeam).mockResolvedValue({ success: true, teamId: 'team-1', restoredRunIds: [], activeRunIds: [], skippedTerminalRunIds: [] });
    vi.mocked(saveTeamRunGraphProjection).mockResolvedValue({ success: true });
    vi.mocked(submitTeamRunDecision).mockResolvedValue(undefined);
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
      sourcePath: '.tmp/team-skill/SKILL.md',
    }));
    expect(state.teams[0]?.activeRunId).toBeUndefined();
    expect(state.runIdsByTeamId[id]).toEqual([]);
  });

  it('creates and selects a manual team with manual source identity', () => {
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
      eventCursorByTeamId: { 'team-1': 8 },
      eventCursorByRunId: { 'team-1-run-1.0.0-1000': 8 },
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
          sourcePath: '.tmp/team-skill-1.1.0/SKILL.md',
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
      sourcePath: '.tmp/team-skill-1.1.0/SKILL.md',
    }));
    expect(state.teams[0]?.activeRunId).toBeUndefined();
    expect(state.runIdsByTeamId['team-1']).toEqual(['team-1-run-1.0.0-1000']);
    expect(state.runsById['team-1-run-1.0.0-1000']).toBeDefined();
    expect(state.runByTeamId['team-1']).toBeDefined();
    expect(state.rolesByTeamId['team-1']).toHaveLength(1);
    expect(state.eventCursorByTeamId['team-1']).toBe(8);
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
      stagesByTeamId: { 'team-1': [] },
      eventsByTeamId: { 'team-1': [{ eventId: 'e1', runId: 'runtime-run-1', revision: 2, type: 'run:started', payload: {}, createdAt: 2 }] },
      eventsByRunId: { 'runtime-run-1': [{ eventId: 'e1', runId: 'runtime-run-1', revision: 2, type: 'run:started', payload: {}, createdAt: 2 }] },
      eventCursorByTeamId: { 'team-1': 2 },
      eventCursorByRunId: { 'runtime-run-1': 2 },
      errorByTeamId: { 'team-1': 'previous error' },
    });
    let releaseDelete!: () => void;
    vi.mocked(deleteTeamInstance).mockReturnValueOnce(new Promise((resolve) => {
      releaseDelete = () => resolve({ teamId: 'team-1', deleted: true, deletedRunIds: ['runtime-run-1'], deletedAgentIds: [] });
    }));

    const deletion = useTeamsStore.getState().deleteTeam('team-1');

    expect(deleteTeamInstance).toHaveBeenCalledTimes(1);
    expect(deleteTeamInstance).toHaveBeenCalledWith({ teamId: 'team-1' });
    expect(deleteTeamRun).not.toHaveBeenCalled();
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
    expect(state.stagesByTeamId['team-1']).toBeUndefined();
    expect(state.eventsByTeamId['team-1']).toBeUndefined();
    expect(state.eventsByRunId['runtime-run-1']).toBeUndefined();
    expect(state.eventCursorByTeamId['team-1']).toBeUndefined();
    expect(state.eventCursorByRunId['runtime-run-1']).toBeUndefined();
    expect(state.loadingByTeamId['team-1']).toBeUndefined();
    expect(state.errorByTeamId['team-1']).toBeUndefined();
  });

  it('cleans local and backend-reported run state when deleting a team', async () => {
    const localRun = buildSnapshot('running', [{ eventId: 'local-event', runId: 'local-run', revision: 2, type: 'run:started', payload: {}, createdAt: 2 }]).run;
    const backendRun = buildSnapshot('completed', [{ eventId: 'backend-event', runId: 'backend-run', revision: 3, type: 'run:completed', payload: {}, createdAt: 3 }]).run;
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'local-run' })],
      activeTeamId: 'team-1',
      runIdsByTeamId: { 'team-1': ['local-run'] },
      runsById: { 'local-run': localRun ?? undefined, 'backend-run': backendRun ?? undefined },
      eventsByRunId: {
        'local-run': [{ eventId: 'local-event', runId: 'local-run', revision: 2, type: 'run:started', payload: {}, createdAt: 2 }],
        'backend-run': [{ eventId: 'backend-event', runId: 'backend-run', revision: 3, type: 'run:completed', payload: {}, createdAt: 3 }],
      },
      eventCursorByRunId: { 'local-run': 2, 'backend-run': 3 },
    });
    vi.mocked(deleteTeamInstance).mockResolvedValueOnce({ teamId: 'team-1', deleted: true, deletedRunIds: ['backend-run'], deletedAgentIds: [] });

    await useTeamsStore.getState().deleteTeam('team-1');

    const state = useTeamsStore.getState();
    expect(state.runsById['local-run']).toBeUndefined();
    expect(state.runsById['backend-run']).toBeUndefined();
    expect(state.eventsByRunId['local-run']).toBeUndefined();
    expect(state.eventsByRunId['backend-run']).toBeUndefined();
    expect(state.eventCursorByRunId['local-run']).toBeUndefined();
    expect(state.eventCursorByRunId['backend-run']).toBeUndefined();
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
      runIdsByTeamId: { 'team-1': ['local-run'] },
      runsById: {
        'local-run': buildSnapshot('running', [{ eventId: 'local-event', runId: 'local-run', revision: 2, type: 'run:started', payload: {}, createdAt: 2 }]).run ?? undefined,
        'backend-run': buildSnapshot('running', [{ eventId: 'backend-event', runId: 'backend-run', revision: 3, type: 'run:started', payload: {}, createdAt: 3 }]).run ?? undefined,
      },
      rolesByTeamId: {
        'team-1': [leaderBinding, analystBinding, otherTeamRoleBinding],
      },
    } as never);
    vi.mocked(deleteTeamInstance).mockResolvedValueOnce({ teamId: 'team-1', deleted: true, deletedRunIds: ['backend-run'], deletedAgentIds: [] });

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
      eventsByTeamId: { 'team-1': [{ eventId: 'e1', runId: 'team-1-run-1.0.0-1000', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }] },
      eventsByRunId: { 'team-1-run-1.0.0-1000': [{ eventId: 'e1', runId: 'team-1-run-1.0.0-1000', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }] },
      eventCursorByTeamId: { 'team-1': 1 },
      eventCursorByRunId: { 'team-1-run-1.0.0-1000': 1 },
    });
    vi.mocked(deleteTeamInstance).mockRejectedValueOnce(new Error('team runtime delete failed'));

    await expect(useTeamsStore.getState().deleteTeam('team-1')).rejects.toThrow('team runtime delete failed');

    const state = useTeamsStore.getState();
    expect(deleteTeamInstance).toHaveBeenCalledWith({ teamId: 'team-1' });
    expect(deleteTeamRun).not.toHaveBeenCalled();
    expect(state.teams).toEqual([teamMeta()]);
    expect(state.runIdsByTeamId['team-1']).toEqual(['team-1-run-1.0.0-1000']);
    expect(state.runsById['team-1-run-1.0.0-1000']).toEqual(buildSnapshot().run);
    expect(state.runByTeamId['team-1']).toEqual(buildSnapshot().run);
    expect(state.eventCursorByTeamId['team-1']).toBe(1);
    expect(state.eventCursorByRunId['team-1-run-1.0.0-1000']).toBe(1);
    expect(state.loadingByTeamId['team-1']).toBe(false);
    expect(state.errorByTeamId['team-1']).toBe('team runtime delete failed');
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

  it('provisions Team agents without creating a TeamRun', async () => {
    seedTeam({ activeRunId: undefined });

    await useTeamsStore.getState().provisionTeamAgents('team-1');

    expect(provisionTeamAgents).toHaveBeenCalledWith({
      teamId: 'team-1',
      packagePath: '.tmp/team-skill',
      idempotencyKey: 'team-1:provision-agents:ascendc-team:1.0.0',
      sourceType: 'teamskill',
    });
    expect(createTeamRun).not.toHaveBeenCalled();
    expect(useTeamsStore.getState().teams[0]?.activeRunId).toBeUndefined();
    expect(useTeamsStore.getState().runIdsByTeamId['team-1']).toBeUndefined();
    expect(useTeamsStore.getState().runByTeamId['team-1']).toBeUndefined();
  });

  it('provisions manual team agents with the manual source payload', async () => {
    const id = useTeamsStore.getState().createManualTeam({
      displayName: 'Manual Ops Team',
      manualTeam,
    });

    await useTeamsStore.getState().provisionTeamAgents(id);

    expect(provisionTeamAgents).toHaveBeenCalledWith({
      teamId: id,
      packagePath: `manual:${id}`,
      idempotencyKey: `${id}:provision-agents:manual:2026.1`,
      sourceType: 'manual',
      manualTeam: {
        ...manualTeam,
        name: 'Manual Ops Team',
        members: manualTeam.members,
      },
    });
    expect(createTeamRun).not.toHaveBeenCalled();
    expect(useTeamsStore.getState().teams[0]?.activeRunId).toBeUndefined();
  });

  it('creates a new TeamRun with a frontend-generated teamrun id without starting it', async () => {
    seedTeam({ activeRunId: undefined });
    vi.mocked(readTeamRunSnapshot).mockImplementation(async ({ runId }) => buildSnapshot('created', [
      { eventId: 'e1', runId, revision: 1, type: 'run:created', payload: {}, createdAt: 1 },
    ]));

    const createRunPromise = useTeamsStore.getState().createRun('team-1');
    const runId = vi.mocked(createTeamRun).mock.calls[0]?.[0].runId;
    vi.mocked(listTeamRuns).mockResolvedValueOnce({
      teamId: 'team-1',
      runs: [{ ...buildSnapshot('created', [{ eventId: 'e1', runId: runId!, revision: 1, type: 'run:created', payload: {}, createdAt: 1 }]).run!, sessions: [] }],
    });
    await createRunPromise;

    expect(runId).toMatch(/^teamrun-/);
    expect(createTeamRun).toHaveBeenCalledWith({
      teamId: 'team-1',
      packagePath: '.tmp/team-skill',
      runId,
      idempotencyKey: `team-1:create:${runId}`,
      sourceType: 'teamskill',
    });
    expect(listTeamRuns).toHaveBeenCalledWith({ teamId: 'team-1' });
    expect(readTeamRunSnapshot).toHaveBeenCalledWith({ runId, eventCursor: undefined, eventLimit: 200 });
    expect(useTeamsStore.getState().teams[0]?.activeRunId).toBe(runId);
    expect(useTeamsStore.getState().runIdsByTeamId['team-1']).toEqual([runId]);
    expect(useTeamsStore.getState().runByTeamId['team-1']?.status).toBe('created');
  });

  it('creates a manual TeamRun with the manual source type', async () => {
    const id = useTeamsStore.getState().createManualTeam({
      displayName: 'Manual Ops Team',
      manualTeam,
    });
    vi.mocked(readTeamRunSnapshot).mockImplementation(async ({ runId }) => buildSnapshot('created', [
      { eventId: 'e1', runId, revision: 1, type: 'run:created', payload: {}, createdAt: 1 },
    ]));

    const createRunPromise = useTeamsStore.getState().createRun(id);
    const runId = vi.mocked(createTeamRun).mock.calls[0]?.[0].runId;
    vi.mocked(listTeamRuns).mockResolvedValueOnce({
      teamId: id,
      runs: [{ ...buildSnapshot('created', [{ eventId: 'e1', runId: runId!, revision: 1, type: 'run:created', payload: {}, createdAt: 1 }]).run!, sessions: [] }],
    });
    await createRunPromise;

    expect(createTeamRun).toHaveBeenCalledWith({
      teamId: id,
      packagePath: `manual:${id}`,
      runId,
      idempotencyKey: `${id}:create:${runId}`,
      sourceType: 'manual',
    });
    expect(readTeamRunSnapshot).toHaveBeenCalledWith({ runId, eventCursor: undefined, eventLimit: 200 });
    expect(useTeamsStore.getState().teams[0]?.activeRunId).toBe(runId);
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
    vi.mocked(createTeamRun).mockImplementationOnce(async (payload) => ({ runId: payload.runId!, status: 'created', revision: 1 }));
    vi.mocked(readTeamRunSnapshot).mockImplementation(async ({ runId }) => buildSnapshot('created', [
      { eventId: 'e1', runId, revision: 1, type: 'run:created', payload: {}, createdAt: 1 },
    ]));

    const createRunPromise = useTeamsStore.getState().createRun('team-1');
    const runId = vi.mocked(createTeamRun).mock.calls[0]?.[0].runId;
    vi.mocked(listTeamRuns).mockResolvedValueOnce({
      teamId: 'team-1',
      runs: [{ ...buildSnapshot('created', [{ eventId: 'e1', runId: runId!, revision: 1, type: 'run:created', payload: {}, createdAt: 1 }]).run!, sessions: [] }],
    });
    await createRunPromise;

    expect(saveTeamRunGraphProjection).not.toHaveBeenCalled();
    expect(readTeamRunSnapshot).toHaveBeenCalledWith({ runId, eventCursor: undefined, eventLimit: 200 });
  });

  it('deletes only the selected TeamRun and switches to the most recent remaining run', async () => {
    const olderRun = buildSnapshot('completed', [{ eventId: 'e1', runId: 'teamrun-old', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }]).run!;
    const newerRun = { ...buildSnapshot('running', [{ eventId: 'e2', runId: 'teamrun-new', revision: 2, type: 'run:created', payload: {}, createdAt: 2 }]).run!, updatedAt: 10 };
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'teamrun-new' })],
      runIdsByTeamId: { 'team-1': ['teamrun-old', 'teamrun-new'] },
      runsById: { 'teamrun-old': olderRun, 'teamrun-new': newerRun },
      runByTeamId: { 'team-1': newerRun },
      eventsByRunId: { 'teamrun-old': [], 'teamrun-new': [] },
    });

    await useTeamsStore.getState().deleteRun('team-1', 'teamrun-new');

    expect(deleteTeamRun).toHaveBeenCalledWith({ runId: 'teamrun-new' });
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
    vi.mocked(listTeamRuns).mockResolvedValueOnce({
      teamId: 'team-1',
      runs: [
        { ...newerRun, sessions: [] },
        { ...olderRun, sessions: [teamRoleSessionBinding({ runId: 'teamrun-old', roleId: 'leader', agentId: 'agent-1', localSessionId: 'local:teamrun-old:leader', endpointSessionId: 'endpoint-teamrun-old-leader' })] },
      ],
    } as never);

    await useTeamsStore.getState().syncRunList('team-1');

    const state = useTeamsStore.getState();
    expect(state.teams[0]?.activeRunId).toBe('teamrun-old');
    expect(state.runIdsByTeamId['team-1']).toEqual(['teamrun-new', 'teamrun-old']);
    expect(state.runListByTeamId['team-1']?.map((run) => run.runId)).toEqual(['teamrun-new', 'teamrun-old']);
    expect(state.runsById['stale-run']).toBeUndefined();
    expect(state.runByTeamId['team-1']?.runId).toBe('teamrun-old');
    expect(state.rolesByTeamId['team-1']?.map((role) => role.roleId)).toEqual(['leader']);
  });

  it('clears stale team projections when syncing selects a different active run', async () => {
    const olderRun = buildSnapshot('completed', [{ eventId: 'e1', runId: 'teamrun-old', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }]).run!;
    const newerRun = { ...buildSnapshot('running', [{ eventId: 'e2', runId: 'teamrun-new', revision: 2, type: 'run:created', payload: {}, createdAt: 2 }]).run!, updatedAt: 10 };
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'teamrun-missing' })],
      runIdsByTeamId: { 'team-1': ['teamrun-missing'] },
      runListByTeamId: { 'team-1': [] },
      runsById: { 'teamrun-missing': { ...olderRun, runId: 'teamrun-missing' } },
      runByTeamId: { 'team-1': { ...olderRun, runId: 'teamrun-missing' } },
      stagesByTeamId: { 'team-1': [{ ...buildSnapshot().stages[0]!, runId: 'teamrun-missing' }] },
      nodePromptDeliveryAttemptsByTeamId: {
        'team-1': [{
          deliveryRecordId: 'node-prompt-old',
          runId: 'teamrun-missing',
          nodeId: 'node-old',
          nodeExecutionId: 'node-exec-old',
          taskId: 'task-old',
          roleId: 'operator',
          toAgentId: 'agent-2',
          localSessionId: 'local:teamrun-missing:operator',
          kind: 'node.prompt',
          title: 'Old node prompt',
          prompt: 'Prompt',
          status: 'pending',
          idempotencyKey: 'node-prompt-old',
          causationId: 'event-old',
          createdAt: 1,
        }],
      },
      eventsByTeamId: { 'team-1': [{ eventId: 'old-event', runId: 'teamrun-missing', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }] },
      eventCursorByTeamId: { 'team-1': 1 },
    } as never);
    vi.mocked(listTeamRuns).mockResolvedValueOnce({
      teamId: 'team-1',
      runs: [
        { ...olderRun, sessions: [] },
        { ...newerRun, sessions: [] },
      ],
    });

    await useTeamsStore.getState().syncRunList('team-1');

    const state = useTeamsStore.getState();
    expect(state.teams[0]?.activeRunId).toBe('teamrun-new');
    expect(state.runByTeamId['team-1']?.runId).toBe('teamrun-new');
    expect(state.stagesByTeamId['team-1']).toEqual([]);
    expect(state.nodePromptDeliveryAttemptsByTeamId['team-1']).toEqual([]);
    expect(state.eventsByTeamId['team-1']).toEqual([]);
    expect(state.eventCursorByTeamId['team-1']).toBeUndefined();
  });

  it('switches active run projection with the run list role session bindings', () => {
    const olderRun = buildSnapshot('completed', [{ eventId: 'e1', runId: 'teamrun-old', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }]).run!;
    const newerRun = buildSnapshot('running', [{ eventId: 'e2', runId: 'teamrun-new', revision: 2, type: 'run:created', payload: {}, createdAt: 2 }]).run!;
    const oldLeader = teamRoleSessionBinding({ runId: 'teamrun-old', roleId: 'leader', agentId: 'leader-agent', localSessionId: 'team-role-session-old-leader' });
    const newLeader = teamRoleSessionBinding({ runId: 'teamrun-new', roleId: 'leader', agentId: 'leader-agent', localSessionId: 'team-role-session-new-leader' });
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'teamrun-new' })],
      runIdsByTeamId: { 'team-1': ['teamrun-old', 'teamrun-new'] },
      runListByTeamId: {
        'team-1': [
          { ...olderRun, sessions: [oldLeader] },
          { ...newerRun, sessions: [newLeader] },
        ],
      },
      runsById: { 'teamrun-old': olderRun, 'teamrun-new': newerRun },
      runByTeamId: { 'team-1': newerRun },
      rolesByTeamId: { 'team-1': [newLeader] },
    });

    useTeamsStore.getState().setActiveRun('team-1', 'teamrun-old');

    const state = useTeamsStore.getState();
    expect(state.teams[0]?.activeRunId).toBe('teamrun-old');
    expect(state.runByTeamId['team-1']?.runId).toBe('teamrun-old');
    expect(state.rolesByTeamId['team-1']).toEqual([oldLeader]);
  });

  it('switches active run projection before refreshing that run snapshot', async () => {
    const olderRun = buildSnapshot('completed', [{ eventId: 'e1', runId: 'teamrun-old', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }]).run!;
    const newerRun = buildSnapshot('running', [{ eventId: 'e2', runId: 'teamrun-new', revision: 2, type: 'run:created', payload: {}, createdAt: 2 }]).run!;
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'teamrun-new' })],
      runIdsByTeamId: { 'team-1': ['teamrun-old', 'teamrun-new'] },
      runsById: { 'teamrun-old': olderRun, 'teamrun-new': newerRun },
      runByTeamId: { 'team-1': newerRun },
      eventsByRunId: { 'teamrun-old': [{ eventId: 'e1', runId: 'teamrun-old', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }] },
      eventCursorByRunId: { 'teamrun-old': 1 },
    });
    vi.mocked(readTeamRunSnapshot).mockResolvedValue(buildSnapshot('completed', [
      { eventId: 'e3', runId: 'teamrun-old', revision: 2, type: 'run:completed', payload: {}, createdAt: 3 },
    ]));

    useTeamsStore.getState().setActiveRun('team-1', 'teamrun-old');
    await useTeamsStore.getState().refreshSnapshot('team-1');

    expect(readTeamRunSnapshot).toHaveBeenCalledWith({ runId: 'teamrun-old', eventCursor: 1, eventLimit: 200 });
    expect(useTeamsStore.getState().teams[0]?.activeRunId).toBe('teamrun-old');
    expect(useTeamsStore.getState().runByTeamId['team-1']?.runId).toBe('teamrun-old');
  });

  it('keeps the run list order when refreshing an existing active run snapshot', async () => {
    const olderRun = buildSnapshot('completed', [{ eventId: 'e1', runId: 'teamrun-old', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }]).run!;
    const middleRun = buildSnapshot('running', [{ eventId: 'e2', runId: 'teamrun-middle', revision: 2, type: 'run:created', payload: {}, createdAt: 2 }]).run!;
    const newerRun = buildSnapshot('completed', [{ eventId: 'e3', runId: 'teamrun-new', revision: 3, type: 'run:created', payload: {}, createdAt: 3 }]).run!;
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'teamrun-middle' })],
      runIdsByTeamId: { 'team-1': ['teamrun-new', 'teamrun-middle', 'teamrun-old'] },
      runListByTeamId: {
        'team-1': [
          { ...newerRun, sessions: [] },
          { ...middleRun, sessions: [] },
          { ...olderRun, sessions: [] },
        ],
      },
      runsById: { 'teamrun-old': olderRun, 'teamrun-middle': middleRun, 'teamrun-new': newerRun },
      runByTeamId: { 'team-1': middleRun },
      eventsByRunId: { 'teamrun-middle': [] },
      eventCursorByRunId: { 'teamrun-middle': 0 },
    });
    vi.mocked(readTeamRunSnapshot).mockResolvedValue(buildSnapshot('completed', [
      { eventId: 'e4', runId: 'teamrun-middle', revision: 4, type: 'run:completed', payload: {}, createdAt: 4 },
    ]));

    await useTeamsStore.getState().refreshSnapshot('team-1');

    const runList = useTeamsStore.getState().runListByTeamId['team-1'];
    expect(runList?.map((run) => run.runId)).toEqual(['teamrun-new', 'teamrun-middle', 'teamrun-old']);
    expect(runList?.[1]?.status).toBe('completed');
  });

  it('keeps stale snapshot responses from overwriting the current team projection', async () => {
    const oldRun = buildSnapshot('running', [{ eventId: 'old-start', runId: 'teamrun-old', revision: 1, type: 'run:started', payload: {}, createdAt: 1 }]).run!;
    const newRun = buildSnapshot('created', [{ eventId: 'new-created', runId: 'teamrun-new', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }]).run!;
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'teamrun-old' })],
      runIdsByTeamId: { 'team-1': ['teamrun-old', 'teamrun-new'] },
      runsById: { 'teamrun-old': oldRun, 'teamrun-new': newRun },
      runByTeamId: { 'team-1': oldRun },
      stagesByTeamId: { 'team-1': [{ ...buildSnapshot().stages[0]!, runId: 'teamrun-old' }] },
      nodePromptDeliveryAttemptsByTeamId: { 'team-1': [] },
      eventsByRunId: { 'teamrun-old': [] },
      eventCursorByRunId: { 'teamrun-old': 0 },
    });
    let releaseSnapshot!: () => void;
    vi.mocked(readTeamRunSnapshot).mockReturnValueOnce(new Promise((resolve) => {
      releaseSnapshot = () => resolve({
        ...buildSnapshot('completed', [{ eventId: 'old-completed', runId: 'teamrun-old', revision: 2, type: 'run:completed', payload: {}, createdAt: 2 }]),
        nodePromptDeliveries: [{
          deliveryRecordId: 'node-prompt-old',
          runId: 'teamrun-old',
          nodeId: 'node-old',
          nodeExecutionId: 'node-exec-old',
          taskId: 'task-old',
          roleId: 'operator',
          toAgentId: 'agent-2',
          localSessionId: 'local:teamrun-missing:operator',
          kind: 'node.prompt',
          title: 'Old node prompt',
          prompt: 'Prompt',
          status: 'delivered',
          idempotencyKey: 'node-prompt-old',
          causationId: 'old-completed',
          createdAt: 2,
        }],
      } as never);
    }));

    const refresh = useTeamsStore.getState().refreshSnapshot('team-1');
    expect(readTeamRunSnapshot).toHaveBeenCalledWith({ runId: 'teamrun-old', eventCursor: 0, eventLimit: 200 });

    useTeamsStore.getState().setActiveRun('team-1', 'teamrun-new');
    releaseSnapshot();
    await refresh;

    const state = useTeamsStore.getState();
    expect(state.teams[0]?.activeRunId).toBe('teamrun-new');
    expect(state.runByTeamId['team-1']?.runId).toBe('teamrun-new');
    expect(state.stagesByTeamId['team-1']).toEqual([]);
    expect(state.nodePromptDeliveryAttemptsByTeamId['team-1']).toEqual([]);
    expect(state.eventsByTeamId['team-1']).toEqual([]);
    expect(state.eventsByRunId['teamrun-old']?.map((event) => event.eventId)).toEqual(['old-completed']);
    expect(state.eventCursorByRunId['teamrun-old']).toBe(2);
  });

  it('merges incremental events instead of replacing history', async () => {
    useTeamsStore.setState({
      teams: [teamMeta()],
      runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] },
      runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined },
      runByTeamId: { 'team-1': buildSnapshot().run ?? undefined },
      eventsByTeamId: {
        'team-1': [{ eventId: 'e1', runId: 'team-1-run-1.0.0-1000', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }],
      },
      eventsByRunId: {
        'team-1-run-1.0.0-1000': [{ eventId: 'e1', runId: 'team-1-run-1.0.0-1000', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }],
      },
      eventCursorByRunId: { 'team-1-run-1.0.0-1000': 1 },
    });
    vi.mocked(readTeamRunSnapshot).mockResolvedValue(buildSnapshot('running', [
      { eventId: 'e2', runId: 'team-1-run-1.0.0-1000', revision: 2, type: 'run:started', payload: {}, createdAt: 2 },
    ]));

    await useTeamsStore.getState().refreshSnapshot('team-1');

    expect(readTeamRunSnapshot).toHaveBeenCalledWith({ runId: 'team-1-run-1.0.0-1000', eventCursor: 1, eventLimit: 200 });
    expect(useTeamsStore.getState().eventsByTeamId['team-1']?.map((event) => event.eventId)).toEqual(['e1', 'e2']);
  });

  it('saves graph projection through the active TeamRun and updates local graph state', async () => {
    useTeamsStore.setState({ teams: [teamMeta()], runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] }, runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined }, runByTeamId: { 'team-1': buildSnapshot().run ?? undefined } });
    const graph = {
      nodes: [{ nodeId: 'node-1', kind: 'work', title: 'Task 1' }],
      edges: [{ edgeId: 'edge-1', sourceNodeId: 'node-1', targetNodeId: 'node-2', sourcePort: 'completed' }],
      status: 'running',
      updatedAt: 222,
    };

    await useTeamsStore.getState().saveGraph('team-1', graph);

    expect(saveTeamRunGraphProjection).toHaveBeenCalledWith({
      runId: 'team-1-run-1.0.0-1000',
      graph,
      idempotencyKey: 'team-1:graph-save:team-1-run-1.0.0-1000:222',
    });
    expect(useTeamsStore.getState().graphByTeamId['team-1']).toEqual({
      ...graph,
      runId: 'team-1-run-1.0.0-1000',
      updatedAt: 222,
    });
  });

  it('normalizes malformed graph entries when patching a TeamRun snapshot', async () => {
    const snapshot = buildSnapshot('running');
    snapshot.graph = {
      runId: 'team-1-run-1.0.0-1000',
      status: 'running',
      nodes: [
        undefined,
        { title: 'Malformed node without id' },
        { nodeId: 'analysis-work-node', title: 'Work node without kind', status: 'running' },
        { nodeId: 'review-node', kind: 'review', title: 'Review work', status: 'pending' },
      ],
      edges: [
        undefined,
        { edgeId: 'malformed-edge-without-endpoints' },
        { edgeId: 'missing-target-edge', sourceNodeId: 'analysis-work-node', targetNodeId: 'missing-node' },
        { edgeId: 'review-edge', sourceNodeId: 'analysis-work-node', targetNodeId: 'review-node', sourcePort: 'completed' },
      ],
      updatedAt: 300,
    } as unknown as TeamGraphSnapshotRecord;
    useTeamsStore.setState({
      teams: [teamMeta()],
      runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] },
      runsById: { 'team-1-run-1.0.0-1000': snapshot.run ?? undefined },
      runByTeamId: { 'team-1': snapshot.run ?? undefined },
    } as never);
    vi.mocked(readTeamRunSnapshot).mockResolvedValueOnce(snapshot);

    await useTeamsStore.getState().refreshSnapshot('team-1', { force: true });

    expect(useTeamsStore.getState().graphByTeamId['team-1']).toEqual({
      runId: 'team-1-run-1.0.0-1000',
      status: 'running',
      nodes: [
        { nodeId: 'analysis-work-node', title: 'Work node without kind', status: 'running' },
        { nodeId: 'review-node', kind: 'review', title: 'Review work', status: 'pending' },
      ],
      edges: [
        { edgeId: 'missing-target-edge', sourceNodeId: 'analysis-work-node', targetNodeId: 'missing-node' },
        { edgeId: 'review-edge', sourceNodeId: 'analysis-work-node', targetNodeId: 'review-node', sourcePort: 'completed' },
      ],
      updatedAt: 300,
    });
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
    vi.mocked(exportTeamRunGraphYaml).mockResolvedValueOnce({
      fileName: 'unsafe:name.yaml',
      yaml: 'nodes:\n  - id: node-1\n',
    });

    const result = await useTeamsStore.getState().exportGraphYaml('team-1');

    expect(exportTeamRunGraphYaml).toHaveBeenCalledWith({ runId: 'team-1-run-1.0.0-1000' });
    expect(result).toEqual({ fileName: 'unsafe:name.yaml', yaml: 'nodes:\n  - id: node-1\n' });
    expect(useTeamsStore.getState().graphByTeamId['team-1']).toBe(graph);
    expect(saveTeamRunGraphProjection).not.toHaveBeenCalled();
  });

  it('imports graph YAML through the active TeamRun and patches the returned graph snapshot', async () => {
    const snapshot = buildSnapshot('running');
    snapshot.graph = {
      runId: 'team-1-run-1.0.0-1000',
      nodes: [{ nodeId: 'node-1', kind: 'work', title: 'Task 1' }],
      edges: [],
      status: 'running',
      updatedAt: 300,
    };
    useTeamsStore.setState({
      teams: [teamMeta()],
      runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] },
      runsById: { 'team-1-run-1.0.0-1000': snapshot.run ?? undefined },
      runByTeamId: { 'team-1': snapshot.run ?? undefined },
    } as never);
    vi.mocked(importTeamRunGraphYaml).mockResolvedValueOnce({ success: true, imported: true, snapshot });

    const result = await useTeamsStore.getState().importGraphYaml('team-1', 'nodes:\n  - id: node-1\n');

    expect(importTeamRunGraphYaml).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'team-1-run-1.0.0-1000',
      yaml: 'nodes:\n  - id: node-1\n',
    }));
    expect(result.imported).toBe(true);
    expect(useTeamsStore.getState().graphByTeamId['team-1']).toEqual(snapshot.graph);
  });

  it('stores graph save errors without silently accepting failed saves', async () => {
    useTeamsStore.setState({ teams: [teamMeta()], runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] }, runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined }, runByTeamId: { 'team-1': buildSnapshot().run ?? undefined } });
    vi.mocked(saveTeamRunGraphProjection).mockRejectedValueOnce(new Error('Save failed'));

    await expect(useTeamsStore.getState().saveGraph('team-1', { nodes: [], edges: [], status: 'running' })).rejects.toThrow('Save failed');

    expect(useTeamsStore.getState().errorByTeamId['team-1']).toBe('Save failed');
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
    vi.mocked(submitTeamRunRoleMessage).mockReturnValueOnce(new Promise((resolve) => {
      releaseSubmit = () => resolve({ success: true, submitted: true, snapshot: buildSnapshot() });
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
    expect(submitTeamRunRoleMessage).toHaveBeenCalledWith(expect.objectContaining({
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
    const snapshot = buildSnapshot('running', [
      { eventId: 'role-message-1', runId: 'team-1-run-requested', revision: 3, type: 'role_message.submitted', payload: {}, createdAt: 3 },
    ]);
    vi.mocked(submitTeamRunRoleMessage).mockResolvedValueOnce({ success: true, submitted: true, snapshot });

    await useTeamsStore.getState().submitTeamRoleMessageFromChat('team-1', 'leader', '  Analyze Anthropic Series B  ', 'team-1-run-requested');

    expect(submitTeamRunRoleMessage).toHaveBeenCalledWith({
      runId: 'team-1-run-requested',
      roleId: 'leader',
      text: '  Analyze Anthropic Series B  ',
      idempotencyKey: expect.stringMatching(/^team-1:role-message:team-1-run-requested:leader:message:/),
    });
    expect(useTeamsStore.getState().eventsByTeamId['team-1']?.map((event) => event.eventId)).toEqual(['role-message-1']);
    expect(useTeamsStore.getState().loadingByTeamId['team-1']).toBe(false);
  });

  it('resolves Team role chat targets from canonical role identities across run list and binding projections', () => {
    const runListLeader = teamRoleSessionBinding({ runId: 'run-from-list', roleId: 'leader', agentId: 'leader-agent' });
    const bindingAnalyst = teamRoleSessionBinding({ runId: 'run-from-bindings', roleId: 'analyst', agentId: 'analyst-agent' });
    const runFromList = buildSnapshot('running', [
      { eventId: 'run-list-event', runId: 'run-from-list', revision: 1, type: 'run:started', payload: {}, createdAt: 1 },
    ]).run!;
    const targetsByIdentityKey = buildTeamRoleChatTargetByIdentityKey({
      teams: [teamMeta({ activeRunId: 'different-active-run' })],
      runListByTeamId: {
        'team-1': [{
          ...runFromList,
          sessions: [runListLeader],
        }],
      },
      rolesByTeamId: { 'team-1': [bindingAnalyst] },
    });

    expect(resolveTeamRoleChatTarget(targetsByIdentityKey, runListLeader.sessionIdentity)).toMatchObject({
      teamId: 'team-1',
      runId: 'run-from-list',
      roleId: 'leader',
      agentId: 'leader-agent',
      localSessionId: runListLeader.localSessionId,
      endpointSessionId: `agent:leader-agent:${runListLeader.endpointSessionId}`,
      sessionIdentity: runListLeader.sessionIdentity,
    });
    expect(resolveTeamRoleChatTarget(targetsByIdentityKey, bindingAnalyst.sessionIdentity)).toMatchObject({
      teamId: 'team-1',
      runId: 'run-from-bindings',
      roleId: 'analyst',
      agentId: 'analyst-agent',
      localSessionId: bindingAnalyst.localSessionId,
      endpointSessionId: `agent:analyst-agent:${bindingAnalyst.endpointSessionId}`,
      sessionIdentity: bindingAnalyst.sessionIdentity,
    });
    expect(resolveTeamRoleChatTarget(targetsByIdentityKey, createOpenClawTestSessionIdentity('ordinary-session', 'ordinary-agent'))).toBeNull();
  });

  it('exposes Team role chat target resolution through the Teams store contract', () => {
    const runListLeader = teamRoleSessionBinding({ runId: 'run-from-list', roleId: 'leader', agentId: 'leader-agent' });
    const bindingAnalyst = teamRoleSessionBinding({ runId: 'run-from-bindings', roleId: 'analyst', agentId: 'analyst-agent' });
    const runFromList = buildSnapshot('running', [
      { eventId: 'run-list-event', runId: 'run-from-list', revision: 1, type: 'run:started', payload: {}, createdAt: 1 },
    ]).run!;
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'different-active-run' })],
      runListByTeamId: {
        'team-1': [{ ...runFromList, sessions: [runListLeader] }],
      },
      rolesByTeamId: { 'team-1': [bindingAnalyst] },
    } as never);

    expect(useTeamsStore.getState().resolveTeamRoleChatTargetBySession({ sessionIdentity: runListLeader.sessionIdentity })).toMatchObject({
      teamId: 'team-1',
      runId: 'run-from-list',
      roleId: 'leader',
      endpointSessionId: `agent:leader-agent:${runListLeader.endpointSessionId}`,
    });
    expect(useTeamsStore.getState().resolveTeamRoleChatTargetBySession({ sessionIdentity: bindingAnalyst.sessionIdentity })).toMatchObject({
      teamId: 'team-1',
      runId: 'run-from-bindings',
      roleId: 'analyst',
      endpointSessionId: `agent:analyst-agent:${bindingAnalyst.endpointSessionId}`,
    });
    expect(useTeamsStore.getState().isTeamRoleSession({ sessionIdentity: bindingAnalyst.sessionIdentity })).toBe(true);
    expect(useTeamsStore.getState().resolveTeamRoleChatTargetBySession({ sessionIdentity: createOpenClawTestSessionIdentity('ordinary-session', 'ordinary-agent') })).toBeNull();
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
      endpointSessionId: materializedSessionKey,
    });
    expect(resolveTeamRoleChatTargetFromProbe(index, { endpointSessionId: leader.endpointSessionId })).toMatchObject({
      endpointSessionId: materializedSessionKey,
    });
    expect(resolveTeamRoleChatTargetFromProbe(index, { backendSessionKey: materializedSessionKey })).toMatchObject({
      endpointSessionId: materializedSessionKey,
    });
    expect(isKnownTeamRoleSession(index, { backendSessionKey: materializedSessionKey })).toBe(true);
    expect(isKnownTeamRoleSession(index, { backendSessionKey: 'agent:leader-agent:ordinary-session' })).toBe(false);
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
      backendSessionKey: 'agent:leader-agent:main',
    })).toBe(true);
    expect(isKnownTeamRoleSession(firstIndex, {
      sessionIdentity: createOpenClawTestSessionIdentity('team-role-session-orphan-leader', 'leader-agent'),
      sessionKey: 'team-role-session-orphan-leader',
      backendSessionKey: 'agent:leader-agent:main',
    })).toBe(true);
    expect(isKnownTeamRoleSession(firstIndex, {
      sessionIdentity: createOpenClawTestSessionIdentity('agent:leader-agent:main', 'leader-agent'),
      backendSessionKey: 'agent:leader-agent:main',
    })).toBe(false);
  });

  it('stores team role message submit errors from runtime-host', async () => {
    useTeamsStore.setState({
      teams: [teamMeta()],
      runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] },
      runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined },
      runByTeamId: { 'team-1': buildSnapshot().run ?? undefined },
    });
    vi.mocked(submitTeamRunRoleMessage).mockRejectedValueOnce(new Error('Team role session runtime is unavailable'));

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

  it('refreshes the TeamRun snapshot after role message submit when the command returns no snapshot', async () => {
    useTeamsStore.setState({
      teams: [teamMeta()],
      runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] },
      runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined },
      runByTeamId: { 'team-1': buildSnapshot().run ?? undefined },
    });
    vi.mocked(submitTeamRunRoleMessage).mockResolvedValueOnce({ success: true, submitted: true });

    await useTeamsStore.getState().submitTeamRoleMessageFromChat('team-1', 'leader', 'hello');

    expect(readTeamRunSnapshot).toHaveBeenCalledWith({ runId: 'team-1-run-1.0.0-1000', eventCursor: undefined, eventLimit: 200 });
  });

  it('guards duplicate in-flight resume actions and creates a new id for the next explicit resume', async () => {
    useTeamsStore.setState({ teams: [teamMeta()], runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] }, runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined }, runByTeamId: { 'team-1': buildSnapshot().run ?? undefined } });
    let releaseFirstResume!: () => void;
    vi.mocked(resumeTeam)
      .mockReturnValueOnce(new Promise((resolve) => {
        releaseFirstResume = () => resolve({ success: true, teamId: 'team-1', restoredRunIds: [], activeRunIds: [], skippedTerminalRunIds: [] });
      }))
      .mockResolvedValueOnce({ success: true, teamId: 'team-1', restoredRunIds: [], activeRunIds: [], skippedTerminalRunIds: [] });

    const firstResume = useTeamsStore.getState().resumeRun('team-1');
    const duplicateResume = useTeamsStore.getState().resumeRun('team-1');
    releaseFirstResume();
    await Promise.all([firstResume, duplicateResume]);
    await useTeamsStore.getState().resumeRun('team-1');

    expect(resumeTeam).toHaveBeenCalledTimes(2);
    const firstIdempotencyKey = vi.mocked(resumeTeam).mock.calls[0]?.[0].idempotencyKey;
    const secondIdempotencyKey = vi.mocked(resumeTeam).mock.calls[1]?.[0].idempotencyKey;
    expect(vi.mocked(resumeTeam).mock.calls[0]?.[0].teamId).toBe('team-1');
    expect(firstIdempotencyKey).toMatch(/^team-1:resume:/);
    expect(secondIdempotencyKey).toMatch(/^team-1:resume:/);
    expect(secondIdempotencyKey).not.toBe(firstIdempotencyKey);
  });

  it('resumes the Team through the TeamRuntime team-level operation', async () => {
    useTeamsStore.setState({ teams: [teamMeta()] });

    await useTeamsStore.getState().resumeRun('team-1');

    expect(resumeTeam).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1',
      idempotencyKey: expect.stringMatching(/^team-1:resume:/),
    }));
  });

  it('selects a restored active run from team resume before refreshing snapshot', async () => {
    useTeamsStore.setState({ teams: [teamMeta({ activeRunId: undefined })] });
    vi.mocked(resumeTeam).mockResolvedValueOnce({
      success: true,
      teamId: 'team-1',
      restoredRunIds: ['run-restored'],
      activeRunIds: ['run-restored'],
      skippedTerminalRunIds: [],
    });
    vi.mocked(readTeamRunSnapshot).mockResolvedValueOnce(buildSnapshot('running', [
      { eventId: 'restored-event', runId: 'run-restored', revision: 1, type: 'run:restored', payload: {}, createdAt: 1 },
    ]));

    await useTeamsStore.getState().resumeRun('team-1');

    expect(readTeamRunSnapshot).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-restored' }));
    const state = useTeamsStore.getState();
    expect(state.teams.find((team) => team.id === 'team-1')?.activeRunId).toBe('run-restored');
    expect(state.runByTeamId['team-1']?.runId).toBe('run-restored');
  });

  it('submits decisions with waiting-context business idempotency keys', async () => {
    useTeamsStore.setState({ teams: [teamMeta()], runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] }, runsById: { 'team-1-run-1.0.0-1000': buildSnapshot('waiting_for_user').run ?? undefined }, runByTeamId: { 'team-1': buildSnapshot('waiting_for_user').run ?? undefined } });

    await useTeamsStore.getState().submitDecision('team-1', 'retry', 'Try again');

    expect(submitTeamRunDecision).toHaveBeenCalledWith({
      runId: 'team-1-run-1.0.0-1000',
      decision: 'retry',
      note: 'Try again',
      idempotencyKey: 'team-1:decision:team-1-run-1.0.0-1000:stage-1:2:retry',
    });
  });
});
