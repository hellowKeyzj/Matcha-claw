import i18n from '@/i18n';
import type { AppWebviewApi } from '@/types/desktop/app-plugin-sdk';

export type ApplicationOpenRequest = Parameters<AppWebviewApi['openApplication']>[0];

export interface ApplicationOpenChannel {
  readonly initial?: ApplicationOpenRequest;
  open(request: ApplicationOpenRequest): void;
  subscribe(listener: (request: ApplicationOpenRequest) => void): () => void;
}

export function createApplicationOpenChannel(initial?: ApplicationOpenRequest): ApplicationOpenChannel {
  let listener: ((request: ApplicationOpenRequest) => void) | undefined;
  const pending: ApplicationOpenRequest[] = [];
  return {
    initial,
    open(request) {
      if (listener) listener(request);
      else {
        if (pending.length >= 64) throw new Error(i18n.t('common:appFrame.tooManyRequests'));
        pending.push(request);
      }
    },
    subscribe(receive) {
      listener = receive;
      for (const request of pending.splice(0)) receive(request);
      return () => { if (listener === receive) listener = undefined; };
    },
  };
}


// Also serialized into the opaque iframe; keep this validator self-contained.
export function isApplicationOpenRequest(value: unknown): value is ApplicationOpenRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'applicationId' && key !== 'data')
    || typeof input.applicationId !== 'string' || input.applicationId.length > 96 || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(input.applicationId)) return false;
  const json = (item: unknown, depth: number): boolean => depth <= 64 && (item === null || typeof item === 'string' || typeof item === 'boolean'
    || typeof item === 'number' && Number.isFinite(item) || Array.isArray(item) && item.every(child => json(child, depth + 1))
    || !!item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype && Object.values(item).every(child => json(child, depth + 1)));
  try {
    return (input.data === undefined || json(input.data, 0)) && new TextEncoder().encode(JSON.stringify(input)).byteLength <= 8 * 1024 * 1024;
  } catch { return false; }
}
