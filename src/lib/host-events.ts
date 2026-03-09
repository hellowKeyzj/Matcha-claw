import { createHostEventSource } from './host-api';

let eventSource: EventSource | null = null;

function getEventSource(): EventSource {
  if (!eventSource) {
    eventSource = createHostEventSource();
  }
  return eventSource;
}

export function subscribeHostEvent<T = unknown>(
  eventName: string,
  handler: (payload: T) => void,
): () => void {
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
