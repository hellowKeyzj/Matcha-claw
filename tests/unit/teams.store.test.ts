import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openclaw/team-runtime-client', () => ({
  createTeamRun: vi.fn(),
  startTeamRun: vi.fn(),
  readTeamRunSnapshot: vi.fn(),
  tickTeamRun: vi.fn(),
  cancelTeamRun: vi.fn(),
  resolveTeamApproval: vi.fn(),
  submitTeamRunDecision: vi.fn(),
}));

import { useTeamsStore } from '@/stores/teams';
import {
  createTeamRun,
  readTeamRunSnapshot,
  startTeamRun,
  submitTeamRunDecision,
  tickTeamRun,
  type TeamRunSnapshot,
  type TeamRunStatus,
} from '@/services/openclaw/team-runtime-client';

function buildSnapshot(status: TeamRunStatus = 'running', events = [{ eventId: 'e1', runId: 'team-1', revision: 2, type: 'run:started', payload: {}, createdAt: 2 }]): TeamRunSnapshot {
  return {
    run: {
      runId: 'team-1',
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
      runId: 'team-1',
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
      runId: 'team-1',
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

function seedTeam() {
  useTeamsStore.setState({
    teams: [
      {
        id: 'team-1',
        name: 'Team A',
        leadAgentId: 'lead',
        memberIds: ['lead', 'dev'],
        packagePath: '.tmp/team-skill',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
}

describe('teams store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    vi.mocked(createTeamRun).mockResolvedValue({ runId: 'team-1', status: 'created', revision: 1 });
    vi.mocked(startTeamRun).mockResolvedValue({ runId: 'team-1', status: 'running', revision: 2, currentStageId: 'stage-1' });
    vi.mocked(readTeamRunSnapshot).mockResolvedValue(buildSnapshot());
    vi.mocked(tickTeamRun).mockResolvedValue(undefined);
    vi.mocked(submitTeamRunDecision).mockResolvedValue(undefined);
  });

  it('creates and selects team with deduplicated members and package path', () => {
    const id = useTeamsStore.getState().createTeam({
      name: 'Team A',
      leadAgentId: 'lead',
      memberIds: ['lead', 'dev', 'dev'],
      packagePath: '.tmp/team-skill',
    });

    const state = useTeamsStore.getState();
    expect(state.activeTeamId).toBe(id);
    expect(state.teams).toHaveLength(1);
    expect(state.teams[0]?.memberIds).toEqual(['lead', 'dev']);
    expect(state.teams[0]?.packagePath).toBe('.tmp/team-skill');
  });

  it('reads snapshot before creating a missing TeamRun without starting it', async () => {
    seedTeam();
    vi.mocked(readTeamRunSnapshot)
      .mockResolvedValueOnce({ ...buildSnapshot(), run: null, stages: [], events: [], nextEventCursor: 0 })
      .mockResolvedValueOnce(buildSnapshot('created'));

    await useTeamsStore.getState().ensureRunCreated('team-1');

    expect(readTeamRunSnapshot).toHaveBeenNthCalledWith(1, {
      runId: 'team-1',
      eventCursor: undefined,
      eventLimit: 200,
    });
    expect(createTeamRun).toHaveBeenCalledWith({
      packagePath: '.tmp/team-skill',
      runId: 'team-1',
      idempotencyKey: 'team-1:create',
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
      runId: 'team-1',
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
      runByTeamId: { 'team-1': buildSnapshot().run ?? undefined },
      eventsByTeamId: {
        'team-1': [{ eventId: 'e1', runId: 'team-1', revision: 1, type: 'run:created', payload: {}, createdAt: 1 }],
      },
      eventCursorByTeamId: { 'team-1': 1 },
    });
    vi.mocked(readTeamRunSnapshot).mockResolvedValue(buildSnapshot('running', [
      { eventId: 'e2', runId: 'team-1', revision: 2, type: 'run:started', payload: {}, createdAt: 2 },
    ]));

    await useTeamsStore.getState().refreshSnapshot('team-1');

    expect(readTeamRunSnapshot).toHaveBeenCalledWith({ runId: 'team-1', eventCursor: 1, eventLimit: 200 });
    expect(useTeamsStore.getState().eventsByTeamId['team-1']?.map((event) => event.eventId)).toEqual(['e1', 'e2']);
  });

  it('guards duplicate in-flight tick actions and creates a new id for the next diagnostic tick', async () => {
    useTeamsStore.setState({ runByTeamId: { 'team-1': buildSnapshot().run ?? undefined } });
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
    useTeamsStore.setState({ runByTeamId: { 'team-1': buildSnapshot('waiting_for_user').run ?? undefined } });

    await useTeamsStore.getState().submitDecision('team-1', 'retry', 'Try again');

    expect(submitTeamRunDecision).toHaveBeenCalledWith({
      runId: 'team-1',
      decision: 'retry',
      note: 'Try again',
      idempotencyKey: 'team-1:decision:stage-1:2:retry',
    });
  });
});
