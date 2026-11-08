import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AccessSnapshot } from '../../../src/types/resource-access';
import type {
  ConnectionPreview, InterconnectEnvelope, InterconnectFailure, InterconnectJoinEnvelope,
} from '../../../src/types/desktop/interconnect';
import type { createNetworkAccess } from '../network-access';
import type { NetworkInvitation } from '../network-access/provider';
import {
  createExchangeKeys, createInvitation, derivePairKey, INVITATION_TTL_MS, isExchangePublicKey, openJoin, parseInvitation, sealJoin,
  type Invitation,
} from './protocol';
import type { InterconnectState, StoredPair } from './storage';
import { keys, name, record, secret, uuid } from './validation';

export const failure = (error: string): InterconnectFailure => ({ success: false, error });
export const isFailure = (value: unknown): value is InterconnectFailure => record(value) && value.success === false && typeof value.error === 'string';
const isName = (value: unknown): value is string => name(value) && value.trim().length > 0;
const invitationHash = (invitation: Pick<Invitation, 'invitationId' | 'key' | 'hostId' | 'publicKey' | 'network'>) => createHash('sha256')
  .update(JSON.stringify([
    invitation.invitationId, invitation.key, invitation.hostId, invitation.publicKey,
    invitation.network.networkName, invitation.network.secret, invitation.network.peers,
  ])).digest('hex');

