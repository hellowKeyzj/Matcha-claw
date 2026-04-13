import { createHostEventSource } from './host-api';

let eventSource: EventSource | null = null;
let eventSourcePromise: Promise<EventSource> | null = null;
const HOST_EVENT_HUB_KEY = '__MATCHACLAW_HOST_EVENT_HUB__';

type HostEventEnvelope<T = unknown> = {
  eventName: string;
  payload: T;
};

type IpcRendererLike = {
  invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on?: (channel: string, callback: (...args: unknown[]) => void) => (() => void) | void;
  off?: (channel: string, callback?: (...args: unknown[]) => void) => void;
};

type HostEventDispatchHandler = (payload: unknown) => void;

type HostEventHub = {
  listenersByEvent: Map<string, Set<HostEventDispatchHandler>>;
  bridgeListener?: (...args: unknown[]) => void;
  bridgeUnsubscribe?: () => void;
};

function getIpcRendererLike(): IpcRendererLike | undefined {
  return (window as unknown as {
    electron?: {
      ipcRenderer?: IpcRendererLike;
    };
  }).electron?.ipcRenderer;
}

function getOrCreateHostEventHub(): HostEventHub {
  const hostWindow = window as unknown as Record<string, unknown>;
  const existing = hostWindow[HOST_EVENT_HUB_KEY];
  if (existing && typeof existing === 'object') {
    return existing as HostEventHub;
  }
  const created: HostEventHub = {
    listenersByEvent: new Map<string, Set<HostEventDispatchHandler>>(),
  };
  hostWindow[HOST_EVENT_HUB_KEY] = created;
  return created;
}

function detachIpcBridge(hub: HostEventHub): void {
  hub.bridgeUnsubscribe?.();
  hub.bridgeListener = undefined;
  hub.bridgeUnsubscribe = undefined;
}

function ensureIpcBridge(hub: HostEventHub, ipc: IpcRendererLike): void {
  if (hub.bridgeListener || typeof ipc.on !== 'function') {
    return;
  }

  const bridgeListener = (raw: unknown) => {
    const envelope = raw as HostEventEnvelope<unknown> | null;
    if (!envelope || typeof envelope.eventName !== 'string') {
      return;
    }
    const handlers = hub.listenersByEvent.get(envelope.eventName);
    if (!handlers || handlers.size === 0) {
      return;
    }
    for (const handler of Array.from(handlers)) {
      handler(envelope.payload);
    }
  };

  const unsubscribe = ipc.on('host:event', bridgeListener as (...args: unknown[]) => void);
  hub.bridgeListener = bridgeListener;
  if (typeof unsubscribe === 'function') {
    hub.bridgeUnsubscribe = unsubscribe;
    return;
  }
  hub.bridgeUnsubscribe = () => {
    ipc.off?.('host:event', bridgeListener as (...args: unknown[]) => void);
  };
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
    const hub = getOrCreateHostEventHub();
    ensureIpcBridge(hub, ipc);

    const dispatchHandler: HostEventDispatchHandler = (payload) => {
      handler(payload as T);
    };
    let listeners = hub.listenersByEvent.get(eventName);
    if (!listeners) {
      listeners = new Set<HostEventDispatchHandler>();
      hub.listenersByEvent.set(eventName, listeners);
    }
    listeners.add(dispatchHandler);

    return () => {
      const currentListeners = hub.listenersByEvent.get(eventName);
      if (!currentListeners) {
        return;
      }
      currentListeners.delete(dispatchHandler);
      if (currentListeners.size === 0) {
        hub.listenersByEvent.delete(eventName);
      }
      if (hub.listenersByEvent.size === 0) {
        detachIpcBridge(hub);
      }
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
