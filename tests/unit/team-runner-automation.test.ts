import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openclaw/team-runtime-client', () => ({
  createTeamRun: vi.fn(),
  readTeamRunSnapshot: vi.fn(),
  tickTeamRun: vi.fn(),
  cancelTeamRun: vi.fn(),
  resolveTeamApproval: vi.fn(),
  submitTeamRunDecision: vi.fn(),
}));

import { useTeamsStore } from '@/stores/teams';
import { readTeamRunSnapshot, tickTeamRun } from '@/services/openclaw/team-runtime-client';

const snapshot = {
  run: {
    runId: 'team-1',
    packageName: 'ascendc-team',
    packageVersion: '1.0.0',
    sourcePath: '.tmp/team-skill',
    status: 'running',
    currentStageId: 'stage-1',
    revision: 3,
    createdAt: 1,
    updatedAt: 3,
  },
  roles: [],
  stages: [],
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
    counts: { roles: 0, stages: 0, approvals: 0, artifacts: 0, dispatches: 0, dispatchExecutions: 0, messages: 0, gates: 0, kickbacks: 0, decisions: 0, events: 0 },
  },
  events: [],
  nextEventCursor: 0,
};

describe('team runtime tick automation', () => {
  beforeEach(() => {
    localStorage.removeItem('teams-runtime-store');
    vi.mocked(tickTeamRun).mockReset();
    vi.mocked(readTeamRunSnapshot).mockReset();
    vi.mocked(tickTeamRun).mockResolvedValue({ action: 'dispatch_execution_queued' });
    vi.mocked(readTeamRunSnapshot).mockResolvedValue(snapshot as never);

    useTeamsStore.setState({
      teams: [{
        id: 'team-1',
        name: 'Team A',
        packagePath: '.tmp/team-skill',
        createdAt: 1,
        updatedAt: 1,
      }],
      activeTeamId: 'team-1',
      runByTeamId: { 'team-1': { ...snapshot.run, revision: 2 } },
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
  });

  it('ticks the TeamRun through runtime and refreshes the snapshot', async () => {
    await useTeamsStore.getState().tickRun('team-1');

    expect(tickTeamRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'team-1',
      idempotencyKey: expect.stringMatching(/^team-1:tick:/),
    }));
    expect(readTeamRunSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'team-1',
      eventLimit: 200,
    }));
    expect(useTeamsStore.getState().runByTeamId['team-1']?.revision).toBe(3);
  });
});
