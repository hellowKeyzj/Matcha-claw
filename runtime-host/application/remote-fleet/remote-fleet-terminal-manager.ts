import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RuntimeHostLogger } from '../../shared/logger';
import {
  REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_RESULT_TYPE,
  REMOTE_FLEET_TERMINAL_CLOSE_SESSION_HOST_RPC_RESULT_TYPE,
  REMOTE_FLEET_TERMINAL_TICKET_RANDOM_BYTES,
  REMOTE_FLEET_TERMINAL_TICKET_TTL_MS,
  buildRemoteFleetTerminalStreamPath,
  isRemoteFleetTerminalStreamPath,
  isValidTerminalSize,
  normalizeTerminalSize,
  resolveRemoteFleetTerminalProviderKind,
  validateRemoteFleetTerminalSessionTarget,
  type RemoteFleetTerminalCloseSessionHostRpcResponse,
  type RemoteFleetTerminalCloseSessionRequestInput,
  type RemoteFleetTerminalControlFrame,
  type RemoteFleetTerminalIssueTicketHostRpcResponse,
  type RemoteFleetTerminalIssueTicketRequestInput,
  type RemoteFleetTerminalProviderKind,
  type RemoteFleetTerminalSessionTarget,
} from './remote-fleet-terminal-contracts';
import type {
  RemoteFleetTerminalProviderRegistry,
  RemoteFleetTerminalProviderStreamHandle,
  RemoteFleetTerminalSecretResolver,
} from './remote-fleet-terminal-providers';

const TERMINAL_FRAME_MAX_BYTES = 1024 * 1024;
const TERMINAL_CONTROL_FRAME_MAX_BYTES = 64 * 1024;
const TERMINAL_WS_BUFFERED_AMOUNT_HIGH_WATERMARK = 4 * 1024 * 1024;
const TERMINAL_WS_BUFFERED_AMOUNT_LOW_WATERMARK = 1024 * 1024;
const TERMINAL_BACKPRESSURE_RESUME_INTERVAL_MS = 50;

interface RemoteFleetTerminalManagerClock {
  nowMs(): number;
}

export interface RemoteFleetTerminalManagerDeps {
  readonly providers: RemoteFleetTerminalProviderRegistry;
  readonly secretResolver?: RemoteFleetTerminalSecretResolver;
  readonly logger?: Pick<RuntimeHostLogger, 'debug' | 'warn'>;
  readonly clock?: RemoteFleetTerminalManagerClock;
  readonly randomBytes?: (byteLength: number) => Buffer;
  readonly ticketTtlMs?: number;
  readonly maxFrameBytes?: number;
  readonly bufferedAmountHighWatermark?: number;
  readonly bufferedAmountLowWatermark?: number;
}

interface PendingTerminalTicket {
  readonly sessionId: string;
  readonly ticketHash: Buffer;
  readonly target: RemoteFleetTerminalSessionTarget;
  readonly providerKind: RemoteFleetTerminalProviderKind;
  readonly expiresAtMs: number;
}

interface ActiveTerminalSession {
  readonly sessionId: string;
  readonly ws: WebSocket;
  readonly provider: RemoteFleetTerminalProviderStreamHandle;
  resumeTimer: NodeJS.Timeout | null;
  closed: boolean;
}

export class RemoteFleetTerminalManager {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly pendingTickets = new Map<string, PendingTerminalTicket>();
  private readonly activeSessions = new Map<string, ActiveTerminalSession>();
  private disposed = false;

  constructor(private readonly deps: RemoteFleetTerminalManagerDeps) {}

