import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const readSecurityPolicyFromFileMock = vi.fn();
const writeSecurityPolicyToFileMock = vi.fn();
const sendJsonMock = vi.fn();
const parseJsonBodyMock = vi.fn();

vi.mock('@electron/utils/security-policy', () => ({
  readSecurityPolicyFromFile: (...args: unknown[]) => readSecurityPolicyFromFileMock(...args),
  writeSecurityPolicyToFile: (...args: unknown[]) => writeSecurityPolicyToFileMock(...args),
}));

vi.mock('@electron/api/route-utils', () => ({
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
}));

describe('handleSecurityRoutes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('GET /api/security 返回策略文件内容', async () => {
    readSecurityPolicyFromFileMock.mockReturnValueOnce({
      preset: 'balanced',
      securityPolicyVersion: 7,
      securityPolicyByAgent: { main: { defaultAction: 'confirm' } },
    });
    const { handleSecurityRoutes } = await import('@electron/api/routes/security');

    const handled = await handleSecurityRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/security'),
      {
        gatewayManager: { getStatus: () => ({ state: 'stopped' }) },
      } as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        preset: 'balanced',
        securityPolicyVersion: 7,
      }),
    );
  });

  it('PUT /api/security 写入文件并在网关运行时热同步', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      preset: 'strict',
      securityPolicyVersion: 11,
      securityPolicyByAgent: { main: { defaultAction: 'deny' } },
    });
    writeSecurityPolicyToFileMock.mockReturnValueOnce({
      preset: 'strict',
      securityPolicyVersion: 11,
      securityPolicyByAgent: { main: { defaultAction: 'deny' } },
    });
    const rpcMock = vi.fn().mockResolvedValue(undefined);
    const { handleSecurityRoutes } = await import('@electron/api/routes/security');

    const handled = await handleSecurityRoutes(
      { method: 'PUT' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/security'),
      {
        gatewayManager: {
          getStatus: () => ({ state: 'running' }),
          rpc: rpcMock,
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(writeSecurityPolicyToFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ preset: 'strict', securityPolicyVersion: 11 }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'security.policy.sync',
      expect.objectContaining({ preset: 'strict', securityPolicyVersion: 11 }),
      8000,
    );
  });

  it('GET /api/security/audit 代理 security.audit.query', async () => {
    const rpcMock = vi.fn().mockResolvedValue({
      page: 1,
      pageSize: 8,
      total: 1,
      items: [{ ts: 1, toolName: 'system.run', risk: 'high', action: 'confirm', decision: 'allow-once' }],
    });
    const { handleSecurityRoutes } = await import('@electron/api/routes/security');

    const handled = await handleSecurityRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/security/audit?page=1&pageSize=8&agentId=main'),
      {
        gatewayManager: {
          rpc: rpcMock,
          getStatus: () => ({ state: 'running' }),
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith(
      'security.audit.query',
      expect.objectContaining({ page: '1', pageSize: '8', agentId: 'main' }),
      8000,
    );
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ total: 1 }),
    );
  });

  it('POST /api/security/quick-audit 代理 security.quick_audit.run', async () => {
    const rpcMock = vi.fn().mockResolvedValue({
      backend: 'security-core',
      startupAudit: { score: 88 },
    });
    const { handleSecurityRoutes } = await import('@electron/api/routes/security');

    const handled = await handleSecurityRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/security/quick-audit'),
      {
        gatewayManager: {
          rpc: rpcMock,
          getStatus: () => ({ state: 'running' }),
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith(
      'security.quick_audit.run',
      {},
      45000,
    );
  });

  it('POST /api/security/emergency-response 先写入锁定策略并同步，再执行应急 RPC', async () => {
    readSecurityPolicyFromFileMock.mockReturnValueOnce({
      preset: 'relaxed',
      securityPolicyVersion: 3,
      runtime: {
        enabled: true,
        runtimeGuardEnabled: true,
      },
    });
    writeSecurityPolicyToFileMock.mockImplementationOnce((payload: Record<string, unknown>) => payload);
    const rpcMock = vi.fn()
      .mockResolvedValueOnce(undefined) // security.policy.sync
      .mockResolvedValueOnce({ backend: 'security-core', incidentId: 'x-1' }); // security.emergency.run
    const { handleSecurityRoutes } = await import('@electron/api/routes/security');

    const handled = await handleSecurityRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/security/emergency-response'),
      {
        gatewayManager: {
          rpc: rpcMock,
          getStatus: () => ({ state: 'running' }),
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(writeSecurityPolicyToFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: 'strict',
        runtime: expect.objectContaining({
          blockDestructive: true,
          blockSecrets: true,
        }),
      }),
    );
    expect(rpcMock).toHaveBeenNthCalledWith(
      1,
      'security.policy.sync',
      expect.objectContaining({ preset: 'strict' }),
      8000,
    );
    expect(rpcMock).toHaveBeenNthCalledWith(
      2,
      'security.emergency.run',
      {},
      45000,
    );
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        lockdownApplied: true,
        emergency: expect.objectContaining({ incidentId: 'x-1' }),
      }),
    );
  });

  it('POST /api/security/remediation/apply 代理 security.remediation.apply', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      actions: ['harden.gateway.bind.loopback', 'harden.integrity.rebaseline'],
    });
    const rpcMock = vi.fn().mockResolvedValue({
      backend: 'security-core',
      applied: ['harden.gateway.bind.loopback'],
    });
    const { handleSecurityRoutes } = await import('@electron/api/routes/security');

    const handled = await handleSecurityRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/security/remediation/apply'),
      {
        gatewayManager: {
          rpc: rpcMock,
          getStatus: () => ({ state: 'running' }),
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith(
      'security.remediation.apply',
      { actions: ['harden.gateway.bind.loopback', 'harden.integrity.rebaseline'] },
      20000,
    );
  });

  it('GET /api/security/destructive-rule-catalog 返回规则覆盖清单', async () => {
    const { handleSecurityRoutes } = await import('@electron/api/routes/security');

    const handled = await handleSecurityRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/security/destructive-rule-catalog?platform=windows'),
      {
        gatewayManager: { getStatus: () => ({ state: 'running' }) },
      } as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        total: expect.any(Number),
        items: expect.arrayContaining([
          expect.objectContaining({
            platform: 'windows',
            category: expect.any(String),
            severity: expect.any(String),
          }),
        ]),
      }),
    );
  });
});
