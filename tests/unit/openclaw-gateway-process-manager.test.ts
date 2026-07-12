import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const runtime = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    forceTerminate: vi.fn(async () => undefined),
    checkReadiness: vi.fn(async () => ({ status: 'ready' as const })),
    getState: vi.fn(() => ({
      id: 'openclaw-gateway',
      displayName: 'OpenClaw gateway',
      lifecycle: 'running' as const,
      port: 18789,
      pid: 4321,
    })),
    onStateChange: vi.fn(() => () => undefined),
  };
  return {
    runtime,
    createLocalProcessRuntime: vi.fn(() => runtime),
    adapterConstructor: vi.fn(),
  };
});

vi.mock('../../electron/main/process-runtime/local-process-runtime', () => ({
  createLocalProcessRuntime: hoisted.createLocalProcessRuntime,
}));

vi.mock('../../electron/main/process-runtime/adapters/openclaw-gateway-process-adapter', () => ({
  OpenClawGatewayProcessAdapter: class {
    constructor(options: unknown) {
      hoisted.adapterConstructor(options);
    }
  },
}));

import { createOpenClawGatewayProcessManager } from '../../electron/main/process-runtime/openclaw-gateway-process-manager';

describe('createOpenClawGatewayProcessManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves the legacy Gateway lifecycle policy instead of using generic runtime defaults', () => {
    const gatewayManager = {
      setProcessController: vi.fn(),
    };

    createOpenClawGatewayProcessManager({
      gatewayManager: gatewayManager as never,
    });

    expect(hoisted.createLocalProcessRuntime).toHaveBeenCalledWith(expect.objectContaining({
      startTimeoutMs: 10 * 60 * 1000,
      stopTimeoutMs: 5_000,
      autoRestartBaseDelayMs: 1_000,
      autoRestartMaxDelayMs: 30_000,
      autoRestartWindowMs: Number.MAX_SAFE_INTEGER,
      autoRestartMaxAttempts: 10,
    }));
    expect(gatewayManager.setProcessController).toHaveBeenCalledTimes(1);
  });

  it('delegates quit-time emergency cleanup to the physical process owner', async () => {
    const manager = createOpenClawGatewayProcessManager({
      gatewayManager: {
        setProcessController: vi.fn(),
      } as never,
    });

    await manager.forceTerminate();

    expect(manager).not.toHaveProperty('forceTerminateOwnedProcessForQuit');
    expect(hoisted.runtime.forceTerminate).toHaveBeenCalledTimes(1);
    expect(hoisted.runtime.stop).not.toHaveBeenCalled();
  });
});
