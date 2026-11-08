import type { NetworkRuntime } from '../../../src/types/desktop/network-access';
import type { EasyTierProcess } from './easytier-process';
import type { ReceiveNetworkRequest } from './provider';
import { keys, record } from './storage';

const MAX_FRAME = 2 * 1024 * 1024;
const MAX_REQUEST = 64 * 1024;
const UNKNOWN = { status: 503, body: { success: false, error: 'outcome-unknown' } } as const;
const UNAVAILABLE = { status: 503, body: { success: false, error: 'unavailable' } } as const;

type ControlErrorCode = 'unavailable' | 'outcome-unknown' | 'invalid-request';
export class NetworkControlError extends Error {
  constructor(readonly code: ControlErrorCode) { super(code); }
}
type Pending = {
  expected: 'ready' | 'runtime' | 'result';
  reject(error: NetworkControlError): void;
  resolve(value: unknown): void;
  failure: ControlErrorCode;
  clean(): void;
};
type Incoming = {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  replying: boolean;
  cancelWrite?: () => void;
};
type Outgoing = { frame?: Buffer; sent?: () => void };

function isNodeId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= 0xffff_ffff;
}
function isRuntime(value: unknown): value is NetworkRuntime {
  return record(value) && keys(value, ['nodeId', 'listeners', 'peerCount', 'peers']) && isNodeId(value.nodeId)
    && Array.isArray(value.listeners) && value.listeners.every((uri) => typeof uri === 'string' && uri.length <= 4096)
    && Number.isSafeInteger(value.peerCount) && (value.peerCount as number) >= 0
    && Array.isArray(value.peers) && value.peers.every((peer) => record(peer) && keys(peer, ['nodeId', 'name'])
      && isNodeId(peer.nodeId) && peer.nodeId !== value.nodeId && typeof peer.name === 'string' && peer.name.length <= 4096);
}

export class NativeNetworkControl {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly incoming = new Map<number, Incoming>();
  // Commands and accepted replies retain their 64 owner slots while waiting for stdin.
  private readonly outgoing = new Set<Outgoing>();
  private readonly rejections = new Map<number, { timer: ReturnType<typeof setTimeout>; cancelWrite(): void }>();
  private writing = false;
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private body?: Buffer;
  private bodyBytes = 0;
  private failed = false;
  private stopping = false;

  constructor(private readonly process: EasyTierProcess, private readonly receive: ReceiveNetworkRequest) {
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    process.child.stdout.on('data', this.readFrames);
    process.child.stdout.once('end', this.fail);
    process.child.stdout.once('error', this.fail);
    process.child.stdin.once('error', this.fail);
    process.child.stdin.on('drain', this.flush);
    process.child.once('error', this.fail);
    void process.exited.then(this.fail);
  }

  async start(configuration: string): Promise<NetworkRuntime> {
    return await this.command('start', { configuration }, 'ready') as NetworkRuntime;
  }
  async read(): Promise<NetworkRuntime> {
    return await this.command('read', {}, 'runtime') as NetworkRuntime;
  }
  async exchange(nodeId: string, request: object, signal?: AbortSignal): Promise<object> {
    try {
      if (!isNodeId(nodeId) || !record(request) || Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST) {
        return { status: 400, body: { success: false, error: 'invalid-request' } };
      }
      return await this.command('invoke', { nodeId, request }, 'result', signal) as object;
    } catch (error) {
      const code = error instanceof NetworkControlError ? error.code : 'outcome-unknown';
      return code === 'invalid-request' ? { status: 400, body: { success: false, error: code } }
        : { status: 503, body: { success: false, error: code } };
    }
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.cancelPending();
    this.clearWrites();
    try {
      // end(frame) appends one terminal frame after the already handed-off bytes, even under backpressure.
      this.process.child.stdin.end(!this.failed && this.process.isRunning ? this.frame({ kind: 'stop', id: this.nextId++ }) : undefined);
    } catch { this.fail(); }
  }
  dispose(): void {
    this.fail();
    this.process.child.stdout.off('data', this.readFrames);
    this.process.child.stdout.off('end', this.fail);
    this.process.child.stdout.off('error', this.fail);
    this.process.child.stdin.off('error', this.fail);
    this.process.child.stdin.off('drain', this.flush);
    this.process.child.off('error', this.fail);
    this.body = undefined;
  }

