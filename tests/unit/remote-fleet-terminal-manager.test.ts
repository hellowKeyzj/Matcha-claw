import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { RemoteFleetTerminalManager } from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-manager';
import { createRemoteFleetTerminalProviderRegistry, type RemoteFleetTerminalProviderStreamHandle } from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-providers';
import type { RemoteFleetTerminalIssueTicketRequestInput } from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-contracts';

function terminalInput(overrides: Partial<RemoteFleetTerminalIssueTicketRequestInput> = {}): RemoteFleetTerminalIssueTicketRequestInput {
  return {
    reason: 'open',
    nowIso: '2026-07-08T00:00:00.000Z',
    session: {
      id: 'terminal-session-1',
      nodeId: 'node-1',
      targetKind: 'ssh-host',
      status: 'opening',
      createdAt: '2026-07-08T00:00:00.000Z',
      updatedAt: '2026-07-08T00:00:00.000Z',
    },
    node: {
      id: 'node-1',
      displayName: 'Node 1',
      targetKind: 'ssh-host',
      labels: [],
      enabled: true,
      publicConfig: {},
      secretRefs: {},
      health: { reason: 'unknown' },
      createdAt: '2026-07-08T00:00:00.000Z',
      updatedAt: '2026-07-08T00:00:00.000Z',
    },
    ...overrides,
  };
}

function createProviderHandle(): RemoteFleetTerminalProviderStreamHandle {
  const events = new EventEmitter();
  return {
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(() => events.removeAllListeners()),
    onData(listener) {
      events.on('data', listener);
    },
    onExit(listener) {
      events.on('exit', listener);
    },
    onError(listener) {
      events.on('error', listener);
    },
    pause: vi.fn(),
    resume: vi.fn(),
  };
}

function createSocket() {
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) { callback(); },
  });
  const written: Buffer[] = [];
  vi.spyOn(socket, 'write').mockImplementation((chunk: string | Buffer | Uint8Array, _encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (typeof _encoding === 'function') _encoding();
    if (callback) callback();
    return true;
  });
  vi.spyOn(socket, 'end').mockImplementation((chunk?: string | Buffer | Uint8Array | (() => void), _encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    if (typeof chunk !== 'function' && chunk !== undefined) {
      written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (typeof chunk === 'function') chunk();
    if (typeof _encoding === 'function') _encoding();
    if (callback) callback();
    return socket;
  });
  return { socket, written };
}

describe('RemoteFleetTerminalManager', () => {
  it('issues 128-bit+ single-use tickets without exposing stored ticket material', async () => {
    let nowMs = 1_000;
    const handle = createProviderHandle();
    const open = vi.fn(async () => ({ resultType: 'opened' as const, handle }));
    const manager = new RemoteFleetTerminalManager({
      providers: createRemoteFleetTerminalProviderRegistry([{ providerKind: 'ssh', open }]),
      clock: { nowMs: () => nowMs },
      randomBytes: (byteLength) => Buffer.alloc(byteLength, 7),
    });

    const issued = manager.issueConnectionTicket(terminalInput());

    expect(issued.resultType).toBe('issued');
    if (issued.resultType !== 'issued') throw new Error('ticket was not issued');
    expect(Buffer.from(issued.terminalConnection.ticket, 'base64url').byteLength).toBeGreaterThanOrEqual(16);
    expect(JSON.stringify(manager)).not.toContain(issued.terminalConnection.ticket);
    expect(manager.pendingTicketCount()).toBe(1);

    const req = {
      url: issued.terminalConnection.websocketPath,
      method: 'GET',
      headers: {
        host: '127.0.0.1',
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    } as IncomingMessage;
    const first = createSocket();
    const didHandleFirst = await manager.attachWebSocket(req, first.socket, Buffer.alloc(0));
    expect(didHandleFirst).toBe(true);
    expect(manager.pendingTicketCount()).toBe(0);

    const second = createSocket();
    const didHandleSecond = await manager.attachWebSocket(req, second.socket, Buffer.alloc(0));
    expect(didHandleSecond).toBe(true);
    expect(Buffer.concat(second.written).toString('utf8')).toContain('401 Unauthorized');
    expect(open).toHaveBeenCalledTimes(1);
    manager.dispose();
    nowMs += 1;
  });

  it('rejects expired tickets before opening provider streams', async () => {
    let nowMs = 10_000;
    const open = vi.fn(async () => ({ resultType: 'opened' as const, handle: createProviderHandle() }));
    const manager = new RemoteFleetTerminalManager({
      providers: createRemoteFleetTerminalProviderRegistry([{ providerKind: 'ssh', open }]),
      clock: { nowMs: () => nowMs },
      ticketTtlMs: 30_000,
    });
    const issued = manager.issueConnectionTicket(terminalInput());
    if (issued.resultType !== 'issued') throw new Error('ticket was not issued');

    nowMs += 30_001;
    const rejected = createSocket();
    const didHandle = await manager.attachWebSocket({ url: issued.terminalConnection.websocketPath, method: 'GET', headers: {} } as IncomingMessage, rejected.socket, Buffer.alloc(0));

    expect(didHandle).toBe(true);
    expect(Buffer.concat(rejected.written).toString('utf8')).toContain('401 Unauthorized');
    expect(open).not.toHaveBeenCalled();
    expect(manager.pendingTicketCount()).toBe(0);
    manager.dispose();
  });

  it('returns provider unavailable without issuing a secret to renderer', () => {
    const manager = new RemoteFleetTerminalManager({
      providers: createRemoteFleetTerminalProviderRegistry([]),
      randomBytes: () => Buffer.from('renderer-secret-ticket-should-not-appear'),
    });

    const result = manager.issueConnectionTicket(terminalInput());

    expect(result).toMatchObject({ resultType: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('renderer-secret-ticket-should-not-appear');
    expect(manager.pendingTicketCount()).toBe(0);
    manager.dispose();
  });
});
