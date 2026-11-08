import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes,
} from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { InterconnectEnvelope, InterconnectJoinEnvelope } from '../../../src/types/desktop/interconnect';
import type { NetworkInvitation } from '../network-access/provider';
import { isNetworkInvitation } from '../network-access/storage';
import { isExchangePrivateKey, isExchangePublicKey, keys, name, record, secret, uuid } from './validation';

export { isExchangePublicKey } from './validation';
export const INVITATION_TTL_MS = 24 * 60 * 60_000;

export interface Invitation {
  invitationId: string;
  key: string;
  nodeId: string;
  hostId: string;
  name: string;
  expiresAt: number;
  publicKey: string;
  network: NetworkInvitation;
}

type JoinMetadata = Pick<InterconnectJoinEnvelope, 'invitationId' | 'publicKey'>;

const MAX_INVITATION = 32 * 1024;
const MAX_PLAINTEXT = 1024 * 1024;
const MAX_ENVELOPE = 1536 * 1024;
const MAX_CIPHERTEXT = Math.ceil(MAX_PLAINTEXT / 3) * 4;
const VERSION = 'matcha.interconnect.v1';
const JOIN_VERSION = 'matcha.interconnect.join.v1';
const ENVELOPE_KEYS = ['kind', 'pairId', 'nonce', 'ciphertext', 'tag'];
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function isInvitation(value: unknown): value is Invitation {
  const now = Date.now();
  return record(value) && keys(value, ['invitationId', 'key', 'nodeId', 'hostId', 'name', 'expiresAt', 'publicKey', 'network'])
    && uuid(value.invitationId) && secret(value.key) && uuid(value.hostId) && name(value.name) && isExchangePublicKey(value.publicKey)
    && isNetworkInvitation(value.network)
    && typeof value.nodeId === 'string' && /^[1-9][0-9]{0,9}$/.test(value.nodeId) && Number(value.nodeId) <= 0xffff_ffff
    && Number.isSafeInteger(value.expiresAt) && (value.expiresAt as number) > 0 && (value.expiresAt as number) <= now + INVITATION_TTL_MS;
}

