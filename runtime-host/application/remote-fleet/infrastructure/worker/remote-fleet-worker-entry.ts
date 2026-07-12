import { parentPort, workerData } from 'node:worker_threads';
import { RemoteFleetRuntime } from '../../remote-fleet-runtime';
import { FileRemoteFleetStateStore } from '../remote-fleet-file-state-store';
import { NodeRemoteFleetRuntimeIdentity } from '../remote-fleet-node-identity';
import { SystemRemoteFleetRuntimeClock } from '../remote-fleet-system-clock';
import {
  errorFromRemoteFleetWorker,
  serializeRemoteFleetWorkerError,
} from '../../remote-fleet-worker-contracts';
import type {
  RemoteFleetHostRequest,
  RemoteFleetHostRequestWithoutId,
  RemoteFleetHostResponse,
  RemoteFleetMainToWorkerMessage,
  RemoteFleetWorkerConfig,
  RemoteFleetWorkerRequest,
  RemoteFleetWorkerResponse,
} from '../../remote-fleet-worker-contracts';

if (!parentPort) {
  throw new Error('RemoteFleet worker requires parentPort');
}

const config = workerData as RemoteFleetWorkerConfig;
let remoteFleetRuntime: RemoteFleetRuntime | null = null;
let startupError: unknown = null;
let nextHostRequestId = 0;
let acceptingInvokes = true;
let lifecycleQueue = Promise.resolve();
const pendingHostRequests = new Map<string, {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}>();

const startup = startWorkerRuntime().catch((error) => {
  startupError = error;
  parentPort!.postMessage({
    type: 'remote-fleet.result',
    requestId: 'remote-fleet-worker-startup',
    ok: false,
    error: serializeRemoteFleetWorkerError(error),
  } satisfies RemoteFleetWorkerResponse);
});

async function startWorkerRuntime(): Promise<void> {
  remoteFleetRuntime = new RemoteFleetRuntime({
    host: { request: requestHost },
    store: new FileRemoteFleetStateStore({ runtimeDataRootDir: config.runtimeDataRootDir }),
    identity: new NodeRemoteFleetRuntimeIdentity(),
    clock: new SystemRemoteFleetRuntimeClock(),
    runtimeAgentIngressUrl: config.runtimeAgentIngressUrl,
  });
}

async function handleInvoke(message: RemoteFleetWorkerRequest): Promise<void> {
  try {
    await startup;
    if (startupError) {
      throw startupError;
    }
    if (!remoteFleetRuntime) {
      throw new Error('RemoteFleet worker failed to initialize');
    }
    const response = await remoteFleetRuntime.invoke(message.operationId, message.params);
    parentPort!.postMessage({
      type: 'remote-fleet.result',
      requestId: message.requestId,
      ok: true,
      response,
    } satisfies RemoteFleetWorkerResponse);
  } catch (error) {
    parentPort!.postMessage({
      type: 'remote-fleet.result',
      requestId: message.requestId,
      ok: false,
      error: serializeRemoteFleetWorkerError(error),
    } satisfies RemoteFleetWorkerResponse);
  }
}

parentPort.on('message', (message: RemoteFleetMainToWorkerMessage) => {
  if (message.type === 'host.result') {
    resolveHostResponse(message);
    return;
  }
  if (message.type === 'remote-fleet.close') {
    acceptingInvokes = false;
    enqueueLifecycle(() => closeWorkerRuntime(message.requestId));
    return;
  }
  if (message.type === 'remote-fleet.invoke') {
    if (!acceptingInvokes) {
      respondToClosedInvoke(message);
      return;
    }
    enqueueLifecycle(() => handleInvoke(message));
  }
});

function enqueueLifecycle(task: () => Promise<void>): void {
  lifecycleQueue = lifecycleQueue.then(task, task);
}

function respondToClosedInvoke(message: RemoteFleetWorkerRequest): void {
  parentPort!.postMessage({
    type: 'remote-fleet.result',
    requestId: message.requestId,
    ok: false,
    error: serializeRemoteFleetWorkerError(new Error('RemoteFleet worker is closed')),
  } satisfies RemoteFleetWorkerResponse);
}

async function closeWorkerRuntime(requestId: string): Promise<void> {
  try {
    rejectAllHostRequests(new Error('RemoteFleet worker closed'));
    await remoteFleetRuntime?.close();
    remoteFleetRuntime = null;
    parentPort!.postMessage({
      type: 'remote-fleet.result',
      requestId,
      ok: true,
      response: { status: 200, data: { success: true } },
    } satisfies RemoteFleetWorkerResponse);
  } catch (error) {
    parentPort!.postMessage({
      type: 'remote-fleet.result',
      requestId,
      ok: false,
      error: serializeRemoteFleetWorkerError(error),
    } satisfies RemoteFleetWorkerResponse);
  }
}

async function requestHost(request: RemoteFleetHostRequestWithoutId): Promise<unknown> {
  const requestId = `remote-fleet-host-${++nextHostRequestId}`;
  return await new Promise<unknown>((resolve, reject) => {
    pendingHostRequests.set(requestId, { resolve, reject });
    try {
      parentPort!.postMessage({ ...request, requestId } satisfies RemoteFleetHostRequest);
    } catch (error) {
      pendingHostRequests.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function resolveHostResponse(message: RemoteFleetHostResponse): void {
  const pending = pendingHostRequests.get(message.requestId);
  if (!pending) {
    return;
  }
  pendingHostRequests.delete(message.requestId);
  if (message.ok) {
    pending.resolve(message.result);
    return;
  }
  pending.reject(errorFromRemoteFleetWorker(message.error));
}

function rejectAllHostRequests(error: Error): void {
  for (const pending of pendingHostRequests.values()) {
    pending.reject(error);
  }
  pendingHostRequests.clear();
}
