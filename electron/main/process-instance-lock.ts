import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_SCHEMA = 'clawx-instance-lock';
const LOCK_VERSION = 1;

export interface ProcessInstanceFileLock {
  acquired: boolean;
  lockPath: string;
  ownerPid?: number;
  ownerFormat?: 'legacy' | 'structured' | 'unknown';
  release: () => void;
}

export interface ProcessInstanceFileLockOptions {
  userDataDir: string;
  lockName: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  /**
   * 强制模式：不判断 pid 活性，先删除已有 lock 文件再尝试抢占。
   * 仅应在已有外部排他锁（例如 Electron 单实例锁）保证独占时使用。
   */
  force?: boolean;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    return errno !== 'ESRCH';
  }
}

type ParsedLockOwner =
  | { kind: 'legacy'; pid: number }
  | { kind: 'structured'; pid: number }
  | { kind: 'unknown' };

interface StructuredLockContent {
  schema: string;
  version: number;
  pid: number;
}

function parsePositivePid(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function parseStructuredLockContent(raw: string): StructuredLockContent | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<StructuredLockContent>;
    if (
      parsed?.schema === LOCK_SCHEMA
      && parsed?.version === LOCK_VERSION
      && typeof parsed?.pid === 'number'
      && Number.isFinite(parsed.pid)
      && parsed.pid > 0
    ) {
      return {
        schema: parsed.schema,
        version: parsed.version,
        pid: parsed.pid,
      };
    }
  } catch {
    // ignore parse errors
  }
  return undefined;
}

function readLockOwner(lockPath: string): ParsedLockOwner {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const legacyPid = parsePositivePid(raw);
    if (legacyPid !== undefined) {
      return { kind: 'legacy', pid: legacyPid };
    }

    const structured = parseStructuredLockContent(raw);
    if (structured) {
      return { kind: 'structured', pid: structured.pid };
    }
  } catch {
    // ignore read errors
  }

  return { kind: 'unknown' };
}

export function acquireProcessInstanceFileLock(
  options: ProcessInstanceFileLockOptions,
): ProcessInstanceFileLock {
  const pid = options.pid ?? process.pid;
  const isPidAlive = options.isPidAlive ?? defaultPidAlive;

  mkdirSync(options.userDataDir, { recursive: true });
  const lockPath = join(options.userDataDir, `${options.lockName}.instance.lock`);

  if (options.force && existsSync(lockPath)) {
    const staleOwner = readLockOwner(lockPath);
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // best-effort, fall through to normal acquisition
    }
    if (staleOwner.kind !== 'unknown') {
      console.info(
        `[ClawX] Force-cleaned stale instance lock (pid=${staleOwner.pid}, format=${staleOwner.kind})`,
      );
    }
  }

  let ownerPid: number | undefined;
  let ownerFormat: ProcessInstanceFileLock['ownerFormat'] = 'unknown';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        // Write legacy numeric format for now; parser accepts structured JSON too.
        writeFileSync(fd, String(pid), 'utf8');
      } finally {
        closeSync(fd);
      }

      let released = false;
      return {
        acquired: true,
        lockPath,
        release: () => {
          if (released) return;
          released = true;
          try {
            const currentOwner = readLockOwner(lockPath);
            if (
              (currentOwner.kind === 'legacy' || currentOwner.kind === 'structured')
              && currentOwner.pid !== pid
            ) {
              return;
            }
            if (currentOwner.kind === 'unknown') {
              return;
            }
            rmSync(lockPath, { force: true });
          } catch {
            // best-effort
          }
        },
      };
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno !== 'EEXIST') {
        break;
      }

      const owner = readLockOwner(lockPath);
      if (owner.kind === 'legacy' || owner.kind === 'structured') {
        ownerPid = owner.pid;
        ownerFormat = owner.kind;
      } else {
        ownerPid = undefined;
        ownerFormat = 'unknown';
      }
      const shouldTreatAsStale =
        (owner.kind === 'legacy' || owner.kind === 'structured')
        && !isPidAlive(owner.pid);
      if (shouldTreatAsStale && existsSync(lockPath)) {
        try {
          rmSync(lockPath, { force: true });
          continue;
        } catch {
          // If deletion fails, treat lock as held.
        }
      }

      break;
    }
  }

  return {
    acquired: false,
    lockPath,
    ownerPid,
    ownerFormat,
    release: () => {
      // no-op when lock wasn't acquired
    },
  };
}
