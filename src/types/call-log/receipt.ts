import type { CallReceipt } from '../call-log';

export function decodeCallReceipt(value: unknown): CallReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid call receipt');
  }
  const receipt = value as Record<string, unknown>;
  if (Object.keys(receipt).length !== 2 || !Object.hasOwn(receipt, 'callId')
    || !Object.hasOwn(receipt, 'accepted') || typeof receipt.callId !== 'string'
    || !/^[a-f0-9]{32}$/.test(receipt.callId) || receipt.accepted !== true) {
    throw new Error('Invalid call receipt');
  }
  return { callId: receipt.callId, accepted: true };
}
