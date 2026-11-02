import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntimeHostProcessScope, type RuntimeHostProcessScope } from '../runtime-host-delivery/process-scope';
import { AppPluginRuntimeStartupError, within, type AppPluginDevelopmentRuntime } from './runtime';

// Only processes spawned here belong to this scope; never discover or kill a port occupant.
export class AppPluginProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  private scope?: RuntimeHostProcessScope;
  private hasExited = false;
  private spawnError?: Error;
  private code: number | null = null;
  private terminating?: Promise<void>;

  private constructor(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe' });
    this.exited = new Promise<void>((resolve) => {
      this.child.once('error', (error) => { this.spawnError = error; });
      this.child.once('exit', (code) => { this.hasExited = true; this.code = code; resolve(); });
      this.child.once('close', () => { this.hasExited = true; resolve(); });
    });
    // Broken stdin is an execution failure, not an uncaught Main-process error.
    this.child.stdin.on('error', () => undefined);
  }

  static async launch(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<AppPluginProcess> {
    const owned = new AppPluginProcess(executable, args, cwd, env);
    try {
      if (process.platform === 'win32' && owned.child.pid !== undefined) owned.scope = createRuntimeHostProcessScope(owned.child.pid, executable);
      await new Promise<void>((resolve, reject) => { owned.child.once('spawn', resolve); owned.child.once('error', reject); });
      return owned;
    } catch (error) {
      try { await owned.forceClose(); }
      catch (cleanupError) { throw new AppPluginRuntimeStartupError(new AggregateError([error, cleanupError]), owned.asFailedRuntime()); }
      throw error;
    }
  }

  async wait(): Promise<void> {
    await this.exited;
    await this.terminateTree();
    if (this.spawnError) throw this.spawnError;
    if (this.code !== 0) throw new Error(`App plugin process exited (${this.code}); the operation was not retried.`);
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    try { await within(this.exited, 3000, 'App plugin process did not exit gracefully.'); }
    catch { await this.forceClose(); return; }
    await this.terminateTree();
  }

  async forceClose(): Promise<void> {
    await this.terminateTree();
    if (!this.hasExited) this.child.kill('SIGKILL');
    await within(this.exited, 5000, 'App plugin process exit was not confirmed; retain its execution directory.');
  }

  private terminateTree(): Promise<void> {
    this.terminating ??= (async () => {
      if (this.scope) { await within(this.scope.terminate(), 5000, 'App plugin process tree exit was not confirmed.'); return; }
      if (process.platform !== 'win32' && this.child.pid !== undefined) {
        try { process.kill(-this.child.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; return; }
        const deadline = Date.now() + 5000;
        for (;;) {
          try { process.kill(-this.child.pid, 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
          if (Date.now() >= deadline) throw new Error('App plugin process group exit was not confirmed; retain its execution directory.');
          await delay(25);
        }
      }
    })().catch((error) => { this.terminating = undefined; throw error; });
    return this.terminating;
  }

  private asFailedRuntime(): AppPluginDevelopmentRuntime {
    return { call: async () => { throw new Error('App plugin failed to start; stop its owned process before retrying.'); }, close: () => this.forceClose(), forceClose: () => this.forceClose() };
  }
}
