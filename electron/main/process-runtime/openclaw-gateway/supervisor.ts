import { app, utilityProcess } from 'electron';
import path from 'path';
import { existsSync } from 'fs';
import { getOpenClawDir, getOpenClawEntryPath } from '../../../utils/paths';
import { getUvMirrorEnv } from '../../../utils/uv-env';
import { isPythonReady, setupManagedPython } from '../../../utils/uv-setup';
import { logger } from '../../../utils/logger';
import { prependPathEntry } from '../../../utils/env-path';

const ANSI_ESCAPE_RE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function normalizeDoctorOutputLine(line: string): string {
  const withoutAnsi = line.replace(ANSI_ESCAPE_RE, '');
  const withoutControls = withoutAnsi.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return withoutControls.trim();
}

function isLikelyDoctorDecorationNoise(line: string): boolean {
  if (!line) return true;

  const compact = line.replace(/\s+/g, '');
  if (!compact) return true;

  // Decorative box lines usually contain no semantic alphanumeric content.
  const hasAsciiWord = /[A-Za-z0-9]/.test(compact);
  const asciiCount = (compact.match(/[\x20-\x7E]/g) ?? []).length;
  const nonAsciiCount = compact.length - asciiCount;
  if (!hasAsciiWord && nonAsciiCount >= 8) {
    return true;
  }

  // Separators like "──────" / "======" / repeated symbols should be dropped.
  if (/^[\p{S}\p{P}\p{Zs}]+$/u.test(line)) {
    return true;
  }

  return false;
}

export function warmupManagedPythonReadiness(): void {
  void isPythonReady().then((pythonReady) => {
    if (!pythonReady) {
      logger.info('Python environment missing or incomplete, attempting background repair...');
      void setupManagedPython().catch((err) => {
        logger.error('Background Python repair failed:', err);
      });
    }
  }).catch((err) => {
    logger.error('Failed to check Python environment:', err);
  });
}

