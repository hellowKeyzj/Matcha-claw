import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntimeHostProcessScope, type RuntimeHostProcessScope } from '../runtime-host-delivery/process-scope';

async function within<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Network process timeout')), Math.max(1, milliseconds));
    })]);
  } finally { clearTimeout(timer); }
}

// Only this child and its Job/PGID are owned; never discover processes by port.
export class EasyTierProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly started: Promise<void>;
  readonly exited: Promise<void>;
  private readonly finished: Promise<void>;
  private scope?: RuntimeHostProcessScope;
  private hasExited = false;
  private spawnFailed = false;
  private inputFailed = false;
  private closing?: Promise<void>;

  constructor(executable: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(executable, [], { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe' });
    const spawned = new Promise<void>((resolve, reject) => {
      this.child.once('spawn', resolve);
      this.child.once('error', () => { this.spawnFailed = true; reject(new Error('Network spawn failed')); });
    });
    this.exited = new Promise<void>((resolve) => {
      this.child.once('exit', () => { this.hasExited = true; resolve(); });
      this.child.once('close', () => { this.hasExited = true; resolve(); });
    });
    this.finished = new Promise<void>((resolve) => this.child.once('close', resolve));
    this.child.stdin.on('error', () => { this.inputFailed = true; });
    // Native diagnostics are deliberately static; never copy control or business bytes into logs.
    this.child.stderr.resume();
    let scopeFailed = false;
    try {
      if (process.platform === 'win32' && this.child.pid !== undefined) {
        this.scope = createRuntimeHostProcessScope(this.child.pid, executable);
      }
    } catch { scopeFailed = true; }
    this.started = spawned.then(() => { if (scopeFailed) throw new Error('Network process scope failed'); });
    void this.started.catch(() => undefined);
  }

  get isRunning(): boolean { return !this.hasExited && !this.spawnFailed && !this.inputFailed; }

  waitForExit(milliseconds: number): Promise<void> { return within(this.finished, milliseconds); }

  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.scope) {
        await within(this.scope.terminate(), 5000);
      } else if (process.platform !== 'win32' && this.child.pid !== undefined) {
        try { process.kill(-this.child.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        const deadline = Date.now() + 5000;
        for (;;) {
          try { process.kill(-this.child.pid, 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') break; throw error; }
          if (Date.now() >= deadline) throw new Error('Network process group exit unconfirmed');
          await delay(25);
        }
      } else if (!this.hasExited) this.child.kill('SIGKILL');
      await within(this.finished, 5000);
    })().catch((error) => { this.closing = undefined; throw error; });
    return this.closing;
  }
}
