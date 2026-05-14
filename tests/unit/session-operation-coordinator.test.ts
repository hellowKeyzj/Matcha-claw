import { describe, expect, it } from 'vitest';
import { SessionOperationCoordinator } from '../../runtime-host/application/sessions/session-operation-coordinator';
import type { SessionStateSnapshot } from '../../runtime-host/shared/session-adapter-types';

function createSnapshot(revision: number, runEpoch: number): SessionStateSnapshot {
  return {
    sessionKey: 'agent:main:main',
    revision,
    runEpoch,
    catalog: {
      key: 'agent:main:main',
      kind: 'main',
      agentId: 'main',
      displayName: 'Main',
      preferred: false,
      updatedAt: revision,
      titleSource: 'none',
    },
    items: [],
    replayComplete: true,
    runtime: {
      revision,
      runEpoch,
      sending: false,
      activeRunId: null,
      runPhase: 'idle',
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      pendingFinal: false,
      lastUserMessageAt: null,
      lastError: null,
      lastIssue: null,
      updatedAt: revision,
    },
    window: {
      totalItemCount: 0,
      windowStartOffset: 0,
      windowEndOffset: 0,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    },
  };
}

describe('SessionOperationCoordinator', () => {
  it('records the atomic completion snapshot for the latest session operation', async () => {
    const coordinator = new SessionOperationCoordinator();
    const snapshot = createSnapshot(2, 1);

    await coordinator.run('agent:main:main', 'prompt', async () => ({
      success: true,
      snapshot,
    }));

    expect(coordinator.getLatestResult('agent:main:main')).toMatchObject({
      sessionKey: 'agent:main:main',
      kind: 'prompt',
      revision: 2,
      runEpoch: 1,
      snapshot,
    });
    expect(coordinator.getLatestResult('agent:main:main')?.operationId).toMatch(/^prompt:\d+$/);
  });

  it('records raw snapshot results from background session operations', async () => {
    const coordinator = new SessionOperationCoordinator();
    const snapshot = createSnapshot(3, 2);

    await coordinator.run('agent:main:main', 'reconcile', async () => snapshot);

    expect(coordinator.getLatestResult('agent:main:main')).toMatchObject({
      kind: 'reconcile',
      revision: 3,
      runEpoch: 2,
      snapshot,
    });
  });
});
