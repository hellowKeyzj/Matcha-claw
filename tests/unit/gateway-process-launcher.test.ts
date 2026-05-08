import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const forkMock = vi.fn();

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: vi.fn().mockReturnValue('/tmp/matchaclaw'),
  },
  utilityProcess: {
    fork: (...args: unknown[]) => forkMock(...args),
  },
}));

function createChildProcessMock() {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    stderr?: EventEmitter;
  };
  child.pid = 4242;
  child.stderr = new EventEmitter();
  return child;
}

describe('launchGatewayProcess', () => {
  beforeEach(() => {
    vi.resetModules();
    forkMock.mockReset();
  });

  it('forces OPENCLAW_DISABLE_BONJOUR=1 in gateway runtime env', async () => {
    const child = createChildProcessMock();
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    forkMock.mockImplementation((_entryScript: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = options.env;
      queueMicrotask(() => {
        child.emit('spawn');
      });
      return child;
    });

    const { launchGatewayProcess } = await import('../../electron/gateway/process-launcher');

    await launchGatewayProcess({
      port: 18789,
      launchContext: {
        appSettings: {} as never,
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
      getCurrentState: () => 'starting',
      getShouldReconnect: () => true,
      onStderrLine: vi.fn(),
      onSpawn: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    expect(capturedEnv?.EXISTING_VAR).toBe('ok');
    expect(capturedEnv?.OPENCLAW_DISABLE_BONJOUR).toBe('1');
  });
});
