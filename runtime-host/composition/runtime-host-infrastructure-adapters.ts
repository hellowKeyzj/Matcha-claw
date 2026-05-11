import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { ExecFileOptions } from 'node:child_process';
import type {
  RuntimeCommandExecutorPort,
  RuntimeCommandOptions,
  RuntimeCommandResult,
  RuntimeDirectoryEntry,
  RuntimeFileStat,
  RuntimeFileSystemPort,
  RuntimeClockPort,
  RuntimeHttpClientPort,
  RuntimeHttpResponse,
  RuntimeIdGeneratorPort,
  RuntimeProcessControlPort,
  RuntimeProcessSignal,
  RuntimeProcessInfoPort,
  RuntimeScheduledTask,
  RuntimeSchedulerPort,
  RuntimeSystemEnvironmentPort,
  RuntimeTcpProbePort,
  RuntimeTimerPort,
} from '../application/common/runtime-ports';
import type { RuntimeLogSink } from '../shared/logger';

const execFileAsync = promisify(execFile);

export class NodeRuntimeHttpClient implements RuntimeHttpClientPort {
  async request(url: string, init?: RequestInit): Promise<RuntimeHttpResponse> {
    return await fetch(url, init);
  }
}

export class NodeRuntimeProcessInfo implements RuntimeProcessInfoPort {
  get pid(): number {
    return process.pid;
  }

  get nodeVersion(): string {
    return process.versions.node;
  }

  get execPath(): string {
    return process.execPath;
  }

  get platform(): NodeJS.Platform {
    return process.platform;
  }

  get arch(): string {
    return process.arch;
  }
}

export class NodeRuntimeProcessControl implements RuntimeProcessControlPort {
  onSignal(signal: RuntimeProcessSignal, handler: () => void): void {
    process.on(signal, handler);
  }

  exit(code: number): never {
    process.exit(code);
  }
}

export class NodeRuntimeSystemEnvironment implements RuntimeSystemEnvironmentPort {
  get appName(): string {
    return 'MatchaClaw';
  }

  get appVersion(): string {
    return this.getEnv('MATCHACLAW_APP_VERSION') || '0.0.0';
  }

  get isPackaged(): boolean {
    return this.getEnv('MATCHACLAW_APP_PACKAGED') === '1';
  }

  get electronVersion(): string | undefined {
    const electronVersion = process.versions.electron;
    return typeof electronVersion === 'string' && electronVersion.trim()
      ? electronVersion
      : undefined;
  }

  get platform(): NodeJS.Platform {
    return process.platform;
  }

  get arch(): string {
    return process.arch;
  }

  get workingDir(): string {
    return process.cwd();
  }

  get homeDir(): string {
    return homedir();
  }

  get tempDir(): string {
    return tmpdir();
  }

  get locale(): string {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  }

  get resourcesPath(): string | null {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath;
    return typeof resourcesPath === 'string' && resourcesPath.trim()
      ? resourcesPath.trim()
      : null;
  }

  getEnv(name: string): string {
    return String(process.env[name] || '').trim();
  }

  getProcessEnv(): Record<string, string | undefined> {
    return { ...process.env };
  }
}

export class NodeRuntimeCommandExecutor implements RuntimeCommandExecutorPort {
  async execFile(file: string, args: string[], options?: RuntimeCommandOptions): Promise<RuntimeCommandResult> {
    const result = await execFileAsync(file, args, options as ExecFileOptions | undefined);
    return {
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
    };
  }
}

export class NodeRuntimeFileSystem implements RuntimeFileSystemPort {
  async exists(pathname: string): Promise<boolean> {
    return await access(pathname).then(() => true).catch(() => false);
  }

  async ensureDirectory(pathname: string): Promise<void> {
    await mkdir(pathname, { recursive: true });
  }

  async listDirectory(pathname: string): Promise<RuntimeDirectoryEntry[]> {
    const entries = await readdir(pathname, { withFileTypes: true, encoding: 'utf8' });
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    }));
  }

  async readTextFile(pathname: string): Promise<string> {
    return await readFile(pathname, 'utf8');
  }

  async readBinaryFile(pathname: string): Promise<Uint8Array> {
    return await readFile(pathname);
  }

  async writeTextFile(pathname: string, content: string): Promise<void> {
    await writeFile(pathname, content, 'utf8');
  }

  async writeBinaryFile(pathname: string, content: Uint8Array): Promise<void> {
    await writeFile(pathname, content);
  }

  async copyFile(sourcePathname: string, targetPathname: string): Promise<void> {
    await copyFile(sourcePathname, targetPathname);
  }

  async writeTextFileExclusive(pathname: string, content: string): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(pathname, 'wx');
      await handle.writeFile(content, 'utf8');
      return true;
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
  }

  async removeFile(pathname: string): Promise<void> {
    await rm(pathname, { force: true });
  }

  async removeDirectory(pathname: string): Promise<void> {
    await rm(pathname, { recursive: true, force: true });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await rename(oldPath, newPath);
  }

  async realPath(pathname: string): Promise<string> {
    return await realpath(pathname);
  }

  async stat(pathname: string): Promise<RuntimeFileStat> {
    const fileStat = await stat(pathname);
    return {
      isFile: fileStat.isFile(),
      isDirectory: fileStat.isDirectory(),
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  }
}

export class NodeRuntimeIdGenerator implements RuntimeIdGeneratorPort {
  randomId(): string {
    return randomUUID();
  }

  randomHex(bytes: number): string {
    return randomBytes(Math.max(1, bytes)).toString('hex');
  }
}

export class NodeRuntimeClock implements RuntimeClockPort {
  nowMs(): number {
    return Date.now();
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  toIsoString(ms: number): string {
    return new Date(ms).toISOString();
  }
}

export class ConsoleRuntimeLogSink implements RuntimeLogSink {
  debug(message: string): void {
    console.debug(message);
  }

  info(message: string): void {
    console.info(message);
  }

  warn(message: string): void {
    console.warn(message);
  }

  error(message: string): void {
    console.error(message);
  }
}

class NodeRuntimeScheduledTask implements RuntimeScheduledTask {
  private canceled = false;

  constructor(private readonly timer: NodeJS.Timeout) {}

  cancel(): void {
    if (this.canceled) {
      return;
    }
    this.canceled = true;
    clearTimeout(this.timer);
  }
}

export class NodeRuntimeScheduler implements RuntimeSchedulerPort {
  schedule(delayMs: number, task: () => void): RuntimeScheduledTask {
    const timer = setTimeout(task, Math.max(0, delayMs));
    return new NodeRuntimeScheduledTask(timer);
  }
}

export class NodeRuntimeTcpProbe implements RuntimeTcpProbePort {
  async isReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      let settled = false;

      const resolveOnce = (reachable: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        resolve(reachable);
      };

      socket.setTimeout(Math.max(250, timeoutMs));
      socket.once('connect', () => resolveOnce(true));
      socket.once('timeout', () => resolveOnce(false));
      socket.once('error', () => resolveOnce(false));
      socket.once('close', () => resolveOnce(false));
      socket.connect(port, host);
    });
  }
}

export class NodeRuntimeTimer implements RuntimeTimerPort {
  constructor(private readonly scheduler: RuntimeSchedulerPort) {}

  async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.scheduler.schedule(ms, resolve);
    });
  }
}