  private command(kind: 'start' | 'read' | 'invoke', payload: object, expected: Pending['expected'], signal?: AbortSignal): Promise<unknown> {
    if (this.stopping || this.failed || !this.process.isRunning || signal?.aborted || this.pending.size >= 64) {
      return Promise.reject(new NetworkControlError('unavailable'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let cancelWrite: (() => void) | undefined;
      const finish = (error: NetworkControlError) => this.settle(id, undefined, error);
      const abort = () => finish(new NetworkControlError(pending.failure));
      const timer = setTimeout(abort, 12_000);
      const pending: Pending = {
        expected, resolve, reject, failure: 'unavailable',
        clean: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); cancelWrite?.(); },
      };
      this.pending.set(id, pending);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        cancelWrite = this.write({ kind, id, ...payload }, () => {
          pending.failure = kind === 'invoke' ? 'outcome-unknown' : 'unavailable';
        });
      } catch (error) {
        finish(error instanceof NetworkControlError ? error : new NetworkControlError(pending.failure));
      }
    });
  }

  private frame(value: object | Buffer): Buffer {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    if (!body.length || body.length > MAX_FRAME) throw new NetworkControlError('invalid-request');
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32BE(body.length);
    body.copy(frame, 4);
    return frame;
  }

  private write(value: object | Buffer, sent?: () => void): () => void {
    const entry: Outgoing = { frame: this.frame(value), sent };
    this.outgoing.add(entry);
    this.flush();
    return () => { this.outgoing.delete(entry); entry.frame = undefined; };
  }

  private readonly flush = (): void => {
    if (this.failed || this.stopping) return;
    if (!this.process.isRunning) { this.fail(); return; }
    const input = this.process.child.stdin;
    if (this.writing || input.writableNeedDrain) return;
    this.writing = true;
    try {
      for (const entry of this.outgoing) {
        this.outgoing.delete(entry);
        const frame = entry.frame!;
        entry.frame = undefined;
        entry.sent?.();
        const writable = input.write(frame, (error) => { if (error) this.fail(); });
        if (!writable || this.failed || this.stopping) return;
      }
    } catch { this.fail(); }
    finally { this.writing = false; }
  };

  private rejectIncoming(id: number, response: object): void {
    // Native admission is also 64; excess unaccepted requests retain its own timeout.
    if (this.rejections.size >= 64) return;
    const timer = setTimeout(() => { this.rejections.get(id)?.cancelWrite(); this.rejections.delete(id); }, 7000);
    this.rejections.set(id, { timer, cancelWrite: () => {} });
    const cancelWrite = this.write({ kind: 'reply', id, response }, () => {
      clearTimeout(timer); this.rejections.delete(id);
    });
    const entry = this.rejections.get(id);
    if (entry) entry.cancelWrite = cancelWrite;
  }

  private clearWrites(): void {
    for (const { controller, timer } of this.incoming.values()) { clearTimeout(timer); controller.abort(); }
    this.incoming.clear();
    for (const { timer } of this.rejections.values()) clearTimeout(timer);
    this.rejections.clear();
    for (const entry of this.outgoing) entry.frame = undefined;
    this.outgoing.clear();
  }

  private readonly readFrames = (chunk: Buffer): void => {
    if (this.failed) return;
    let offset = 0;
    try {
      while (offset < chunk.length && !this.failed) {
        if (!this.body) {
          const length = Math.min(4 - this.headerBytes, chunk.length - offset);
          chunk.copy(this.header, this.headerBytes, offset, offset + length);
          this.headerBytes += length; offset += length;
          if (this.headerBytes !== 4) continue;
          const size = this.header.readUInt32BE();
          if (!size || size > MAX_FRAME) throw new Error('Invalid network frame');
          this.body = Buffer.allocUnsafe(size); this.bodyBytes = 0; this.headerBytes = 0;
        }
        const length = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
        chunk.copy(this.body, this.bodyBytes, offset, offset + length);
        this.bodyBytes += length; offset += length;
        if (this.bodyBytes !== this.body.length) continue;
        const event: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.body));
        this.body = undefined;
        this.onEvent(event);
      }
    } catch { this.fail(); }
  };

  private onEvent(event: unknown): void {
    if (!record(event) || !Number.isSafeInteger(event.id) || (event.id as number) < 0) throw new Error('Invalid network event');
    const id = event.id as number;
    if (event.kind === 'incoming' && keys(event, ['kind', 'id', 'request'])) {
      if (this.stopping) return;
      if (this.incoming.has(id) || this.rejections.has(id)) throw new Error('Duplicate network incoming');
      if (!record(event.request) || Buffer.byteLength(JSON.stringify(event.request)) > MAX_REQUEST) {
        this.rejectIncoming(id, { status: 400, body: { success: false, error: 'invalid-request' } });
        return;
      }
      if (this.incoming.size >= 64) { this.rejectIncoming(id, UNAVAILABLE); return; }
      const controller = new AbortController();
      const release = () => {
        const entry = this.incoming.get(id);
        if (!entry) return;
        this.incoming.delete(id); clearTimeout(entry.timer); controller.abort(); entry.cancelWrite?.();
      };
      const finish = (response: object) => {
        const entry = this.incoming.get(id);
        if (!entry || entry.replying || this.stopping || this.failed) return;
        entry.replying = true; controller.abort();
        if (this.stopping || this.failed) return;
        try {
          const reply = Buffer.from(JSON.stringify({ kind: 'reply', id, response }));
          entry.cancelWrite = this.write(reply.length <= MAX_FRAME ? reply : { kind: 'reply', id, response: UNKNOWN }, release);
        } catch { this.fail(); }
      };
      const timer = setTimeout(() => { finish(UNKNOWN); release(); }, 7000);
      this.incoming.set(id, { controller, timer, replying: false });
      void Promise.resolve().then(() => this.receive(event.request as object, controller.signal))
        .then((response) => finish(record(response) ? response : UNKNOWN), () => finish(UNKNOWN));
      return;
    }
    if (event.kind === 'failure' && keys(event, ['kind', 'id', 'error'])
      && (event.error === 'unavailable' || event.error === 'outcome-unknown' || event.error === 'invalid-request')) {
      this.settle(id, undefined, new NetworkControlError(event.error)); return;
    }
    if ((event.kind === 'ready' || event.kind === 'runtime') && keys(event, ['kind', 'id', 'runtime']) && isRuntime(event.runtime)) {
      this.settleExpected(id, event.kind, event.runtime); return;
    }
    if (event.kind === 'result' && keys(event, ['kind', 'id', 'response']) && record(event.response)) {
      this.settleExpected(id, 'result', event.response); return;
    }
    throw new Error('Invalid network event');
  }

  private settleExpected(id: number, kind: Pending['expected'], value: unknown): void {
    const pending = this.pending.get(id);
    if (pending && pending.expected !== kind) throw new Error('Unexpected network event');
    this.settle(id, value);
  }
  private settle(id: number, value: unknown, error?: NetworkControlError): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id); pending.clean();
    if (error) pending.reject(error); else pending.resolve(value);
  }
  private cancelPending(): void {
    for (const [id, pending] of this.pending) this.settle(id, undefined, new NetworkControlError(pending.failure));
  }
  private readonly fail = (): void => {
    if (this.failed) return;
    this.failed = true;
    this.cancelPending();
    this.clearWrites();
    this.body = undefined;
    this.resolveClosed();
  };
}
