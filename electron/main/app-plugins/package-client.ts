import { join } from 'node:path';
import { isMarkedAsUntransferable, Worker } from 'node:worker_threads';
import { AppPluginError } from './package';
import type { PackageReply, PackageRequest, PackageResults, PackageWorkerRequest } from './package-contract';

export class AppPluginPackageWorker {
  private worker: Worker | undefined;
  private exited: Promise<void> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private pending: { resolve: (reply: PackageReply) => void; reject: (error: Error) => void } | undefined;
  private failure: Error | undefined;
  private closed = false;
  private closeSent = false;
  private closing: Promise<void> | undefined;
  private forcing: Promise<void> | undefined;

  process(request: Extract<PackageRequest, { operation: 'inspect' }>): Promise<PackageResults['inspect']>;
  process(request: Extract<PackageRequest, { operation: 'import' }>): Promise<PackageResults['import']>;
  process(request: Extract<PackageRequest, { operation: 'build' }>): Promise<PackageResults['build']>;
  process(request: Extract<PackageRequest, { operation: 'read' }>): Promise<PackageResults['read']>;
  process(request: Extract<PackageRequest, { operation: 'files' }>): Promise<PackageResults['files']>;
  process(request: Extract<PackageRequest, { operation: 'validate' }>): Promise<PackageResults['validate']>;
  process(request: Extract<PackageRequest, { operation: 'html' }>): Promise<PackageResults['html']>;
  process(request: Extract<PackageRequest, { operation: 'verify' }>): Promise<PackageResults['verify']>;
  process(request: PackageRequest): Promise<PackageResults[PackageRequest['operation']]> {
    if (this.closed) return Promise.reject(new AppPluginError('closed', 'App plugin package worker is closing.'));
    // The installer and host materialization share one package-only execution lane.
    const result = this.tail.then(() => this.run(request));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      await this.tail;
      if (this.worker && !this.failure) {
        this.closeSent = true;
        this.worker.postMessage({ operation: 'close' } satisfies PackageWorkerRequest);
      }
      await this.exited;
      if (this.failure) throw this.failure;
    })();
    return this.closing;
  }

  forceClose(): Promise<void> {
    this.closed = true;
    this.failure ??= new Error('App plugin package worker stopped before completion.');
    this.forcing ??= (async () => {
      await this.worker?.terminate();
      await this.exited;
      await this.tail;
    })();
    return this.forcing;
  }

  private start(): Worker {
    if (this.failure) throw this.failure;
    if (this.worker) return this.worker;
    let worker: Worker;
    try {
      worker = new Worker(join(__dirname, 'extensions', 'package-worker.js'), { stdout: true, stderr: true });
    } catch {
      this.failure = new Error('App plugin package worker could not start.');
      throw this.failure;
    }
    this.worker = worker;
    worker.stdout.resume();
    worker.stderr.resume();
    worker.on('message', (reply: PackageReply) => {
      this.pending?.resolve(reply);
      this.pending = undefined;
    });
    worker.once('error', () => { this.failure ??= new Error('App plugin package worker exited before completion.'); });
    worker.once('messageerror', () => { void this.forceClose().catch(() => undefined); });
    this.exited = new Promise<void>((resolve) => worker.once('exit', (code) => {
      this.worker = undefined;
      if (!this.closeSent || code !== 0) this.failure ??= new Error('App plugin package worker exited before completion.');
      if (this.failure) this.pending?.reject(this.failure);
      this.pending = undefined;
      resolve();
    }));
    return worker;
  }

  private async run(request: PackageRequest): Promise<PackageResults[PackageRequest['operation']]> {
    const worker = this.start();
    const transferList: ArrayBuffer[] = [];
    if ('bytes' in request) {
      // Byte requests consume caller-owned buffers; callers clone once to retain snapshots.
      // Node's small Buffer pool cannot transfer ownership.
      const bytes = request.bytes.buffer instanceof ArrayBuffer && !isMarkedAsUntransferable(request.bytes.buffer)
        ? request.bytes : new Uint8Array(request.bytes);
      if (bytes.buffer instanceof ArrayBuffer) transferList.push(bytes.buffer);
      request = { ...request, bytes };
    }
    const reply = await new Promise<PackageReply>((resolve, reject) => {
      this.pending = { resolve, reject };
      try { worker.postMessage(request, transferList); }
      catch (error) { this.pending = undefined; reject(error); }
    });
    if (!reply.ok) throw reply.code ? new AppPluginError(reply.code, reply.message) : new Error(reply.message);
    if (reply.operation !== request.operation) {
      void this.forceClose().catch(() => undefined);
      throw new Error('App plugin package worker returned a different operation.');
    }
    return reply.result;
  }
}
