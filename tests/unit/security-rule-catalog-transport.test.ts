import { describe, expect, it, vi } from 'vitest';

import { createSecurityRuleCatalogTransport } from '../../electron/main/runtime-host-delivery/transport/security/rule-catalog';

const issuer = {
  verificationKey: 'public-key',
  signDecision: vi.fn(() => 'signed-token'),
};

const catalog = {
  success: true,
  total: 3,
  items: [
    {
      platform: 'universal',
      command: 'rm -rf <系统路径>',
      category: 'file_delete',
      severity: 'critical',
      reason: '递归强删目录树',
    },
    {
      platform: 'windows',
      command: 'rmdir /s /q C:\\temp\\demo',
      category: 'file_delete',
      severity: 'critical',
      reason: '递归删除目录树',
    },
    {
      platform: 'windows',
      command: 'taskkill /f /pid 1234',
      category: 'process_kill',
      severity: 'high',
      reason: '终止进程（/f 提升风险）',
    },
  ],
} as const;

describe('security rule catalog transport', () => {
  it('reads the fixed native path and optional platform query', async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => catalog });
    const transport = createSecurityRuleCatalogTransport(issuer, 3227, fetcher);

    await expect(transport.read('windows')).resolves.toEqual({ status: 200, body: catalog });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:3227/api/security/destructive-rule-catalog/current?platform=windows',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer signed-token' }),
        method: 'GET',
      }),
    );
    expect(issuer.signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/security/destructive-rule-catalog/current',
      scope: 'security:read',
      capability: 'security.rule-catalog.read',
      subject: 'security-rule-catalog',
    }));
  });

  it('reads the unfiltered catalog without fabricating query parameters', async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => catalog });
    const transport = createSecurityRuleCatalogTransport(issuer, 3227, fetcher);

    await expect(transport.read()).resolves.toEqual({ status: 200, body: catalog });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:3227/api/security/destructive-rule-catalog/current',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('rejects native details and unknown fields at the Main boundary', async () => {
    const body = {
      success: true,
      total: 1,
      items: [{
        platform: 'windows',
        command: 'rmdir /s /q C:\\temp\\demo',
        category: 'file_delete',
        severity: 'critical',
        reason: '递归删除目录树',
        nativeDetail: 'opaque',
        path: 'C:\\private',
        evidence: 'private evidence',
        secret: 'private secret',
      }],
      revision: 7,
    };
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => body });
    const transport = createSecurityRuleCatalogTransport(issuer, 3227, fetcher);

    await expect(transport.read('PowerShell')).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Security rule catalog is unavailable' },
    });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:3227/api/security/destructive-rule-catalog/current?platform=PowerShell',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('rejects unbounded or unsafe public catalog values', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        success: true,
        total: 1,
        items: [{
          platform: 'windows',
          command: `unsafe${'x'.repeat(4096)}`,
          category: 'file_delete',
          severity: 'critical',
          reason: 'line\nbreak',
        }],
      }),
    });
    const transport = createSecurityRuleCatalogTransport(issuer, 3227, fetcher);

    await expect(transport.read()).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Security rule catalog is unavailable' },
    });
  });

  it('redacts native failures and non-success responses', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('private native path'))
      .mockResolvedValueOnce({ status: 500, json: async () => ({ error: 'private detail' }) });
    const transport = createSecurityRuleCatalogTransport(issuer, 3227, fetcher);

    await expect(transport.read()).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Security rule catalog is unavailable' },
    });
    await expect(transport.read('linux')).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Security rule catalog is unavailable' },
    });
  });
});
