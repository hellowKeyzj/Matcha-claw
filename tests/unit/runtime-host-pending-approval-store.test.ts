import { describe, expect, it, vi } from 'vitest';
import { createEmptyCanonicalSessionState, reduceCanonicalSessionEvents } from '../../runtime-host/application/sessions/canonical/canonical-reducer';
import { buildCanonicalApprovalEventsFromGatewayNotification } from '../../runtime-host/application/sessions/canonical/canonical-approval-events';
import { OpenClawApprovalAdapter } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-approval-adapter';
import { SessionCommandService } from '../../runtime-host/application/sessions/session-command-service';
import { SessionCommandOperationsWorkflow } from '../../runtime-host/application/workflows/session-command/session-command-operations-workflow';
import { SessionOperationCoordinator } from '../../runtime-host/application/sessions/session-operation-coordinator';
import { createOpenClawTestSessionIdentity, createOpenClawTestRuntimeContext } from './helpers/runtime-address-fixtures';

const testClock = {
  nowMs: () => 1_700_000_000_000,
  nowIso: () => '2023-11-14T22:13:20.000Z',
  toIsoString: (ms: number) => new Date(ms).toISOString(),
};

const openClawApprovalIdentity = {
  protocolId: 'openclaw-v4',
  runtimeEndpointId: 'openclaw-local',
};

describe('runtime-host ACP approvals', () => {
  it('normalizes OpenClaw approval payloads before building canonical events', () => {
    const adapter = new OpenClawApprovalAdapter();
    const events = adapter.translateNotification({
      method: 'exec.approval.requested',
      params: {
        data: {
          id: 'approval-openclaw-1',
          runId: 'run-approval',
          request: {
            sessionKey: 'agent:main:main',
            commandArgv: ['pnpm', 'test'],
            host: 'gateway',
            allowedDecisions: ['allow-once', 'deny'],
          },
        },
      },
    }, testClock.nowMs());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'approval',
      sessionId: 'agent:main:main',
      runId: 'run-approval',
      approvalId: 'approval-openclaw-1',
      title: 'gateway',
      command: 'pnpm test',
      allowedDecisions: ['allow-once', 'deny'],
    });
  });
  it('reduces pending exec approvals from gateway requested and resolved events', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));

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
    }, testClock.nowMs(), openClawApprovalIdentity));

    expect(state.approvals).toEqual([{
      id: 'approval-1',
      sessionKey: 'agent:main:main',
      sessionIdentity: createOpenClawTestSessionIdentity('agent:main:main'),
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
    }, testClock.nowMs(), openClawApprovalIdentity));

    expect(state.approvals).toEqual([]);
  });

  it('drops expired approvals while reducing pending approval events', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));

    reduceCanonicalSessionEvents(state, buildCanonicalApprovalEventsFromGatewayNotification({
      method: 'exec.approval.requested',
      params: {
        id: 'approval-expired',
        request: { sessionKey: 'agent:main:main' },
        createdAtMs: 1_699_999_000_000,
        expiresAtMs: 1_699_999_999_999,
      },
    }, testClock.nowMs(), openClawApprovalIdentity));

    expect(state.approvals).toEqual([]);
  });

  it('reduces plugin approvals with nested data payloads', () => {
    const state = createEmptyCanonicalSessionState('agent:plugin:main', createOpenClawTestRuntimeContext('agent:plugin:main'));

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
    }, testClock.nowMs(), openClawApprovalIdentity));

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
    }, testClock.nowMs(), openClawApprovalIdentity));

    expect(state.approvals).toEqual([]);
  });
});

describe('session approval command service', () => {
  it('lists pending approvals through the SessionIdentity approval index', async () => {
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:main:main');
    const canonical = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
    canonical.approvals = [{
      id: 'approval-1',
      sessionKey: 'agent:main:main',
      sessionIdentity,
      title: 'gateway',
      allowedDecisions: ['allow-once', 'deny'],
      createdAtMs: 1_700_000_000_010,
    }];
    const listSessionStates = vi.fn(() => [['agent:main:main', { canonical }]]);
    const listApprovals = vi.fn(() => [{ sessionKey: 'agent:main:main', approval: canonical.approvals[0] }]);
    const service = new SessionCommandService({
      operationsWorkflow: new SessionCommandOperationsWorkflow({
        stateStore: {
          listSessionStates,
          listApprovals,
        } as never,
        sessionLifecycleWorkflow: {} as never,
        sessionHydrationWorkflow: {} as never,
        sessionApprovalWorkflow: {} as never,
        sessionModelSelectionWorkflow: {} as never,
      }),
    });

    await expect(service.listPendingApprovals({ sessionIdentity })).resolves.toEqual({
      status: 200,
      data: {
        approvals: [{
          id: 'approval-1',
          sessionKey: 'agent:main:main',
          sessionIdentity,
          title: 'gateway',
          allowedDecisions: ['allow-once', 'deny'],
          createdAtMs: 1_700_000_000_010,
        }],
      },
    });
    expect(listApprovals).toHaveBeenCalledWith(sessionIdentity);
    expect(listSessionStates).not.toHaveBeenCalled();
  });
});
