export type RuntimePlatform = 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd';

export type RuntimeProcessEnvironment = Record<string, string | undefined>;

export interface RuntimeCommandOptions {
  readonly cwd?: string;
  readonly env?: RuntimeProcessEnvironment;
  readonly timeout?: number;
  readonly windowsHide?: boolean;
  readonly shell?: boolean | string;
  readonly encoding?: BufferEncoding;
  readonly maxBuffer?: number;
}

export interface RuntimeHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface RuntimeHttpClientPort {
  request(url: string, init?: RequestInit): Promise<RuntimeHttpResponse>;
}

export interface RuntimeProcessInfoPort {
  readonly pid: number;
  readonly nodeVersion: string;
  readonly execPath: string;
  readonly platform: RuntimePlatform;
  readonly arch: string;
}

export type RuntimeProcessSignal = 'SIGINT' | 'SIGTERM';

export interface RuntimeProcessControlPort {
  onSignal(signal: RuntimeProcessSignal, handler: () => void): void;
  exit(code: number): never;
}

export interface RuntimeSystemEnvironmentPort {
  readonly appName: string;
  readonly appVersion: string;
  readonly isPackaged: boolean;
  readonly electronVersion?: string;
  readonly platform: RuntimePlatform;
  readonly arch: string;
  readonly workingDir: string;
  readonly homeDir: string;
  readonly tempDir: string;
  readonly locale: string;
  readonly resourcesPath: string | null;
  getEnv(name: string): string;
  getProcessEnv(): RuntimeProcessEnvironment;
}

export interface RuntimeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface RuntimeDirectoryEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

export interface RuntimeFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface RuntimeFileSystemPort {
  exists(pathname: string): Promise<boolean>;
  ensureDirectory(pathname: string): Promise<void>;
  listDirectory(pathname: string): Promise<RuntimeDirectoryEntry[]>;
  readTextFile(pathname: string): Promise<string>;
  readBinaryFile(pathname: string): Promise<Uint8Array>;
  writeTextFile(pathname: string, content: string): Promise<void>;
  writeBinaryFile(pathname: string, content: Uint8Array): Promise<void>;
  writeTextFileExclusive(pathname: string, content: string): Promise<boolean>;
  copyFile(sourcePathname: string, targetPathname: string): Promise<void>;
  removeFile(pathname: string): Promise<void>;
  removeDirectory(pathname: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  realPath(pathname: string): Promise<string>;
  stat(pathname: string): Promise<RuntimeFileStat>;
}

export interface RuntimeIdGeneratorPort {
  randomId(): string;
  randomHex(bytes: number): string;
}

export interface RuntimeClockPort {
  nowMs(): number;
  nowIso(): string;
  toIsoString(ms: number): string;
}

export interface RuntimeCommandExecutorPort {
  execFile(file: string, args: string[], options?: RuntimeCommandOptions): Promise<RuntimeCommandResult>;
}

export interface RuntimeScheduledTask {
  cancel(): void;
}

export interface RuntimeSchedulerPort {
  schedule(delayMs: number, task: () => void): RuntimeScheduledTask;
}

export interface RuntimeTcpProbePort {
  isReachable(host: string, port: number, timeoutMs: number): Promise<boolean>;
}

export interface RuntimeTimerPort {
  sleep(ms: number): Promise<void>;
}
