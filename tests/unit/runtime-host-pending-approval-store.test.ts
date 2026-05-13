import { describe, expect, it, vi } from 'vitest';
import { PendingApprovalStore } from '../../runtime-host/application/sessions/pending-approval-store';
import { SessionCommandService } from '../../runtime-host/application/sessions/session-command-service';

const testClock = {
  nowMs: () => 1_700_000_000_000,
  nowIso: () => '2023-11-14T22:13:20.000Z',
  toIsoString: (ms: number) => new Date(ms).toISOString(),
};

describe('runtime-host pending approval store', () => {
  it('mirrors pending exec approvals from gateway requested and resolved events', () => {
    const store = new PendingApprovalStore({ clock: testClock });

    store.consumeGatewayNotification({
      method: 'exec.approval.requested',
      params: {
        id: 'approval-1',
        request: {
          sessionKey: 'agent:main:main',
          runId: 'run-1',
          toolName: 'shell',
        },
        createdAtMs: 1_700_000_000_010,
        expiresAtMs: 1_700_000_060_000,
      },
    });

    expect(store.list()).toEqual([{
      id: 'approval-1',
      sessionKey: 'agent:main:main',
      runId: 'run-1',
      toolName: 'shell',
      request: {
        sessionKey: 'agent:main:main',
        runId: 'run-1',
        toolName: 'shell',
      },
      createdAtMs: 1_700_000_000_010,
      expiresAtMs: 1_700_000_060_000,
    }]);

    store.consumeGatewayNotification({
      method: 'exec.approval.resolved',
      params: {
        id: 'approval-1',
      },
    });

    expect(store.list()).toEqual([]);
  });

  it('drops expired approvals when listing the mirror', () => {
    const store = new PendingApprovalStore({ clock: testClock });

    store.consumeGatewayNotification({
      method: 'exec.approval.requested',
      params: {
        id: 'approval-expired',
        request: { sessionKey: 'agent:main:main' },
        createdAtMs: 1_699_999_000_000,
        expiresAtMs: 1_699_999_999_999,
      },
    });

    expect(store.list()).toEqual([]);
  });
});

describe('session approval command service', () => {
  it('lists pending approvals from the local mirror without calling gateway policy RPC', async () => {
    const gatewayRpc = vi.fn();
    const service = new SessionCommandService({
      sessionCatalog: {} as never,
      sessionCatalogJobs: {
        submitRefreshCatalog: vi.fn(),
        getRefreshCatalogJob: vi.fn(() => null),
      },
      sessionStorage: {} as never,
      stateStore: {} as never,
      timelineRuntime: {} as never,
      snapshotService: {} as never,
      gateway: { gatewayRpc },
      pendingApprovals: {
        list: () => [{
          id: 'approval-1',
          sessionKey: 'agent:main:main',
          createdAtMs: 1_700_000_000_010,
        }],
      },
      clock: testClock,
      idGenerator: { randomId: () => 'id', randomHex: () => 'hex' },
      sessionHydrationJobs: {} as never,
    });

    await expect(service.listPendingApprovals()).resolves.toEqual({
      status: 200,
      data: {
        approvals: [{
          id: 'approval-1',
          sessionKey: 'agent:main:main',
          createdAtMs: 1_700_000_000_010,
        }],
      },
    });
    expect(gatewayRpc).not.toHaveBeenCalled();
  });
});
