import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleSecurityRoutes } from '../../electron/api/routes/security';
import {
  createSecurityPolicyTransport,
  type SecurityOperationRequest,
} from '../../electron/main/runtime-host-delivery/transport/security/policy';

function request(body: unknown, method = 'POST') {
  return Object.assign(Readable.from(method === 'GET' ? [] : [JSON.stringify(body)]), {
    method,
    headers: { 'content-type': 'application/json' },
  });
}

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

function operation(
  operationId: SecurityOperationRequest['operationId'],
  input: Record<string, unknown> = {},
  target: SecurityOperationRequest['target'] = {
    kind: operationId === 'security.previewRemediation'
      || operationId === 'security.applyRemediation'
      || operationId === 'security.rollbackRemediation'
      ? 'security-remediation'
      : 'security-policy',
  },
): SecurityOperationRequest {
  const kind = target.kind;
  return {
    id: 'security.operation',
    operationId,
    scope: { kind },
    target,
    input,
  };
}

const operations: readonly SecurityOperationRequest[] = [
  operation('security.quickAudit'),
  operation('security.checkIntegrity'),
  operation('security.rebaselineIntegrity'),
  operation('security.scanSkills', { scanPath: 'C:\\scan' }),
  operation('security.checkAdvisories', { feedUrl: 'https://feed.example' }),
  operation('security.previewRemediation'),
  operation('security.applyRemediation', { actions: ['action-a', 'action-b'] }),
  operation(
    'security.rollbackRemediation',
    { snapshotId: 'snapshot-1' },
    { kind: 'security-remediation', snapshotId: 'snapshot-1' },
  ),
];

function routeTransport(operate: ReturnType<typeof vi.fn>) {
  return {
    read: vi.fn(),
    readAudit: vi.fn(),
    submit: vi.fn(),
    operate,
  };
}

function catalogTransport() {
  return { read: vi.fn() };
}

function boundedResponse(operationId: SecurityOperationRequest['operationId']): Record<string, unknown> {
  switch (operationId) {
    case 'security.quickAudit':
      return {
        backend: 'security-core',
        startupAudit: { ok: true, checks: 0, issues: 0 },
        integrity: { checked: 0, tampered: 0, missing: 0, noBaseline: 0, items: [] },
        skillScan: { total: 0, suspicious: 0, clean: 0, skills: [] },
        advisories: { reachable: true, advisories: [], criticalOrHigh: [] },
      };
    case 'security.checkIntegrity':
      return { backend: 'security-core', checked: 0, tampered: 0, missing: 0, noBaseline: 0, items: [] };
    case 'security.rebaselineIntegrity':
      return { backend: 'security-core', created: 0, files: [] };
    case 'security.scanSkills':
      return { backend: 'security-core', total: 0, suspicious: 0, clean: 0, skills: [] };
    case 'security.checkAdvisories':
      return { backend: 'security-core', reachable: true, advisories: [], criticalOrHigh: [] };
    case 'security.previewRemediation':
      return { backend: 'security-core', actions: [] };
    case 'security.applyRemediation':
      return { backend: 'security-core', actions: [], snapshotId: 'snapshot-1', applied: true };
    case 'security.rollbackRemediation':
      return { backend: 'security-core', snapshotId: 'snapshot-1', restored: 0 };
  }
}

describe('Security operation Host API route and Main transport', () => {
  it('accepts all fixed operation envelopes and returns the bounded backend body directly', async () => {
    const operate = vi.fn(async (body: SecurityOperationRequest) => ({
      status: 200 as const,
      body: boundedResponse(body.operationId),
    }));
    const transport = routeTransport(operate);

    for (const body of operations) {
      const result = response();
      await expect(handleSecurityRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/security/operation'),
        transport as never,
        catalogTransport() as never,
      )).resolves.toBe(true);

      expect(result.state).toEqual({
        statusCode: 200,
        body: boundedResponse(body.operationId),
      });
    }

    expect(operate).toHaveBeenCalledTimes(operations.length);
    expect(operate.mock.calls.map(([body]) => body)).toEqual(operations);
    for (const [body] of operate.mock.calls) {
      expect(Object.keys(body)).toEqual(['id', 'operationId', 'scope', 'target', 'input']);
    }
  });

  it.each([
    [422, { success: false, error: 'Security operation was rejected' }],
    [503, { success: false, error: 'Security operation is unavailable' }],
  ] as const)('preserves operation rejection/unavailability status %s without exposing backend details', async (status, body) => {
    const operate = vi.fn().mockResolvedValue({ status, body });
    const result = response();
    const transport = routeTransport(operate);

    await handleSecurityRoutes(
      request(operations[0]) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/security/operation'),
      transport as never,
      catalogTransport() as never,
    );

    expect(result.state).toEqual({ statusCode: status, body });
  });

  it('rejects unknown or extra operation request fields before invoking the backend', async () => {
    const operate = vi.fn();
    const result = response();
    const invalid = { ...operations[0], operationId: 'security.unknown', extra: true };
    const transport = routeTransport(operate);

    await handleSecurityRoutes(
      request(invalid) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/security/operation'),
      transport as never,
      catalogTransport() as never,
    );

    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Security operation request is invalid' },
    });
    expect(operate).not.toHaveBeenCalled();
  });

  it.each(operations)('signs %s with the fixed operation delivery claims and forwards the exact envelope', async (body) => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 503,
      json: async () => ({ success: false, error: 'private native failure' }),
    });
    const transport = createSecurityPolicyTransport(
      { verificationKey: 'public', signDecision },
      34_107,
      fetcher,
    );

    await expect(transport.operate(body)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Security operation is unavailable' },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/security/operation',
      scope: 'security:operate',
      capability: body.operationId,
      subject: 'security-operation',
    }));
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:34107/api/security/operation',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer signed-decision',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
  });

  it('returns direct bounded results, stable rejection, and stable unavailable responses', async () => {
    const issuer = { verificationKey: 'public', signDecision: () => 'signed-decision' };
    const accepted = createSecurityPolicyTransport(
      issuer,
      34_107,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => boundedResponse('security.quickAudit'),
      }),
    );
    const rejected = createSecurityPolicyTransport(
      issuer,
      34_107,
      vi.fn().mockResolvedValue({
        status: 422,
        json: async () => ({ success: false, error: 'Security operation was rejected' }),
      }),
    );
    const unavailable = createSecurityPolicyTransport(
      issuer,
      34_107,
      vi.fn().mockResolvedValue({
        status: 500,
        json: async () => ({ success: false, error: 'private native failure' }),
      }),
    );
    const priorUnknownShape = createSecurityPolicyTransport(
      issuer,
      34_107,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ outcome: 'outcome_unknown' }),
      }),
    );

    await expect(accepted.operate(operations[0])).resolves.toEqual({
      status: 200,
      body: boundedResponse('security.quickAudit'),
    });
    await expect(rejected.operate(operations[0])).resolves.toEqual({
      status: 422,
      body: { success: false, error: 'Security operation was rejected' },
    });
    await expect(unavailable.operate(operations[0])).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Security operation is unavailable' },
    });
    await expect(priorUnknownShape.operate(operations[0])).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Security operation is unavailable' },
    });
  });
});
