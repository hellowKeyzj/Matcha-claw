import { createHash, randomUUID } from 'node:crypto';
import { ACCESS_HOST_NAME_MAX_LENGTH, type AccessResponse, type AccessSnapshot } from '../../../src/types/resource-access';
import type {
  CapabilityCall, CapabilityCallReceipt, ConnectionPreview, InterconnectCommand, InterconnectEnvelope, InterconnectJoinEnvelope,
  InterconnectFailure, InterconnectRemoteRequest, InterconnectSnapshot, RemoteCapability,
} from '../../../src/types/desktop/interconnect';
import type { AccessOwner } from '../access';
import { isValidText } from '../access/validation';
import type { createNetworkAccess } from '../network-access';
import { keys, record } from '../network-access/storage';
import type { createSharedCapabilities } from './capabilities';
import { createPairing, failure, isFailure } from './pairing';
import { identifyCapability, isCapabilityPresentation } from './capability';
import { prepareSharedFolder, type createSharedFolders } from './capability-folder';
import { FolderError } from '../shared-folders/contracts';
import { open, seal } from './protocol';
import { loadInterconnectState, saveInterconnectState, type StoredPair } from './storage';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_RESULT = 1024 * 1024 - 512;
const RETENTION = 10 * 60_000;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isHostName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= ACCESS_HOST_NAME_MAX_LENGTH && isValidText(value, 256);
const isName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 128
  && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);

class InterconnectError extends Error {
  constructor(readonly code: string) { super(code); }
}

function unwrap<T>(response: AccessResponse<T>): T {
  if (isFailure(response.body)) throw new InterconnectError(response.body.error);
  return response.body as T;
}

interface RetainedCall {
  pairId: string;
  resourceId: string;
  sourceId: string;
  argumentsHash: string;
  receipt: CapabilityCallReceipt;
}