export function createInvitation(value: Invitation): string {
  try {
    if (!isInvitation(value) || value.expiresAt <= Date.now()) throw new Error('invalid-request');
    const invitation = `matcha:${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
    if (Buffer.byteLength(invitation) > MAX_INVITATION) throw new Error('invalid-request');
    return invitation;
  } catch { throw new Error('invalid-request'); }
}

export function parseInvitation(text: string): Invitation {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_INVITATION || !text.startsWith('matcha:')) throw new Error('invalid-request');
    const encoded = text.slice(7);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('invalid-request');
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error('invalid-request');
    const invitation: unknown = JSON.parse(decoder.decode(bytes));
    if (!isInvitation(invitation)) throw new Error('invalid-request');
    return invitation;
  } catch { throw new Error('invalid-request'); }
}

export function createExchangeKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

export function derivePairKey(privateKey: string, remotePublicKey: string, invitation: Pick<Invitation, 'invitationId' | 'key' | 'hostId' | 'publicKey'>, pairId: string, clientPublicKey: string): string {
  try {
    if (!isExchangePrivateKey(privateKey) || !isExchangePublicKey(remotePublicKey) || !record(invitation)
      || !uuid(invitation.invitationId) || !secret(invitation.key) || !uuid(invitation.hostId) || !isExchangePublicKey(invitation.publicKey)
      || !uuid(pairId) || !isExchangePublicKey(clientPublicKey)) throw new Error('invalid-request');
    const shared = diffieHellman({
      privateKey: createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' }),
      publicKey: createPublicKey({ key: Buffer.from(remotePublicKey, 'base64'), format: 'der', type: 'spki' }),
    });
    const info = JSON.stringify([JOIN_VERSION, invitation.invitationId, pairId, invitation.hostId, invitation.publicKey, clientPublicKey]);
    return Buffer.from(hkdfSync('sha256', shared, Buffer.from(invitation.key, 'hex'), Buffer.from(info), 32)).toString('hex');
  } catch { throw new Error('invalid-request'); }
}

function decode(value: unknown, maximum: number): Buffer {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maximum / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('invalid-request');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maximum || bytes.toString('base64') !== value) throw new Error('invalid-request');
  return bytes;
}

function payload(bytes: Buffer): { requestId: string; body: unknown } {
  if (bytes.length > MAX_PLAINTEXT) throw new Error('invalid-request');
  const value: unknown = JSON.parse(decoder.decode(bytes));
  const now = Date.now();
  if (!record(value) || !keys(value, ['requestId', 'issuedAt', 'body']) || !uuid(value.requestId)
    || !Number.isSafeInteger(value.issuedAt) || (value.issuedAt as number) < now - 30_000 || (value.issuedAt as number) > now + 5_000) throw new Error('invalid-request');
  return { requestId: value.requestId, body: value.body };
}

function aad(pairId: string, join?: JoinMetadata): Buffer {
  return Buffer.from(join ? JSON.stringify([JOIN_VERSION, pairId, join.invitationId, join.publicKey]) : `${VERSION}:${pairId}`);
}

function sealEnvelope(pairId: string, key: string, requestId: string, body: unknown, join?: JoinMetadata): InterconnectEnvelope {
  try {
    if (!uuid(pairId) || !secret(key) || !uuid(requestId)
      || join && (!uuid(join.invitationId) || !isExchangePublicKey(join.publicKey))) throw new Error('invalid-request');
    const plaintext = Buffer.from(JSON.stringify({ requestId, issuedAt: Date.now(), body }));
    payload(plaintext);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), nonce, { authTagLength: 16 });
    cipher.setAAD(aad(pairId, join));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: InterconnectEnvelope = {
      kind: 'interconnect', pairId, nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ...join,
    };
    if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_ENVELOPE) throw new Error('invalid-request');
    return envelope;
  } catch { throw new Error('invalid-request'); }
}

function openEnvelope(envelope: InterconnectEnvelope, key: string, join: boolean): { requestId: string; body: unknown } {
  try {
    if (!secret(key) || !record(envelope) || !keys(envelope, join ? [...ENVELOPE_KEYS, 'invitationId', 'publicKey'] : ENVELOPE_KEYS)
      || envelope.kind !== 'interconnect' || !uuid(envelope.pairId)
      || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > MAX_CIPHERTEXT) throw new Error('invalid-request');
    let metadata: JoinMetadata | undefined;
    if (join) {
      const { invitationId, publicKey } = envelope;
      if (!uuid(invitationId) || !isExchangePublicKey(publicKey)) throw new Error('invalid-request');
      metadata = { invitationId, publicKey };
    }
    const nonce = decode(envelope.nonce, 12);
    const ciphertext = decode(envelope.ciphertext, MAX_PLAINTEXT);
    const tag = decode(envelope.tag, 16);
    if (nonce.length !== 12 || tag.length !== 16 || Buffer.byteLength(JSON.stringify(envelope)) > MAX_ENVELOPE) throw new Error('invalid-request');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), nonce, { authTagLength: 16 });
    decipher.setAAD(aad(envelope.pairId, metadata));
    decipher.setAuthTag(tag);
    return payload(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch { throw new Error('invalid-request'); }
}

export function seal(pairId: string, key: string, requestId: string, body: unknown): InterconnectEnvelope {
  return sealEnvelope(pairId, key, requestId, body);
}

export function open(envelope: InterconnectEnvelope, key: string): { requestId: string; body: unknown } {
  return openEnvelope(envelope, key, false);
}

export function sealJoin(invitationId: string, publicKey: string, pairId: string, key: string, requestId: string, body: unknown): InterconnectJoinEnvelope {
  return sealEnvelope(pairId, key, requestId, body, { invitationId, publicKey }) as InterconnectJoinEnvelope;
}

export function openJoin(envelope: InterconnectJoinEnvelope, key: string): { requestId: string; body: unknown } {
  return openEnvelope(envelope, key, true);
}
