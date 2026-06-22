import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openclaw/team-runtime-client', () => ({
  createTeamRun: vi.fn(),
  deleteTeamInstance: vi.fn(),
  deleteTeamRun: vi.fn(),
  listTeamRuns: vi.fn(),
  provisionTeamAgents: vi.fn(),
  readTeamRunSnapshot: vi.fn(),
  tickTeamRun: vi.fn(),
  resumeTeam: vi.fn(),
  cancelTeamRun: vi.fn(),
  resolveTeamApproval: vi.fn(),
  submitTeamRunDecision: vi.fn(),
}));

import { useChatStore } from '@/stores/chat';
import { buildSessionIdentityRecordIndex, buildSessionRecordKey } from '@/stores/chat/session-identity';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { useTeamsStore, type TeamMeta, type TeamSkillCandidate } from '@/stores/teams';
import {
  createTeamRun,
  deleteTeamInstance,
  deleteTeamRun,
  listTeamRuns,
  provisionTeamAgents,
  readTeamRunSnapshot,
  resumeTeam,
  submitTeamRunDecision,
  tickTeamRun,
  type TeamRunSnapshot,
  type TeamRunStatus,
  type TeamSkillPackage,
} from '@/services/openclaw/team-runtime-client';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

const basePackage: TeamSkillPackage = {
  name: 'ascendc-team',
  version: '1.0.0',
  kind: 'team-skill',
  description: 'AscendC team',
  dependencies: { skills: [], tools: [] },
  sourcePath: '.tmp/team-skill/SKILL.md',
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
    roles: [],
    stages: [{
      runId,
      stageId: 'stage-1',
      title: 'Stage 1',
      executor: 'Leader',
      status: 'running',
      attempt: 1,
      maxAttempts: 1,
      inputArtifactIds: [],
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
    mails: [],
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

function sessionRecord(sessionKey: string, agentId: string, runPhase: 'idle' | 'streaming' = 'idle') {
  const identity = createOpenClawTestSessionIdentity(sessionKey, agentId);
  const recordKey = buildSessionRecordKey(identity);
  return {
    recordKey,
    record: {
      ...createEmptySessionRecord(),
      meta: {
        ...createEmptySessionRecord().meta,
        backendSessionKey: sessionKey,
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
      workflowPlanByTeamId: {},
      dispatchGroupsByTeamId: {},
      dispatchTasksByTeamId: {},
      approvalsByTeamId: {},
      artifactsByTeamId: {},
      messagesByTeamId: {},
      mailsByTeamId: {},
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
    vi.mocked(provisionTeamAgents).mockResolvedValue({ teamId: 'team-1', managedAgentCount: 2 });
    vi.mocked(tickTeamRun).mockResolvedValue(undefined);
    vi.mocked(resumeTeam).mockResolvedValue({ success: true, teamId: 'team-1', restoredRunIds: [], activeRunIds: [], skippedTerminalRunIds: [] });
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

  it('replaces a TeamSkill version on the same team and clears old run projections', () => {
    seedTeam();
    useTeamsStore.setState({
      teams: [teamMeta()],
      runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] },
      runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined },
      runByTeamId: { 'team-1': buildSnapshot().run ?? undefined },
      rolesByTeamId: { 'team-1': [{ runId: 'old-run', roleId: 'leader', agentId: 'agent-1', agentName: 'Leader', workspaceDir: '/w', agentDir: '/a', skills: [], tools: [], status: 'idle' }] },
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
    expect(state.runIdsByTeamId['team-1']).toEqual([]);
    expect(state.runsById['team-1-run-1.0.0-1000']).toBeUndefined();
    expect(state.runByTeamId['team-1']).toBeUndefined();
    expect(state.rolesByTeamId['team-1']).toEqual([]);
    expect(state.eventCursorByTeamId['team-1']).toBeUndefined();
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
    const leader = sessionRecord('agent:leader-agent:team-role:local-run:leader', 'leader-agent', 'streaming');
    const analyst = sessionRecord('agent:analyst-agent:team-role:backend-run:analyst', 'analyst-agent');
    const otherTeamRole = sessionRecord('agent:other-agent:team-role:other-run:leader', 'other-agent');
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
    });
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
    });
    expect(createTeamRun).not.toHaveBeenCalled();
    expect(useTeamsStore.getState().teams[0]?.activeRunId).toBeUndefined();
    expect(useTeamsStore.getState().runIdsByTeamId['team-1']).toBeUndefined();
    expect(useTeamsStore.getState().runByTeamId['team-1']).toBeUndefined();
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
    });
    expect(listTeamRuns).toHaveBeenCalledWith({ teamId: 'team-1' });
    expect(readTeamRunSnapshot).toHaveBeenCalledWith({ runId, eventCursor: undefined, eventLimit: 200 });
    expect(useTeamsStore.getState().teams[0]?.activeRunId).toBe(runId);
    expect(useTeamsStore.getState().runIdsByTeamId['team-1']).toEqual([runId]);
    expect(useTeamsStore.getState().runByTeamId['team-1']?.status).toBe('created');
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
        { ...olderRun, sessions: [{ runId: 'teamrun-old', roleId: 'leader', agentId: 'agent-1', sessionKey: 'agent:agent-1:main', sessionIdentity: { endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }, agentId: 'agent-1', sessionKey: 'agent:agent-1:main' } }] },
      ],
    });

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
      mailsByTeamId: {
        'team-1': [{
          mailId: 'mail-old',
          runId: 'teamrun-missing',
          threadId: 'thread-1',
          kind: 'handoff',
          toAgentId: 'agent-2',
          subject: 'Old mail',
          relatedEntity: { kind: 'stage', id: 'stage-1' },
          status: 'pending',
          idempotencyKey: 'mail-old',
          causationId: 'event-old',
          createdAt: 1,
        }],
      },
      eventsByTeamId: { 'team-1': [{ eventId: 'old-event', runId: 'teamrun-missing', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }] },
      eventCursorByTeamId: { 'team-1': 1 },
    });
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
    expect(state.mailsByTeamId['team-1']).toEqual([]);
    expect(state.eventsByTeamId['team-1']).toEqual([]);
    expect(state.eventCursorByTeamId['team-1']).toBeUndefined();
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

  it('keeps stale snapshot responses from overwriting the current team projection', async () => {
    const oldRun = buildSnapshot('running', [{ eventId: 'old-start', runId: 'teamrun-old', revision: 1, type: 'run:started', payload: {}, createdAt: 1 }]).run!;
    const newRun = buildSnapshot('created', [{ eventId: 'new-created', runId: 'teamrun-new', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }]).run!;
    useTeamsStore.setState({
      teams: [teamMeta({ activeRunId: 'teamrun-old' })],
      runIdsByTeamId: { 'team-1': ['teamrun-old', 'teamrun-new'] },
      runsById: { 'teamrun-old': oldRun, 'teamrun-new': newRun },
      runByTeamId: { 'team-1': oldRun },
      stagesByTeamId: { 'team-1': [{ ...buildSnapshot().stages[0]!, runId: 'teamrun-old' }] },
      mailsByTeamId: { 'team-1': [] },
      eventsByRunId: { 'teamrun-old': [] },
      eventCursorByRunId: { 'teamrun-old': 0 },
    });
    let releaseSnapshot!: () => void;
    vi.mocked(readTeamRunSnapshot).mockReturnValueOnce(new Promise((resolve) => {
      releaseSnapshot = () => resolve({
        ...buildSnapshot('completed', [{ eventId: 'old-completed', runId: 'teamrun-old', revision: 2, type: 'run:completed', payload: {}, createdAt: 2 }]),
        mails: [{
          mailId: 'mail-old',
          runId: 'teamrun-old',
          threadId: 'thread-1',
          kind: 'handoff',
          toAgentId: 'agent-2',
          subject: 'Old run mail',
          relatedEntity: { kind: 'stage', id: 'stage-1' },
          status: 'delivered',
          idempotencyKey: 'mail-old',
          causationId: 'old-completed',
          createdAt: 2,
        }],
      });
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
    expect(state.mailsByTeamId['team-1']).toEqual([]);
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

  it('guards duplicate in-flight tick actions and creates a new id for the next diagnostic tick', async () => {
    useTeamsStore.setState({ teams: [teamMeta()], runIdsByTeamId: { 'team-1': ['team-1-run-1.0.0-1000'] }, runsById: { 'team-1-run-1.0.0-1000': buildSnapshot().run ?? undefined }, runByTeamId: { 'team-1': buildSnapshot().run ?? undefined } });
    let releaseFirstTick!: () => void;
    vi.mocked(tickTeamRun)
      .mockReturnValueOnce(new Promise<void>((resolve) => {
        releaseFirstTick = resolve;
      }))
      .mockResolvedValueOnce(undefined);

    const firstTick = useTeamsStore.getState().tickRun('team-1');
    const duplicateTick = useTeamsStore.getState().tickRun('team-1');
    releaseFirstTick();
    await Promise.all([firstTick, duplicateTick]);
    await useTeamsStore.getState().tickRun('team-1');

    expect(tickTeamRun).toHaveBeenCalledTimes(2);
    const firstIdempotencyKey = vi.mocked(tickTeamRun).mock.calls[0]?.[0].idempotencyKey;
    const secondIdempotencyKey = vi.mocked(tickTeamRun).mock.calls[1]?.[0].idempotencyKey;
    expect(firstIdempotencyKey).toMatch(/^team-1:tick:/);
    expect(secondIdempotencyKey).toMatch(/^team-1:tick:/);
    expect(secondIdempotencyKey).not.toBe(firstIdempotencyKey);
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