export async function createInterconnect(options: {
  root: string;
  access: AccessOwner;
  network: ReturnType<typeof createNetworkAccess>;
  capabilities: ReturnType<typeof createSharedCapabilities>;
  folders: ReturnType<typeof createSharedFolders>;
  signal: AbortSignal;
}) {
  const state = await loadInterconnectState(options.root);
  const epoch = randomUUID();
  const seen = new Map<string, number>();
  const activeCalls = new Map<string, RetainedCall>();
  const completedCalls = new Map<string, RetainedCall & { finishedAt: number }>();
  const locations = new Map<string, { nodeId: string; epoch: string }>();
  const controllers = new Set<AbortController>();
  const pairingShutdown = new AbortController();
  const pendingControls = new Set<Promise<unknown>>();
  let closed = false;
  let mutations = Promise.resolve();
  const admitControl = <T>(work: () => Promise<T>): Promise<T> => {
    if (closed || options.signal.aborted || pendingControls.size >= 16) return Promise.reject(new InterconnectError('unavailable'));
    const pending = Promise.resolve().then(work);
    pendingControls.add(pending);
    void pending.then(() => { pendingControls.delete(pending); }, () => { pendingControls.delete(pending); });
    return pending;
  };
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    if (closed || options.signal.aborted) return Promise.reject(new InterconnectError('unavailable'));
    const pending = mutations.then(() => {
      if (closed || options.signal.aborted) throw new InterconnectError('unavailable');
      return work();
    });
    mutations = pending.then(() => {}, () => {});
    return pending;
  };
  const persist = async () => {
    try { await saveInterconnectState(options.root, state); }
    catch { closed = true; pairingShutdown.abort(); throw new InterconnectError('storage-unavailable'); }
  };
  const pairFor = (id: string) => {
    const pair = state.pairs.find((item) => item.id === id && item.phase === 'paired');
    if (!pair) throw new InterconnectError('not-found');
    return pair;
  };
  const snapshot = async (): Promise<InterconnectSnapshot> => {
    const pairs = [...state.pairs];
    const members = new Map(pairs.length ? (await local()).members.map((member) => [member.id, member.name]) : []);
    return {
      clients: pairs.map(({ id, hostId, memberId, phase }) => {
        const name = members.get(memberId);
        if (name === undefined) throw new InterconnectError('storage-unavailable');
        return { id, name, hostId, memberId, phase };
      }),
      invitations: state.invitations.map(({ id, name, expiresAt, maxUses, uses }) => ({ id, name, expiresAt, maxUses, uses })),
      capabilities: await options.capabilities.list(),
    };
  };
  const local = async () => unwrap(await options.access.read(options.signal));
  const renameHost = async (name: string, expectedRevision: number) => {
    const own = await local();
    if (own.revision !== expectedRevision) throw new InterconnectError('conflict');
    if (own.host.name === name) return false;
    unwrap(await options.access.command({ expectedRevision, change: { kind: 'host.rename', name } }, options.signal));
    return true;
  };
  const createMember = async (name: string, credential: string) => {
    const before = await local();
    const after = unwrap(await options.access.createMember({ expectedRevision: before.revision, name, credential }, options.signal));
    const added = after.members.filter((member) => !before.members.some((old) => old.id === member.id));
    if (added.length !== 1) throw new InterconnectError('outcome-unknown');
    return { memberId: added[0].id, host: after.host };
  };
  const disableMember = async (pair: StoredPair) => {
    const before = await local();
    const member = before.members.find((item) => item.id === pair.memberId);
    if (!member) throw new InterconnectError('not-found');
    if (member.enabled) unwrap(await options.access.command({
      expectedRevision: before.revision,
      change: { kind: 'member.update', id: member.id, name: member.name, enabled: false, roleIds: member.roleIds },
    }, options.signal));
  };
  const rememberNonce = (envelope: InterconnectEnvelope): InterconnectFailure | undefined => {
    const now = Date.now();
    for (const [nonce, time] of seen) if (now - time > 60_000) seen.delete(nonce);
    const nonce = `${envelope.pairId}:${envelope.nonce}`;
    if (seen.has(nonce)) return failure('invalid-request');
    if (seen.size >= 4096) return failure('busy');
    seen.set(nonce, now);
  };
  const authorize = async (pair: StoredPair) => { unwrap(await options.access.discover({ credential: pair.localCredential }, options.signal)); };
  // Lane-only: Join confirmation and hello share the same authenticated name update.
  const acceptName = async (pair: StoredPair, name: string) => {
    if (closed || options.signal.aborted) throw new InterconnectError('unavailable');
    if (!state.pairs.includes(pair)) throw new InterconnectError('conflict');
    await authorize(pair);
    let own = await local();
    if (closed || options.signal.aborted) throw new InterconnectError('unavailable');
    const member = own.members.find((item) => item.id === pair.memberId);
    if (!member?.enabled) throw new InterconnectError('unauthorized');
    if (member.name !== name) own = unwrap(await options.access.command({
      expectedRevision: own.revision,
      change: { kind: 'member.update', id: member.id, name, enabled: member.enabled, roleIds: member.roleIds },
    }, options.signal));
    if (closed || options.signal.aborted) throw new InterconnectError('unavailable');
    return own.host;
  };
  const pairing = createPairing({
    state, network: options.network, signal: AbortSignal.any([options.signal, pairingShutdown.signal]),
    local, createMember, persist, rememberNonce, serial, authorize, acceptName,
  });
  const send = async (pair: StoredPair, nodeId: string, body: InterconnectRemoteRequest, signal: AbortSignal): Promise<unknown> => {
    const requestId = randomUUID();
    const response = await (await options.network).exchange(nodeId, seal(pair.id, pair.key, requestId, body), signal);
    if (isFailure(response)) throw new InterconnectError(response.error);
    if (record(response) && isFailure(response.body)) throw new InterconnectError(response.body.error);
    if (!record(response) || response.pairId !== pair.id) throw new InterconnectError('outcome-unknown');
    const decoded = open(response as unknown as InterconnectEnvelope, pair.key);
    if (decoded.requestId !== requestId) throw new InterconnectError('outcome-unknown');
    return decoded.body;
  };
  const locate = async (pair: StoredPair, signal: AbortSignal) => {
    await authorize(pair);
    const own = await local();
    let network;
    try { network = await (await options.network).read(); }
    catch { return; }
    if (!network.runtime) return;
    const cached = locations.get(pair.id);
    const nodes = [...new Set([...(cached ? [cached.nodeId] : []), ...network.runtime.peers.map((peer) => peer.nodeId)])];
    // Route IDs are ephemeral. Even cached routes must answer a fresh authenticated hello.
    for (let offset = 0; offset < nodes.length && !signal.aborted; offset += 8) {
      const replies = await Promise.allSettled(nodes.slice(offset, offset + 8).map(async (nodeId) => {
        let reply: unknown;
        try { reply = await send(pair, nodeId, { kind: 'hello', hostId: own.host.id, name: own.host.name }, signal); }
        catch { return; }
        if (isFailure(reply)) throw new InterconnectError(reply.error);
        if (!record(reply) || !keys(reply, ['kind', 'hostId', 'name', 'epoch']) || reply.kind !== 'hello'
          || reply.hostId !== pair.hostId || !isName(reply.name) || !isUuid(reply.epoch) || signal.aborted) return;
        const target = { nodeId, epoch: reply.epoch };
        const name = reply.name;
        return serial(async () => {
          if (signal.aborted) return;
          await acceptName(pair, name);
          if (closed || options.signal.aborted) throw new InterconnectError('unavailable');
          locations.set(pair.id, target);
          return target;
        });
      }));
      const rejected = replies.find((reply) => reply.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      const target = replies.flatMap((reply) => reply.status === 'fulfilled' && reply.value ? [reply.value] : [])[0];
      if (target) return target;
    }
    locations.delete(pair.id);
  };
  const remote = async (pair: StoredPair, body: InterconnectRemoteRequest, signal: AbortSignal) => {
    const target = locations.get(pair.id) ?? await locate(pair, signal);
    if (!target) throw new InterconnectError('unavailable');
    const request = 'epoch' in body ? { ...body, epoch: target.epoch } : body;
    try {
      const response = await send(pair, target.nodeId, request, signal);
      if (isFailure(response)) throw new InterconnectError(response.error);
      return response;
    } catch (error) { locations.delete(pair.id); throw error; }
  };
  const admit = async (pair: StoredPair, callId: string, resourceId: string, sourceId: string, argumentsHash: string) => {
    const admitted = unwrap(await options.access.admit({ callId, resourceId, sourceId, argumentsHash, credential: pair.localCredential }, options.signal));
    if (admitted.callId !== callId || admitted.resourceId !== resourceId || admitted.sourceId !== sourceId || admitted.argumentsHash !== argumentsHash) {
      throw new InterconnectError('outcome-unknown');
    }
  };
  const pruneCompletedCalls = () => {
    const now = Date.now();
    for (const [id, call] of completedCalls) if (now - call.finishedAt >= RETENTION) completedCalls.delete(id);
  };
  const finishCall = (callId: string, call: RetainedCall) => {
    activeCalls.delete(callId);
    if (closed) return;
    pruneCompletedCalls();
    if (completedCalls.size >= 64) completedCalls.delete(completedCalls.keys().next().value!);
    completedCalls.set(callId, { ...call, finishedAt: Date.now() });
  };
  const receiveBody = async (pair: StoredPair, value: unknown): Promise<unknown> => {
    if (!record(value) || !isUuid(value.hostId)) return failure('invalid-request');
    if (pair.phase !== 'paired' || pair.hostId !== value.hostId) return failure('unauthorized');
    if (value.kind === 'hello') {
      if (!keys(value, ['kind', 'hostId', 'name']) || !isName(value.name)) return failure('invalid-request');
      const name = value.name;
      return admitControl(() => serial(async () => {
        const host = await acceptName(pair, name);
        return { kind: 'hello', hostId: host.id, name: host.name, epoch };
      }));
    }
    if (value.epoch !== epoch) return failure('outcome-unknown');
    if (value.kind === 'discover' && keys(value, ['kind', 'hostId', 'epoch'])) {
      const authorized = unwrap(await options.access.discover({ credential: pair.localCredential }, options.signal));
      const available = await options.capabilities.list();
      const descriptors = new Map(available.map((item) => [item.sourceId, item]));
      return { capabilities: authorized.resources.flatMap((resource) => {
        const descriptor = descriptors.get(resource.sourceId);
        return descriptor ? [{ ...descriptor, resourceId: resource.id }] : [];
      }) };
    }
    if (value.kind === 'invoke' && keys(value, ['kind', 'hostId', 'epoch', 'callId', 'resourceId', 'sourceId', 'arguments'])
      && isUuid(value.callId) && isUuid(value.resourceId) && typeof value.sourceId === 'string' && record(value.arguments)) {
      pruneCompletedCalls();
      if (activeCalls.has(value.callId) || completedCalls.has(value.callId)) return failure('conflict');
      if (activeCalls.size >= 64) return failure('busy');
      const resolved = await options.capabilities.resolve(value.sourceId);
      if (!resolved) return failure('not-found');
      if (activeCalls.has(value.callId) || completedCalls.has(value.callId)) return failure('conflict');
      if (activeCalls.size >= 64 || closed || options.signal.aborted) return failure('unavailable');
      const callId = value.callId;
      const args = value.arguments;
      const argumentsHash = createHash('sha256').update(JSON.stringify(args)).digest('hex');
      // Reserve before awaiting admission so concurrent duplicates cannot execute twice.
      const call: RetainedCall = {
        pairId: pair.id, resourceId: value.resourceId, sourceId: value.sourceId, argumentsHash,
        receipt: { phase: 'running', callId },
      };
      activeCalls.set(callId, call);
      try { await admit(pair, callId, call.resourceId, call.sourceId, argumentsHash); }
      catch (error) {
        call.receipt = { phase: 'failed', callId, error: error instanceof InterconnectError ? error.code : 'outcome-unknown' };
        finishCall(callId, call);
        return call.receipt;
      }
      if (closed || options.signal.aborted) {
        call.receipt = { phase: 'unknown', callId }; finishCall(callId, call);
        return call.receipt;
      }
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 30 * 60_000);
      void Promise.resolve().then(() => {
        if (closed || options.signal.aborted) throw new InterconnectError('outcome-unknown');
        return resolved.execute(args, AbortSignal.any([controller.signal, options.signal]));
      }).then((result) => {
        if (closed) return;
        const receipt: CapabilityCallReceipt = { phase: 'completed', callId, result };
        const serialized = JSON.stringify(receipt);
        call.receipt = Buffer.byteLength(serialized) <= MAX_RESULT ? JSON.parse(serialized) as CapabilityCallReceipt
          : { phase: 'failed', callId, error: 'response-too-large' };
      }).catch(() => {
        if (!closed) call.receipt = { phase: 'unknown', callId };
      }).finally(() => {
        clearTimeout(timer); controllers.delete(controller); finishCall(callId, call);
      });
      return { phase: 'accepted', callId };
    }
    if (value.kind === 'result' && keys(value, ['kind', 'hostId', 'epoch', 'callId']) && isUuid(value.callId)) {
      pruneCompletedCalls();
      const call = activeCalls.get(value.callId) ?? completedCalls.get(value.callId);
      if (!call || call.pairId !== pair.id) return { phase: 'unknown', callId: value.callId };
      await admit(pair, value.callId, call.resourceId, call.sourceId, call.argumentsHash);
      return call.receipt;
    }
    return failure('invalid-request');
  };

  return {
    read: snapshot,
    hasCapability: async (sourceId: string): Promise<boolean> => typeof sourceId === 'string' && !!await options.capabilities.resolve(sourceId),
    async command(command: InterconnectCommand): Promise<InterconnectSnapshot | AccessSnapshot | ConnectionPreview | { invitation: string } | InterconnectFailure> {
      const preview = record(command) && command.kind === 'connect.preview';
      try {
        return await admitControl(async () => {
          if (!record(command)) return failure('invalid-request');
          if (command.kind === 'connect.preview' && keys(command, ['kind', 'invitation']) && typeof command.invitation === 'string') {
            return pairing.preview(command.invitation);
          }
          if (command.kind === 'invite' && keys(command, ['kind', 'name', 'maxUses', 'hostName', 'expectedRevision'])
            && isName(command.name) && Number.isSafeInteger(command.maxUses) && command.maxUses >= 1 && command.maxUses <= 128
            && isHostName(command.hostName) && isRevision(command.expectedRevision)) {
            await serial(() => renameHost(command.hostName, command.expectedRevision));
            const network = await options.network;
            const invitation = await network.prepareInvitation();
            if (isFailure(invitation)) return invitation;
            const current = await network.read();
            if (!current.runtime) return failure('unavailable');
            return serial(() => pairing.invite(command.name, command.maxUses, invitation, current.runtime!.nodeId));
          }
          if (command.kind === 'connect' && keys(command, ['kind', 'invitation', 'hostName', 'expectedRevision', 'expectedNetworkRevision', 'replaceNetwork'])
            && typeof command.invitation === 'string' && isHostName(command.hostName) && isRevision(command.expectedRevision)
            && isRevision(command.expectedNetworkRevision) && typeof command.replaceNetwork === 'boolean') {
            await serial(async () => {
              if ((await local()).revision !== command.expectedRevision) throw new InterconnectError('conflict');
            });
            const error = await pairing.connect(command.invitation, command.expectedNetworkRevision, command.replaceNetwork,
              () => serial(() => renameHost(command.hostName, command.expectedRevision)));
            return error ?? snapshot();
          }
          if (command.kind === 'clients.refresh' && keys(command, ['kind'])) {
            const signal = AbortSignal.any([options.signal, pairingShutdown.signal, AbortSignal.timeout(10_000)]);
            const pairs = await serial(async () => state.pairs.filter((pair) => pair.phase === 'paired'));
            for (let offset = 0; offset < pairs.length && !signal.aborted; offset += 8) {
              const replies = await Promise.allSettled(pairs.slice(offset, offset + 8).map((pair) => locate(pair, signal)));
              const rejected = replies.find((reply) => reply.status === 'rejected');
              if (rejected?.status === 'rejected') throw rejected.reason;
            }
            if (closed || options.signal.aborted) throw new InterconnectError('unavailable');
            return snapshot();
          }
          return serial(async () => {
            if (command.kind === 'invitation.revoke' && keys(command, ['kind', 'invitationId']) && isUuid(command.invitationId)) {
              const error = await pairing.revoke(command.invitationId);
              return error ?? snapshot();
            }
            if (command.kind === 'disconnect' && keys(command, ['kind', 'clientId']) && isUuid(command.clientId)) {
              const pair = state.pairs.find((item) => item.id === command.clientId);
              if (!pair) return failure('not-found');
              await disableMember(pair);
              state.pairs.splice(state.pairs.indexOf(pair), 1);
              locations.delete(pair.id);
              await persist();
              return snapshot();
            }
            if (command.kind === 'share.folder' && keys(command, ['kind', 'name', 'path', 'operations', 'expectedRevision'])
              && typeof command.name === 'string' && isValidText(command.name, 128) && typeof command.path === 'string'
              && Array.isArray(command.operations) && command.operations.length > 0 && command.operations.length <= 3
              && command.operations.every((operation) => operation === 'list' || operation === 'read' || operation === 'write')
              && new Set(command.operations).size === command.operations.length && isRevision(command.expectedRevision)) {
              if ((await local()).revision !== command.expectedRevision) return failure('conflict');
              let root: string;
              try { root = await prepareSharedFolder(command.path); }
              catch (error) {
                return failure(error instanceof FolderError
                  ? error.outcome === 'not-found' ? 'not-found'
                    : ['invalid-input', 'forbidden-path', 'not-directory'].includes(error.outcome) ? 'invalid-request' : 'unavailable'
                  : 'unavailable');
              }
              const existing = unwrap(await options.access.folders(options.signal)).find((folder) => folder.root === root);
              if (existing && existing.name !== command.name) return failure('conflict');
              const id = existing?.id ?? randomUUID();
              const resources = command.operations.map((operation) => {
                const folder = { id, name: command.name, root, operation };
                const descriptor = identifyCapability(options.folders.folderCapability(folder));
                return { name: descriptor.name, sourceId: descriptor.sourceId, folder };
              });
              return unwrap(await options.access.registerFolder({ expectedRevision: command.expectedRevision, resources }, options.signal));
            }
            if (command.kind === 'share' && keys(command, ['kind', 'sourceId', 'expectedRevision']) && typeof command.sourceId === 'string'
              && Number.isSafeInteger(command.expectedRevision) && command.expectedRevision >= 0) {
              const capability = await options.capabilities.resolve(command.sourceId);
              if (!capability) return failure('not-found');
              return unwrap(await options.access.command({
                expectedRevision: command.expectedRevision,
                change: { kind: 'resource.capability', name: capability.descriptor.name, sourceId: capability.descriptor.sourceId },
              }, options.signal));
            }
            return failure('invalid-request');
          });
        });
      } catch (error) { return failure(error instanceof InterconnectError ? error.code : preview ? 'unavailable' : 'outcome-unknown'); }
    },
    async discover(clientId: string, signal: AbortSignal): Promise<{ capabilities: RemoteCapability[] } | InterconnectFailure> {
      try {
        const pair = pairFor(clientId);
        const own = await local();
        const response = await remote(pair, { kind: 'discover', hostId: own.host.id, epoch: '' }, signal);
        if (!record(response) || !Array.isArray(response.capabilities) || response.capabilities.length > 4096
          || !response.capabilities.every((item) => record(item) && isUuid(item.resourceId) && typeof item.sourceId === 'string'
            && typeof item.name === 'string' && typeof item.description === 'string' && record(item.inputSchema)
            && (item.presentation === undefined || isCapabilityPresentation(item.presentation)))) return failure('outcome-unknown');
        return response as unknown as { capabilities: RemoteCapability[] };
      } catch (error) { return failure(error instanceof InterconnectError ? error.code : 'unavailable'); }
    },
    async invoke(request: CapabilityCall, signal: AbortSignal): Promise<CapabilityCallReceipt | InterconnectFailure> {
      try {
        if (!record(request) || !keys(request, ['clientId', 'resourceId', 'sourceId', 'arguments']) || !isUuid(request.clientId)
          || !isUuid(request.resourceId) || typeof request.sourceId !== 'string' || !record(request.arguments)) return failure('invalid-request');
        const pair = pairFor(request.clientId);
        const own = await local();
        const callId = randomUUID();
        const response = await remote(pair, { kind: 'invoke', hostId: own.host.id, epoch: '', callId, resourceId: request.resourceId, sourceId: request.sourceId, arguments: request.arguments }, signal);
        return isReceipt(response, callId) ? response : failure('outcome-unknown');
      } catch (error) { return failure(error instanceof InterconnectError ? error.code : 'outcome-unknown'); }
    },
    async result(clientId: string, callId: string, signal: AbortSignal): Promise<CapabilityCallReceipt | InterconnectFailure> {
      try {
        if (!isUuid(clientId) || !isUuid(callId)) return failure('invalid-request');
        const pair = pairFor(clientId);
        const own = await local();
        const response = await remote(pair, { kind: 'result', hostId: own.host.id, epoch: '', callId }, signal);
        return isReceipt(response, callId) ? response : failure('outcome-unknown');
      } catch (error) { return failure(error instanceof InterconnectError ? error.code : 'outcome-unknown'); }
    },
    async receive(envelope: InterconnectEnvelope): Promise<InterconnectEnvelope | InterconnectFailure> {
      if (closed || options.signal.aborted) return failure('unavailable');
      try {
        if (!record(envelope)) return failure('invalid-request');
        if ('invitationId' in envelope || 'publicKey' in envelope) {
          return await admitControl(() => serial(() => pairing.receive(envelope as unknown as InterconnectJoinEnvelope)));
        }
        const pair = state.pairs.find((item) => item.id === envelope.pairId);
        if (!pair) return failure('unauthorized');
        const decoded = open(envelope, pair.key);
        const duplicate = rememberNonce(envelope);
        if (duplicate) return duplicate;
        let body: unknown;
        try { body = await receiveBody(pair, decoded.body); }
        catch (error) { body = failure(error instanceof InterconnectError ? error.code : 'outcome-unknown'); }
        return seal(pair.id, pair.key, decoded.requestId, body);
      } catch (error) { return failure(error instanceof InterconnectError ? error.code : 'invalid-request'); }
    },
    async close(): Promise<void> {
      closed = true;
      pairingShutdown.abort();
      for (const controller of controllers) controller.abort();
      seen.clear(); locations.clear(); activeCalls.clear(); completedCalls.clear();
      await Promise.allSettled([...pendingControls]);
      await mutations;
    },
  };
}

function isReceipt(value: unknown, callId: string): value is CapabilityCallReceipt {
  if (!record(value) || value.callId !== callId) return false;
  switch (value.phase) {
    case 'accepted': case 'running': case 'unknown': return keys(value, ['phase', 'callId']);
    case 'completed': return keys(value, ['phase', 'callId', 'result']);
    case 'failed': return keys(value, ['phase', 'callId', 'error']) && typeof value.error === 'string';
    default: return false;
  }
}
