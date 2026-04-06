import { createHostEventSource } from './host-api';

let eventSource: EventSource | null = null;

type HostEventEnvelope<T = unknown> = {
  eventName: string;
  payload: T;
};

function getEventSource(): EventSource {
  if (!eventSource) {
    eventSource = createHostEventSource();
  }
  return eventSource;
}

function allowSseFallback(): boolean {
  try {
    return window.localStorage.getItem('clawx:allow-sse-fallback') === '1';
  } catch {
    return false;
  }
}

export function subscribeHostEvent<T = unknown>(
  eventName: string,
  handler: (payload: T) => void,
): () => void {
  const ipc = window.electron?.ipcRenderer;
  if (ipc?.on && ipc?.off) {
    const envelopeListener = (raw: unknown) => {
      const envelope = raw as HostEventEnvelope<T> | null;
      if (!envelope || envelope.eventName !== eventName) {
        return;
      }
      handler(envelope.payload);
    };
    const unsubscribe = ipc.on('host:event', envelopeListener);
    if (typeof unsubscribe === 'function') {
      return () => {
        unsubscribe();
      };
    }
    return () => {
      ipc.off('host:event', envelopeListener);
    };
  }

  if (!allowSseFallback()) {
    console.warn(`[host-events] host:event unavailable, SSE fallback disabled for "${eventName}"`);
    return () => {};
  }

  const source = getEventSource();
  const listener = (event: Event) => {
    const payload = JSON.parse((event as MessageEvent).data) as T;
    handler(payload);
  };
  source.addEventListener(eventName, listener);
  return () => {
    source.removeEventListener(eventName, listener);
  };
}