  issueConnectionTicket(input: RemoteFleetTerminalIssueTicketRequestInput): RemoteFleetTerminalIssueTicketHostRpcResponse {
    if (this.disposed) {
      return issueTicketUnavailable('terminal-manager', 'Remote Fleet terminal manager is disposed.');
    }
    const validation = validateRemoteFleetTerminalSessionTarget(input);
    if (validation.resultType !== 'valid') {
      return issueTicketInvalid('terminal-manager', validation.message);
    }
    const providerKind = resolveRemoteFleetTerminalProviderKind({
      targetKind: input.session.targetKind,
      providerKind: input.providerKind,
    });
    if (!this.deps.providers.getProvider(providerKind)) {
      return issueTicketUnavailable('terminal-manager', `Remote Fleet terminal provider ${providerKind} is unavailable.`);
    }

    this.deleteTicketsForSession(input.session.id);
    const ticket = this.generateTicket();
    const expiresAtMs = this.nowMs() + this.ticketTtlMs();
    this.pendingTickets.set(input.session.id, {
      sessionId: input.session.id,
      ticketHash: hashTicket(ticket),
      target: input,
      providerKind,
      expiresAtMs,
    });
    return {
      type: REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_RESULT_TYPE,
      requestId: 'terminal-manager',
      resultType: 'issued',
      terminalConnection: {
        sessionId: input.session.id,
        ticket,
        websocketPath: buildRemoteFleetTerminalStreamPath({ sessionId: input.session.id, ticket }),
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    };
  }

  issueTicketForHostRequest(
    requestId: string,
    input: RemoteFleetTerminalIssueTicketRequestInput,
  ): RemoteFleetTerminalIssueTicketHostRpcResponse {
    return withRequestId(this.issueConnectionTicket(input), requestId);
  }

  async attachWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (!isRemoteFleetTerminalStreamPath(url.pathname)) {
      return false;
    }
    if (this.disposed) {
      closeUpgradeSocket(socket, 503, 'Remote Fleet terminal manager is disposed.');
      return true;
    }
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const ticket = url.searchParams.get('ticket') ?? '';
    const ticketResult = this.consumeTicket(sessionId, ticket);
    if (ticketResult.resultType !== 'accepted') {
      closeUpgradeSocket(socket, ticketResult.statusCode, ticketResult.message);
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      void this.openProviderStream(ws, ticketResult.ticket).catch((error) => {
        this.sendControlFrame(ws, {
          type: 'terminal.error',
          sessionId,
          message: 'Remote Fleet terminal provider failed to open.',
        });
        this.deps.logger?.warn?.('[remote-fleet:terminal] provider open failed', {
          sessionId,
          providerKind: ticketResult.ticket.providerKind,
          errorName: error instanceof Error ? error.name : typeof error,
        });
        ws.close(1011, 'provider open failed');
      });
    });
    return true;
  }

  closeSession(input: RemoteFleetTerminalCloseSessionRequestInput): RemoteFleetTerminalCloseSessionHostRpcResponse {
    const sessionId = input.session?.id;
    if (!sessionId) {
      return closeSessionInvalid('terminal-manager', 'Remote Fleet terminal session id is required.');
    }
    const wasPending = this.pendingTickets.delete(sessionId);
    const active = this.activeSessions.get(sessionId);
    if (active) {
      this.closeActiveSession(active, input.reason ?? 'closed by host request');
    }
    return {
      type: REMOTE_FLEET_TERMINAL_CLOSE_SESSION_HOST_RPC_RESULT_TYPE,
      requestId: 'terminal-manager',
      resultType: 'closed',
    };
  }

  closeSessionForHostRequest(
    requestId: string,
    input: RemoteFleetTerminalCloseSessionRequestInput,
  ): RemoteFleetTerminalCloseSessionHostRpcResponse {
    return withRequestId(this.closeSession(input), requestId);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.pendingTickets.clear();
    for (const active of this.activeSessions.values()) {
      this.closeActiveSession(active, 'terminal manager disposed');
    }
    this.activeSessions.clear();
    this.wss.close();
  }

  pendingTicketCount(): number {
    this.pruneExpiredTickets();
    return this.pendingTickets.size;
  }

  activeSessionCount(): number {
    return this.activeSessions.size;
  }

  private async openProviderStream(ws: WebSocket, ticket: PendingTerminalTicket): Promise<void> {
    const previousActive = this.activeSessions.get(ticket.sessionId);
    if (previousActive) {
      this.closeActiveSession(previousActive, 'terminal session reconnected');
    }
    const provider = this.deps.providers.getProvider(ticket.providerKind);
    if (!provider) {
      this.sendControlFrame(ws, {
        type: 'terminal.error',
        sessionId: ticket.sessionId,
        message: `Remote Fleet terminal provider ${ticket.providerKind} is unavailable.`,
      });
      ws.close(1011, 'provider unavailable');
      return;
    }
    const size = normalizeTerminalSize(ticket.target.size);
    const openResult = await provider.open({
      ...ticket.target,
      rows: size.rows,
      cols: size.cols,
      ...(this.deps.secretResolver ? { secretResolver: this.deps.secretResolver } : {}),
    });
    if (openResult.resultType !== 'opened') {
      this.sendControlFrame(ws, {
        type: 'terminal.error',
        sessionId: ticket.sessionId,
        message: openResult.message,
      });
      ws.close(1011, 'provider failed');
      return;
    }

    const active: ActiveTerminalSession = {
      sessionId: ticket.sessionId,
      ws,
      provider: openResult.handle,
      resumeTimer: null,
      closed: false,
    };
    this.activeSessions.set(ticket.sessionId, active);
    this.bindActiveSession(active);
    this.sendControlFrame(ws, { type: 'terminal.ready', sessionId: ticket.sessionId });
  }

  private bindActiveSession(active: ActiveTerminalSession): void {
    active.provider.onData((chunk) => {
      if (active.closed || active.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if (chunk.byteLength > this.maxFrameBytes()) {
        this.sendControlFrame(active.ws, {
          type: 'terminal.error',
          sessionId: active.sessionId,
          message: 'Remote Fleet terminal provider frame exceeded the safety limit.',
        });
        this.closeActiveSession(active, 'provider frame too large');
        return;
      }
      active.ws.send(chunk, { binary: true }, (error) => {
        if (error) {
          this.closeActiveSession(active, 'websocket send failed');
        }
      });
      this.applyProviderBackpressure(active);
    });
    active.provider.onExit((event) => {
      if (active.closed) return;
      this.sendControlFrame(active.ws, {
        type: 'terminal.exit',
        sessionId: active.sessionId,
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        ...(event.signal ? { signal: event.signal } : {}),
      });
      this.closeActiveSession(active, 'provider exited');
    });
    active.provider.onError((error) => {
      if (active.closed) return;
      this.sendControlFrame(active.ws, {
        type: 'terminal.error',
        sessionId: active.sessionId,
        message: error.message || 'Remote Fleet terminal provider error.',
      });
      this.closeActiveSession(active, 'provider error');
    });
    active.ws.on('message', (data, isBinary) => {
      this.handleClientFrame(active, data, isBinary);
    });
    active.ws.on('close', () => {
      this.closeActiveSession(active, 'websocket closed');
    });
    active.ws.on('error', () => {
      this.closeActiveSession(active, 'websocket error');
    });
  }

  private handleClientFrame(active: ActiveTerminalSession, data: WebSocket.RawData, isBinary: boolean): void {
    if (active.closed) {
      return;
    }
    const bytes = rawDataToBytes(data);
    const maxBytes = isBinary ? this.maxFrameBytes() : TERMINAL_CONTROL_FRAME_MAX_BYTES;
    if (bytes.byteLength > maxBytes) {
      this.sendControlFrame(active.ws, {
        type: 'terminal.error',
        sessionId: active.sessionId,
        message: 'Remote Fleet terminal frame exceeded the safety limit.',
      });
      this.closeActiveSession(active, 'client frame too large');
      return;
    }
    if (isBinary) {
      active.provider.write(bytes);
      return;
    }
    const controlFrame = parseControlFrame(bytes);
    if (!controlFrame) {
      this.sendControlFrame(active.ws, {
        type: 'terminal.error',
        sessionId: active.sessionId,
        message: 'Remote Fleet terminal control frame is invalid.',
      });
      this.closeActiveSession(active, 'invalid control frame');
      return;
    }
    this.handleControlFrame(active, controlFrame);
  }

  private handleControlFrame(active: ActiveTerminalSession, frame: RemoteFleetTerminalControlFrame): void {
    switch (frame.type) {
      case 'terminal.resize':
        if (!isValidTerminalSize({ rows: frame.rows, cols: frame.cols })) {
          this.sendControlFrame(active.ws, {
            type: 'terminal.error',
            sessionId: active.sessionId,
            message: 'Remote Fleet terminal resize frame is invalid.',
          });
          return;
        }
        active.provider.resize({ rows: frame.rows, cols: frame.cols });
        return;
      case 'terminal.close':
        this.closeActiveSession(active, frame.reason ?? 'client requested close');
        return;
      case 'terminal.ping':
        this.sendControlFrame(active.ws, {
          type: 'terminal.pong',
          ...(frame.nonce ? { nonce: frame.nonce } : {}),
        });
        return;
      case 'terminal.pong':
      case 'terminal.ready':
      case 'terminal.exit':
      case 'terminal.error':
        return;
    }
  }

  private applyProviderBackpressure(active: ActiveTerminalSession): void {
    if (!active.provider.pause || !active.provider.resume) {
      if (active.ws.bufferedAmount > this.bufferedAmountHighWatermark()) {
        this.closeActiveSession(active, 'websocket backpressure exceeded');
      }
      return;
    }
    if (active.ws.bufferedAmount <= this.bufferedAmountHighWatermark()) {
      return;
    }
    active.provider.pause();
    if (active.resumeTimer) {
      return;
    }
    active.resumeTimer = setInterval(() => {
      if (active.closed || active.ws.readyState !== WebSocket.OPEN) {
        clearResumeTimer(active);
        return;
      }
      if (active.ws.bufferedAmount <= this.bufferedAmountLowWatermark()) {
        active.provider.resume?.();
        clearResumeTimer(active);
      }
    }, TERMINAL_BACKPRESSURE_RESUME_INTERVAL_MS);
  }

  private closeActiveSession(active: ActiveTerminalSession, reason: string): void {
    if (active.closed) {
      return;
    }
    active.closed = true;
    clearResumeTimer(active);
    this.activeSessions.delete(active.sessionId);
    try {
      active.provider.close();
    } catch {
      // Provider close is best-effort cleanup; errors must not leak terminal data.
    }
    if (active.ws.readyState === WebSocket.OPEN || active.ws.readyState === WebSocket.CONNECTING) {
      active.ws.close(1000, reason.slice(0, 120));
    }
  }

  private consumeTicket(sessionId: string, ticket: string):
    | { readonly resultType: 'accepted'; readonly ticket: PendingTerminalTicket }
    | { readonly resultType: 'rejected'; readonly statusCode: number; readonly message: string } {
    this.pruneExpiredTickets();
    if (!sessionId || !ticket) {
      return { resultType: 'rejected', statusCode: 400, message: 'Remote Fleet terminal sessionId and ticket are required.' };
    }
    const pending = this.pendingTickets.get(sessionId);
    if (!pending) {
      return { resultType: 'rejected', statusCode: 401, message: 'Remote Fleet terminal ticket is not valid.' };
    }
    if (pending.expiresAtMs <= this.nowMs()) {
      this.pendingTickets.delete(sessionId);
      return { resultType: 'rejected', statusCode: 401, message: 'Remote Fleet terminal ticket expired.' };
    }
    if (!isSameTicketHash(pending.ticketHash, hashTicket(ticket))) {
      return { resultType: 'rejected', statusCode: 401, message: 'Remote Fleet terminal ticket is not valid.' };
    }
    this.pendingTickets.delete(sessionId);
    return { resultType: 'accepted', ticket: pending };
  }

  private deleteTicketsForSession(sessionId: string): void {
    this.pendingTickets.delete(sessionId);
  }

  private pruneExpiredTickets(): void {
    const nowMs = this.nowMs();
    for (const [sessionId, pending] of this.pendingTickets.entries()) {
      if (pending.expiresAtMs <= nowMs) {
        this.pendingTickets.delete(sessionId);
      }
    }
  }

  private sendControlFrame(ws: WebSocket, frame: RemoteFleetTerminalControlFrame): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(frame));
  }

  private generateTicket(): string {
    const random = this.deps.randomBytes ?? randomBytes;
    return random(REMOTE_FLEET_TERMINAL_TICKET_RANDOM_BYTES).toString('base64url');
  }

  private nowMs(): number {
    return this.deps.clock?.nowMs() ?? Date.now();
  }

  private ticketTtlMs(): number {
    return positiveOrDefault(this.deps.ticketTtlMs, REMOTE_FLEET_TERMINAL_TICKET_TTL_MS);
  }

  private maxFrameBytes(): number {
    return positiveOrDefault(this.deps.maxFrameBytes, TERMINAL_FRAME_MAX_BYTES);
  }

  private bufferedAmountHighWatermark(): number {
    return positiveOrDefault(this.deps.bufferedAmountHighWatermark, TERMINAL_WS_BUFFERED_AMOUNT_HIGH_WATERMARK);
  }

  private bufferedAmountLowWatermark(): number {
    return positiveOrDefault(this.deps.bufferedAmountLowWatermark, TERMINAL_WS_BUFFERED_AMOUNT_LOW_WATERMARK);
  }
}

