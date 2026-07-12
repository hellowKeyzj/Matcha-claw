import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplicationServiceRegistry } from '../../runtime-host/composition/application-services';
import { RuntimeHostContainer } from '../../runtime-host/composition/container';
import { registerRemoteFleetApplicationServices } from '../../runtime-host/composition/modules/remote-fleet-application-module';
import { REMOTE_FLEET_SERVICE_TOKEN } from '../../runtime-host/composition/runtime-host-tokens';
import {
  REMOTE_FLEET_SECRET_HOST_RPC_METHOD,
  REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
  REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
  type RemoteFleetPort,
} from '../../runtime-host/application/remote-fleet';
import { RemoteFleetTerminalManager } from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-manager';
import type { RemoteFleetTerminalIssueTicketRequestInput } from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-contracts';
import type { RemoteFleetMainToWorkerMessage, RemoteFleetWorkerToMainMessage } from '../../runtime-host/application/remote-fleet/remote-fleet-worker-contracts';

type MockWorkerEventName = 'message' | 'error' | 'exit';
type MockWorkerHandler = (payload: unknown) => void;
type MockWorkerInstance = {
  readonly workerData: unknown;
  readonly messages: RemoteFleetMainToWorkerMessage[];
  postMessage(message: RemoteFleetMainToWorkerMessage): void;
  terminate(): Promise<number>;
  emitWorkerMessage(message: RemoteFleetWorkerToMainMessage): void;
};

const workerMock = vi.hoisted(() => {
  const instances: MockWorkerInstance[] = [];
  class MockWorker {
    readonly workerData: unknown;
    readonly messages: RemoteFleetMainToWorkerMessage[] = [];
    private readonly handlers = new Map<MockWorkerEventName, MockWorkerHandler[]>();

    constructor(_scriptPath: string, options: { readonly workerData?: unknown } = {}) {
      this.workerData = options.workerData;
      instances.push(this);
    }

    on(eventName: MockWorkerEventName, handler: MockWorkerHandler): this {
      this.handlers.set(eventName, [...(this.handlers.get(eventName) ?? []), handler]);
      return this;
    }

    postMessage(message: RemoteFleetMainToWorkerMessage): void {
      this.messages.push(message);
    }

    async terminate(): Promise<number> {
      this.emit('exit', 0);
      return 0;
    }

    emitWorkerMessage(message: RemoteFleetWorkerToMainMessage): void {
      this.emit('message', message);
    }

    private emit(eventName: MockWorkerEventName, payload: unknown): void {
      for (const handler of this.handlers.get(eventName) ?? []) {
        handler(payload);
      }
    }
  }
  return { instances, MockWorker };
});

vi.mock('node:worker_threads', () => ({
  default: { Worker: workerMock.MockWorker },
  Worker: workerMock.MockWorker,
}));

async function waitForWorkerMessage(worker: MockWorkerInstance, index: number): Promise<RemoteFleetMainToWorkerMessage | undefined> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (worker.messages[index]) {
      return worker.messages[index];
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return worker.messages[index];
}

