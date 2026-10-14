/// <reference types="vite/client" />
import { Worker } from 'node:worker_threads';
import workerSource from './auth-profile-sqlite-worker.cjs?raw';

export type AuthProfileMutation =
  | Readonly<{ type: 'apply'; provider: string; profileId: string; legacyProfileId: string; profile: Record<string, unknown> }>
  | Readonly<{ type: 'remove'; profileId: string; legacyProfileId: string }>;

type FailureCode = 'auth-profile-read-invalid' | 'auth-profile-write-failed';
type WorkerReply =
  | Readonly<{ type: 'ready' }>
  | Readonly<{ type: 'completed'; id: number; changed: boolean }>
  | Readonly<{ type: 'failed'; id: number; code: FailureCode }>;

export class AuthProfileSqliteError extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
    this.name = 'AuthProfileSqliteError';
  }
}

const MAX_PENDING_WRITES = 64;

export class AuthProfileSqliteWriter {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly exit: Promise<number>;
  private status: 'starting' | 'open' | 'closing' | 'closed' | 'failed' = 'starting';
  private queue = Promise.resolve();
  private pending = 0;
  private nextId = 0;
  private active?: { id: number; resolve: (changed: boolean) => void; reject: (error: AuthProfileSqliteError) => void };
  private closePromise?: Promise<void>;

  private constructor(openClawStateDir: string) {
    // Vite inlines this trusted CJS source into the Main bundle: no runtime file,
    // app.asar path resolution, generated entry or credential-bearing eval text.
    this.worker = new Worker(workerSource, {
      eval: true,
      workerData: { openClawStateDir },
      stdout: true,
      stderr: true,
    });
    this.worker.stdout.resume();
    this.worker.stderr.resume();
    let resolveReady!: () => void;
    let rejectReady!: (error: AuthProfileSqliteError) => void;
    this.ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const fail = () => {
      this.status = 'failed';
      const error = new AuthProfileSqliteError('auth-profile-write-failed');
      rejectReady(error);
      this.active?.reject(error);
      this.active = undefined;
    };
    this.worker.on('error', fail);
    this.exit = new Promise<number>((resolve) => {
      this.worker.once('exit', (code) => {
        if (this.status !== 'closing' || code !== 0 || this.pending !== 0) fail();
        else this.status = 'closed';
        resolve(code);
      });
    });
    this.worker.on('message', (reply: WorkerReply) => {
      if (reply.type === 'ready' && this.status === 'starting') {
        this.status = 'open';
        resolveReady();
        return;
      }
      const active = this.active;
      if (reply.type === 'ready' || !active || active.id !== reply.id) {
        fail();
        void this.worker.terminate();
        return;
      }
      this.active = undefined;
      if (reply.type === 'completed') active.resolve(reply.changed);
      else active.reject(new AuthProfileSqliteError(
        reply.code === 'auth-profile-read-invalid' ? reply.code : 'auth-profile-write-failed',
      ));
    });
  }

  static async start(openClawStateDir: string): Promise<AuthProfileSqliteWriter> {
    let writer: AuthProfileSqliteWriter;
    try { writer = new AuthProfileSqliteWriter(openClawStateDir); }
    catch { throw new AuthProfileSqliteError('auth-profile-write-failed'); }
    try {
      await writer.ready;
      return writer;
    } catch (error) {
      await writer.close().catch(() => undefined);
      throw error;
    }
  }

  update(mutation: AuthProfileMutation): Promise<boolean> {
    if (this.status !== 'open' || this.pending >= MAX_PENDING_WRITES) {
      return Promise.reject(new AuthProfileSqliteError('auth-profile-write-failed'));
    }
    this.pending += 1;
    const operation = this.queue.then(() => {
      if (this.status === 'failed' || this.status === 'closed') {
        throw new AuthProfileSqliteError('auth-profile-write-failed');
      }
      return new Promise<boolean>((resolve, reject) => {
        const id = ++this.nextId;
        this.active = { id, resolve, reject };
        try { this.worker.postMessage({ type: 'update', id, mutation }); }
        catch {
          this.active = undefined;
          reject(new AuthProfileSqliteError('auth-profile-write-failed'));
        }
      });
    }).finally(() => { this.pending -= 1; });
    // Only one command (including its busy retries) can be in the worker at once.
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.status === 'open') this.status = 'closing';
    this.closePromise = (async () => {
      await this.queue;
      if (this.status === 'closing') this.worker.postMessage({ type: 'close' });
      const code = await this.exit;
      if (this.status !== 'closed' || code !== 0) throw new AuthProfileSqliteError('auth-profile-write-failed');
    })();
    return this.closePromise;
  }
}
