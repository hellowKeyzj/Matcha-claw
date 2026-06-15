import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openclaw/team-runtime-client', () => ({
  createTeamRun: vi.fn(),
  deleteTeamRun: vi.fn(),
  startTeamRun: vi.fn(),
  readTeamRunSnapshot: vi.fn(),
  tickTeamRun: vi.fn(),
  cancelTeamRun: vi.fn(),
  resolveTeamApproval: vi.fn(),
  submitTeamRunDecision: vi.fn(),
}));

import { useTeamsStore, type TeamMeta, type TeamSkillCandidate } from '@/stores/teams';
import {
  createTeamRun,
  deleteTeamRun,
  readTeamRunSnapshot,
  startTeamRun,
  submitTeamRunDecision,
  tickTeamRun,
  type TeamRunSnapshot,
  type TeamRunStatus,
  type TeamSkillPackage,
} from '@/services/openclaw/team-runtime-client';

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
    approvals: [],
    artifacts: [],
    dispatches: [],
    dispatchExecutions: [],
    messages: [],
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

describe('teams store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    localStorage.removeItem('teams-runtime-store');

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
    });

    vi.mocked(createTeamRun).mockResolvedValue({ runId: 'team-1-run-1.0.0-1000', status: 'created', revision: 1 });
    vi.mocked(startTeamRun).mockResolvedValue({ runId: 'team-1-run-1.0.0-1000', status: 'running', revision: 2, currentStageId: 'stage-1' });
    vi.mocked(readTeamRunSnapshot).mockResolvedValue(buildSnapshot());
    vi.mocked(deleteTeamRun).mockResolvedValue({ runId: 'team-1-run-1.0.0-1000', deleted: true });
    vi.mocked(tickTeamRun).mockResolvedValue(undefined);
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
    expect(state.teams[0]?.activeRunId).toMatch(/^team-\d+-run-1\.0\.0-\d+$/);
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
      runByTeamId: { 'team-1': buildSnapshot().run ?? undefined },
      rolesByTeamId: { 'team-1': [{ runId: 'old-run', roleId: 'leader', agentId: 'agent-1', agentName: 'Leader', workspaceDir: '/w', agentDir: '/a', skills: [], tools: [], status: 'idle' }] },
      eventCursorByTeamId: { 'team-1': 8 },
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
    expect(state.teams[0]?.activeRunId).toMatch(/^team-1-run-1\.1\.0-\d+$/);
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

  it('removes a team only after deleting its backend TeamRun', async () => {
    useTeamsStore.setState({
      teams: [teamMeta()],
      activeTeamId: 'team-1',
      runByTeamId: { 'team-1': buildSnapshot('running', [{ eventId: 'e1', runId: 'runtime-run-1', revision: 2, type: 'run:started', payload: {}, createdAt: 2 }]).run ?? undefined },
      rolesByTeamId: { 'team-1': [] },
      errorByTeamId: { 'team-1': 'previous error' },
    });
    let releaseDelete!: () => void;
    vi.mocked(deleteTeamRun).mockReturnValueOnce(new Promise((resolve) => {
      releaseDelete = () => resolve({ runId: 'runtime-run-1', deleted: true });
    }));

    const deletion = useTeamsStore.getState().deleteTeam('team-1');

    expect(deleteTeamRun).toHaveBeenCalledWith({ runId: 'runtime-run-1' });
    expect(useTeamsStore.getState().teams).toHaveLength(1);
    expect(useTeamsStore.getState().loadingByTeamId['team-1']).toBe(true);
    expect(useTeamsStore.getState().errorByTeamId['team-1']).toBeUndefined();

    releaseDelete();
    await deletion;

    const state = useTeamsStore.getState();
    expect(state.teams).toHaveLength(0);
    expect(state.activeTeamId).toBeNull();
    expect(state.runByTeamId['team-1']).toBeUndefined();
    expect(state.loadingByTeamId['team-1']).toBeUndefined();
    expect(state.errorByTeamId['team-1']).toBeUndefined();
  });

  it('keeps the team and records an error when backend TeamRun deletion fails', async () => {
    seedTeam();
    vi.mocked(deleteTeamRun).mockRejectedValueOnce(new Error('team runtime delete failed'));

    await expect(useTeamsStore.getState().deleteTeam('team-1')).rejects.toThrow('team runtime delete failed');

    const state = useTeamsStore.getState();
    expect(deleteTeamRun).toHaveBeenCalledWith({ runId: 'team-1-run-1.0.0-1000' });
    expect(state.teams).toEqual([teamMeta()]);
    expect(state.loadingByTeamId['team-1']).toBe(false);
    expect(state.errorByTeamId['team-1']).toBe('team runtime delete failed');
  });

  it('drops persisted teams with unsafe legacy run ids', async () => {
    localStorage.setItem('teams-runtime-store', JSON.stringify({
      state: {
        teams: [teamMeta({ activeRunId: 'team-1:run:1.0.0:1000' })],
        activeTeamId: 'team-1',
      },
      version: 2,
    }));

    await useTeamsStore.persist.rehydrate();

    expect(useTeamsStore.getState().teams).toEqual([]);
    expect(useTeamsStore.getState().activeTeamId).toBeNull();
  });

  it('reads snapshot before creating a missing TeamRun without starting it', async () => {
    seedTeam();
    vi.mocked(readTeamRunSnapshot)
      .mockResolvedValueOnce({ ...buildSnapshot(), run: null, stages: [], events: [], nextEventCursor: 0 })
      .mockResolvedValueOnce(buildSnapshot('created'));

    await useTeamsStore.getState().ensureRunCreated('team-1');

    expect(readTeamRunSnapshot).toHaveBeenNthCalledWith(1, {
      runId: 'team-1-run-1.0.0-1000',
      eventCursor: undefined,
      eventLimit: 200,
    });
    expect(createTeamRun).toHaveBeenCalledWith({
      packagePath: '.tmp/team-skill',
      runId: 'team-1-run-1.0.0-1000',
      idempotencyKey: 'team-1:create:team-1-run-1.0.0-1000',
    });
    expect(startTeamRun).not.toHaveBeenCalled();
    expect(useTeamsStore.getState().runByTeamId['team-1']?.status).toBe('created');
  });

  it('starts only an existing startable TeamRun from explicit start', async () => {
    seedTeam();
    vi.mocked(readTeamRunSnapshot)
      .mockResolvedValueOnce(buildSnapshot('created'))
      .mockResolvedValueOnce(buildSnapshot('running'));

    await useTeamsStore.getState().startRun('team-1');

    expect(createTeamRun).not.toHaveBeenCalled();
    expect(startTeamRun).toHaveBeenCalledWith({
      runId: 'team-1-run-1.0.0-1000',
      idempotencyKey: 'team-1:start:2',
    });
    expect(useTeamsStore.getState().runByTeamId['team-1']?.status).toBe('running');
  });

  it('does not start an existing completed TeamRun', async () => {
    seedTeam();
    vi.mocked(readTeamRunSnapshot).mockResolvedValue(buildSnapshot('completed'));

    await useTeamsStore.getState().startRun('team-1');

    expect(readTeamRunSnapshot).toHaveBeenCalledTimes(1);
    expect(createTeamRun).not.toHaveBeenCalled();
    expect(startTeamRun).not.toHaveBeenCalled();
    expect(useTeamsStore.getState().runByTeamId['team-1']?.status).toBe('completed');
  });

  it('merges incremental events instead of replacing history', async () => {
    useTeamsStore.setState({
      teams: [teamMeta()],
      runByTeamId: { 'team-1': buildSnapshot().run ?? undefined },
      eventsByTeamId: {
        'team-1': [{ eventId: 'e1', runId: 'team-1-run-1.0.0-1000', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }],
      },
      eventCursorByTeamId: { 'team-1': 1 },
    });
    vi.mocked(readTeamRunSnapshot).mockResolvedValue(buildSnapshot('running', [
      { eventId: 'e2', runId: 'team-1-run-1.0.0-1000', revision: 2, type: 'run:started', payload: {}, createdAt: 2 },
    ]));

    await useTeamsStore.getState().refreshSnapshot('team-1');

    expect(readTeamRunSnapshot).toHaveBeenCalledWith({ runId: 'team-1-run-1.0.0-1000', eventCursor: 1, eventLimit: 200 });
    expect(useTeamsStore.getState().eventsByTeamId['team-1']?.map((event) => event.eventId)).toEqual(['e1', 'e2']);
  });

  it('guards duplicate in-flight tick actions and creates a new id for the next diagnostic tick', async () => {
    useTeamsStore.setState({ teams: [teamMeta()], runByTeamId: { 'team-1': buildSnapshot().run ?? undefined } });
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

  it('submits decisions with waiting-context business idempotency keys', async () => {
    useTeamsStore.setState({ teams: [teamMeta()], runByTeamId: { 'team-1': buildSnapshot('waiting_for_user').run ?? undefined } });

    await useTeamsStore.getState().submitDecision('team-1', 'retry', 'Try again');

    expect(submitTeamRunDecision).toHaveBeenCalledWith({
      runId: 'team-1-run-1.0.0-1000',
      decision: 'retry',
      note: 'Try again',
      idempotencyKey: 'team-1:decision:stage-1:2:retry',
    });
  });
});
