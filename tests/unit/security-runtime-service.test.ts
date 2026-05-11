import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecurityRuntimeService } from '../../runtime-host/application/security/service';
import { normalizeSecurityPolicyPayload } from '../../runtime-host/application/security/security-policy-normalizer';

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

function createPolicyRepository() {
  let policy = normalizeSecurityPolicyPayload({});
  return {
    async read() {
      return policy;
    },
    async write(payload: unknown) {
      policy = normalizeSecurityPolicyPayload(payload);
      return policy;
    },
    getFilePath() {
      return 'memory://security.policy.json';
    },
  };
}

function createJobSubmission(type: string, id = 'job-1') {
  return {
    success: true as const,
    job: {
      id,
      type,
      status: 'queued' as const,
      queuedAt: 1,
      attempts: 0,
      maxAttempts: 1,
    },
  };
}

function createSecurityJobs() {
  return {
    submitPolicySync: vi.fn(() => createJobSubmission('security.policySync', 'security-sync-job')),
    submitQuickAudit: vi.fn(() => createJobSubmission('security.quickAudit')),
    submitEmergencyResponse: vi.fn(() => createJobSubmission('security.emergencyResponse')),
    submitIntegrityCheck: vi.fn(() => createJobSubmission('security.integrityCheck')),
    submitIntegrityRebaseline: vi.fn(() => createJobSubmission('security.integrityRebaseline')),
    submitSkillsScan: vi.fn(() => createJobSubmission('security.skillsScan')),
    submitAdvisoriesCheck: vi.fn(() => createJobSubmission('security.advisoriesCheck')),
    submitRemediationPreview: vi.fn(() => createJobSubmission('security.remediationPreview')),
    submitRemediationApply: vi.fn(() => createJobSubmission('security.remediationApply')),
    submitRemediationRollback: vi.fn(() => createJobSubmission('security.remediationRollback')),
  };
}

