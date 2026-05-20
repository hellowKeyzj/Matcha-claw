import { describe, expect, it, vi } from 'vitest';
import { SecurityPluginConfigApplier } from '../../runtime-host/application/security/security-plugin-config-applier';
import { normalizeSecurityPolicyPayload } from '../../runtime-host/application/security/security-policy-normalizer';

describe('security plugin config applier', () => {
  it('Gateway 启动前把保存的安全策略写入 security-core 插件 config', async () => {
    let openclawConfig: Record<string, unknown> = {
      plugins: {
        entries: {
          'security-core': {
            enabled: true,
            config: {
              customField: 'keep',
              runtimeGuardEnabled: true,
            },
          },
        },
      },
    };
    const configRepository = {
      async read() {
        return openclawConfig;
      },
      async write(nextConfig: Record<string, unknown>) {
        openclawConfig = nextConfig;
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

    await new SecurityPluginConfigApplier(configRepository as never, policyRepository).applySavedPolicyToPluginConfig();

    expect(openclawConfig).toMatchObject({
      plugins: {
        entries: {
          'security-core': {
            enabled: true,
            config: {
              customField: 'keep',
              runtimeGuardEnabled: false,
              enablePromptInjectionGuard: false,
              blockDestructive: false,
              blockSecrets: false,
            },
          },
        },
      },
    });
  });
});