function createCompositionFixture(runtimeAgentIngressUrl?: string): { readonly container: RuntimeHostContainer; readonly service: RemoteFleetPort } {
  const container = new RuntimeHostContainer();
  container.registerValue('runtimeHost.runtimeDataRoot', {
    getRuntimeDataRootDir: () => 'E:/tmp/matchaclaw-runtime-data',
  });
  container.registerValue('runtime.systemEnvironment', {
    getEnv: (name: string) => {
      if (name === 'MATCHACLAW_REMOTE_FLEET_SECRET_NODE_1_API_KEY') {
        return 'sk-env-secret';
      }
      return name === 'MATCHACLAW_REMOTE_FLEET_AGENT_INGRESS_URL' ? runtimeAgentIngressUrl ?? '' : '';
    },
  });
  container.registerValue('runtime.httpClient', {
    request: vi.fn(),
  });
  container.registerValue('runtime.commandExecutor', {
    execFile: vi.fn(),
  });
  container.registerValue('runtime.timer', {
    sleep: vi.fn(),
  });
  container.registerValue('logger', {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  container.registerValue('agentRuntime.registry', {
    replaceForRuntimeEndpointScope: vi.fn(),
    removeForRuntimeEndpointScope: vi.fn(),
  });
  const facades = createApplicationServiceRegistry();
  registerRemoteFleetApplicationServices(container, facades);
  return { container, service: facades.resolve<RemoteFleetPort>(REMOTE_FLEET_SERVICE_TOKEN) };
}

function registerCompositionService(): RemoteFleetPort {
  return createCompositionFixture().service;
}

describe('remote fleet composition secret resolver wiring', () => {
  beforeEach(() => {
    workerMock.instances.length = 0;
  });

  it('leaves the RuntimeAgent ingress URL undefined when it is not configured', () => {
    createCompositionFixture();

    expect(workerMock.instances[0]?.workerData).toEqual({
      runtimeDataRootDir: 'E:/tmp/matchaclaw-runtime-data',
      runtimeAgentIngressUrl: undefined,
    });
  });

  it('forwards an exact configured RuntimeAgent ingress URL to the worker', () => {
    const runtimeAgentIngressUrl = 'https://remote.example.test/api/remote-fleet/runtime-agent/ingress';

    createCompositionFixture(runtimeAgentIngressUrl);

    expect(workerMock.instances[0]?.workerData).toEqual({
      runtimeDataRootDir: 'E:/tmp/matchaclaw-runtime-data',
      runtimeAgentIngressUrl,
    });
  });

  it.each([
    'http://remote.example.test/api/remote-fleet/runtime-agent/ingress',
    'https://remote.example.test/api/remote-fleet/runtime-agent/ingress?token=secret-query',
    'https://remote.example.test/api/remote-fleet/runtime-agent/ingress#secret-hash',
    'https://user:secret-password@remote.example.test/api/remote-fleet/runtime-agent/ingress',
    'https://remote.example.test/api/remote-fleet/runtime-agent/wrong-path',
  ])('rejects an invalid RuntimeAgent ingress URL without leaking it: %s', (runtimeAgentIngressUrl) => {
    expect(() => createCompositionFixture(runtimeAgentIngressUrl)).toThrow('MATCHACLAW_REMOTE_FLEET_AGENT_INGRESS_URL must be a valid RuntimeAgent ingress URL.');
    expect(() => createCompositionFixture(runtimeAgentIngressUrl)).not.toThrow(runtimeAgentIngressUrl);
  });

  it('registers VM terminal provider through the SSH-like terminal provider contribution', () => {
    const { container } = createCompositionFixture();
    const manager = container.resolve<RemoteFleetTerminalManager>('remoteFleet.terminalManager');
    const input = {
      reason: 'open',
      nowIso: '2026-07-08T00:00:00.000Z',
      session: {
        id: 'terminal-session-vm-1',
        nodeId: 'vm-node-1',
        targetKind: 'vm',
        status: 'opening',
        createdAt: '2026-07-08T00:00:00.000Z',
        updatedAt: '2026-07-08T00:00:00.000Z',
      },
      node: {
        id: 'vm-node-1',
        displayName: 'VM Node 1',
        targetKind: 'vm',
        labels: [],
        enabled: true,
        publicConfig: {
          sshHost: '192.0.2.10',
          sshUsername: 'admin',
        },
        secretRefs: {
          sshPassword: { ref: 'remote-fleet://vm-node-1/ssh-password' },
        },
        health: { reason: 'unknown' },
        createdAt: '2026-07-08T00:00:00.000Z',
        updatedAt: '2026-07-08T00:00:00.000Z',
      },
    } satisfies RemoteFleetTerminalIssueTicketRequestInput;

    const result = manager.issueConnectionTicket(input);

    expect(result.resultType).toBe('issued');
    manager.dispose();
  });

  it('resolves only remote-fleet namespaced secrets through the host-only environment resolver', async () => {
    const service = registerCompositionService();
    const worker = workerMock.instances[0];
    expect(worker).toBeDefined();

    const invokePromise = service.invoke('remote-fleet.snapshot', {});
    expect(worker.messages).toEqual([
      {
        type: 'remote-fleet.invoke',
        requestId: 'remote-fleet-worker-1',
        operationId: 'remote-fleet.snapshot',
        params: {},
      },
    ]);

    worker.emitWorkerMessage({
      type: REMOTE_FLEET_SECRET_HOST_RPC_METHOD,
      requestId: 'secret-rpc-1',
      input: {
        secretRef: 'remote-fleet://node-1/api-key',
        purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
        commandExecutionId: 'command-1',
      },
    });

    expect(await waitForWorkerMessage(worker, 1)).toEqual({
      type: 'host.result',
      requestId: 'secret-rpc-1',
      ok: true,
      result: {
        type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
        requestId: 'secret-rpc-1',
        resultType: 'resolved',
        secretRef: 'remote-fleet://node-1/api-key',
        plaintextSecretValue: 'sk-env-secret',
      },
    });

    worker.emitWorkerMessage({
      type: 'remote-fleet.result',
      requestId: 'remote-fleet-worker-1',
      ok: true,
      response: { ok: true, data: { result: 'ok' } },
    });
    await expect(invokePromise).resolves.toEqual({ ok: true, data: { result: 'ok' } });
  });
});
