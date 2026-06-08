import { describe, expect, it } from 'vitest';
import { SessionOperationCoordinator } from '../../runtime-host/application/sessions/session-operation-coordinator';
import { SessionOperationResultWorkflow } from '../../runtime-host/application/workflows/session-operation/session-operation-result-workflow';
import type { SessionStateSnapshot } from '../../runtime-host/shared/session-adapter-types';
import type { SessionIdentity } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';

const mainIdentity: SessionIdentity = {
  endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
  agentId: 'main',
  sessionKey: 'agent:main:main',
};

function createSnapshot(updatedAt: number): SessionStateSnapshot {
  return {
    sessionKey: 'agent:main:main',
    catalog: {
      key: 'agent:main:main',
      kind: 'main',
      agentId: 'main',
      displayName: 'Main',
      preferred: false,
      updatedAt,
      titleSource: 'none',
      sessionIdentity: mainIdentity,
    },
    items: [],
    approvals: [],
    usage: [],
    artifacts: [],
    replayComplete: true,
    runtime: {
      activeRunId: null,
      runPhase: 'idle',
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      runtimeActivity: null,
      lastUserMessageAt: null,
      lastError: null,
      lastIssue: null,
      updatedAt,
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
    const coordinator = new SessionOperationCoordinator(new SessionOperationResultWorkflow());
    const snapshot = createSnapshot(2);

    await coordinator.run(mainIdentity, 'prompt', async () => ({
      success: true,
      snapshot,
    }));

    expect(coordinator.getLatestResult(mainIdentity)).toMatchObject({
      sessionKey: 'agent:main:main',
      kind: 'prompt',
      snapshot,
    });
    expect(coordinator.getLatestResult(mainIdentity)?.operationId).toMatch(/^prompt:\d+$/);
  });

  it('records raw snapshot results from background session operations', async () => {
    const coordinator = new SessionOperationCoordinator(new SessionOperationResultWorkflow());
    const snapshot = createSnapshot(3);

    await coordinator.run(mainIdentity, 'reconcile', async () => snapshot);

    expect(coordinator.getLatestResult(mainIdentity)).toMatchObject({
      kind: 'reconcile',
      snapshot,
    });
  });

  it('isolates queues and latest results by full SessionIdentity for same sessionKey', async () => {
    const coordinator = new SessionOperationCoordinator(new SessionOperationResultWorkflow());
    const alphaIdentity = { ...mainIdentity, agentId: 'alpha', sessionKey: 'main' };
    const betaIdentity = { ...mainIdentity, agentId: 'beta', sessionKey: 'main' };
    const events: string[] = [];
    let releaseAlpha: (() => void) | null = null;

    const alpha = coordinator.run(alphaIdentity, 'prompt', async () => {
      events.push('alpha:start');
      await new Promise<void>((resolve) => {
        releaseAlpha = resolve;
      });
      events.push('alpha:end');
      return { snapshot: createSnapshot(10) };
    });
    const beta = coordinator.run(betaIdentity, 'prompt', async () => {
      events.push('beta');
      return { snapshot: createSnapshot(20) };
    });

    await beta;
    expect(events).toEqual(['alpha:start', 'beta']);
    releaseAlpha?.();
    await alpha;

    expect(coordinator.getLatestResult(alphaIdentity)?.snapshot.runtime.updatedAt).toBe(10);
    expect(coordinator.getLatestResult(betaIdentity)?.snapshot.runtime.updatedAt).toBe(20);
  });
});
