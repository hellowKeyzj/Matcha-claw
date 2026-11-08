import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { NetworkConfiguration, NetworkErrorCode, NetworkRequest, NetworkSnapshot } from '../../../src/types/desktop/network-access';
import { createEasyTierProvider } from './easytier';
import type { NetworkConnection, NetworkInvitation, NetworkProvider, ReceiveNetworkRequest } from './provider';
import { decryptSecret, encryptSecret, initialState, isConfiguration, isNetworkInvitation, keys, loadState, record, saveState, validSecret, type NetworkState } from './storage';

const MAX_PENDING_OPERATIONS = 64;
type NetworkFailure = { success: false; error: NetworkErrorCode };

export async function createNetworkAccess(input: {
  root: string;
  receive: ReceiveNetworkRequest;
  getHostName: () => Promise<string>;
  providers?: readonly NetworkProvider[];
  bootstrapPeers?: readonly string[];
}) {
  const providers = input.providers ?? [createEasyTierProvider()];
  let state: NetworkState;
  let storageAvailable = true;
  let phase: NetworkSnapshot['phase'] = 'stopped';
  let error: NetworkErrorCode | null = null;
  try { state = await loadState(input.root); }
  catch { state = initialState(); storageAvailable = false; phase = 'failed'; error = 'storage-unavailable'; }
  let connection: NetworkConnection | undefined;
  let runningHostName: string | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let reading: Promise<NetworkSnapshot> | undefined;
  let pendingOperations = 0;
  let operations = Promise.resolve();
  // Public admission is bounded; exit notifications and close must always drain.
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    // A later read must not reuse a snapshot from before this control operation.
    reading = undefined;
    pendingOperations++;
    const pending = operations.then(operation).finally(() => { pendingOperations--; });
    operations = pending.then(() => {}, () => {});
    return pending;
  };
  const failure = (code: NetworkErrorCode) => ({ success: false as const, error: code });
  const snapshot = async (): Promise<NetworkSnapshot> => {
    if (closed) throw new Error('unavailable');
    let runtime: NetworkSnapshot['runtime'] = null;
    if (connection && phase === 'running') {
      try { runtime = await connection.read(); if (error === 'unavailable') error = null; }
      catch { error = 'unavailable'; }
    }
    const result: NetworkSnapshot = {
      revision: state.revision,
      providers: await Promise.all(providers.map(async (provider) => ({ id: provider.id, name: provider.name, available: await provider.available().catch(() => false) }))),
      config: structuredClone(state.config), hasSecret: state.encryptedSecret !== null, phase,
      error: error ?? providers.find((provider) => provider.id === state.config.providerId)?.unavailableReason ?? null,
      runtime,
    };
    if (closed) throw new Error('unavailable');
    return result;
  };
  const stop = async (): Promise<boolean> => {
    try {
      if (connection) { await connection.close(); connection = undefined; }
      await providers.find((provider) => provider.id === state.config.providerId)?.close();
      runningHostName = undefined;
      phase = storageAvailable ? 'stopped' : 'failed';
      error = storageAvailable ? null : 'storage-unavailable';
      return true;
    } catch { phase = 'failed'; error = 'stop-failed'; return false; }
  };
  const start = async (hostName?: string): Promise<NetworkErrorCode | null> => {
    if (closed) return 'unavailable';
    if (!storageAvailable) return 'storage-unavailable';
    if (!state.config.enabled || state.encryptedSecret === null) return 'invalid-request';
    if (connection && phase === 'running') return null;
    if (connection && !await stop()) return 'stop-failed';
    const provider = providers.find((provider) => provider.id === state.config.providerId);
    if (provider?.unavailableReason) { phase = 'failed'; error = provider.unavailableReason; return error; }
    if (!provider || !await provider.available().catch(() => false)) { phase = 'failed'; error = 'component-missing'; return error; }
    if (closed) return 'unavailable';
    let secret: string;
    try { secret = decryptSecret(state.encryptedSecret); }
    catch { phase = 'failed'; error = 'storage-unavailable'; return error; }
    phase = 'starting'; error = null;
    try {
      hostName ??= await input.getHostName();
      if (closed) return 'unavailable';
      connection = await provider.start({ root: input.root, identity: state.identity, config: structuredClone(state.config), secret, hostName, receive: input.receive });
      runningHostName = hostName;
      const owned = connection;
      void owned.closed.then(() => serial(async () => {
        if (closed || connection !== owned) return;
        phase = 'failed'; error = 'start-failed';
        connection = undefined;
      }), () => serial(async () => {
        if (closed || connection !== owned) return;
        phase = 'failed'; error = 'stop-failed';
      }));
      if (closed) return 'unavailable';
      phase = 'running';
      return null;
    } catch {
      const stopped = await stop();
      phase = 'failed'; error = stopped ? 'start-failed' : 'stop-failed';
      return error;
    }
  };
  const saveConfiguration = async (config: NetworkConfiguration, secret?: string): Promise<NetworkErrorCode | null> => {
    if (secret === undefined && isDeepStrictEqual(config, state.config)) return null;
    if (state.revision >= Number.MAX_SAFE_INTEGER) return 'storage-unavailable';
    const next = { ...state, revision: state.revision + 1, config };
    try {
      if (secret !== undefined) next.encryptedSecret = encryptSecret(secret);
      await saveState(input.root, next);
    } catch { return 'storage-unavailable'; }
    state = next;
    return null;
  };
  const refreshHostName = async (): Promise<NetworkErrorCode | null> => {
    if (!connection || phase !== 'running') return null;
    let hostName: string;
    try { hostName = await input.getHostName(); }
    catch { error = 'unavailable'; return error; }
    if (closed) return 'unavailable';
    if (hostName === runningHostName) return null;
    if (!await stop()) return 'stop-failed';
    return start(hostName);
  };
  const differentNetwork = (network: NetworkInvitation): boolean => {
    if (state.encryptedSecret === null) return false;
    const secret = decryptSecret(state.encryptedSecret);
    return state.config.networkName !== network.networkName || secret !== network.secret;
  };
  return {
    read(): Promise<NetworkSnapshot> {
      if (closed) return Promise.reject(new Error('unavailable'));
      if (!reading) {
        if (pendingOperations >= MAX_PENDING_OPERATIONS) return Promise.reject(new Error('unavailable'));
        const pending = serial(snapshot).finally(() => { if (reading === pending) reading = undefined; });
        reading = pending;
      }
      return reading.then((value) => {
        if (closed) throw new Error('unavailable');
        return structuredClone(value);
      });
    },
    async exchange(nodeId: string, request: object, signal?: AbortSignal): Promise<object> {
      if (typeof nodeId !== 'string' || !record(request)) {
        return { status: 400, body: { success: false, error: 'invalid-request' } };
      }
      if (closed || phase !== 'running' || !connection || signal?.aborted) {
        return { status: 503, body: { success: false, error: 'unavailable' } };
      }
      return connection.exchange(nodeId, request, signal);
    },
    prepareInvitation(): Promise<NetworkInvitation | NetworkFailure> {
      if (closed || pendingOperations >= MAX_PENDING_OPERATIONS) return Promise.resolve(failure('unavailable'));
      return serial(async () => {
        if (closed) return failure('unavailable');
        if (!storageAvailable) return failure('storage-unavailable');
        let config: NetworkConfiguration;
        let secret: string;
        const create = state.encryptedSecret === null;
        if (create) {
          secret = randomBytes(32).toString('hex');
          config = {
            ...structuredClone(state.config), networkName: `matcha-${randomBytes(8).toString('hex')}`,
            peers: [...(input.bootstrapPeers ?? ['tcp://public.easytier.top:11010'])], enabled: true, autoStart: true,
          };
        } else {
          try { secret = decryptSecret(state.encryptedSecret!); }
          catch { return failure('storage-unavailable'); }
          config = { ...structuredClone(state.config), enabled: true, autoStart: true };
        }
        const peers = config.peers.length ? [...config.peers] : config.listeners.filter((listener) => {
          const host = new URL(listener).hostname;
          return host !== '0.0.0.0' && host !== '[::]' && host !== '[::1]' && !host.startsWith('127.');
        });
        const invitation = { networkName: config.networkName, secret, peers };
        if (!isConfiguration(config) || !isNetworkInvitation(invitation)) return failure('invalid-request');
        if (!peers.length) return failure('unavailable');
        const changed = !isDeepStrictEqual(config, state.config) || create;
        const code = await saveConfiguration(config, create ? secret : undefined);
        if (code) return failure(code);
        if (changed && connection && !await stop()) return failure('stop-failed');
        const started = await refreshHostName() ?? await start();
        return started ? failure(started) : invitation;
      });
    },
    previewInvitation(network: NetworkInvitation): Promise<{ currentNetworkName: string | null; networkRevision: number; replaceNetwork: boolean } | NetworkFailure> {
      if (closed || pendingOperations >= MAX_PENDING_OPERATIONS) return Promise.resolve(failure('unavailable'));
      return serial(async () => {
        if (closed) return failure('unavailable');
        if (!isNetworkInvitation(network)) return failure('invalid-request');
        if (!storageAvailable) return failure('storage-unavailable');
        try {
          return {
            currentNetworkName: state.encryptedSecret === null ? null : state.config.networkName,
            networkRevision: state.revision, replaceNetwork: differentNetwork(network),
          };
        } catch { return failure('storage-unavailable'); }
      });
    },
    joinInvitation(network: NetworkInvitation, expectedRevision: number, replaceNetwork: boolean): Promise<NetworkSnapshot | NetworkFailure> {
      if (closed || pendingOperations >= MAX_PENDING_OPERATIONS) return Promise.resolve(failure('unavailable'));
      return serial(async () => {
        if (closed) return failure('unavailable');
        if (!isNetworkInvitation(network) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
          || typeof replaceNetwork !== 'boolean') return failure('invalid-request');
        if (!storageAvailable) return failure('storage-unavailable');
        if (expectedRevision !== state.revision) return failure('conflict');
        let different: boolean;
        try { different = differentNetwork(network); }
        catch { return failure('storage-unavailable'); }
        if (different && !replaceNetwork) return failure('network-change-required');
        const create = state.encryptedSecret === null;
        const config = {
          ...structuredClone(state.config), networkName: network.networkName, enabled: true, autoStart: true,
          peers: different || create ? [...network.peers] : [...new Set([...state.config.peers, ...network.peers])],
        };
        if (!isConfiguration(config)) return failure('invalid-request');
        const changed = different || create || !isDeepStrictEqual(config, state.config);
        const code = await saveConfiguration(config, different || create ? network.secret : undefined);
        if (code) return failure(code);
        if (changed && connection && !await stop()) return failure('stop-failed');
        const started = await refreshHostName() ?? await start();
        return started ? failure(started) : snapshot().catch(() => failure('unavailable'));
      });
    },
    refreshHostName(): Promise<NetworkSnapshot | NetworkFailure> {
      if (closed || pendingOperations >= MAX_PENDING_OPERATIONS) return Promise.resolve(failure('unavailable'));
      return serial(async () => {
        if (closed) return failure('unavailable');
        if (!storageAvailable) return failure('storage-unavailable');
        const code = await refreshHostName();
        return code ? failure(code) : snapshot().catch(() => failure('unavailable'));
      });
    },
    command(request: NetworkRequest): Promise<NetworkSnapshot | NetworkFailure> {
      if (closed || pendingOperations >= MAX_PENDING_OPERATIONS) return Promise.resolve(failure('unavailable'));
      return serial(async () => {
        if (closed) return failure('unavailable');
        if (!record(request)) return failure('invalid-request');
        if (request.kind === 'stop' && keys(request, ['kind'])) return await stop() ? snapshot() : failure('stop-failed');
        if (request.kind === 'start' && keys(request, ['kind'])) {
          const code = await start();
          return code ? failure(code) : snapshot();
        }
        if (request.kind !== 'configure' || !keys(request, ['kind', 'expectedRevision', 'config'], ['secret'])
          || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 || !isConfiguration(request.config)
          || !providers.some((provider) => provider.id === request.config.providerId)
          || request.secret !== undefined && !validSecret(request.secret)) return failure('invalid-request');
        if (!storageAvailable) return failure('storage-unavailable');
        if (request.expectedRevision !== state.revision) return failure('conflict');
        if (state.revision >= Number.MAX_SAFE_INTEGER) return failure('storage-unavailable');
        const next = { ...state, revision: state.revision + 1, config: structuredClone(request.config) };
        try {
          if (request.secret !== undefined) next.encryptedSecret = encryptSecret(request.secret);
          if (next.config.enabled && next.encryptedSecret === null) return failure('invalid-request');
          await saveState(input.root, next);
        } catch { return failure('storage-unavailable'); }
        state = next;
        const wasActive = connection !== undefined;
        if (wasActive && !await stop()) return snapshot();
        if (wasActive && state.config.enabled) await start();
        return snapshot();
      });
    },
    startConfigured(): Promise<void> {
      if (closed || pendingOperations >= MAX_PENDING_OPERATIONS) return Promise.reject(new Error('unavailable'));
      return serial(async () => {
        if (!closed && storageAvailable && state.config.enabled && state.config.autoStart) {
          const code = await start();
          if (code) throw new Error(code);
        }
      });
    },
    close(): Promise<void> {
      closed = true;
      closing ??= serial(async () => {
        if (!await stop()) { closing = undefined; throw new Error('stop-failed'); }
      });
      return closing;
    },
  };
}
