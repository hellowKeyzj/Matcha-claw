import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: vi.fn().mockReturnValue('/tmp/matchaclaw'),
  },
}));

describe('buildGatewayLaunchPlan', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('builds a LocalProcessRuntime utility plan and forces OPENCLAW_DISABLE_BONJOUR=1', async () => {
    const { buildGatewayLaunchPlan } = await import('../../electron/main/process-runtime/openclaw-gateway/process-launcher');

    const { plan } = buildGatewayLaunchPlan({
      port: 18789,
      launchContext: {
        openclawDir: '/tmp/openclaw',
        entryScript: '/tmp/openclaw/openclaw.mjs',
        gatewayArgs: ['gateway'],
        forkEnv: {
          OPENCLAW_DISABLE_BONJOUR: '0',
          EXISTING_VAR: 'ok',
        },
        mode: 'packaged',
        binPathExists: false,
        loadedProviderKeyCount: 0,
        proxySummary: 'disabled',
        channelStartupSummary: 'enabled(unknown)',
      },
      sanitizeSpawnArgs: (args) => args,
    });

    expect(plan).toMatchObject({
      kind: 'utility',
      command: '/tmp/openclaw/openclaw.mjs',
      args: ['gateway'],
      cwd: '/tmp/openclaw',
      stdio: 'pipe',
      serviceName: 'OpenClaw Gateway',
      terminateProcessTree: true,
      port: 18789,
    });
    expect(plan.env?.EXISTING_VAR).toBe('ok');
    expect(plan.env?.OPENCLAW_DISABLE_BONJOUR).toBe('1');
  });
});
