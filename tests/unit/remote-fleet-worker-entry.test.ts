import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteFleetPersistedState } from '../../runtime-host/application/remote-fleet/remote-fleet-store';
import type {
  RemoteFleetMainToWorkerMessage,
  RemoteFleetWorkerRequest,
  RemoteFleetWorkerResponse,
} from '../../runtime-host/application/remote-fleet/remote-fleet-worker-contracts';

const workerThreadMock = vi.hoisted(() => {
  let messageHandler: ((message: unknown) => void) | undefined;
  const postedMessages: unknown[] = [];
  const parentPort = {
    postMessage(message: unknown): void {
      postedMessages.push(message);
    },
    on(eventName: string, handler: (message: unknown) => void) {
      if (eventName === 'message') {
        messageHandler = handler;
      }
      return parentPort;
    },
  };

  return {
    parentPort,
    workerData: {
      runtimeDataRootDir: 'E:/tmp/remote-fleet-worker-entry-test',
      runtimeAgentIngressUrl: 'https://remote.example.test/api/remote-fleet/runtime-agent/ingress',
    },
    emit(message: unknown): void {
      messageHandler?.(message);
    },
    postedMessages,
    reset(): void {
      messageHandler = undefined;
      postedMessages.length = 0;
    },
  };
});

const remoteFleetRuntimeMock = vi.hoisted(() => ({
  constructorDeps: [] as unknown[],
}));

const stateStoreMock = vi.hoisted(() => {
  let firstWriteStarted: Promise<void>;
  let releaseFirstWrite: () => void;
  let signalFirstWriteStarted: () => void;
  const writes: unknown[] = [];
  let persistedState: unknown = null;

  function reset(): void {
    writes.length = 0;
    persistedState = null;
    firstWriteStarted = new Promise<void>((resolve) => {
      signalFirstWriteStarted = resolve;
    });
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    MockFileRemoteFleetStateStore.firstWriteBlocked = firstWriteBlocked;
  }

  class MockFileRemoteFleetStateStore {
    static firstWriteBlocked: Promise<void>;

    constructor(_input: { readonly runtimeDataRootDir: string }) {}

    async readState(): Promise<null> {
      return null;
    }

    async writeState(state: unknown): Promise<void> {
      const snapshot = structuredClone(state);
      writes.push(snapshot);
      if (writes.length === 1) {
        signalFirstWriteStarted();
        await MockFileRemoteFleetStateStore.firstWriteBlocked;
      }
      persistedState = snapshot;
    }
  }

  reset();
  return {
    MockFileRemoteFleetStateStore,
    reset,
    firstWriteStarted: () => firstWriteStarted,
    releaseFirstWrite: () => releaseFirstWrite(),
    writes: () => writes,
    persistedState: () => persistedState,
  };
});

vi.mock('node:worker_threads', () => ({
  default: workerThreadMock,
  parentPort: workerThreadMock.parentPort,
  workerData: workerThreadMock.workerData,
}));

vi.mock('../../runtime-host/application/remote-fleet/infrastructure/remote-fleet-file-state-store', () => ({
  FileRemoteFleetStateStore: stateStoreMock.MockFileRemoteFleetStateStore,
}));

vi.mock('../../runtime-host/application/remote-fleet/remote-fleet-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime-host/application/remote-fleet/remote-fleet-runtime')>();
  return {
    ...actual,
    RemoteFleetRuntime: class extends actual.RemoteFleetRuntime {
      constructor(deps: ConstructorParameters<typeof actual.RemoteFleetRuntime>[0]) {
        super(deps);
        remoteFleetRuntimeMock.constructorDeps.push(deps);
      }
    },
  };
});

function invokeMessage(requestId: string, nodeId: string): RemoteFleetWorkerRequest {
  return {
    type: 'remote-fleet.invoke',
    requestId,
    operationId: 'register',
    params: {
      node: {
        id: nodeId,
        displayName: nodeId,
        targetKind: 'container',
        labels: [],
        endpointUrl: `ssh://${nodeId}.example.test`,
      },
    },
  };
}

