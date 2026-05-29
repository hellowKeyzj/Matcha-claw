import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AcpFrameParser, encodeAcpJsonRpcMessage, type AcpJsonRpcMessage } from './acp-framing';
import type { RuntimeLauncherConfig, RuntimeProviderId } from '../runtime-provider-types';

interface PendingAcpRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: NodeJS.Timeout;
  epoch: number;
}

export interface AcpJsonRpcClientOptions {
  runtimeProviderId: RuntimeProviderId;
  launcher: RuntimeLauncherConfig;
}

export class AcpJsonRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private parser = new AcpFrameParser();
  private nextId = 1;
  private epoch = 0;
  private stderrTail = '';
  private readonly pending = new Map<string | number, PendingAcpRequest>();

  constructor(private readonly options: AcpJsonRpcClientOptions) {}

  get transportEpoch(): number {
    return this.epoch;
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  async request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const child = this.ensureChild();
    const id = this.nextId++;
    const epoch = this.epoch;
    const message: AcpJsonRpcMessage = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout, epoch });
      child.stdin.write(encodeAcpJsonRpcMessage(message), (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        reject(error);
      });
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.rejectAllPending(new Error(`ACP process stopped: ${this.options.runtimeProviderId}`));
    if (child && !child.killed) {
      child.kill();
    }
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) {
      return this.child;
    }
    this.epoch += 1;
    this.parser = new AcpFrameParser();
    const childEpoch = this.epoch;
    const child = spawn(this.options.launcher.command, this.options.launcher.args, {
      env: { ...process.env, ...this.options.launcher.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      if (this.child !== child || this.epoch !== childEpoch) {
        return;
      }
      for (const message of this.parser.push(chunk)) {
        this.handleMessage(message, childEpoch);
      }
    });
    child.stderr.on('data', (chunk) => {
      if (this.child !== child || this.epoch !== childEpoch) {
        return;
      }
      this.appendStderrTail(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    });
    child.on('exit', () => {
      if (this.child !== child || this.epoch !== childEpoch) {
        return;
      }
      this.child = null;
      this.rejectPendingForEpoch(childEpoch, new Error(`ACP process exited: ${this.options.runtimeProviderId}`));
    });
    child.on('error', (error) => {
      if (this.child !== child || this.epoch !== childEpoch) {
        return;
      }
      this.child = null;
      this.rejectPendingForEpoch(childEpoch, error);
    });
    this.child = child;
    return child;
  }

  private handleMessage(message: AcpJsonRpcMessage, epoch: number): void {
    if (message.id == null) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending || pending.epoch !== epoch) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error !== undefined) {
      pending.reject(message.error);
      return;
    }
    pending.resolve(message.result);
  }

  private appendStderrTail(chunk: string): void {
    this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
  }

  private rejectPendingForEpoch(epoch: number, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.epoch !== epoch) {
        continue;
      }
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }
}
