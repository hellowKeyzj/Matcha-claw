/**
 * Gateway Process Manager
 * Manages the OpenClaw Gateway process lifecycle
 */
import { app } from 'electron';
import path from 'path';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, readFileSync } from 'fs';
import WebSocket from 'ws';
import { PORTS } from '../utils/config';
import { 
  getOpenClawDir, 
  getOpenClawConfigDir,
  getDefaultOpenClawConfigDir,
  setOpenClawConfigDirOverride,
  getOpenClawEntryPath, 
  isOpenClawBuilt, 
  isOpenClawPresent 
} from '../utils/paths';
import { getSetting, setSetting } from '../utils/store';
import { getApiKey, getDefaultProvider, getProvider } from '../utils/secure-storage';
import { getProviderEnvVar, getKeyableProviderTypes } from '../utils/provider-registry';
import { GatewayEventType, JsonRpcNotification, isNotification, isResponse } from './protocol';
import {
  buildPosixPortOwnerProbeScript,
  buildWindowsPortOwnerProbeScript,
  isLikelyWslPortProxyCommand,
  tryConvertPosixWslUncToWindowsPath,
} from './runtime-utils';
import { logger } from '../utils/logger';
import { getUvMirrorEnv } from '../utils/uv-env';
import { isPythonReady, setupManagedPython } from '../utils/uv-setup';
import {
  loadOrCreateDeviceIdentity,
  signDevicePayload,
  publicKeyRawBase64UrlFromPem,
  buildDeviceAuthPayload,
  type DeviceIdentity,
} from '../utils/device-identity';

/**
 * Gateway connection status
 */
export interface GatewayStatus {
  state: 'stopped' | 'starting' | 'running' | 'error' | 'reconnecting';
  port: number;
  pid?: number;
  uptime?: number;
  error?: string;
  connectedAt?: number;
  version?: string;
  reconnectAttempts?: number;
}

/**
 * Gateway Manager Events
 */
export interface GatewayManagerEvents {
  status: (status: GatewayStatus) => void;
  message: (message: unknown) => void;
  notification: (notification: JsonRpcNotification) => void;
  exit: (code: number | null) => void;
  error: (error: Error) => void;
  'channel:status': (data: { channelId: string; status: string }) => void;
  'chat:message': (data: { message: unknown }) => void;
}

/**
 * Reconnection configuration
 */
interface ReconnectConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
}

const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  maxAttempts: 10,
  baseDelay: 1000,
  maxDelay: 30000,
};

const FAST_ATTACH_HANDSHAKE_TIMEOUT_MS = 1200;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10000;
const ATTACH_TOTAL_BUDGET_MS = 3000;
const ATTACH_RETRY_INTERVAL_MS = 200;
const FAST_ATTACH_TOTAL_BUDGET_MS = 1200;
const PORT_OWNER_PROBE_TIMEOUT_MS = 3500;

export type GatewayHostRuntime = 'linux' | 'wsl' | 'windows' | 'macos';

/**
 * Get the Node.js-compatible executable path for spawning child processes.
 *
 * On macOS in packaged mode, using `process.execPath` directly causes the
 * child process to appear as a separate dock icon (named "exec") because the
 * binary lives inside a `.app` bundle that macOS treats as a GUI application.
 *
 * To avoid this, we resolve the Electron Helper binary which has
 * `LSUIElement` set in its Info.plist, preventing dock icon creation.
 * Falls back to `process.execPath` if the Helper binary is not found.
 */
function getNodeExecutablePath(): string {
  if (process.platform === 'darwin' && app.isPackaged) {
    // Electron Helper binary lives at:
    // <App>.app/Contents/Frameworks/<ProductName> Helper.app/Contents/MacOS/<ProductName> Helper
    const appName = app.getName();
    const helperName = `${appName} Helper`;
    const helperPath = path.join(
      path.dirname(process.execPath), // .../Contents/MacOS
      '../Frameworks',
      `${helperName}.app`,
      'Contents/MacOS',
      helperName,
    );
    if (existsSync(helperPath)) {
      logger.debug(`Using Electron Helper binary to avoid dock icon: ${helperPath}`);
      return helperPath;
    }
    logger.debug(`Electron Helper binary not found at ${helperPath}, falling back to process.execPath`);
  }
  return process.execPath;
}

/**
 * Gateway Manager
 * Handles starting, stopping, and communicating with the OpenClaw Gateway
 */