function workerResults(): RemoteFleetWorkerResponse[] {
  return workerThreadMock.postedMessages.filter((message): message is RemoteFleetWorkerResponse => (
    typeof message === 'object'
    && message !== null
    && 'type' in message
    && message.type === 'remote-fleet.result'
  ));
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('Timed out while waiting for worker entrypoint activity.');
}

function nodeIds(state: unknown): string[] {
  return (state as RemoteFleetPersistedState).nodes.map((node) => node.id);
}

async function loadWorkerEntry(): Promise<void> {
  await import('../../runtime-host/application/remote-fleet/infrastructure/worker/remote-fleet-worker-entry');
}

describe('Remote Fleet worker entry lifecycle', () => {
  beforeEach(async () => {
    vi.resetModules();
    workerThreadMock.reset();
    remoteFleetRuntimeMock.constructorDeps.length = 0;
    stateStoreMock.reset();
    await loadWorkerEntry();
  });

  it('forwards configured RuntimeAgent ingress URL to the runtime', () => {
    const runtimeAgentIngressUrl = 'https://remote.example.test/api/remote-fleet/runtime-agent/ingress';
    workerThreadMock.workerData = {
      runtimeDataRootDir: 'E:/tmp/remote-fleet-worker-entry-test',
      runtimeAgentIngressUrl,
    };

    expect(remoteFleetRuntimeMock.constructorDeps).toContainEqual(expect.objectContaining({ runtimeAgentIngressUrl }));
  });

  it('serializes concurrent invokes so the final persisted snapshot retains both updates', async () => {
    workerThreadMock.emit(invokeMessage('invoke-first', 'node-first') satisfies RemoteFleetMainToWorkerMessage);
    await stateStoreMock.firstWriteStarted();

    workerThreadMock.emit(invokeMessage('invoke-second', 'node-second') satisfies RemoteFleetMainToWorkerMessage);
    await Promise.resolve();
    await Promise.resolve();

    expect(stateStoreMock.writes()).toHaveLength(1);
    stateStoreMock.releaseFirstWrite();

    await waitFor(() => workerResults().length === 2);

    expect(stateStoreMock.writes().map(nodeIds)).toEqual([
      ['node-first'],
      ['node-first', 'node-second'],
    ]);
    expect(nodeIds(stateStoreMock.persistedState())).toEqual(['node-first', 'node-second']);
    expect(workerResults()).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: 'invoke-first', ok: true }),
      expect.objectContaining({ requestId: 'invoke-second', ok: true }),
    ]));
  });

  it('waits for queued invokes before close and rejects invokes received after close', async () => {
    workerThreadMock.emit(invokeMessage('invoke-before-close', 'node-before-close') satisfies RemoteFleetMainToWorkerMessage);
    await stateStoreMock.firstWriteStarted();

    workerThreadMock.emit({ type: 'remote-fleet.close', requestId: 'close' } satisfies RemoteFleetMainToWorkerMessage);
    workerThreadMock.emit(invokeMessage('invoke-after-close', 'node-after-close') satisfies RemoteFleetMainToWorkerMessage);
    await Promise.resolve();
    await Promise.resolve();

    expect(stateStoreMock.writes()).toHaveLength(1);
    stateStoreMock.releaseFirstWrite();

    await waitFor(() => workerResults().length === 3);

    expect(stateStoreMock.writes().map(nodeIds)).toEqual([
      ['node-before-close'],
      ['node-before-close'],
    ]);
    expect(workerResults().filter((result) => result.ok).map((result) => result.requestId)).toEqual([
      'invoke-before-close',
      'close',
    ]);
    expect(workerResults()).toContainEqual(expect.objectContaining({
      requestId: 'invoke-after-close',
      ok: false,
    }));
    expect(nodeIds(stateStoreMock.persistedState())).toEqual(['node-before-close']);
  });
});