export function createPairing(input: {
  state: InterconnectState;
  network: ReturnType<typeof createNetworkAccess>;
  signal: AbortSignal;
  local: () => Promise<AccessSnapshot>;
  createMember: (name: string, credential: string) => Promise<{ memberId: string; host: AccessSnapshot['host'] }>;
  authorize: (pair: StoredPair) => Promise<void>;
  acceptName: (pair: StoredPair, name: string) => Promise<AccessSnapshot['host']>;
  persist: () => Promise<void>;
  rememberNonce: (envelope: InterconnectEnvelope) => InterconnectFailure | undefined;
  serial: <T>(work: () => Promise<T>) => Promise<T>;
}) {
  const { state } = input;
  const decodeInvitation = (code: string): Invitation | InterconnectFailure => {
    let invitation: Invitation;
    try { invitation = parseInvitation(code); }
    catch { return failure('invalid-request'); }
    const pair = state.pairs.find((item) => item.join?.invitationId === invitation.invitationId);
    if (pair && (pair.hostId !== invitation.hostId || pair.join!.invitationHash !== invitationHash(invitation))) return failure('conflict');
    if (!pair && invitation.expiresAt <= Date.now()) return failure('invitation-expired');
    return invitation;
  };
  const sendJoin = async (pair: StoredPair, nodeId: string, signal: AbortSignal): Promise<{ kind: 'paired'; hostId: string; name: string } | InterconnectFailure> => {
    if (signal.aborted) return failure('unavailable');
    if (!pair.join) return failure('conflict');
    const own = await input.local();
    try {
      const requestId = randomUUID();
      const response = await (await input.network).exchange(nodeId, sealJoin(
        pair.join.invitationId, pair.join.publicKey, pair.id, pair.key, requestId,
        { kind: 'pair', hostId: own.host.id, name: own.host.name, invitationHash: pair.join.invitationHash },
      ), signal);
      if (isFailure(response)) return response;
      if (record(response) && isFailure(response.body)) return response.body;
      if (!record(response) || response.pairId !== pair.id || response.invitationId !== pair.join.invitationId
        || response.publicKey !== pair.join.publicKey) return failure('outcome-unknown');
      const decoded = openJoin(response as unknown as InterconnectJoinEnvelope, pair.key);
      const value = decoded.body;
      if (decoded.requestId !== requestId || !record(value) || !keys(value, ['kind', 'hostId', 'name', 'invitationHash'])
        || value.kind !== 'paired' || value.hostId !== pair.hostId || !isName(value.name)
        || value.invitationHash !== pair.join.invitationHash) return failure('outcome-unknown');
      return { kind: 'paired', hostId: value.hostId, name: value.name };
    } catch { return failure('outcome-unknown'); }
  };
  const locateJoin = async (pair: StoredPair, nodeId: string, signal: AbortSignal) => {
    const network = await input.network;
    const attempted = new Set<string>();
    let failureResult = failure('unavailable');
    while (!signal.aborted) {
      const snapshot = await network.read();
      const candidates = (snapshot.runtime?.peers ?? []).map((peer) => peer.nodeId).filter((id) => !attempted.has(id));
      candidates.sort((left, right) => Number(right === nodeId) - Number(left === nodeId));
      for (let offset = 0; offset < candidates.length && !signal.aborted; offset += 8) {
        const batch = candidates.slice(offset, offset + 8);
        batch.forEach((id) => attempted.add(id));
        const replies = await Promise.all(batch.map((id) => sendJoin(pair, id, signal)));
        const paired = replies.find((reply) => !isFailure(reply));
        if (paired) return paired;
        failureResult = replies[0] as InterconnectFailure;
        if (replies.some((reply) => isFailure(reply) && reply.error === 'outcome-unknown')) return failure('outcome-unknown');
      }
      try { await delay(250, undefined, { signal }); }
      catch { break; }
    }
    return failureResult;
  };

  return {
    async invite(invitationName: string, maxUses: number, network: NetworkInvitation, nodeId: string): Promise<{ invitation: string } | InterconnectFailure> {
      const now = Date.now();
      for (let index = state.invitations.length - 1; index >= 0; index--) {
        if (state.invitations[index].expiresAt <= now) state.invitations.splice(index, 1);
      }
      if (state.invitations.length >= 32) return failure('busy');
      const own = await input.local();
      const exchange = createExchangeKeys();
      const invitation = {
        id: randomUUID(), name: invitationName, key: randomBytes(32).toString('hex'),
        ...exchange, expiresAt: Date.now() + INVITATION_TTL_MS, maxUses, uses: 0,
      };
      const payload: Invitation = {
        invitationId: invitation.id, key: invitation.key, publicKey: invitation.publicKey,
        nodeId, hostId: own.host.id, name: own.host.name, expiresAt: invitation.expiresAt, network,
      };
      const code = createInvitation(payload);
      state.invitations.push({ ...invitation, invitationHash: invitationHash(payload) });
      await input.persist();
      return { invitation: code };
    },
    async revoke(invitationId: string): Promise<InterconnectFailure | undefined> {
      const index = state.invitations.findIndex((invitation) => invitation.id === invitationId);
      if (index < 0) return failure('not-found');
      state.invitations.splice(index, 1);
      await input.persist();
    },
    async preview(code: string): Promise<ConnectionPreview | InterconnectFailure> {
      const invitation = decodeInvitation(code);
      if (isFailure(invitation)) return invitation;
      const preview = await (await input.network).previewInvitation(invitation.network);
      if (isFailure(preview)) return preview;
      const alreadyPaired = state.pairs.some((pair) => pair.join?.invitationId === invitation.invitationId && pair.phase === 'paired');
      return {
        alreadyPaired, hostName: invitation.name, networkName: invitation.network.networkName,
        currentNetworkName: preview.currentNetworkName, networkRevision: preview.networkRevision, replaceNetwork: !alreadyPaired && preview.replaceNetwork,
      };
    },
    async connect(code: string, expectedNetworkRevision: number, replaceNetwork: boolean, renameHost: () => Promise<boolean>): Promise<InterconnectFailure | undefined> {
      const invitation = decodeInvitation(code);
      if (isFailure(invitation)) return invitation;
      const hash = invitationHash(invitation);
      const existing = await input.serial(async () => {
        const pair = state.pairs.find((item) => item.join?.invitationId === invitation.invitationId);
        if (pair) {
          if (pair.hostId !== invitation.hostId || pair.join!.invitationHash !== hash) return failure('conflict');
          await input.authorize(pair);
        } else {
          if (state.pairs.length >= 128) return failure('busy');
          if ((await input.local()).host.id === invitation.hostId) return failure('invalid-request');
        }
        return { pair, confirmed: pair?.phase === 'paired' };
      });
      if (isFailure(existing)) return existing;
      const network = await input.network;
      const preview = await network.previewInvitation(invitation.network);
      if (isFailure(preview)) return preview;
      if (preview.networkRevision !== expectedNetworkRevision) return failure('conflict');
      if (existing.confirmed) {
        if (await renameHost()) {
          const refreshed = await network.refreshHostName();
          if (isFailure(refreshed)) return refreshed;
        }
        return;
      }
      if (preview.replaceNetwork && !replaceNetwork) return failure('network-change-required');
      await renameHost();
      const joined = await network.joinInvitation(invitation.network, expectedNetworkRevision, replaceNetwork);
      if (isFailure(joined)) return joined;
      const prepared = await input.serial(async () => {
        if (existing.pair && !state.pairs.includes(existing.pair)) return failure('conflict');
        let pair = state.pairs.find((item) => item.join?.invitationId === invitation.invitationId);
        if (pair) {
          if (pair.hostId !== invitation.hostId || pair.join!.invitationHash !== hash) return failure('conflict');
          await input.authorize(pair);
        } else {
          if (invitation.expiresAt <= Date.now()) return failure('invitation-expired');
          if (state.pairs.length >= 128) return failure('busy');
          if ((await input.local()).host.id === invitation.hostId) return failure('invalid-request');
          const id = randomUUID();
          const exchange = createExchangeKeys();
          const key = derivePairKey(exchange.privateKey, invitation.publicKey, invitation, id, exchange.publicKey);
          const localCredential = randomBytes(32).toString('hex');
          const member = await input.createMember(invitation.name, localCredential);
          pair = {
            id, hostId: invitation.hostId, memberId: member.memberId, localCredential,
            key, phase: 'invited', expiresAt: invitation.expiresAt,
            join: { invitationId: invitation.invitationId, publicKey: exchange.publicKey, invitationHash: hash },
          };
          // Persist before sending so an uncertain handshake reuses this member and key.
          state.pairs.push(pair);
          await input.persist();
        }
        return { pair, confirmed: pair.phase === 'paired' };
      });
      if (isFailure(prepared)) return prepared;
      if (prepared.confirmed) return;
      const { pair } = prepared;
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]);
      const response = await locateJoin(pair, invitation.nodeId, signal);
      if (isFailure(response)) return response;
      return input.serial(async () => {
        if (input.signal.aborted) return failure('unavailable');
        if (!state.pairs.includes(pair)) return failure('conflict');
        await input.acceptName(pair, response.name);
        if (input.signal.aborted) return failure('unavailable');
        if (pair.phase === 'paired') return;
        pair.phase = 'paired'; pair.expiresAt = null;
        await input.persist();
      });
    },
    async receive(envelope: InterconnectJoinEnvelope): Promise<InterconnectEnvelope | InterconnectFailure> {
      if (input.signal.aborted) return failure('unavailable');
      if (!uuid(envelope.pairId) || !uuid(envelope.invitationId) || !isExchangePublicKey(envelope.publicKey)) return failure('invalid-request');
      let pair = state.pairs.find((item) => item.id === envelope.pairId);
      let invitation: InterconnectState['invitations'][number] | undefined;
      let host: AccessSnapshot['host'] | undefined;
      let key: string;
      if (pair) {
        if (pair.phase !== 'paired' || pair.join?.invitationId !== envelope.invitationId
          || pair.join.publicKey !== envelope.publicKey) return failure('unauthorized');
        key = pair.key;
      } else {
        invitation = state.invitations.find((item) => item.id === envelope.invitationId);
        if (!invitation || invitation.expiresAt <= Date.now() || invitation.uses >= invitation.maxUses) return failure('invitation-expired');
        if (state.pairs.length >= 128) return failure('busy');
        host = (await input.local()).host;
        key = derivePairKey(invitation.privateKey, envelope.publicKey, {
          invitationId: invitation.id, key: invitation.key, hostId: host.id, publicKey: invitation.publicKey,
        }, envelope.pairId, envelope.publicKey);
      }
      const decoded = openJoin(envelope, key);
      const duplicate = input.rememberNonce(envelope);
      if (duplicate) return duplicate;
      const value = decoded.body;
      if (!record(value) || !keys(value, ['kind', 'hostId', 'name', 'invitationHash']) || value.kind !== 'pair'
        || !uuid(value.hostId) || !isName(value.name) || !secret(value.invitationHash)) return failure('invalid-request');
      if (value.invitationHash !== (pair ? pair.join!.invitationHash : invitation?.invitationHash)) return failure('conflict');
      if (pair) {
        if (pair.hostId !== value.hostId) return failure('unauthorized');
        host = await input.acceptName(pair, value.name);
      } else {
        if (!host || !invitation || value.hostId === host.id) return failure('invalid-request');
        const localCredential = randomBytes(32).toString('hex');
        const member = await input.createMember(value.name, localCredential);
        if (input.signal.aborted) return failure('unavailable');
        pair = {
          id: envelope.pairId, hostId: value.hostId, memberId: member.memberId, localCredential,
          key, phase: 'paired', expiresAt: null,
          join: {
            invitationId: envelope.invitationId, publicKey: envelope.publicKey,
            invitationHash: invitation.invitationHash,
          },
        };
        state.pairs.push(pair);
        invitation.uses++;
        await input.persist();
        host = member.host;
      }
      return sealJoin(envelope.invitationId, envelope.publicKey, pair.id, key, decoded.requestId,
        { kind: 'paired', hostId: host.id, name: host.name, invitationHash: pair.join!.invitationHash });
    },
  };
}