export class GatewayManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private ownsProcess = false;
  private ws: WebSocket | null = null;
  private status: GatewayStatus = { state: 'stopped', port: PORTS.OPENCLAW_GATEWAY };
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private reconnectConfig: ReconnectConfig;
  private shouldReconnect = true;
  private startLock = false;
  private lastSpawnSummary: string | null = null;
  private pendingRequests: Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private deviceIdentity: DeviceIdentity | null = null;
  private runtimePaths: {
    hostRuntime: GatewayHostRuntime;
    configDir: string;
    workspaceDir?: string;
    configPath?: string;
  } = {
      hostRuntime: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
      configDir: getDefaultOpenClawConfigDir(),
    };
  
  constructor(config?: Partial<ReconnectConfig>) {
    super();
    this.reconnectConfig = { ...DEFAULT_RECONNECT_CONFIG, ...config };
    this.initDeviceIdentity();
    const localRuntime = this.detectLocalRuntime();
    this.runtimePaths.hostRuntime = localRuntime;
    this.runtimePaths.configDir = this.getDefaultConfigDirForRuntime(localRuntime);
    setOpenClawConfigDirOverride(this.runtimePaths.configDir);
  }

  private initDeviceIdentity(): void {
    try {
      const identityPath = path.join(app.getPath('userData'), 'clawx-device-identity.json');
      this.deviceIdentity = loadOrCreateDeviceIdentity(identityPath);
      logger.debug(`Device identity loaded (deviceId=${this.deviceIdentity.deviceId})`);
    } catch (err) {
      logger.warn('Failed to load device identity, scopes will be limited:', err);
    }
  }

  private sanitizeSpawnArgs(args: string[]): string[] {
    const sanitized = [...args];
    const tokenIdx = sanitized.indexOf('--token');
    if (tokenIdx !== -1 && tokenIdx + 1 < sanitized.length) {
      sanitized[tokenIdx + 1] = '[redacted]';
    }
    return sanitized;
  }

  private formatExit(code: number | null, signal: NodeJS.Signals | null): string {
    if (code !== null) return `code=${code}`;
    if (signal) return `signal=${signal}`;
    return 'code=null signal=null';
  }

  private classifyStderrMessage(message: string): { level: 'drop' | 'debug' | 'warn'; normalized: string } {
    const msg = message.trim();
    if (!msg) return { level: 'drop', normalized: msg };

    // Known noisy lines that are not actionable for Gateway lifecycle debugging.
    if (msg.includes('openclaw-control-ui') && msg.includes('token_mismatch')) return { level: 'drop', normalized: msg };
    if (msg.includes('closed before connect') && msg.includes('token mismatch')) return { level: 'drop', normalized: msg };

    // Downgrade frequent non-fatal noise.
    if (msg.includes('ExperimentalWarning')) return { level: 'debug', normalized: msg };
    if (msg.includes('DeprecationWarning')) return { level: 'debug', normalized: msg };
    if (msg.includes('Debugger attached')) return { level: 'debug', normalized: msg };

    return { level: 'warn', normalized: msg };
  }

  private truncateForLog(input: string, maxLen = 220): string {
    const normalized = input.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return 'n/a';
    }
    if (normalized.length <= maxLen) {
      return normalized;
    }
    return `${normalized.slice(0, maxLen)}...`;
  }

  private formatProbeDiagnostics(
    probe: {
      status: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
      stdout?: string | Buffer | null;
      stderr?: string | Buffer | null;
    },
    elapsedMs: number,
  ): string {
    const stdoutRaw = (() => {
      if (probe.stdout == null) return '';
      return typeof probe.stdout === 'string' ? probe.stdout : probe.stdout.toString('utf-8');
    })();
    const stderrRaw = (() => {
      if (probe.stderr == null) return '';
      return typeof probe.stderr === 'string' ? probe.stderr : probe.stderr.toString('utf-8');
    })();
    const errorCode =
      probe.error && typeof (probe.error as NodeJS.ErrnoException).code === 'string'
        ? (probe.error as NodeJS.ErrnoException).code
        : 'n/a';
    const errorMsg = probe.error ? this.truncateForLog(probe.error.message, 180) : 'n/a';
    return `elapsedMs=${elapsedMs}, status=${probe.status ?? 'null'}, signal=${probe.signal ?? 'null'}, errorCode=${errorCode}, errorMsg=${errorMsg}, stdout="${this.truncateForLog(stdoutRaw)}", stderr="${this.truncateForLog(stderrRaw)}"`;
  }

  private isWslKernel(): boolean {
    if (process.platform !== 'linux') {
      return false;
    }
    if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
      return true;
    }
    try {
      const osrelease = readFileSync('/proc/sys/kernel/osrelease', 'utf-8').toLowerCase();
      return osrelease.includes('microsoft');
    } catch {
      return false;
    }
  }

  private detectLocalRuntime(): GatewayHostRuntime {
    if (process.platform === 'win32') return 'windows';
    if (process.platform === 'darwin') return 'macos';
    return this.isWslKernel() ? 'wsl' : 'linux';
  }

  private isLikelyWindowsPath(input: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\');
  }

  private convertWslPathToWindows(posixPath: string): string | undefined {
    if (process.platform !== 'win32' || !posixPath.startsWith('/')) {
      return undefined;
    }
    try {
      const converted = spawnSync('wsl.exe', ['wslpath', '-w', posixPath], {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 1500,
      });
      if (converted.status !== 0) {
        return undefined;
      }
      const out = (converted.stdout ?? '').trim();
      return out.length > 0 ? out : undefined;
    } catch (error) {
      logger.debug('Failed to convert WSL path to Windows path:', error);
      return undefined;
    }
  }

  private getWslDefaultConfigDirFromWindows(): string | undefined {
    if (process.platform !== 'win32') {
      return undefined;
    }
    try {
      const probe = spawnSync(
        'wsl.exe',
        ['sh', '-lc', 'printf %s "$HOME/.openclaw"'],
        {
          encoding: 'utf-8',
          windowsHide: true,
          timeout: 1500,
        },
      );
      if (probe.status !== 0) {
        return undefined;
      }
      const posixPath = (probe.stdout ?? '').trim();
      if (!posixPath) {
        return undefined;
      }
      return this.convertWslPathToWindows(posixPath);
    } catch (error) {
      logger.debug('Failed to resolve WSL default config dir from Windows:', error);
      return undefined;
    }
  }

  private getDefaultConfigDirForRuntime(hostRuntime: GatewayHostRuntime): string {
    if (hostRuntime === 'wsl' && process.platform === 'win32') {
      return this.getWslDefaultConfigDirFromWindows() ?? getDefaultOpenClawConfigDir();
    }
    return getDefaultOpenClawConfigDir();
  }

  private applyHostRuntime(hostRuntime: GatewayHostRuntime): void {
    const nextConfigDir = this.getDefaultConfigDirForRuntime(hostRuntime);
    this.runtimePaths = {
      ...this.runtimePaths,
      hostRuntime,
      configDir: nextConfigDir,
      configPath: undefined,
      workspaceDir: undefined,
    };
    setOpenClawConfigDirOverride(nextConfigDir);
    logger.debug(`Gateway host runtime set: ${hostRuntime}, configDir=${nextConfigDir}`);
  }

  private isPortListeningInWsl(port: number): boolean {
    if (process.platform !== 'win32') {
      return false;
    }
    try {
      const probe = spawnSync(
        'wsl.exe',
        ['sh', '-lc', `ss -H -ltn 'sport = :${port}' | head -n 1`],
        {
          encoding: 'utf-8',
          windowsHide: true,
          timeout: 1200,
        },
      );
      if (probe.status !== 0) {
        return false;
      }
      return (probe.stdout ?? '').trim().length > 0;
    } catch (error) {
      logger.debug('Failed to detect WSL listening port:', error);
      return false;
    }
  }

  private isPortListeningInWindows(port: number): boolean {
    if (process.platform !== 'win32') {
      return false;
    }
    try {
      const probe = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.LocalPort })`],
        {
          encoding: 'utf-8',
          windowsHide: true,
          timeout: 1200,
        },
      );
      if (probe.status !== 0) {
        return false;
      }
      return (probe.stdout ?? '').trim().length > 0;
    } catch (error) {
      logger.debug('Failed to detect Windows listening port:', error);
      return false;
    }
  }

  private async detectGatewayHostRuntimeByProcess(port: number): Promise<GatewayHostRuntime> {
    const localRuntime = this.detectLocalRuntime();
    if (process.platform !== 'win32') {
      return localRuntime;
    }

    const listeningInWindows = this.isPortListeningInWindows(port);
    const listeningInWsl = this.isPortListeningInWsl(port);

    if (listeningInWindows && !listeningInWsl) {
      return 'windows';
    }
    if (listeningInWsl && !listeningInWindows) {
      return 'wsl';
    }

    const saved = await getSetting('gatewayHostRuntime');
    if (saved === 'windows' || saved === 'wsl') {
      return saved;
    }
    return localRuntime;
  }

  private isOpenClawProcessCommand(command?: string): boolean {
    if (!command) {
      return false;
    }
    const normalized = command.toLowerCase();
    return normalized.includes('openclaw') || normalized.includes('openclaw.mjs') || normalized.includes(' gateway ');
  }

  private getWindowsPortOwner(port: number): { occupied: boolean; pid?: number; command?: string } {
    if (process.platform !== 'win32') {
      return { occupied: false };
    }
    try {
      const script = buildWindowsPortOwnerProbeScript(port);
      const startedAt = Date.now();
      const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: PORT_OWNER_PROBE_TIMEOUT_MS,
      });
      const elapsedMs = Date.now() - startedAt;
      if (probe.status !== 0) {
        logger.debug(`Windows port owner probe failed (port=${port}): ${this.formatProbeDiagnostics(probe, elapsedMs)}`);
        return { occupied: false };
      }
      const raw = (probe.stdout ?? '').trim();
      if (!raw) {
        logger.debug(`Windows port owner probe returned empty output (port=${port}): ${this.formatProbeDiagnostics(probe, elapsedMs)}`);
        return { occupied: false };
      }
      try {
        const parsed = JSON.parse(raw) as { occupied?: boolean; pid?: number; command?: string };
        return {
          occupied: Boolean(parsed.occupied),
          pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
          command: typeof parsed.command === 'string' ? parsed.command : undefined,
        };
      } catch (error) {
        logger.debug(
          `Windows port owner probe returned non-JSON output (port=${port}): ${this.formatProbeDiagnostics(probe, elapsedMs)}`,
          error,
        );
        return { occupied: false };
      }
    } catch (error) {
      logger.debug('Failed to query Windows port owner:', error);
      return { occupied: false };
    }
  }

  private getWslPortOwnerFromWindows(port: number): { occupied: boolean; pid?: number; command?: string } {
    if (process.platform !== 'win32') {
      return { occupied: false };
    }
    try {
      const startedAt = Date.now();
      const probe = spawnSync('wsl.exe', ['--exec', 'ss', '-H', '-ltnp', `sport = :${port}`], {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: PORT_OWNER_PROBE_TIMEOUT_MS,
      });
      const elapsedMs = Date.now() - startedAt;
      if (probe.status !== 0) {
        logger.debug(`WSL port owner probe failed (port=${port}): ${this.formatProbeDiagnostics(probe, elapsedMs)}`);
        return { occupied: false };
      }
      const raw = (probe.stdout ?? '').trim();
      if (!raw) {
        logger.debug(`WSL port owner probe returned empty output (port=${port}): ${this.formatProbeDiagnostics(probe, elapsedMs)}`);
        return { occupied: false };
      }
      const firstLine = raw.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
      if (!firstLine) {
        logger.debug(`WSL port owner probe returned no parsable line (port=${port}): ${this.formatProbeDiagnostics(probe, elapsedMs)}`);
        return { occupied: false };
      }
      const pidMatch = firstLine.match(/pid=([0-9]+)/);
      const pid = pidMatch ? Number(pidMatch[1]) : undefined;
      let command: string | undefined;
      if (typeof pid === 'number' && Number.isFinite(pid)) {
        const psStartedAt = Date.now();
        const psProbe = spawnSync('wsl.exe', ['--exec', 'ps', '-p', String(pid), '-o', 'args='], {
          encoding: 'utf-8',
          windowsHide: true,
          timeout: PORT_OWNER_PROBE_TIMEOUT_MS,
        });
        const psElapsedMs = Date.now() - psStartedAt;
        if (psProbe.status !== 0) {
          logger.debug(`WSL pid command probe failed (port=${port}, pid=${pid}): ${this.formatProbeDiagnostics(psProbe, psElapsedMs)}`);
        } else {
          const psRaw = (psProbe.stdout ?? '').trim();
          if (psRaw.length > 0) {
            command = psRaw.split(/\r?\n/)[0]?.trim() || undefined;
          }
        }
      }
      return {
        occupied: true,
        pid: typeof pid === 'number' && Number.isFinite(pid) ? pid : undefined,
        command,
      };
    } catch (error) {
      logger.debug('Failed to query WSL port owner:', error);
      return { occupied: false };
    }
  }

  private getLocalPortOwner(port: number): { occupied: boolean; pid?: number; command?: string } {
    if (process.platform === 'win32') {
      return this.getWindowsPortOwner(port);
    }
    try {
      const script = buildPosixPortOwnerProbeScript(port);
      const probe = spawnSync('sh', ['-lc', script], {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: PORT_OWNER_PROBE_TIMEOUT_MS,
      });
      if (probe.status !== 0) {
        return { occupied: false };
      }
      const raw = (probe.stdout ?? '').trim();
      if (!raw) {
        return { occupied: false };
      }
      const [occupiedFlag, pidRaw, ...cmdParts] = raw.split('|');
      if (occupiedFlag !== '1') {
        return { occupied: false };
      }
      const pid = Number(pidRaw);
      return {
        occupied: true,
        pid: Number.isFinite(pid) ? pid : undefined,
        command: cmdParts.join('|').trim() || undefined,
      };
    } catch (error) {
      logger.debug('Failed to query local port owner:', error);
      return { occupied: false };
    }
  }

  private async detectAttachTarget(port: number): Promise<{
    occupied: boolean;
    hostRuntime: GatewayHostRuntime;
    ownerKind: 'openclaw' | 'other' | 'unknown';
    details: string;
  }> {
    const localRuntime = this.detectLocalRuntime();
    if (process.platform !== 'win32') {
      const owner = this.getLocalPortOwner(port);
      if (!owner.occupied) {
        return {
          occupied: false,
          hostRuntime: localRuntime,
          ownerKind: 'unknown',
          details: 'port not occupied',
        };
      }
      if (owner.command && !this.isOpenClawProcessCommand(owner.command)) {
        return {
          occupied: true,
          hostRuntime: localRuntime,
          ownerKind: 'other',
          details: `pid=${owner.pid ?? 'unknown'} cmd=${owner.command}`,
        };
      }
      return {
        occupied: true,
        hostRuntime: localRuntime,
        ownerKind: owner.command ? 'openclaw' : 'unknown',
        details: `pid=${owner.pid ?? 'unknown'} cmd=${owner.command ?? 'n/a'}`,
      };
    }

    const winOwner = this.getWindowsPortOwner(port);
    const wslOwner = this.getWslPortOwnerFromWindows(port);
    logger.debug(
      `Attach target probe summary (port=${port}): win={occupied=${winOwner.occupied}, pid=${winOwner.pid ?? 'n/a'}, cmd="${this.truncateForLog(winOwner.command ?? '')}"}, wsl={occupied=${wslOwner.occupied}, pid=${wslOwner.pid ?? 'n/a'}, cmd="${this.truncateForLog(wslOwner.command ?? '')}"}`,
    );
    if (!winOwner.occupied && !wslOwner.occupied) {
      logger.debug(
        `Attach target resolved as not occupied (port=${port}); this may indicate a transient probe miss when external gateway is expected.`,
      );
      return {
        occupied: false,
        hostRuntime: 'windows',
        ownerKind: 'unknown',
        details: 'port not occupied',
      };
    }

    const chooseHost = async (): Promise<GatewayHostRuntime> => {
      if (winOwner.occupied && !wslOwner.occupied && isLikelyWslPortProxyCommand(winOwner.command)) {
        logger.debug(`Attach target host decision: prefer wsl due to Windows WSL proxy signature (port=${port})`);
        return 'wsl';
      }
      if (winOwner.occupied && !wslOwner.occupied) return 'windows';
      if (wslOwner.occupied && !winOwner.occupied) return 'wsl';
      const winLooksOpenClaw = this.isOpenClawProcessCommand(winOwner.command);
      const wslLooksOpenClaw = this.isOpenClawProcessCommand(wslOwner.command);
      if (winLooksOpenClaw && !wslLooksOpenClaw) return 'windows';
      if (wslLooksOpenClaw && !winLooksOpenClaw) return 'wsl';
      const saved = await getSetting('gatewayHostRuntime');
      if (saved === 'windows' || saved === 'wsl') return saved;
      return 'windows';
    };
    const hostRuntime = await chooseHost();
    const usingWslProxyFallback =
      hostRuntime === 'wsl' &&
      !wslOwner.occupied &&
      winOwner.occupied &&
      isLikelyWslPortProxyCommand(winOwner.command);
    const owner = hostRuntime === 'wsl' && wslOwner.occupied ? wslOwner : winOwner;
    if (usingWslProxyFallback) {
      return {
        occupied: true,
        hostRuntime,
        ownerKind: 'unknown',
        details: `host=${hostRuntime} proxyPid=${winOwner.pid ?? 'unknown'} cmd=${winOwner.command ?? 'n/a'}`,
      };
    }
    if (owner.command && !this.isOpenClawProcessCommand(owner.command)) {
      return {
        occupied: true,
        hostRuntime,
        ownerKind: 'other',
        details: `host=${hostRuntime} pid=${owner.pid ?? 'unknown'} cmd=${owner.command}`,
      };
    }
    return {
      occupied: true,
      hostRuntime,
      ownerKind: owner.command ? 'openclaw' : 'unknown',
      details: `host=${hostRuntime} pid=${owner.pid ?? 'unknown'} cmd=${owner.command ?? 'n/a'}`,
    };
  }

  private readGatewayTokenFromConfigDir(configDir: string): string | undefined {
    try {
      const configPath = path.join(configDir, 'openclaw.json');
      if (!existsSync(configPath)) {
        return undefined;
      }
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as {
        gateway?: { auth?: { token?: unknown } };
      };
      const token = parsed?.gateway?.auth?.token;
      if (typeof token !== 'string') {
        return undefined;
      }
      const trimmed = token.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch (error) {
      logger.debug('Failed to read gateway.auth.token from openclaw.json:', error);
      return undefined;
    }
  }

  private readGatewayTokenFromWslConfig(): string | undefined {
    if (process.platform !== 'win32') {
      return undefined;
    }
    try {
      const probe = spawnSync(
        'wsl.exe',
        ['sh', '-lc', 'cat ~/.openclaw/openclaw.json 2>/dev/null'],
        {
          encoding: 'utf-8',
          windowsHide: true,
          timeout: 1500,
        },
      );
      if (probe.status !== 0) {
        return undefined;
      }
      const raw = (probe.stdout ?? '').trim();
      if (!raw) {
        return undefined;
      }
      const parsed = JSON.parse(raw) as {
        gateway?: { auth?: { token?: unknown } };
      };
      const token = parsed?.gateway?.auth?.token;
      if (typeof token !== 'string') {
        return undefined;
      }
      const trimmed = token.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch (error) {
      logger.debug('Failed to read gateway.auth.token from WSL openclaw.json:', error);
      return undefined;
    }
  }

  private resolvePathForHost(hostRuntime: GatewayHostRuntime, input?: string): string | undefined {
    if (!input || typeof input !== 'string') {
      return undefined;
    }
    const trimmed = input.trim();
    if (!trimmed) {
      return undefined;
    }
    if (hostRuntime === 'wsl' && process.platform === 'win32') {
      if (this.isLikelyWindowsPath(trimmed)) {
        return trimmed;
      }
      const uncPath = tryConvertPosixWslUncToWindowsPath(trimmed);
      if (uncPath) {
        return uncPath;
      }
      return this.convertWslPathToWindows(trimmed) ?? trimmed;
    }
    return trimmed;
  }

  private inferHostRuntimeFromGatewayPaths(
    fallback: GatewayHostRuntime,
    configPathRaw?: string,
    workspaceRaw?: string,
    sessionsPathRaw?: string,
  ): GatewayHostRuntime {
    if (process.platform !== 'win32') {
      return fallback;
    }
    const hasPosixStylePath = [configPathRaw, workspaceRaw, sessionsPathRaw]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .some((value) => value.startsWith('/'));
    if (hasPosixStylePath) {
      return 'wsl';
    }
    if (this.isLikelyWindowsPath(configPathRaw ?? '') || this.isLikelyWindowsPath(workspaceRaw ?? '') || this.isLikelyWindowsPath(sessionsPathRaw ?? '')) {
      return 'windows';
    }
    return fallback;
  }

  private async refreshRuntimePathsFromGateway(): Promise<void> {
    if (!this.isConnected()) {
      return;
    }

    let configPathRaw: string | undefined;
    let workspaceRaw: string | undefined;
    let sessionsPathRaw: string | undefined;

    try {
      const snapshot = await this.rpc<{
        path?: string;
        config?: { agents?: { defaults?: { workspace?: string } } };
      }>('config.get', undefined, 5000);
      configPathRaw = snapshot?.path;
      workspaceRaw = snapshot?.config?.agents?.defaults?.workspace;
    } catch (error) {
      logger.debug('Failed to fetch config.get for runtime path detection:', error);
    }

    try {
      const status = await this.rpc<{
        sessions?: { paths?: string[]; path?: string };
      }>('status', undefined, 5000);
      sessionsPathRaw = status?.sessions?.paths?.[0] ?? status?.sessions?.path;
    } catch (error) {
      logger.debug('Failed to fetch status for runtime path detection:', error);
    }

    const detectedHostRuntime = this.inferHostRuntimeFromGatewayPaths(
      this.runtimePaths.hostRuntime,
      configPathRaw,
      workspaceRaw,
      sessionsPathRaw,
    );
    const hostConfigPath = this.resolvePathForHost(detectedHostRuntime, configPathRaw);
    const hostWorkspace = this.resolvePathForHost(detectedHostRuntime, workspaceRaw);
    const hostSessionsPath = this.resolvePathForHost(detectedHostRuntime, sessionsPathRaw);
    const inferredConfigDir = (() => {
      if (hostConfigPath) {
        return path.dirname(hostConfigPath);
      }
      if (!hostSessionsPath) {
        return undefined;
      }
      const normalized = hostSessionsPath.replace(/\\/g, '/');
      const marker = '/agents/';
      const idx = normalized.indexOf(marker);
      if (idx === -1) {
        return undefined;
      }
      const prefix = normalized.slice(0, idx);
      return this.resolvePathForHost(detectedHostRuntime, prefix) ?? prefix;
    })();

    const resolvedConfigDir = inferredConfigDir ?? this.getDefaultConfigDirForRuntime(detectedHostRuntime);

    this.runtimePaths = {
      hostRuntime: detectedHostRuntime,
      configDir: resolvedConfigDir,
      workspaceDir: hostWorkspace,
      configPath: hostConfigPath,
    };
    setOpenClawConfigDirOverride(resolvedConfigDir);

    logger.debug(`Gateway runtime paths detected: hostRuntime=${this.runtimePaths.hostRuntime}, configDir=${this.runtimePaths.configDir}, workspaceDir=${this.runtimePaths.workspaceDir ?? 'n/a'}`);
    await setSetting('gatewayHostRuntime', detectedHostRuntime);
  }

  getRuntimePaths(): {
    hostRuntime: GatewayHostRuntime;
    configDir: string;
    workspaceDir?: string;
    configPath?: string;
  } {
    return { ...this.runtimePaths };
  }

  private async getGatewayTokenCandidates(hostRuntime: GatewayHostRuntime): Promise<string[]> {
    const candidates: string[] = [];
    if (hostRuntime === 'wsl' && process.platform === 'win32') {
      const wslToken = this.readGatewayTokenFromWslConfig();
      if (wslToken) {
        candidates.push(wslToken);
      }
    } else {
      const configDirCandidates = Array.from(
        new Set(
          [this.runtimePaths.configDir, getOpenClawConfigDir(), getDefaultOpenClawConfigDir()]
            .filter((dir): dir is string => typeof dir === 'string' && dir.trim().length > 0),
        ),
      );
      for (const configDir of configDirCandidates) {
        const configToken = this.readGatewayTokenFromConfigDir(configDir);
        if (configToken) {
          candidates.push(configToken);
        }
      }
    }

    const settingsToken = await getSetting('gatewayToken');
    if (settingsToken && typeof settingsToken === 'string') {
      const trimmed = settingsToken.trim();
      if (trimmed.length > 0) {
        candidates.push(trimmed);
      }
    }

    return Array.from(new Set(candidates));
  }

  private async connectWithTokenDiscovery(
    port: number,
    hostRuntime: GatewayHostRuntime,
    handshakeTimeoutMs = FAST_ATTACH_HANDSHAKE_TIMEOUT_MS,
  ): Promise<void> {
    const candidates = await this.getGatewayTokenCandidates(hostRuntime);
    let lastError: Error | null = null;

    if (candidates.length === 0) {
      throw new Error('No gateway token available for authentication');
    }

    for (const token of candidates) {
      try {
        await this.connect(port, {
          token,
          handshakeTimeoutMs,
        });

        const currentToken = await getSetting('gatewayToken');
        if (currentToken !== token) {
          await setSetting('gatewayToken', token);
          logger.debug('Synchronized ClawX gatewayToken with successful token source');
        }
        await setSetting('gatewayHostRuntime', hostRuntime);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error('Gateway authentication failed');
  }

  private async attachWithBudget(
    port: number,
    hostRuntime: GatewayHostRuntime,
    totalBudgetMs = ATTACH_TOTAL_BUDGET_MS,
  ): Promise<void> {
    const startedAt = Date.now();
    let lastError: Error | null = null;
    while (Date.now() - startedAt < totalBudgetMs) {
      const elapsed = Date.now() - startedAt;
      const remaining = totalBudgetMs - elapsed;
      const handshakeTimeoutMs = Math.min(FAST_ATTACH_HANDSHAKE_TIMEOUT_MS, Math.max(350, remaining - 50));
      try {
        await this.connectWithTokenDiscovery(port, hostRuntime, handshakeTimeoutMs);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      const nowElapsed = Date.now() - startedAt;
      if (nowElapsed >= totalBudgetMs) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, ATTACH_RETRY_INTERVAL_MS));
    }
    throw lastError ?? new Error(`Failed to attach Gateway within ${totalBudgetMs}ms`);
  }

  private async getFastAttachHostCandidates(): Promise<GatewayHostRuntime[]> {
    const localRuntime = this.detectLocalRuntime();
    if (process.platform !== 'win32') {
      return [localRuntime];
    }
    const ordered: GatewayHostRuntime[] = [];
    const pushUnique = (runtime: GatewayHostRuntime) => {
      if (!ordered.includes(runtime)) {
        ordered.push(runtime);
      }
    };

    const saved = await getSetting('gatewayHostRuntime');
    if (saved === 'windows' || saved === 'wsl') {
      pushUnique(saved);
    }
    if (this.runtimePaths.hostRuntime === 'windows' || this.runtimePaths.hostRuntime === 'wsl') {
      pushUnique(this.runtimePaths.hostRuntime);
    }
    pushUnique('wsl');
    pushUnique('windows');
    return ordered;
  }

  private async tryFastAttachBeforeProbe(port: number): Promise<GatewayHostRuntime | undefined> {
    const candidates = await this.getFastAttachHostCandidates();
    for (const hostRuntime of candidates) {
      try {
        this.applyHostRuntime(hostRuntime);
        await this.attachWithBudget(port, hostRuntime, FAST_ATTACH_TOTAL_BUDGET_MS);
        logger.debug(`Fast attach succeeded before owner probe (port=${port}, hostRuntime=${hostRuntime})`);
        return hostRuntime;
      } catch (error) {
        logger.debug(`Fast attach attempt failed before owner probe (port=${port}, hostRuntime=${hostRuntime})`, error);
      }
    }
    logger.debug(`Fast attach did not succeed before owner probe (port=${port})`);
    return undefined;
  }
  
  /**
   * Get current Gateway status
   */
  getStatus(): GatewayStatus {
    return { ...this.status };
  }
  
  /**
   * Check if Gateway is connected and ready
   */
  isConnected(): boolean {
    return this.status.state === 'running' && this.ws?.readyState === WebSocket.OPEN;
  }
  
  /**
   * Start Gateway process
   */
  async start(): Promise<void> {
    if (this.startLock) {
      logger.debug('Gateway start ignored because a start flow is already in progress');
      return;
    }

    if (this.status.state === 'running') {
      logger.debug('Gateway already running, skipping start');
      return;
    }
    
    this.startLock = true;
    logger.info(`Gateway start requested (port=${this.status.port})`);
    this.lastSpawnSummary = null;
    this.shouldReconnect = true;

    // Manual start should override and cancel any pending reconnect timer.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      logger.debug('Cleared pending reconnect timer because start was requested manually');
    }

    this.reconnectAttempts = 0;
    this.setStatus({ state: 'starting', reconnectAttempts: 0 });
    
    try {
      const fastAttachHost = await this.tryFastAttachBeforeProbe(this.status.port);
      if (fastAttachHost) {
        this.ownsProcess = false;
        this.setStatus({ pid: undefined });
        this.startHealthCheck();
        return;
      }

      const attachTarget = await this.detectAttachTarget(this.status.port);
      this.applyHostRuntime(attachTarget.hostRuntime);
      logger.debug(`Gateway attach target: occupied=${attachTarget.occupied}, ownerKind=${attachTarget.ownerKind}, details=${attachTarget.details}`);

      // Port is already occupied: attach only, never spawn.
      if (attachTarget.occupied) {
        if (attachTarget.ownerKind === 'other') {
          throw new Error(`Port ${this.status.port} is occupied by non-OpenClaw process (${attachTarget.details})`);
        }
        await this.attachWithBudget(this.status.port, attachTarget.hostRuntime);
        this.ownsProcess = false;
        this.setStatus({ pid: undefined });
        this.startHealthCheck();
        return;
      }

      // Only perform runtime self-healing when we actually need to spawn.
      const pythonReady = await isPythonReady();
      if (!pythonReady) {
        logger.info('Python environment missing or incomplete, attempting background repair...');
        void setupManagedPython().catch(err => {
          logger.error('Background Python repair failed:', err);
        });
      }
      
      logger.debug('No existing Gateway found, starting new process...');
      const spawnHostRuntime = this.detectLocalRuntime();
      this.applyHostRuntime(spawnHostRuntime);
      
      // Start new Gateway process
      await this.startProcess();
      
      // Wait for Gateway to be ready
      await this.waitForReady();

      const readyHostRuntime = await this.detectGatewayHostRuntimeByProcess(this.status.port);
      this.applyHostRuntime(readyHostRuntime);
      
      // Connect WebSocket
      await this.connectWithTokenDiscovery(this.status.port, readyHostRuntime, DEFAULT_HANDSHAKE_TIMEOUT_MS);
      
      // Start health monitoring
      this.startHealthCheck();
      logger.debug('Gateway started successfully');
      
    } catch (error) {
      logger.error(
        `Gateway start failed (port=${this.status.port}, reconnectAttempts=${this.reconnectAttempts}, spawn=${this.lastSpawnSummary ?? 'n/a'})`,
        error
      );
      this.setStatus({ state: 'error', error: String(error) });
      throw error;
    } finally {
      this.startLock = false;
    }
  }
  
  /**
   * Stop Gateway process
   */
  async stop(options?: { shutdownExternal?: boolean }): Promise<void> {
    logger.info('Gateway stop requested');
    const shutdownExternal = options?.shutdownExternal ?? false;
    // Disable auto-reconnect
    this.shouldReconnect = false;
    
    // Clear all timers
    this.clearAllTimers();
    
    // If this manager is attached to an external gateway process, ask it to shut down
    // over protocol before closing the socket.
    if (shutdownExternal && !this.ownsProcess && this.ws?.readyState === WebSocket.OPEN) {
      try {
        await this.rpc('shutdown', undefined, 5000);
      } catch (error) {
        logger.warn('Failed to request shutdown for externally managed Gateway:', error);
      }
    } else if (!this.ownsProcess) {
      logger.debug('Skipping external Gateway shutdown; disconnecting ClawX only');
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.close(1000, 'Gateway stopped by user');
      this.ws = null;
    }
    
    // Kill process
    if (this.process && this.ownsProcess) {
      const child = this.process;
      logger.info(`Sending SIGTERM to Gateway (pid=${child.pid ?? 'unknown'})`);
      child.kill('SIGTERM');
      // Force kill after timeout
      setTimeout(() => {
        if (child.exitCode === null) {
          logger.warn(`Gateway did not exit in time, sending SIGKILL (pid=${child.pid ?? 'unknown'})`);
          child.kill('SIGKILL');
        }
        if (this.process === child) {
          this.process = null;
        }
      }, 5000);
      this.process = null;
    }
    this.ownsProcess = false;
    
    // Reject all pending requests
    for (const [, request] of this.pendingRequests) {
      clearTimeout(request.timeout);
      request.reject(new Error('Gateway stopped'));
    }
    this.pendingRequests.clear();
    
    this.setStatus({ state: 'stopped', error: undefined, pid: undefined, connectedAt: undefined, uptime: undefined });
  }
  
  /**
   * Restart Gateway process
   */
  async restart(): Promise<void> {
    logger.debug('Gateway restart requested');
    await this.stop();
    // Brief delay before restart
    await new Promise(resolve => setTimeout(resolve, 1000));
    await this.start();
  }
  
  /**
   * Clear all active timers
   */
  private clearAllTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }
  
  /**
   * Make an RPC call to the Gateway
   * Uses OpenClaw protocol format: { type: "req", id: "...", method: "...", params: {...} }
   */
  async rpc<T>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Gateway not connected'));
        return;
      }
      
      const id = crypto.randomUUID();
      
      // Set timeout for request
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      
      // Store pending request
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
      
      // Send request using OpenClaw protocol format
      const request = {
        type: 'req',
        id,
        method,
        params,
      };
      
      try {
        this.ws.send(JSON.stringify(request));
      } catch (error) {
        this.pendingRequests.delete(id);
        clearTimeout(timeout);
        reject(new Error(`Failed to send RPC request: ${error}`));
      }
    });
  }
  
  /**
   * Start health check monitoring
   */
  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    this.healthCheckInterval = setInterval(async () => {
      if (this.status.state !== 'running') {
        return;
      }
      
      try {
        const health = await this.checkHealth();
        if (!health.ok) {
          logger.warn(`Gateway health check failed: ${health.error ?? 'unknown'}`);
          this.emit('error', new Error(health.error || 'Health check failed'));
        }
      } catch (error) {
        logger.error('Gateway health check error:', error);
      }
    }, 30000); // Check every 30 seconds
  }
  
  /**
   * Check Gateway health via WebSocket ping
   * OpenClaw Gateway doesn't have an HTTP /health endpoint
   */
  async checkHealth(): Promise<{ ok: boolean; error?: string; uptime?: number }> {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const uptime = this.status.connectedAt 
          ? Math.floor((Date.now() - this.status.connectedAt) / 1000)
          : undefined;
        return { ok: true, uptime };
      }
      return { ok: false, error: 'WebSocket not connected' };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
  
  /**
   * Start Gateway process
   * Uses OpenClaw npm package from node_modules (dev) or resources (production)
   */
  private async startProcess(): Promise<void> {
    const openclawDir = getOpenClawDir();
    const entryScript = getOpenClawEntryPath();
    
    // Verify OpenClaw package exists
    if (!isOpenClawPresent()) {
      const errMsg = `OpenClaw package not found at: ${openclawDir}`;
      logger.error(errMsg);
      throw new Error(errMsg);
    }
    
    // Get or generate gateway token
    const tokenCandidates = await this.getGatewayTokenCandidates(this.runtimePaths.hostRuntime);
    const gatewayToken = tokenCandidates[0];
    if (!gatewayToken) {
      throw new Error('Missing gateway token. Configure gateway.auth.token or ClawX gatewayToken first.');
    }
    
    let command: string;
    let args: string[];
    let mode: 'packaged' | 'dev-built' | 'dev-pnpm';
    
    // Determine the Node.js executable
    // In packaged Electron app, use process.execPath with ELECTRON_RUN_AS_NODE=1
    // which makes the Electron binary behave as plain Node.js.
    // In development, use system 'node'.
    const gatewayArgs = ['gateway', '--port', String(this.status.port), '--token', gatewayToken, '--dev', '--allow-unconfigured'];
    
    if (app.isPackaged) {
      // Production: use Electron binary as Node.js via ELECTRON_RUN_AS_NODE
      // On macOS, use the Electron Helper binary to avoid extra dock icons
      if (existsSync(entryScript)) {
        command = getNodeExecutablePath();
        args = [entryScript, ...gatewayArgs];
        mode = 'packaged';
      } else {
        const errMsg = `OpenClaw entry script not found at: ${entryScript}`;
        logger.error(errMsg);
        throw new Error(errMsg);
      }
    } else if (isOpenClawBuilt() && existsSync(entryScript)) {
      // Development with built package: use system node
      command = 'node';
      args = [entryScript, ...gatewayArgs];
      mode = 'dev-built';
    } else {
      // Development without build: use pnpm dev
      command = 'pnpm';
      args = ['run', 'dev', ...gatewayArgs];
      mode = 'dev-pnpm';
    }

    // Resolve bundled bin path for uv
    const platform = process.platform;
    const arch = process.arch;
    const target = `${platform}-${arch}`;

    const binPath = app.isPackaged
      ? path.join(process.resourcesPath, 'bin')
      : path.join(process.cwd(), 'resources', 'bin', target);

    const binPathExists = existsSync(binPath);
    const finalPath = binPathExists
      ? `${binPath}${path.delimiter}${process.env.PATH || ''}`
      : process.env.PATH || '';
    
    // Load provider API keys from storage to pass as environment variables
    const providerEnv: Record<string, string> = {};
    const providerTypes = getKeyableProviderTypes();
    let loadedProviderKeyCount = 0;

    // Prefer the selected default provider key when provider IDs are instance-based.
    try {
      const defaultProviderId = await getDefaultProvider();
      if (defaultProviderId) {
        const defaultProvider = await getProvider(defaultProviderId);
        const defaultProviderType = defaultProvider?.type;
        const defaultProviderKey = await getApiKey(defaultProviderId);
        if (defaultProviderType && defaultProviderKey) {
          const envVar = getProviderEnvVar(defaultProviderType);
          if (envVar) {
            providerEnv[envVar] = defaultProviderKey;
            loadedProviderKeyCount++;
          }
        }
      }
    } catch (err) {
      logger.warn('Failed to load default provider key for environment injection:', err);
    }

    for (const providerType of providerTypes) {
      try {
        const key = await getApiKey(providerType);
        if (key) {
          const envVar = getProviderEnvVar(providerType);
          if (envVar) {
            providerEnv[envVar] = key;
            loadedProviderKeyCount++;
          }
        }
      } catch (err) {
        logger.warn(`Failed to load API key for ${providerType}:`, err);
      }
    }

    const uvEnv = await getUvMirrorEnv();
    logger.info(
      `Starting Gateway process (mode=${mode}, port=${this.status.port}, command="${command}", args="${this.sanitizeSpawnArgs(args).join(' ')}", cwd="${openclawDir}", bundledBin=${binPathExists ? 'yes' : 'no'}, providerKeys=${loadedProviderKeyCount})`
    );
    this.lastSpawnSummary = `mode=${mode}, command="${command}", args="${this.sanitizeSpawnArgs(args).join(' ')}", cwd="${openclawDir}"`;
    
    // Load proxy settings for Gateway subprocess
    const proxyEnabled = await getSetting('gatewayProxyEnabled');
    const proxyHttp = await getSetting('gatewayProxyHttp');
    const proxyHttps = await getSetting('gatewayProxyHttps');
    const proxyAll = await getSetting('gatewayProxyAll');

    return new Promise((resolve, reject) => {
      const spawnEnv: Record<string, string | undefined> = {
        ...process.env,
        PATH: finalPath,
        ...providerEnv,
        ...uvEnv,
        OPENCLAW_GATEWAY_TOKEN: gatewayToken,
        OPENCLAW_SKIP_CHANNELS: '',
        CLAWDBOT_SKIP_CHANNELS: '',
      };

      const httpProxy = proxyHttp?.trim();
      const httpsProxy = proxyHttps?.trim();
      const allProxy = proxyAll?.trim();

      if (proxyEnabled) {
        if (httpProxy) {
          spawnEnv.HTTP_PROXY = httpProxy;
          spawnEnv.http_proxy = httpProxy;
        }
        if (httpsProxy) {
          spawnEnv.HTTPS_PROXY = httpsProxy;
          spawnEnv.https_proxy = httpsProxy;
        }
        if (allProxy) {
          spawnEnv.ALL_PROXY = allProxy;
          spawnEnv.all_proxy = allProxy;
        }
      } else {
        delete spawnEnv.HTTP_PROXY;
        delete spawnEnv.http_proxy;
        delete spawnEnv.HTTPS_PROXY;
        delete spawnEnv.https_proxy;
        delete spawnEnv.ALL_PROXY;
        delete spawnEnv.all_proxy;
      }

      // Critical: In packaged mode, make Electron binary act as Node.js
      if (app.isPackaged) {
        spawnEnv['ELECTRON_RUN_AS_NODE'] = '1';
        // Prevent OpenClaw entry.ts from respawning itself (which would create
        // another child process and a second "exec" dock icon on macOS)
        spawnEnv['OPENCLAW_NO_RESPAWN'] = '1';
        // Pre-set the NODE_OPTIONS that entry.ts would have added via respawn
        const existingNodeOpts = spawnEnv['NODE_OPTIONS'] ?? '';
        if (!existingNodeOpts.includes('--disable-warning=ExperimentalWarning') &&
            !existingNodeOpts.includes('--no-warnings')) {
          spawnEnv['NODE_OPTIONS'] = `${existingNodeOpts} --disable-warning=ExperimentalWarning`.trim();
        }
      }

      this.process = spawn(command, args, {
        cwd: openclawDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        shell: !app.isPackaged && process.platform === 'win32', // shell only in dev on Windows
        env: spawnEnv,
      });
      const child = this.process;
      this.ownsProcess = true;
      
      child.on('error', (error) => {
        this.ownsProcess = false;
        logger.error('Gateway process spawn error:', error);
        reject(error);
      });
      
      child.on('exit', (code, signal) => {
        const expectedExit = !this.shouldReconnect || this.status.state === 'stopped';
        const level = expectedExit ? logger.info : logger.warn;
        level(`Gateway process exited (${this.formatExit(code, signal)}, expected=${expectedExit ? 'yes' : 'no'})`);
        this.ownsProcess = false;
        if (this.process === child) {
          this.process = null;
        }
        this.emit('exit', code);
        
        if (this.status.state === 'running') {
          this.setStatus({ state: 'stopped' });
          this.scheduleReconnect();
        }
      });

      child.on('close', (code, signal) => {
        logger.debug(`Gateway process stdio closed (${this.formatExit(code, signal)})`);
      });
      
      // Log stderr
      child.stderr?.on('data', (data) => {
        const raw = data.toString();
        for (const line of raw.split(/\r?\n/)) {
          const classified = this.classifyStderrMessage(line);
          if (classified.level === 'drop') continue;
          if (classified.level === 'debug') {
            logger.debug(`[Gateway stderr] ${classified.normalized}`);
            continue;
          }
          logger.warn(`[Gateway stderr] ${classified.normalized}`);
        }
      });
      
      // Store PID
      if (child.pid) {
        logger.info(`Gateway process started (pid=${child.pid})`);
        this.setStatus({ pid: child.pid });
      } else {
        logger.warn('Gateway process spawned but PID is undefined');
      }
      
      resolve();
    });
  }
  
  /**
   * Wait for Gateway to be ready by checking if the port is accepting connections
   */
  private async waitForReady(retries = 600, interval = 1000): Promise<void> {
    for (let i = 0; i < retries; i++) {
      // Early exit if the gateway process has already exited
      if (this.process && (this.process.exitCode !== null || this.process.signalCode !== null)) {
        const code = this.process.exitCode;
        const signal = this.process.signalCode;
        logger.error(`Gateway process exited before ready (${this.formatExit(code, signal)})`);
        throw new Error(`Gateway process exited before becoming ready (${this.formatExit(code, signal)})`);
      }
      
      try {
        const ready = await new Promise<boolean>((resolve) => {
          const testWs = new WebSocket(`ws://localhost:${this.status.port}/ws`);
          const timeout = setTimeout(() => {
            testWs.close();
            resolve(false);
          }, 2000);
          
          testWs.on('open', () => {
            clearTimeout(timeout);
            testWs.close();
            resolve(true);
          });
          
          testWs.on('error', () => {
            clearTimeout(timeout);
            resolve(false);
          });
        });
        
        if (ready) {
          logger.debug(`Gateway ready after ${i + 1} attempt(s)`);
          return;
        }
      } catch {
        // Gateway not ready yet
      }
      
      if (i > 0 && i % 10 === 0) {
        logger.debug(`Still waiting for Gateway... (attempt ${i + 1}/${retries})`);
      }
      
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    
    logger.error(`Gateway failed to become ready after ${retries} attempts on port ${this.status.port}`);
    throw new Error(`Gateway failed to start after ${retries} retries (port ${this.status.port})`);
  }
  
  /**
   * Connect WebSocket to Gateway
   */
  private async connect(
    port: number,
    opts?: { token?: string; handshakeTimeoutMs?: number }
  ): Promise<void> {
    const gatewayToken = opts?.token;
    if (!gatewayToken) {
      throw new Error('Missing gateway token for connection');
    }
    const handshakeTimeoutMs = opts?.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    logger.debug(`Connecting Gateway WebSocket (ws://localhost:${port}/ws)`);
    
    return new Promise((resolve, reject) => {
      // WebSocket URL (token will be sent in connect handshake, not URL)
      const wsUrl = `ws://localhost:${port}/ws`;
      
      this.ws = new WebSocket(wsUrl);
      let handshakeComplete = false;
      let connectId: string | null = null;
      let handshakeTimeout: NodeJS.Timeout | null = null;
      let settled = false;

      const cleanupHandshakeRequest = () => {
        if (handshakeTimeout) {
          clearTimeout(handshakeTimeout);
          handshakeTimeout = null;
        }
        if (connectId && this.pendingRequests.has(connectId)) {
          const request = this.pendingRequests.get(connectId);
          if (request) {
            clearTimeout(request.timeout);
          }
          this.pendingRequests.delete(connectId);
        }
      };

      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        cleanupHandshakeRequest();
        resolve();
      };

      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanupHandshakeRequest();
        const err = error instanceof Error ? error : new Error(String(error));
        reject(err);
      };
      
      this.ws.on('open', () => {
        logger.debug('Gateway WebSocket opened, sending connect handshake');
        
        // Send proper connect handshake as required by OpenClaw Gateway protocol
        // The Gateway expects: { type: "req", id: "...", method: "connect", params: ConnectParams }
        // Since 2026.2.15, scopes are only granted when a signed device identity is included.
        connectId = `connect-${Date.now()}`;
        const role = 'operator';
        const scopes = ['operator.admin'];
        const signedAtMs = Date.now();
        const clientId = 'gateway-client';
        const clientMode = 'ui';

        const device = (() => {
          if (!this.deviceIdentity) return undefined;

          const payload = buildDeviceAuthPayload({
            deviceId: this.deviceIdentity.deviceId,
            clientId,
            clientMode,
            role,
            scopes,
            signedAtMs,
            token: gatewayToken,
          });
          const signature = signDevicePayload(this.deviceIdentity.privateKeyPem, payload);
          return {
            id: this.deviceIdentity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(this.deviceIdentity.publicKeyPem),
            signature,
            signedAt: signedAtMs,
          };
        })();

        const connectFrame = {
          type: 'req',
          id: connectId,
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: clientId,
              displayName: 'ClawX',
              version: '0.1.0',
              platform: process.platform,
              mode: clientMode,
            },
            auth: {
              token: gatewayToken,
            },
            caps: [],
            role,
            scopes,
            device,
          },
        };
        
        this.ws?.send(JSON.stringify(connectFrame));
        
        // Store pending connect request
        const requestTimeout = setTimeout(() => {
          if (!handshakeComplete) {
            logger.error('Gateway connect handshake timed out');
            this.ws?.close();
            rejectOnce(new Error('Connect handshake timeout'));
          }
        }, handshakeTimeoutMs);
        handshakeTimeout = requestTimeout;
        
        this.pendingRequests.set(connectId, {
          resolve: (_result) => {
            handshakeComplete = true;
            logger.debug('Gateway connect handshake completed');
          this.setStatus({
            state: 'running',
            port,
            connectedAt: Date.now(),
          });
          void this.refreshRuntimePathsFromGateway().catch((err) =>
            logger.debug('Runtime path refresh failed after connect:', err),
          );
          this.startPing();
          resolveOnce();
        },
          reject: (error) => {
            logger.error('Gateway connect handshake failed:', error);
            rejectOnce(error);
          },
          timeout: requestTimeout,
        });
      });
      
      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          logger.debug('Failed to parse Gateway WebSocket message:', error);
        }
      });
      
      this.ws.on('close', (code, reason) => {
        const reasonStr = reason?.toString() || 'unknown';
        logger.warn(`Gateway WebSocket closed (code=${code}, reason=${reasonStr}, handshake=${handshakeComplete ? 'ok' : 'pending'})`);
        if (!handshakeComplete) {
          rejectOnce(new Error(`WebSocket closed before handshake: ${reasonStr}`));
          return;
        }
        cleanupHandshakeRequest();
        if (this.status.state === 'running') {
          this.setStatus({ state: 'stopped' });
          this.scheduleReconnect();
        }
      });
      
      this.ws.on('error', (error) => {
        logger.error('Gateway WebSocket error:', error);
        if (!handshakeComplete) {
          rejectOnce(error);
        }
      });
    });
  }
  
  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      logger.debug('Received non-object Gateway message');
      return;
    }
    
    const msg = message as Record<string, unknown>;
    
    // Handle OpenClaw protocol response format: { type: "res", id: "...", ok: true/false, ... }
    if (msg.type === 'res' && typeof msg.id === 'string') {
      if (this.pendingRequests.has(msg.id)) {
        const request = this.pendingRequests.get(msg.id)!;
        clearTimeout(request.timeout);
        this.pendingRequests.delete(msg.id);
        
        if (msg.ok === false || msg.error) {
          const errorObj = msg.error as { message?: string; code?: number } | undefined;
          const errorMsg = errorObj?.message || JSON.stringify(msg.error) || 'Unknown error';
          request.reject(new Error(errorMsg));
        } else {
          request.resolve(msg.payload ?? msg);
        }
        return;
      }
    }
    
    // Handle OpenClaw protocol event format: { type: "event", event: "...", payload: {...} }
    if (msg.type === 'event' && typeof msg.event === 'string') {
      this.handleProtocolEvent(msg.event, msg.payload);
      return;
    }
    
    // Fallback: Check if this is a JSON-RPC 2.0 response (legacy support)
    if (isResponse(message) && message.id && this.pendingRequests.has(String(message.id))) {
      const request = this.pendingRequests.get(String(message.id))!;
      clearTimeout(request.timeout);
      this.pendingRequests.delete(String(message.id));
      
      if (message.error) {
        const errorMsg = typeof message.error === 'object' 
          ? (message.error as { message?: string }).message || JSON.stringify(message.error)
          : String(message.error);
        request.reject(new Error(errorMsg));
      } else {
        request.resolve(message.result);
      }
      return;
    }
    
    // Check if this is a JSON-RPC notification (server-initiated event)
    if (isNotification(message)) {
      this.handleNotification(message);
      return;
    }
    
    // Emit generic message for other handlers
    this.emit('message', message);
  }
  
  /**
   * Handle OpenClaw protocol events
   */
  private handleProtocolEvent(event: string, payload: unknown): void {
    // Map OpenClaw events to our internal event types
    switch (event) {
      case 'tick':
        // Heartbeat tick, ignore
        break;
      case 'chat':
        this.emit('chat:message', { message: payload });
        break;
      case 'channel.status':
        this.emit('channel:status', payload as { channelId: string; status: string });
        break;
      default:
        // Forward unknown events as generic notifications
        this.emit('notification', { method: event, params: payload });
    }
  }
  
  /**
   * Handle server-initiated notifications
   */
  private handleNotification(notification: JsonRpcNotification): void {
    this.emit('notification', notification);
    
    // Route specific events
    switch (notification.method) {
      case GatewayEventType.CHANNEL_STATUS_CHANGED:
        this.emit('channel:status', notification.params as { channelId: string; status: string });
        break;
        
      case GatewayEventType.MESSAGE_RECEIVED:
        this.emit('chat:message', notification.params as { message: unknown });
        break;
        
      case GatewayEventType.ERROR: {
        const errorData = notification.params as { message?: string };
        this.emit('error', new Error(errorData.message || 'Gateway error'));
        break;
      }
        
      default:
        // Unknown notification type, just log it
        logger.debug(`Unknown Gateway notification: ${notification.method}`);
    }
  }
  
  /**
   * Start ping interval to keep connection alive
   */
  private startPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }
  
  /**
   * Schedule reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      logger.debug('Gateway reconnect skipped (auto-reconnect disabled)');
      return;
    }
    
    if (this.reconnectTimer) {
      return;
    }
    
    if (this.reconnectAttempts >= this.reconnectConfig.maxAttempts) {
      logger.error(`Gateway reconnect failed: max attempts reached (${this.reconnectConfig.maxAttempts})`);
      this.setStatus({ 
        state: 'error', 
        error: 'Failed to reconnect after maximum attempts',
        reconnectAttempts: this.reconnectAttempts 
      });
      return;
    }
    
    // Calculate delay with exponential backoff
    const delay = Math.min(
      this.reconnectConfig.baseDelay * Math.pow(2, this.reconnectAttempts),
      this.reconnectConfig.maxDelay
    );
    
    this.reconnectAttempts++;
    logger.warn(`Scheduling Gateway reconnect attempt ${this.reconnectAttempts}/${this.reconnectConfig.maxAttempts} in ${delay}ms`);
    
    this.setStatus({ 
      state: 'reconnecting', 
      reconnectAttempts: this.reconnectAttempts 
    });
    
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        const fastAttachHost = await this.tryFastAttachBeforeProbe(this.status.port);
        if (fastAttachHost) {
          this.ownsProcess = false;
          this.setStatus({ pid: undefined });
          this.reconnectAttempts = 0;
          this.startHealthCheck();
          return;
        }

        const attachTarget = await this.detectAttachTarget(this.status.port);
        this.applyHostRuntime(attachTarget.hostRuntime);
        if (attachTarget.occupied) {
          if (attachTarget.ownerKind === 'other') {
            throw new Error(`Port ${this.status.port} is occupied by non-OpenClaw process (${attachTarget.details})`);
          }
          await this.attachWithBudget(this.status.port, attachTarget.hostRuntime);
          this.ownsProcess = false;
          this.setStatus({ pid: undefined });
          this.reconnectAttempts = 0;
          this.startHealthCheck();
          return;
        }
        
        // Otherwise restart the process
        const spawnHostRuntime = this.detectLocalRuntime();
        this.applyHostRuntime(spawnHostRuntime);
        await this.startProcess();
        await this.waitForReady();
        const readyHostRuntime = await this.detectGatewayHostRuntimeByProcess(this.status.port);
        this.applyHostRuntime(readyHostRuntime);
        await this.connectWithTokenDiscovery(this.status.port, readyHostRuntime, DEFAULT_HANDSHAKE_TIMEOUT_MS);
        this.reconnectAttempts = 0;
        this.startHealthCheck();
      } catch (error) {
        logger.error('Gateway reconnection attempt failed:', error);
        this.scheduleReconnect();
      }
    }, delay);
  }
  
  /**
   * Update status and emit event
   */
  private setStatus(update: Partial<GatewayStatus>): void {
    const previousState = this.status.state;
    this.status = { ...this.status, ...update };
    
    // Calculate uptime if connected
    if (this.status.state === 'running' && this.status.connectedAt) {
      this.status.uptime = Date.now() - this.status.connectedAt;
    }
    
    this.emit('status', this.status);
    
    // Log state transitions
    if (previousState !== this.status.state) {
      logger.debug(`Gateway state changed: ${previousState} -> ${this.status.state}`);
    }
  }
}