describe('security service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('写入策略时只落盘并提交后台同步任务，不在请求链路触发 gateway sync', async () => {
    const openclawBridge = createOpenclawBridge();
    const jobs = createSecurityJobs();
    const service = new SecurityRuntimeService({ gateway: openclawBridge, policyRepository: createPolicyRepository(), jobs });

    const response = await service.writePolicy({ preset: 'strict', securityPolicyVersion: 5 });

    expect(response.status).toBe(202);
    expect(response.data).toEqual(expect.objectContaining({
      success: true,
      policy: expect.objectContaining({ preset: 'strict', securityPolicyVersion: 5 }),
      sync: expect.objectContaining({
        job: expect.objectContaining({ type: 'security.policySync' }),
      }),
    }));
    expect(jobs.submitPolicySync).toHaveBeenCalledTimes(1);
    expect(openclawBridge.securityPolicySync).not.toHaveBeenCalled();
  });

  it('同步当前策略时复用同一套 service 主链', async () => {
    const openclawBridge = createOpenclawBridge();
    const service = new SecurityRuntimeService({ gateway: openclawBridge, policyRepository: createPolicyRepository(), jobs: createSecurityJobs() });

    const skipped = await service.executePolicySync();
    expect(skipped).toEqual({
      synced: true as const,
      policy: expect.any(Object),
    });
    expect(openclawBridge.securityPolicySync).toHaveBeenCalledTimes(1);

    openclawBridge.securityPolicySync.mockClear();
    openclawBridge.isGatewayRunning.mockResolvedValue(false);

    const stopped = await service.executePolicySync();
    expect(stopped).toEqual({ synced: false, policy: null });
    expect(openclawBridge.securityPolicySync).not.toHaveBeenCalled();
  });

  it('应急响应请求只提交后台任务，不直接触发 policy sync 和 emergency rpc', async () => {
    const openclawBridge = createOpenclawBridge();
    const jobs = createSecurityJobs();
    const service = new SecurityRuntimeService({ gateway: openclawBridge, policyRepository: createPolicyRepository(), jobs });

    const result = await service.runEmergencyResponse();

    expect(jobs.submitEmergencyResponse).toHaveBeenCalledTimes(1);
    expect(openclawBridge.securityPolicySync).not.toHaveBeenCalled();
    expect(openclawBridge.securityEmergencyRun).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      success: true,
      job: expect.objectContaining({ type: 'security.emergencyResponse' }),
    }));
  });

  it('后台执行应急响应时先锁定策略，再在 gateway 运行时触发 policy sync 和 emergency rpc', async () => {
    const openclawBridge = createOpenclawBridge();
    openclawBridge.securityEmergencyRun.mockResolvedValueOnce({ backend: 'security-core', incidentId: 'incident-1' });
    const service = new SecurityRuntimeService({ gateway: openclawBridge, policyRepository: createPolicyRepository(), jobs: createSecurityJobs() });

    const result = await service.executeEmergencyResponse();

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
    const service = new SecurityRuntimeService({ gateway: openclawBridge, policyRepository: createPolicyRepository(), jobs: createSecurityJobs() });

    const result = service.listRuleCatalog('windows');

    expect(result.success).toBe(true);
    expect(result.total).toBeGreaterThan(0);
    expect(result.items.some((item) => item.platform === 'windows')).toBe(true);
    expect(result.items.every((item) => item.platform === 'windows' || item.platform === 'universal')).toBe(true);
  });

  it('应急响应会把策略收紧到 block_all 和全级别 block', async () => {
    const openclawBridge = createOpenclawBridge();
    const service = new SecurityRuntimeService({ gateway: openclawBridge, policyRepository: createPolicyRepository(), jobs: createSecurityJobs() });

    const result = await service.executeEmergencyResponse();
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

  it('技能扫描在注入长任务服务后提交后台任务，不直接执行 gateway scan', async () => {
    const openclawBridge = createOpenclawBridge();
    const jobs = createSecurityJobs();
    const service = new SecurityRuntimeService({ gateway: openclawBridge, policyRepository: createPolicyRepository(), jobs });

    const result = service.scanSkillsFromPayload({ scanPath: 'skills' });

    expect(jobs.submitSkillsScan).toHaveBeenCalledWith('skills');
    expect(openclawBridge.securitySkillsScan).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      job: {
        id: 'job-1',
        type: 'security.skillsScan',
        status: 'queued',
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
      },
    });
  });

  it('安全长操作统一提交后台任务，不直接执行 gateway rpc', async () => {
    const openclawBridge = createOpenclawBridge();
    const jobs = createSecurityJobs();
    const service = new SecurityRuntimeService({ gateway: openclawBridge, policyRepository: createPolicyRepository(), jobs });

    await service.runQuickAudit();
    await service.checkIntegrity();
    await service.rebaselineIntegrity();
    await service.checkAdvisories('https://example.test/feed.json');
    await service.previewRemediation();
    await service.applyRemediation(['action-1']);
    await service.rollbackRemediation('snapshot-1');

    expect(jobs.submitQuickAudit).toHaveBeenCalledTimes(1);
    expect(jobs.submitIntegrityCheck).toHaveBeenCalledTimes(1);
    expect(jobs.submitIntegrityRebaseline).toHaveBeenCalledTimes(1);
    expect(jobs.submitAdvisoriesCheck).toHaveBeenCalledWith('https://example.test/feed.json');
    expect(jobs.submitRemediationPreview).toHaveBeenCalledTimes(1);
    expect(jobs.submitRemediationApply).toHaveBeenCalledWith(['action-1']);
    expect(jobs.submitRemediationRollback).toHaveBeenCalledWith('snapshot-1');
    expect(openclawBridge.securityQuickAuditRun).not.toHaveBeenCalled();
    expect(openclawBridge.securityIntegrityCheck).not.toHaveBeenCalled();
    expect(openclawBridge.securityIntegrityRebaseline).not.toHaveBeenCalled();
    expect(openclawBridge.securityAdvisoriesCheck).not.toHaveBeenCalled();
    expect(openclawBridge.securityRemediationPreview).not.toHaveBeenCalled();
    expect(openclawBridge.securityRemediationApply).not.toHaveBeenCalled();
    expect(openclawBridge.securityRemediationRollback).not.toHaveBeenCalled();
  });
});
