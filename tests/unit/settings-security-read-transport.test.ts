import { beforeEach, describe, expect, it, vi } from 'vitest';

const applyLaunchAtStartupSettingMock = vi.hoisted(() => vi.fn());

vi.mock('../../electron/main/launch-at-startup', () => ({
  applyLaunchAtStartupSetting: (...args: unknown[]) => applyLaunchAtStartupSettingMock(...args),
}));

import { createSettingsDesiredTransport } from '../../electron/main/runtime-host-delivery/products/settings/desired';
import { createSecurityPolicyTransport } from '../../electron/main/runtime-host-delivery/transport/security/policy';

describe('Settings and Security read transports', () => {
  beforeEach(() => {
    applyLaunchAtStartupSettingMock.mockReset();
    applyLaunchAtStartupSettingMock.mockResolvedValue(true);
  });

  it('applies launch-at-startup only after a confirmed Rust receipt', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ status: 200, json: async () => ({ desired: { revision: 2, outcome: 'confirmed' } }) });
    const transport = createSettingsDesiredTransport(
      { verificationKey: 'public', signDecision: () => 'signed' },
      34_107,
      fetcher,
    );
    const request = {
      id: 'settings.desired' as const,
      operationId: 'settings.replace' as const,
      scope: { kind: 'settings-desired' as const },
      target: { kind: 'settings' as const },
      input: {
        browserMode: 'native' as const,
        launchAtStartup: true,
        gatewayAutoStart: true,
        proxy: { enabled: false, server: '', bypassRules: '', credentialReference: null },
      },
    };

    await expect(transport.submit(request)).resolves.toMatchObject({ status: 200 });
    expect(applyLaunchAtStartupSettingMock).toHaveBeenCalledWith(true);
  });

  it('does not claim confirmed when Main launch projection fails', async () => {
    applyLaunchAtStartupSettingMock.mockResolvedValue(false);
    const transport = createSettingsDesiredTransport(
      { verificationKey: 'public', signDecision: () => 'signed' },
      34_107,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ desired: { revision: 2, outcome: 'confirmed' } }),
      }),
    );
    const request = {
      id: 'settings.desired' as const,
      operationId: 'settings.replace' as const,
      scope: { kind: 'settings-desired' as const },
      target: { kind: 'settings' as const },
      input: {
        browserMode: 'native' as const,
        launchAtStartup: false,
        gatewayAutoStart: true,
        proxy: { enabled: false, server: '', bypassRules: '', credentialReference: null },
      },
    };

    await expect(transport.submit(request)).resolves.toMatchObject({
      status: 503,
      body: { error: 'Settings desired projection is unavailable' },
    });
  });

  it('accepts only the exact non-secret settings snapshot', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        browserMode: 'native',
        launchAtStartup: false,
        gatewayAutoStart: true,
        proxyEnabled: false,
        proxyServer: '',
        proxyBypassRules: 'localhost',
      }),
    });
    const transport = createSettingsDesiredTransport(
      { verificationKey: 'public', signDecision: () => 'signed' },
      34_107,
      fetcher,
    );

    await expect(transport.read()).resolves.toEqual({
      browserMode: 'native',
      launchAtStartup: false,
      gatewayAutoStart: true,
      proxyEnabled: false,
      proxyServer: '',
      proxyBypassRules: 'localhost',
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34107/api/settings/current');

    for (const body of [
      {
        browserMode: 'native',
        launchAtStartup: false,
        gatewayAutoStart: true,
        proxyEnabled: false,
        proxyServer: '',
        proxyBypassRules: 'localhost',
        credentialReference: 'secret-ref',
      },
      {
        browserMode: 'native',
        launchAtStartup: false,
        gatewayAutoStart: true,
        proxyEnabled: false,
        proxyServer: 'http://user:password@proxy.example.test',
        proxyBypassRules: '',
      },
    ]) {
      const malformed = createSettingsDesiredTransport(
        { verificationKey: 'public', signDecision: () => 'signed' },
        34_107,
        vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
      );
      await expect(malformed.read()).resolves.toBeNull();
    }
  });

  it('accepts only safe audit projections and strips no native detail by forwarding it', async () => {
    const audit = {
      page: 1,
      pageSize: 8,
      total: 1,
      items: [{
        ts: 1_725_000_000_000,
        toolName: 'shell.exec',
        risk: 'high',
        action: 'block',
        decision: 'rule-match',
        ruleId: 'destructive.shell',
      }],
    };
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => audit });
    const transport = createSecurityPolicyTransport(
      { verificationKey: 'public', signDecision: () => 'signed' },
      34_137,
      fetcher,
    );

    await expect(transport.readAudit(1, 8)).resolves.toEqual(audit);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer signed' },
    });
    await expect(createSecurityPolicyTransport(
      { verificationKey: 'public', signDecision: () => 'signed' },
      34_137,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ ...audit, total: -1 }),
      }),
    ).readAudit(1, 8)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:34137/api/security/audit/current?page=1&pageSize=8',
      expect.objectContaining({
        headers: { Authorization: 'Bearer signed' },
      }),
    );

    for (const item of [
      { ...audit.items[0], detail: 'private native detail' },
      { ...audit.items[0], toolName: 'C:\\private\\token.txt' },
      { ...audit.items[0], agentId: 'agent-secret' },
    ]) {
      const malformed = createSecurityPolicyTransport(
        { verificationKey: 'public', signDecision: () => 'signed' },
        34_137,
        vi.fn().mockResolvedValue({
          status: 200,
          json: async () => ({ ...audit, items: [item] }),
        }),
      );
      await expect(malformed.readAudit(1, 8)).resolves.toBeNull();
    }
  });

  it('does not leak native transport errors', async () => {
    const transport = createSecurityPolicyTransport(
      { verificationKey: 'public', signDecision: () => 'signed' },
      34_137,
      vi.fn().mockRejectedValue(new Error('private security path')),
    );
    await expect(transport.read()).resolves.toBeNull();
    await expect(transport.readAudit(1, 20)).resolves.toBeNull();
  });

  it('signs policy and audit reads independently from the write capability', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-read');
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ status: 200, json: async () => ({
        preset: 'balanced',
        securityPolicyVersion: 1,
        runtime: {},
      }) })
      .mockResolvedValueOnce({ status: 200, json: async () => ({
        page: 1,
        pageSize: 20,
        total: 0,
        items: [],
      }) });
    const transport = createSecurityPolicyTransport(
      { verificationKey: 'public', signDecision },
      34_137,
      fetcher,
    );

    await transport.read();
    await transport.readAudit(1, 20);

    expect(signDecision).toHaveBeenNthCalledWith(1, expect.objectContaining({
      endpoint: '/api/security/policy/current',
      scope: 'security:read',
      capability: 'security.read',
      subject: 'policy-read',
    }));
    expect(signDecision).toHaveBeenNthCalledWith(2, expect.objectContaining({
      endpoint: '/api/security/audit/current',
      scope: 'security:read',
      capability: 'security.read',
      subject: 'audit-read',
    }));
    expect(signDecision).toHaveBeenCalledTimes(2);
  });
});
