import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostSecurityReadPolicyMock = vi.fn();
const hostSecurityWritePolicyMock = vi.fn();

vi.mock('@/lib/security-runtime', () => ({
  hostSecurityReadPolicy: (...args: unknown[]) => hostSecurityReadPolicyMock(...args),
  hostSecurityWritePolicy: (...args: unknown[]) => hostSecurityWritePolicyMock(...args),
}));

function buildRuntimePolicy() {
  return {
    runtimeGuardEnabled: true,
    auditOnGatewayStart: true,
    autoHarden: false,
    enablePromptInjectionGuard: true,
    blockDestructive: true,
    blockSecrets: true,
    monitors: { credentials: true, memory: true, cost: false },
    logging: { logDetections: true },
    allowPathPrefixes: [],
    allowDomains: [],
    auditEgressAllowlist: ['api.openai.com'],
    auditDailyCostLimitUsd: 5,
    auditFailureMode: null,
    promptInjectionPatterns: [],
    allowlist: { tools: ['system.run'], sessions: [] },
    destructive: {
      action: 'confirm',
      severityActions: { critical: 'block', high: 'confirm', medium: 'confirm', low: 'warn' },
      categories: {
        fileDelete: true,
        gitDestructive: true,
        sqlDestructive: true,
        systemDestructive: true,
        processKill: true,
        networkDestructive: true,
        privilegeEscalation: true,
      },
    },
    secrets: {
      action: 'block',
      severityActions: { critical: 'block', high: 'block', medium: 'redact', low: 'warn' },
    },
    destructivePatterns: [],
    secretPatterns: [],
  };
}

describe('security policy store', () => {
  beforeEach(() => {
    vi.resetModules();
    hostSecurityReadPolicyMock.mockReset();
    hostSecurityWritePolicyMock.mockReset();
  });

  it('首次无缓存时使用 initialLoading，加载成功后写入快照', async () => {
    hostSecurityReadPolicyMock.mockResolvedValue({
      preset: 'strict',
      securityPolicyVersion: 2,
      runtime: buildRuntimePolicy(),
    });
    const { useSecurityPolicyStore } = await import('@/stores/security-policy-store');

    expect(useSecurityPolicyStore.getState().policyReady).toBe(false);
    expect(useSecurityPolicyStore.getState().initialLoading).toBe(true);

    await useSecurityPolicyStore.getState().loadPolicy();

    const state = useSecurityPolicyStore.getState();
    expect(state.policyReady).toBe(true);
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.error).toBeNull();
    expect(state.policy.preset).toBe('strict');
    expect(state.savedPolicySnapshot.preset).toBe('strict');
  });

  it('有缓存时刷新失败保留旧策略，不回退空白', async () => {
    hostSecurityReadPolicyMock.mockResolvedValue({
      preset: 'balanced',
      securityPolicyVersion: 1,
      runtime: buildRuntimePolicy(),
    });
    const { useSecurityPolicyStore } = await import('@/stores/security-policy-store');
    await useSecurityPolicyStore.getState().loadPolicy();

    hostSecurityReadPolicyMock.mockRejectedValue(new Error('network down'));
    await useSecurityPolicyStore.getState().loadPolicy();

    const state = useSecurityPolicyStore.getState();
    expect(state.policyReady).toBe(true);
    expect(state.policy.preset).toBe('balanced');
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.error).toBe('network down');
  });

  it('savePolicy 走 mutating，并在成功后同步 saved snapshot', async () => {
    hostSecurityReadPolicyMock.mockResolvedValue({
      preset: 'balanced',
      securityPolicyVersion: 1,
      runtime: buildRuntimePolicy(),
    });
    hostSecurityWritePolicyMock.mockResolvedValue({ success: true });
    const { useSecurityPolicyStore } = await import('@/stores/security-policy-store');
    await useSecurityPolicyStore.getState().loadPolicy();

    useSecurityPolicyStore.getState().applyPresetTemplate('relaxed');
    await useSecurityPolicyStore.getState().savePolicy();

    const state = useSecurityPolicyStore.getState();
    expect(state.mutating).toBe(false);
    expect(state.policy.preset).toBe('relaxed');
    expect(state.savedPolicySnapshot.preset).toBe('relaxed');
    expect(hostSecurityWritePolicyMock).toHaveBeenCalledTimes(1);
  });
});
