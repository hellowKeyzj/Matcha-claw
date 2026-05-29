import { describe, expect, it, vi } from 'vitest';
import { createEmptyCanonicalSessionState, reduceCanonicalSessionEvents } from '../../runtime-host/application/sessions/canonical/canonical-reducer';
import { buildCanonicalApprovalEventsFromGatewayNotification } from '../../runtime-host/application/sessions/canonical/canonical-approval-events';
import { SessionCommandService } from '../../runtime-host/application/sessions/session-command-service';
import { SessionOperationCoordinator } from '../../runtime-host/application/sessions/session-operation-coordinator';

const testClock = {
  nowMs: () => 1_700_000_000_000,
  nowIso: () => '2023-11-14T22:13:20.000Z',
  toIsoString: (ms: number) => new Date(ms).toISOString(),
};

describe('runtime-host ACP approvals', () => {
  it('reduces pending exec approvals from gateway requested and resolved events', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main');

    reduceCanonicalSessionEvents(state, buildCanonicalApprovalEventsFromGatewayNotification({
      method: 'exec.approval.requested',
      params: {
        id: 'approval-1',
        request: {
          sessionKey: 'agent:main:main',
          runId: 'run-1',
          command: 'Remove-Item demo.txt',
          host: 'gateway',
          allowedDecisions: ['allow-once', 'deny'],
        },
        createdAtMs: 1_700_000_000_010,
        expiresAtMs: 1_700_000_060_000,
      },
    }, testClock.nowMs()));

    expect(state.approvals).toEqual([{
      id: 'approval-1',
      sessionKey: 'agent:main:main',
      runId: 'run-1',
      title: 'gateway',
      command: 'Remove-Item demo.txt',
      allowedDecisions: ['allow-once', 'deny'],
      request: {
        sessionKey: 'agent:main:main',
        runId: 'run-1',
        command: 'Remove-Item demo.txt',
        host: 'gateway',
        allowedDecisions: ['allow-once', 'deny'],
      },
      createdAtMs: 1_700_000_000_010,
      expiresAtMs: 1_700_000_060_000,
    }]);

    reduceCanonicalSessionEvents(state, buildCanonicalApprovalEventsFromGatewayNotification({
      method: 'exec.approval.resolved',
      params: {
        id: 'approval-1',
        sessionKey: 'agent:main:main',
      },
    }, testClock.nowMs()));

    expect(state.approvals).toEqual([]);
  });

  it('drops expired approvals while reducing pending approval events', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main');

    reduceCanonicalSessionEvents(state, buildCanonicalApprovalEventsFromGatewayNotification({
      method: 'exec.approval.requested',
      params: {
        id: 'approval-expired',
        request: { sessionKey: 'agent:main:main' },
        createdAtMs: 1_699_999_000_000,
        expiresAtMs: 1_699_999_999_999,
      },
    }, testClock.nowMs()));

    expect(state.approvals).toEqual([]);
  });

  it('reduces plugin approvals with nested data payloads', () => {
    const state = createEmptyCanonicalSessionState('agent:plugin:main');

    reduceCanonicalSessionEvents(state, buildCanonicalApprovalEventsFromGatewayNotification({
      method: 'plugin.approval.requested',
      params: {
        data: {
          id: 'approval-plugin-1',
          request: {
            sessionKey: 'agent:plugin:main',
            runId: 'run-plugin-1',
            commandArgv: ['tool:example'],
            host: 'plugin-host',
            allowedDecisions: ['allow-once', 'deny'],
          },
        },
      },
    }, testClock.nowMs()));

    expect(state.approvals).toMatchObject([{
      id: 'approval-plugin-1',
      sessionKey: 'agent:plugin:main',
      runId: 'run-plugin-1',
      title: 'plugin-host',
      command: 'tool:example',
      allowedDecisions: ['allow-once', 'deny'],
    }]);

    reduceCanonicalSessionEvents(state, buildCanonicalApprovalEventsFromGatewayNotification({
      method: 'plugin.approval.resolved',
      params: {
        data: {
          id: 'approval-plugin-1',
          sessionKey: 'agent:plugin:main',
        },
      },
    }, testClock.nowMs()));

    expect(state.approvals).toEqual([]);
  });
});

describe('session approval command service', () => {
  it('lists pending approvals from ACP session states without calling gateway policy RPC', async () => {
    const gatewayRpc = vi.fn();
    const canonical = createEmptyCanonicalSessionState('agent:main:main');
    canonical.approvals = [{
      id: 'approval-1',
      sessionKey: 'agent:main:main',
      title: 'gateway',
      allowedDecisions: ['allow-once', 'deny'],
      createdAtMs: 1_700_000_000_010,
    }];
    const service = new SessionCommandService({
      sessionCatalog: {} as never,
      sessionCatalogJobs: {
        submitRefreshCatalog: vi.fn(),
        getRefreshCatalogJob: vi.fn(() => null),
      },
      sessionStorage: {} as never,
      stateStore: {
        listSessionStates: () => [['agent:main:main', { canonical }]],
      } as never,
      timelineRuntime: {} as never,
      snapshotService: {} as never,
      gateway: { gatewayRpc },
      operationCoordinator: new SessionOperationCoordinator(),
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
          title: 'gateway',
          allowedDecisions: ['allow-once', 'deny'],
          createdAtMs: 1_700_000_000_010,
        }],
      },
    });
    expect(gatewayRpc).not.toHaveBeenCalled();
  });
});
