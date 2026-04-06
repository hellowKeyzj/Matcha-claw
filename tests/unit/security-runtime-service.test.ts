import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecurityRuntimeService } from '../../runtime-host/application/security/service';

function createOpenclawBridge() {
  return {
    isGatewayRunning: vi.fn(async () => true),
    securityPolicySync: vi.fn(async () => ({ success: true })),
    securityAuditQueryFromUrl: vi.fn(async () => ({ success: true })),
    securityQuickAuditRun: vi.fn(async () => ({ success: true })),
    securityEmergencyRun: vi.fn(async () => ({ success: true })),
    securityIntegrityCheck: vi.fn(async () => ({ success: true })),
    securityIntegrityRebaseline: vi.fn(async () => ({ success: true })),
    securitySkillsScan: vi.fn(async () => ({ success: true })),
    securityAdvisoriesCheck: vi.fn(async () => ({ success: true })),
    securityRemediationPreview: vi.fn(async () => ({ success: true })),
    securityRemediationApply: vi.fn(async () => ({ success: true })),
    securityRemediationRollback: vi.fn(async () => ({ success: true })),
  };
}

describe('security service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('写入策略时仅在 gateway 运行中触发热同步', async () => {
    const openclawBridge = createOpenclawBridge();
    const service = createSecurityRuntimeService(openclawBridge);

    await service.writePolicy({ preset: 'strict', securityPolicyVersion: 5 });
    expect(openclawBridge.securityPolicySync).toHaveBeenCalledWith(
      expect.objectContaining({ preset: 'strict', securityPolicyVersion: 5 }),
    );

    openclawBridge.securityPolicySync.mockClear();
    openclawBridge.isGatewayRunning.mockResolvedValue(false);

    await service.writePolicy({ preset: 'balanced', securityPolicyVersion: 6 });
    expect(openclawBridge.securityPolicySync).not.toHaveBeenCalled();
  });

  it('同步当前策略时复用同一套 service 主链', async () => {
    const openclawBridge = createOpenclawBridge();
    const service = createSecurityRuntimeService(openclawBridge);

    const skipped = await service.syncCurrentPolicyToGatewayIfRunning();
    expect(skipped).toEqual({
      synced: true as const,
      policy: expect.any(Object),
    });
    expect(openclawBridge.securityPolicySync).toHaveBeenCalledTimes(1);

    openclawBridge.securityPolicySync.mockClear();
    openclawBridge.isGatewayRunning.mockResolvedValue(false);

    const stopped = await service.syncCurrentPolicyToGatewayIfRunning();
    expect(stopped).toEqual({ synced: false, policy: null });
    expect(openclawBridge.securityPolicySync).not.toHaveBeenCalled();
  });

  it('执行应急响应时先锁定策略，再在 gateway 运行时触发 policy sync 和 emergency rpc', async () => {
    const openclawBridge = createOpenclawBridge();
    openclawBridge.securityEmergencyRun.mockResolvedValueOnce({ backend: 'security-core', incidentId: 'incident-1' });
    const service = createSecurityRuntimeService(openclawBridge);

    const result = await service.runEmergencyResponse();

    expect(openclawBridge.securityPolicySync).toHaveBeenCalledTimes(1);
    expect(openclawBridge.securityEmergencyRun).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({
      success: true,
      lockdownApplied: true,
      emergency: expect.objectContaining({ incidentId: 'incident-1' }),
    }));
  });

  it('规则目录支持按平台过滤，并始终保留 universal 条目', () => {
    const openclawBridge = createOpenclawBridge();
    const service = createSecurityRuntimeService(openclawBridge);

    const result = service.listRuleCatalog('windows');

    expect(result.success).toBe(true);
    expect(result.total).toBeGreaterThan(0);
    expect(result.items.some((item) => item.platform === 'windows')).toBe(true);
    expect(result.items.every((item) => item.platform === 'windows' || item.platform === 'universal')).toBe(true);
  });

  it('应急响应会把策略收紧到 block_all 和全级别 block', async () => {
    const openclawBridge = createOpenclawBridge();
    const service = createSecurityRuntimeService(openclawBridge);

    const result = await service.runEmergencyResponse();
    const policy = result.policy as {
      preset: string;
      runtime: {
        auditFailureMode: string | null;
        destructive: { action: string; severityActions: Record<string, string> };
        secrets: { action: string; severityActions: Record<string, string> };
      };
    };

    expect(policy.preset).toBe('strict');
    expect(policy.runtime.auditFailureMode).toBe('block_all');
    expect(policy.runtime.destructive.action).toBe('block');
    expect(Object.values(policy.runtime.destructive.severityActions).every((value) => value === 'block')).toBe(true);
    expect(policy.runtime.secrets.action).toBe('block');
    expect(Object.values(policy.runtime.secrets.severityActions).every((value) => value === 'block')).toBe(true);
  });
});
