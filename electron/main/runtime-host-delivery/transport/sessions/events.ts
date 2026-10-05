import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { isSessionTraceEnabled, logSessionTrace, summarizeIdentifier, summarizeSessionChanges, summarizeSessionIdentity } from './trace';
import { decodeSessionDelta, decodeSessionResync, type SessionDelta, type SessionResync } from './session-contract';

const ENDPOINT = '/api/sessions/events';
const DECISION_TTL_MS = 30_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;

export type SessionDeltaEventHandler = (delta: SessionDelta) => void;

export type SessionEventsTransportOptions = Readonly<{
  reconnectDelayMs?: number;
}>;

export interface SessionEventsTransport {
  onDelta(handler: SessionDeltaEventHandler): () => void;
  onResync(handler: (event: SessionResync) => void): () => void;
  onReconnect(handler: () => void): () => void;
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
  const resyncHandlers = new Set<(event: SessionResync) => void>();
  const reconnectHandlers = new Set<() => void>();
  let connected = false;
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
      if (connected) reconnectHandlers.forEach((handler) => handler());
      connected = true;
      await readEventStream(response.body, (frame) => {
        const value = parseEventData(frame.data);
        const tracing = isSessionTraceEnabled();
        if (tracing && (frame.event === 'session.delta' || frame.event === 'session.resync')) logSessionTrace('electron.session.sse.decode.before', 'session-events-boundary', {
          event: frame.event, eventId: summarizeIdentifier(frame.id), utf8Bytes: Buffer.byteLength(frame.data, 'utf8'), utf16Length: frame.data.length, parsed: value !== null,
        });
        if (frame.event === 'session.delta') {
          const delta = decodeSessionDelta(value);
          if (tracing) logSessionTrace('electron.session.sse.decode.after', 'session-events-boundary', {
            event: 'session.delta', decoded: !!delta, reason: delta ? null : 'strict-decode-rejected',
            ...(delta ? { identity: summarizeSessionIdentity(delta.identity), epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor,
              changes: summarizeSessionChanges(delta.changes), handlerCount: handlers.size } : {}),
          });
          if (!delta) return;
          if (frame.id !== undefined) lastEventId = frame.id;
          handlers.forEach((handler) => handler(delta));
          if (tracing) logSessionTrace('electron.session.sse.publish', 'session-events-boundary', {
            event: 'session.delta', identity: summarizeSessionIdentity(delta.identity), epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor,
          });
        } else if (frame.event === 'session.resync') {
          const event = decodeSessionResync(value);
          if (tracing) logSessionTrace('electron.session.sse.decode.after', 'session-events-boundary', {
            event: 'session.resync', decoded: !!event, reason: event ? null : 'strict-decode-rejected',
            ...(event ? { identity: summarizeSessionIdentity(event.identity), epoch: event.epoch, seq: event.seq, handlerCount: resyncHandlers.size } : {}),
          });
          if (!event) return;
          if (frame.id !== undefined) lastEventId = frame.id;
          resyncHandlers.forEach((handler) => handler(event));
        }
      });
      scheduleReconnect();
    } catch (error) {
      if (isSessionTraceEnabled()) logSessionTrace('electron.session.sse.failed', 'session-events-boundary', {
        aborted: requestController.signal.aborted, closed, lastEventId: summarizeIdentifier(lastEventId),
        error: summarizeIdentifier(error instanceof Error ? error.message : String(error)),
      });
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
    onResync(handler): () => void {
      resyncHandlers.add(handler);
      return () => { resyncHandlers.delete(handler); };
    },
    onReconnect(handler): () => void {
      reconnectHandlers.add(handler);
      return () => { reconnectHandlers.delete(handler); };
    },
    close(): void {
      closed = true;
      handlers.clear();
      resyncHandlers.clear();
      reconnectHandlers.clear();
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

function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data);
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
