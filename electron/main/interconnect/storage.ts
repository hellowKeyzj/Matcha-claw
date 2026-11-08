import { createPrivateKey, createPublicKey } from 'node:crypto';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { ensurePrivateDirectory, readBoundedFile, replacePrivateFile } from '../../utils/private-file';
import { isExchangePrivateKey, isExchangePublicKey, keys, name, record, secret, uuid } from './validation';

export interface StoredPair {
  id: string;
  hostId: string;
  memberId: string;
  localCredential: string;
  key: string;
  phase: 'invited' | 'paired';
  expiresAt: number | null;
  join?: { invitationId: string; publicKey: string; invitationHash: string };
}

export interface StoredInvitation {
  id: string;
  name: string;
  key: string;
  publicKey: string;
  privateKey: string;
  invitationHash: string;
  expiresAt: number;
  maxUses: number;
  uses: number;
}

export interface InterconnectState {
  pairs: StoredPair[];
  invitations: StoredInvitation[];
}

const MAX_FILE = 1024 * 1024;
const PAIR_KEYS = ['id', 'hostId', 'memberId', 'localCredential', 'key', 'phase', 'expiresAt'];

function isPair(value: unknown): value is StoredPair {
  return record(value) && keys(value, Object.hasOwn(value, 'join') ? [...PAIR_KEYS, 'join'] : PAIR_KEYS)
    && uuid(value.id) && uuid(value.memberId)
    && secret(value.localCredential) && secret(value.key)
    && (!Object.hasOwn(value, 'join') || record(value.join) && keys(value.join, ['invitationId', 'publicKey', 'invitationHash'])
      && uuid(value.join.invitationId) && isExchangePublicKey(value.join.publicKey) && secret(value.join.invitationHash))
    && (value.phase === 'invited' && (value.hostId === '' || uuid(value.hostId))
      && Number.isSafeInteger(value.expiresAt) && (value.expiresAt as number) > 0
      || value.phase === 'paired' && uuid(value.hostId) && value.expiresAt === null);
}

function isInvitation(value: unknown, withHash = true): boolean {
  const fields = ['id', 'name', 'key', 'publicKey', 'privateKey', 'expiresAt', 'maxUses', 'uses'];
  if (!record(value) || !keys(value, withHash ? [...fields, 'invitationHash'] : fields)
    || withHash && !secret(value.invitationHash)
    || !uuid(value.id) || !name(value.name) || !secret(value.key)
    || !isExchangePublicKey(value.publicKey) || !isExchangePrivateKey(value.privateKey)
    || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= 0
    || !Number.isSafeInteger(value.maxUses) || (value.maxUses as number) < 1 || (value.maxUses as number) > 128
    || !Number.isSafeInteger(value.uses) || (value.uses as number) < 0 || (value.uses as number) > (value.maxUses as number)) return false;
  const privateKey = createPrivateKey({ key: Buffer.from(value.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64') === value.publicKey;
}

function isState(value: unknown): value is InterconnectState {
  if (!record(value) || !keys(value, ['pairs', 'invitations'])
    || !Array.isArray(value.pairs) || value.pairs.length > 128
    || !Array.isArray(value.invitations) || value.invitations.length > 32) return false;
  const pairIds = new Set<string>();
  const invitationIds = new Set<string>();
  return value.pairs.every((pair: unknown) => {
    if (!isPair(pair) || pairIds.has(pair.id)) return false;
    pairIds.add(pair.id);
    return true;
  }) && value.invitations.every((invitation: unknown) => {
    if (!record(invitation) || !uuid(invitation.id) || !isInvitation(invitation) || invitationIds.has(invitation.id)) return false;
    invitationIds.add(invitation.id);
    return true;
  });
}

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable() || process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    throw new Error('storage-unavailable');
  }
}

export async function loadInterconnectState(root: string): Promise<InterconnectState> {
  try {
    let bytes: Buffer;
    try { bytes = await readBoundedFile(join(root, 'state.json'), MAX_FILE); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { pairs: [], invitations: [] };
      throw error;
    }
    requireEncryption();
    const encrypted: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof encrypted !== 'string' || !encrypted.length) throw new Error('storage-unavailable');
    const ciphertext = Buffer.from(encrypted, 'base64');
    if (ciphertext.toString('base64') !== encrypted) throw new Error('storage-unavailable');
    const plaintext = safeStorage.decryptString(ciphertext);
    if (Buffer.byteLength(plaintext) > MAX_FILE) throw new Error('storage-unavailable');
    const stored: unknown = JSON.parse(plaintext);
    let state: unknown = record(stored) && keys(stored, ['pairs']) ? { pairs: stored.pairs, invitations: [] } : stored;
    // Existing encrypted pairs contain a duplicate label; Access owns the current member name.
    if (record(state) && Array.isArray(state.pairs)) state = { ...state, pairs: state.pairs.map((pair: unknown) => {
      if (!record(pair) || !Object.hasOwn(pair, 'name')) return pair;
      const { name: storedName, ...identity } = pair;
      if (!name(storedName)) throw new Error('storage-unavailable');
      return identity;
    }) };
    // Invitations without a network binding cannot admit new clients.
    if (record(state) && Array.isArray(state.invitations)) {
      const ids = new Set<unknown>();
      if (state.invitations.length > 32) throw new Error('storage-unavailable');
      state = { ...state, invitations: state.invitations.filter((invitation: unknown) => {
        if (!record(invitation) || ids.has(invitation.id)) throw new Error('storage-unavailable');
        ids.add(invitation.id);
        if (Object.hasOwn(invitation, 'invitationHash')) return true;
        if (!isInvitation(invitation, false)) throw new Error('storage-unavailable');
        return false;
      }) };
    }
    if (!isState(state)) throw new Error('storage-unavailable');
    return state;
  } catch { throw new Error('storage-unavailable'); }
}

export async function saveInterconnectState(root: string, state: InterconnectState): Promise<void> {
  try {
    if (!isState(state)) throw new Error('storage-unavailable');
    requireEncryption();
    const plaintext = JSON.stringify(state);
    if (Buffer.byteLength(plaintext) > MAX_FILE) throw new Error('storage-unavailable');
    const contents = JSON.stringify(safeStorage.encryptString(plaintext).toString('base64'));
    if (Buffer.byteLength(contents) > MAX_FILE) throw new Error('storage-unavailable');
    await loadInterconnectState(root);
    await ensurePrivateDirectory(root);
    await replacePrivateFile(join(root, 'state.json'), contents);
  } catch { throw new Error('storage-unavailable'); }
}