export async function unloadLaunchctlGatewayService(): Promise<void> {
  if (process.platform !== 'darwin') return;

  try {
    const uid = process.getuid?.();
    if (uid === undefined) return;

    const launchdLabel = 'ai.openclaw.gateway';
    const serviceTarget = `gui/${uid}/${launchdLabel}`;
    const cp = await import('child_process');
    const fsPromises = await import('fs/promises');
    const os = await import('os');

    const loaded = await new Promise<boolean>((resolve) => {
      cp.exec(`launchctl print ${serviceTarget}`, { timeout: 5000 }, (err) => {
        resolve(!err);
      });
    });

    if (!loaded) return;

    logger.info(`Unloading launchctl service ${serviceTarget} to prevent auto-respawn`);
    await new Promise<void>((resolve) => {
      cp.exec(`launchctl bootout ${serviceTarget}`, { timeout: 10000 }, (err) => {
        if (err) {
          logger.warn(`Failed to bootout launchctl service: ${err.message}`);
        } else {
          logger.info('Successfully unloaded launchctl gateway service');
        }
        resolve();
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchdLabel}.plist`);
      await fsPromises.access(plistPath);
      await fsPromises.unlink(plistPath);
      logger.info(`Removed legacy launchd plist to prevent reload on next login: ${plistPath}`);
    } catch {
      // File doesn't exist or can't be removed -- not fatal
    }
  } catch (err) {
    logger.warn('Error while unloading launchctl gateway service:', err);
  }
}

export async function waitForPortFree(port: number, timeoutMs = 30000): Promise<void> {
  const net = await import('net');
  const start = Date.now();
  const pollInterval = 500;
  let logged = false;

  while (Date.now() - start < timeoutMs) {
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });

    if (available) {
      const elapsed = Date.now() - start;
      if (elapsed > pollInterval) {
        logger.info(`Port ${port} became available after ${elapsed}ms`);
      }
      return;
    }

    if (!logged) {
      logger.info(`Waiting for port ${port} to become available (Windows TCP TIME_WAIT)...`);
      logged = true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  logger.error(`Port ${port} still occupied after ${timeoutMs}ms; aborting startup to avoid port conflict`);
  throw new Error(`Port ${port} still occupied after ${timeoutMs}ms`);
}

async function getListeningProcessIds(port: number): Promise<string[]> {
  const cmd = process.platform === 'win32'
    ? `netstat -ano | findstr :${port}`
    : `lsof -i :${port} -sTCP:LISTEN -t`;

  const cp = await import('child_process');
  const { stdout } = await new Promise<{ stdout: string }>((resolve) => {
    cp.exec(cmd, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({ stdout: '' });
      } else {
        resolve({ stdout });
      }
    });
  });

  if (!stdout.trim()) {
    return [];
  }

  if (process.platform === 'win32') {
    const pids: string[] = [];
    for (const line of stdout.trim().split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[3] === 'LISTENING') {
        pids.push(parts[4]);
      }
    }
    return [...new Set(pids)];
  }

  return [...new Set(stdout.trim().split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
}

const PROCESS_EXIT_POLL_INTERVAL_MS = 100;
const WINDOWS_PROCESS_EXIT_TIMEOUT_MS = 2000;
const GRACEFUL_PROCESS_EXIT_TIMEOUT_MS = 3000;
const FORCE_PROCESS_EXIT_TIMEOUT_MS = 1000;

function isNoSuchProcessError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ESRCH';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcessError(error)) {
      return false;
    }
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
      return true;
    }
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.min(PROCESS_EXIT_POLL_INTERVAL_MS, remainingMs),
    ));
  }
  return true;
}

function gatewayTerminationError(options: {
  port: number;
  pid: number;
  reason: string;
  detail: string;
  cause?: unknown;
}): Error {
  const { port, pid, reason, detail, cause } = options;
  return new Error(
    `Failed to terminate ${reason} process ${pid} on port ${port}: ${detail}`,
    cause === undefined ? undefined : { cause },
  );
}

async function terminateWindowsGatewayProcess(options: {
  port: number;
  pid: number;
  reason: string;
}): Promise<void> {
  const { port, pid, reason } = options;
  const cp = await import('child_process');

  try {
    await new Promise<void>((resolve, reject) => {
      cp.exec(
        `taskkill /F /PID ${pid} /T`,
        { timeout: 5000, windowsHide: true },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        },
      );
    });
  } catch (error) {
    if (!isProcessAlive(pid)) {
      return;
    }
    throw gatewayTerminationError({
      port,
      pid,
      reason,
      detail: 'taskkill failed while the process was still running',
      cause: error,
    });
  }

  if (await waitForProcessExit(pid, WINDOWS_PROCESS_EXIT_TIMEOUT_MS)) {
    return;
  }
  throw gatewayTerminationError({
    port,
    pid,
    reason,
    detail: `process was still running ${WINDOWS_PROCESS_EXIT_TIMEOUT_MS}ms after taskkill`,
  });
}

async function terminatePosixGatewayProcess(options: {
  port: number;
  pid: number;
  reason: string;
}): Promise<void> {
  const { port, pid, reason } = options;

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (!isProcessAlive(pid)) {
      return;
    }
    throw gatewayTerminationError({
      port,
      pid,
      reason,
      detail: 'SIGTERM failed while the process was still running',
      cause: error,
    });
  }

  if (await waitForProcessExit(pid, GRACEFUL_PROCESS_EXIT_TIMEOUT_MS)) {
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!isProcessAlive(pid)) {
      return;
    }
    throw gatewayTerminationError({
      port,
      pid,
      reason,
      detail: 'SIGKILL failed while the process was still running',
      cause: error,
    });
  }

  if (await waitForProcessExit(pid, FORCE_PROCESS_EXIT_TIMEOUT_MS)) {
    return;
  }
  throw gatewayTerminationError({
    port,
    pid,
    reason,
    detail: `process was still running ${FORCE_PROCESS_EXIT_TIMEOUT_MS}ms after SIGKILL`,
  });
}

export async function terminateGatewayProcessIds(options: {
  port: number;
  pids: readonly string[];
  reason: string;
}): Promise<void> {
  const { port, pids, reason } = options;
  logger.info(`Terminating ${reason} process listening on port ${port} (PIDs: ${pids.join(', ')})`);

  if (process.platform === 'darwin') {
    await unloadLaunchctlGatewayService();
  }

  const terminationResults = await Promise.allSettled(pids.map(async (pidValue) => {
    const pid = parseInt(pidValue, 10);
    const terminationOptions = { port, pid, reason };
    if (process.platform === 'win32') {
      await terminateWindowsGatewayProcess(terminationOptions);
    } else {
      await terminatePosixGatewayProcess(terminationOptions);
    }
  }));
  const failures = terminationResults.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failures.length === 1) {
    throw failures[0].reason;
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `Failed to terminate ${failures.length} ${reason} processes on port ${port}`,
    );
  }
}

async function terminateOrphanedProcessIds(port: number, pids: string[]): Promise<void> {
  await terminateGatewayProcessIds({ port, pids, reason: 'orphaned gateway' });
}

export async function findExistingGatewayProcess(options: {
  port: number;
  ownedPid?: number;
  signal?: AbortSignal;
  assertActive?: () => void;
}): Promise<{ port: number; externalToken?: string } | null> {
  const { port, ownedPid, signal, assertActive } = options;
  const pids = await getListeningProcessIds(port);
  assertActive?.();
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Gateway startup aborted');
  }
  if (pids.length === 0) {
    return null;
  }

  const ownedPidValue = typeof ownedPid === 'number' ? String(ownedPid) : '';
  if (ownedPidValue && pids.includes(ownedPidValue)) {
    return { port };
  }

  assertActive?.();
  await terminateOrphanedProcessIds(port, pids);
  assertActive?.();
  await waitForPortFree(port, 10000);
  return null;
}

export async function runOpenClawDoctorRepair(): Promise<boolean> {
  const openclawDir = getOpenClawDir();
  const entryScript = getOpenClawEntryPath();
  if (!existsSync(entryScript)) {
    logger.error(`Cannot run OpenClaw doctor repair: entry script not found at ${entryScript}`);
    return false;
  }

  const platform = process.platform;
  const arch = process.arch;
  const target = `${platform}-${arch}`;
  const binPath = app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(process.cwd(), 'resources', 'bin', target);
  const binPathExists = existsSync(binPath);
  const baseProcessEnv = process.env as Record<string, string | undefined>;
  const baseEnvPatched = binPathExists
    ? prependPathEntry(baseProcessEnv, binPath).env
    : baseProcessEnv;

  const uvEnv = await getUvMirrorEnv();
  const doctorArgs = ['--no-color', 'doctor', '--fix', '--yes', '--non-interactive'];
  logger.info(
    `Running OpenClaw doctor repair (entry="${entryScript}", args="${doctorArgs.join(' ')}", cwd="${openclawDir}", bundledBin=${binPathExists ? 'yes' : 'no'})`,
  );

  return await new Promise<boolean>((resolve) => {
    const forkEnv: Record<string, string | undefined> = {
      ...baseEnvPatched,
      ...uvEnv,
      OPENCLAW_NO_RESPAWN: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'dumb',
      CI: '1',
    };

    const child = utilityProcess.fork(entryScript, doctorArgs, {
      cwd: openclawDir,
      stdio: 'pipe',
      env: forkEnv as NodeJS.ProcessEnv,
    });

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const timeout = setTimeout(() => {
      logger.error('OpenClaw doctor repair timed out after 120000ms');
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish(false);
    }, 120000);

    child.on('error', (err) => {
      clearTimeout(timeout);
      logger.error('Failed to spawn OpenClaw doctor repair process:', err);
      finish(false);
    });

    child.stdout?.on('data', (data) => {
      const raw = data.toString();
      for (const line of raw.split(/\r?\n/)) {
        const normalized = normalizeDoctorOutputLine(line);
        if (!normalized || isLikelyDoctorDecorationNoise(normalized)) continue;
        logger.debug(`[Gateway doctor stdout] ${normalized}`);
      }
    });

    child.stderr?.on('data', (data) => {
      const raw = data.toString();
      for (const line of raw.split(/\r?\n/)) {
        const normalized = normalizeDoctorOutputLine(line);
        if (!normalized || isLikelyDoctorDecorationNoise(normalized)) continue;
        logger.warn(`[Gateway doctor stderr] ${normalized}`);
      }
    });

    child.on('exit', (code: number) => {
      clearTimeout(timeout);
      if (code === 0) {
        logger.info('OpenClaw doctor repair completed successfully');
        finish(true);
        return;
      }
      logger.warn(`OpenClaw doctor repair exited (code=${code})`);
      finish(false);
    });
  });
}
