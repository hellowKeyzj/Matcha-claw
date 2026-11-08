import { createPrivateKey, createPublicKey } from 'node:crypto';

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function keys(value: Record<string, unknown>, required: string[]): boolean {
  return Object.keys(value).length === required.length && required.every((key) => Object.hasOwn(value, key));
}

export function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}

export function secret(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function name(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128
    && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}

function exchangeKey(value: unknown, kind: 'public' | 'private'): value is string {
  if (typeof value !== 'string' || !value.length || value.length > 172 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) return false;
    const key = kind === 'public' ? createPublicKey({ key: bytes, format: 'der', type: 'spki' })
      : createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
    return key.asymmetricKeyType === 'x25519'
      && key.export({ format: 'der', type: kind === 'public' ? 'spki' : 'pkcs8' }).toString('base64') === value;
  } catch { return false; }
}

export const isExchangePublicKey = (value: unknown): value is string => exchangeKey(value, 'public');
export const isExchangePrivateKey = (value: unknown): value is string => exchangeKey(value, 'private');
