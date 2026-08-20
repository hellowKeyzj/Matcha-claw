import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeHostDeliveryIssuer,
} from '../../electron/main/runtime-host-delivery/bootstrap';
import {
  createSessionApprovalTransport,
} from '../../electron/main/runtime-host-delivery/transport/sessions/approvals';

const endpoint = {
  kind: 'native-runtime' as const,
  runtimeAdapterId: 'matcha-agent' as const,
  runtimeInstanceId: 'local' as const,
};

const listRequest = {
  id: 'session.approval' as const,
  operationId: 'sessions.approvals.list' as const,
  scope: {
    kind: 'session' as const,
    endpoint,
    sessionId: 'session-1',
  },
  target: { kind: 'session' as const },
  input: { endpoint, sessionId: 'session-1' },
};

const respondRequest = {
  id: 'session.approval' as const,
  operationId: 'sessions.approvals.respond' as const,
  scope: {
    kind: 'session' as const,
    endpoint,
    sessionId: 'session-1',
  },
  target: { kind: 'approval' as const },
  input: {
    endpoint,
    sessionId: 'session-1',
    approvalId: 'approval-1',
    optionId: 'option-1',
  },
};

describe('session approval delivery transport', () => {
  it('binds separate Matcha approval capabilities to fixed localhost endpoints', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          approvals: [{ approvalId: 'approval-1', optionIds: ['option-1'] }],
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ outcome: 'responded' }),
      });
    const transport = createSessionApprovalTransport(
      createRuntimeHostDeliveryIssuer(),
      32_021,
      fetcher,
    );

    await expect(transport.list(listRequest)).resolves.toEqual({
      status: 200,
      body: { approvals: [{ approvalId: 'approval-1', optionIds: ['option-1'] }] },
    });
    await expect(transport.respond(respondRequest)).resolves.toEqual({
      status: 200,
      body: { outcome: 'responded' },
    });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:32021/api/sessions/approvals/list',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(listRequest) }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:32021/api/sessions/approvals/respond',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(respondRequest) }),
    );
    expect(decision(fetcher.mock.calls[0]?.[1]?.headers.Authorization)).toMatchObject({
      endpoint: '/api/sessions/approvals/list',
      scope: 'sessions:write',
      capability: 'sessions.approvals.list',
      subject: 'session-approval',
    });
    expect(decision(fetcher.mock.calls[1]?.[1]?.headers.Authorization)).toMatchObject({
      endpoint: '/api/sessions/approvals/respond',
      scope: 'sessions:write',
      capability: 'sessions.approvals.respond',
      subject: 'session-approval',
    });
  });

  it('rejects legacy decisions and non-Matcha endpoints before delivery', async () => {
    const fetcher = vi.fn();
    const transport = createSessionApprovalTransport(
      createRuntimeHostDeliveryIssuer(),
      32_021,
      fetcher,
    );

    await expect(transport.respond({
      ...respondRequest,
      input: { ...respondRequest.input, decision: 'allow-once' },
    })).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Session approval is unavailable' },
    });
    await expect(transport.list({
      ...listRequest,
      scope: {
        ...listRequest.scope,
        endpoint: { ...endpoint, runtimeAdapterId: 'openclaw' },
      },
      input: {
        ...listRequest.input,
        endpoint: { ...endpoint, runtimeAdapterId: 'openclaw' },
      },
    })).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Session approval is unavailable' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('projects only the fixed unsupported delivery response', async () => {
    const transport = createSessionApprovalTransport(
      createRuntimeHostDeliveryIssuer(),
      32_021,
      vi.fn().mockResolvedValue({
        status: 422,
        json: async () => ({
          success: false,
          error: 'Session approval endpoint is unsupported',
        }),
      }),
    );

    await expect(transport.list(listRequest)).resolves.toEqual({
      status: 422,
      body: { success: false, error: 'Session approval endpoint is unsupported' },
    });
  });

  it('does not project broker terminal payloads from malformed responses', async () => {
    const transport = createSessionApprovalTransport(
      createRuntimeHostDeliveryIssuer(),
      32_021,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          outcome: 'approved',
          optionId: 'option-1',
        }),
      }),
    );

    await expect(transport.respond(respondRequest)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Session approval is unavailable' },
    });
  });
});

function decision(authorization: unknown): unknown {
  const bearer = String(authorization);
  const encoded = bearer.slice('Bearer capability-decision.v1.'.length).split('.')[0];
  return JSON.parse(Buffer.from(encoded, 'base64url').toString());
}
