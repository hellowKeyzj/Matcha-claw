import type { AppJson } from '@matcha/app-plugins-sdk';
import { base64ToBytes, bytesToBase64 } from '../documents/client';

export function encodePdfValue(value: unknown): AppJson {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof ArrayBuffer) return { $pdfBytes: bytesToBase64(new Uint8Array(value)), arrayBuffer: true };
  if (value instanceof Uint8Array) return { $pdfBytes: bytesToBase64(value), arrayBuffer: false };
  if (Array.isArray(value)) return Array.from(value, encodePdfValue);
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, encodePdfValue(entry)]));
  }
  throw new Error('PDF IPC returned a value that cannot be represented as JSON.');
}
export function decodePdfValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodePdfValue);
  if (value && typeof value === 'object') {
    if ('$pdfBytes' in value && typeof value.$pdfBytes === 'string') {
      const bytes = base64ToBytes(value.$pdfBytes);
      return 'arrayBuffer' in value && value.arrayBuffer === true ? bytes.buffer : bytes;
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodePdfValue(entry)]));
  }
  return value;
}