function issueTicketUnavailable(requestId: string, message: string): RemoteFleetTerminalIssueTicketHostRpcResponse {
  return {
    type: REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_RESULT_TYPE,
    requestId,
    resultType: 'unavailable',
    message,
  };
}

function issueTicketInvalid(requestId: string, message: string): RemoteFleetTerminalIssueTicketHostRpcResponse {
  return {
    type: REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_RESULT_TYPE,
    requestId,
    resultType: 'invalidRequest',
    message,
  };
}

function closeSessionInvalid(requestId: string, message: string): RemoteFleetTerminalCloseSessionHostRpcResponse {
  return {
    type: REMOTE_FLEET_TERMINAL_CLOSE_SESSION_HOST_RPC_RESULT_TYPE,
    requestId,
    resultType: 'invalidRequest',
    message,
  };
}

function withRequestId<TResponse extends { readonly requestId: string }>(response: TResponse, requestId: string): TResponse {
  return { ...response, requestId };
}

function hashTicket(ticket: string): Buffer {
  return createHash('sha256').update(ticket).digest();
}

function isSameTicketHash(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function closeUpgradeSocket(socket: Duplex, statusCode: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText(statusCode)}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${Buffer.byteLength(message)}\r\n`
    + '\r\n'
    + message,
  );
}

function statusText(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 503:
      return 'Service Unavailable';
    default:
      return 'Error';
  }
}

function rawDataToBytes(data: WebSocket.RawData): Uint8Array {
  if (data instanceof Buffer) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(String(data));
}

function parseControlFrame(bytes: Uint8Array): RemoteFleetTerminalControlFrame | null {
  try {
    const payload = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    return isTerminalControlFrame(payload) ? payload : null;
  } catch {
    return null;
  }
}

function isTerminalControlFrame(value: unknown): value is RemoteFleetTerminalControlFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const frame = value as Record<string, unknown>;
  switch (frame.type) {
    case 'terminal.resize':
      return Number.isInteger(frame.rows) && Number.isInteger(frame.cols);
    case 'terminal.close':
      return frame.reason === undefined || typeof frame.reason === 'string';
    case 'terminal.ping':
    case 'terminal.pong':
      return frame.nonce === undefined || typeof frame.nonce === 'string';
    case 'terminal.ready':
    case 'terminal.exit':
    case 'terminal.error':
      return true;
    default:
      return false;
  }
}

function clearResumeTimer(active: ActiveTerminalSession): void {
  if (!active.resumeTimer) {
    return;
  }
  clearInterval(active.resumeTimer);
  active.resumeTimer = null;
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Number(value) : fallback;
}
