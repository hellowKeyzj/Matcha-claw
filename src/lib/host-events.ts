import { createHostEventSource } from './host-api';

let eventSource: EventSource | null = null;
let eventSourcePromise: Promise<EventSource> | null = null;

type HostEventEnvelope<T = unknown> = {
  eventName: string;
  payload: T;
};

type IpcRendererLike = {
  invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on?: (channel: string, callback: (...args: unknown[]) => void) => (() => void) | void;
  off?: (channel: string, callback?: (...args: unknown[]) => void) => void;
};

function getIpcRendererLike(): IpcRendererLike | undefined {
  return (window as unknown as {
    electron?: {
      ipcRenderer?: IpcRendererLike;
    };
  }).electron?.ipcRenderer;
}

async function getEventSource(): Promise<EventSource> {
  if (eventSource) {
    return eventSource;
  }

  if (!eventSourcePromise) {
    eventSourcePromise = createHostEventSource()
      .then((source) => {
        eventSource = source;
        return source;
      })
      .catch((error) => {
        eventSourcePromise = null;
        throw error;
      });
  }

  return await eventSourcePromise;
}

function allowSseFallback(): boolean {
  try {
    return window.localStorage.getItem('clawx:allow-sse-fallback') === '1';
  } catch {
    return false;
  }
}

function canResolveHostApiTokenForSse(): boolean {
  const ipc = getIpcRendererLike();
  return typeof ipc?.invoke === 'function';
}

export function subscribeHostEvent<T = unknown>(
  eventName: string,
  handler: (payload: T) => void,
): () => void {
  const ipc = getIpcRendererLike();

  if (typeof ipc?.on === 'function' && typeof ipc?.off === 'function') {
    const envelopeListener = (raw: unknown) => {
      const envelope = raw as HostEventEnvelope<T> | null;
      if (!envelope || envelope.eventName !== eventName) {
        return;
      }
      handler(envelope.payload);
    };
    const unsubscribe = ipc.on('host:event', envelopeListener as (...args: unknown[]) => void);
    if (typeof unsubscribe === 'function') {
      return () => {
        unsubscribe();
      };
    }
    return () => {
      ipc.off?.('host:event', envelopeListener as (...args: unknown[]) => void);
    };
  }

  if (!allowSseFallback()) {
    console.warn(`[host-events] host:event unavailable, SSE fallback disabled for "${eventName}"`);
    return () => {};
  }

  if (!canResolveHostApiTokenForSse()) {
    console.warn(`[host-events] SSE fallback requires hostapi:token IPC for "${eventName}"`);
    return () => {};
  }

  let disposed = false;
  let source: EventSource | null = null;
  let listener: ((event: Event) => void) | null = null;

  void (async () => {
    try {
      source = await getEventSource();
      if (disposed) {
        return;
      }

      listener = (event: Event) => {
        const payload = JSON.parse((event as MessageEvent).data) as T;
        handler(payload);
      };
      source.addEventListener(eventName, listener);
    } catch (error) {
      console.warn(`[host-events] SSE fallback failed for "${eventName}"`, error);
    }
  })();

  return () => {
    disposed = true;
    if (source && listener) {
      source.removeEventListener(eventName, listener);
    }
  };
}
