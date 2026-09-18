import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { decodeSessionDelta, type SessionDelta } from './session-contract';

const ENDPOINT = '/api/sessions/events';
const DECISION_TTL_MS = 30_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;

export type SessionDeltaEventHandler = (delta: SessionDelta) => void;

export type SessionEventsTransportOptions = Readonly<{
  reconnectDelayMs?: number;
}>;

export interface SessionEventsTransport {
  onDelta(handler: SessionDeltaEventHandler): () => void;
  close(): void;
}

type SseFrame = Readonly<{
  event?: string;
  data: string;
  id?: string;
}>;

export function createSessionEventsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
  options: SessionEventsTransportOptions = {},
): SessionEventsTransport {
  const url = `http://127.0.0.1:${runtimeHostTransportPort}${ENDPOINT}`;
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const handlers = new Set<SessionDeltaEventHandler>();
  let closed = false;
  let started = false;
  let controller: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastEventId: string | undefined;

  const connect = async (): Promise<void> => {
    if (closed) return;
    const requestController = new AbortController();
    controller = requestController;
    try {
      const response = await fetcher(url, {
        method: 'GET',
        headers: createHeaders(issuer, lastEventId),
        signal: requestController.signal,
      });
      if (closed) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        closed = true;
        return;
      }
      if (response.status !== 200 || !response.body) {
        scheduleReconnect();
        return;
      }
      await readEventStream(response.body, (frame) => {
        if (frame.id !== undefined) lastEventId = frame.id;
        if (frame.event !== 'session.delta') return;
        const delta = decodeSessionDeltaData(frame.data);
        if (delta) handlers.forEach((handler) => handler(delta));
      });
      scheduleReconnect();
    } catch {
      scheduleReconnect();
    } finally {
      if (controller === requestController) controller = null;
    }
  };

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, reconnectDelayMs);
  };

  return {
    onDelta(handler: SessionDeltaEventHandler): () => void {
      handlers.add(handler);
      if (!started) {
        started = true;
        void connect();
      }
      return () => {
        handlers.delete(handler);
      };
    },
    close(): void {
      closed = true;
      handlers.clear();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      controller?.abort();
      controller = null;
    },
  };
}

function createHeaders(
  issuer: RuntimeHostDeliveryIssuer,
  lastEventId: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    Authorization: `Bearer ${issuer.signDecision({
      principal: 'electron-main-local',
      endpoint: ENDPOINT,
      scope: 'session:events:read',
      capability: 'session.events',
      subject: 'session-events',
      expiresAt: Date.now() + DECISION_TTL_MS,
      revision: '1',
    })}`,
  };
  if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;
  return headers;
}

async function readEventStream(
  body: NonNullable<Response['body']>,
  onFrame: (frame: SseFrame) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseFrames(buffer);
      buffer = parsed.remaining;
      parsed.frames.forEach(onFrame);
    }
    buffer += decoder.decode();
    const parsed = parseSseFrames(buffer);
    parsed.frames.forEach(onFrame);
  } finally {
    reader.releaseLock();
  }
}

function decodeSessionDeltaData(data: string): SessionDelta | null {
  try {
    return decodeSessionDelta(JSON.parse(data));
  } catch {
    return null;
  }
}

function parseSseFrames(input: string): Readonly<{ frames: SseFrame[]; remaining: string }> {
  const frames: SseFrame[] = [];
  let frameStart = 0;
  let lineStart = 0;

  for (;;) {
    const lineFeed = input.indexOf('\n', lineStart);
    if (lineFeed === -1) break;
    const lineEnd = lineFeed > lineStart && input[lineFeed - 1] === '\r'
      ? lineFeed - 1
      : lineFeed;
    if (lineEnd === lineStart) {
      const frame = parseSseFrame(input.slice(frameStart, lineStart));
      if (frame) frames.push(frame);
      frameStart = lineFeed + 1;
    }
    lineStart = lineFeed + 1;
  }

  return { frames, remaining: input.slice(frameStart) };
}

function parseSseFrame(input: string): SseFrame | null {
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  for (const rawLine of input.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }

  if (event === undefined && id === undefined && data.length === 0) return null;
  return {
    ...(event === undefined ? {} : { event }),
    data: data.join('\n'),
    ...(id === undefined ? {} : { id }),
  };
}
