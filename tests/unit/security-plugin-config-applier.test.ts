import { describe, expect, it, vi } from 'vitest';
import { SecurityPluginConfigApplier, type SecurityPluginConfigProjectionPort } from '../../runtime-host/application/security/security-plugin-config-applier';
import { normalizeSecurityPolicyPayload } from '../../runtime-host/application/security/security-policy-normalizer';

describe('security plugin config applier', () => {
  it('Gateway 启动前把保存的安全策略写入 security-core 插件 config', async () => {
    let appliedRuntimePolicy: Record<string, unknown> | null = null;
    const pluginConfig: SecurityPluginConfigProjectionPort = {
      async applyPolicy(policy) {
        appliedRuntimePolicy = policy.runtime;
      },
    };
    const policyRepository = {
      read: vi.fn(async () => normalizeSecurityPolicyPayload({
        preset: 'relaxed',
        securityPolicyVersion: 9,
        runtime: {
          runtimeGuardEnabled: false,
          enablePromptInjectionGuard: false,
          blockDestructive: false,
          blockSecrets: false,
        },
      })),
    };

    await new SecurityPluginConfigApplier(pluginConfig, policyRepository).applySavedPolicyToPluginConfig();

    expect(appliedRuntimePolicy).toMatchObject({
      runtimeGuardEnabled: false,
      enablePromptInjectionGuard: false,
      blockDestructive: false,
      blockSecrets: false,
    });
  });
});
