import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expandHomePath } from '../storage/paths';

function findUvInPathSync() {
  try {
    const cmd = process.platform === 'win32' ? 'where.exe uv' : 'which uv';
    execSync(cmd, { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function getBundledUvPathCandidates() {
  const binName = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const target = `${process.platform}-${process.arch}`;
  const explicit = String(process.env.MATCHACLAW_UV_BIN || '').trim();
  const candidates = [
    explicit,
    join(process.cwd(), 'resources', 'bin', target, binName),
    resolve(join(__dirname, '../../../resources/bin', target, binName)),
    process.resourcesPath ? join(process.resourcesPath, 'bin', binName) : '',
  ]
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => resolve(expandHomePath(item)));
  return [...new Set(candidates)];
}

export function checkUvInstalledLocal() {
  const candidates = getBundledUvPathCandidates();
  if (candidates.some((candidate) => existsSync(candidate))) {
    return true;
  }
  return findUvInPathSync();
}

function resolveUvExecutableForInstall() {
  const candidates = getBundledUvPathCandidates();
  const bundled = candidates.find((candidate) => existsSync(candidate));
  if (bundled) {
    return bundled;
  }
  return 'uv';
}

export function installUvLocal() {
  const uvExecutable = resolveUvExecutableForInstall();
  if (uvExecutable === 'uv' && !findUvInPathSync()) {
    return {
      success: false,
      error: 'uv not found in system PATH',
    };
  }

  try {
    const installResult = spawnSync(uvExecutable, ['python', 'install', '3.12'], {
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
    });
    if (installResult.error) {
      return {
        success: false,
        error: installResult.error.message,
      };
    }
    if (installResult.status !== 0) {
      return {
        success: false,
        error: installResult.stderr?.trim() || installResult.stdout?.trim() || `uv exited with code ${String(installResult.status)}`,
      };
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: String(error),
    };
  }
}
