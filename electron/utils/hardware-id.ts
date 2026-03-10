import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const HARDWARE_ID_CONTEXT = 'matchaclaw-hardware-id-v1';

function normalizeRawMachineId(input: string): string {
  return input.trim().toLowerCase();
}

function execFileText(command: string, args: string[], timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: 1024 * 256,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve((stdout || '').toString());
      },
    );
  });
}

async function resolveWindowsMachineGuid(): Promise<string | null> {
  try {
    const output = await execFileText('reg', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
      '/v',
      'MachineGuid',
    ]);
    const matched = output.match(/MachineGuid\s+REG_\w+\s+([^\r\n]+)/i);
    if (!matched) {
      return null;
    }
    return matched[1].trim();
  } catch {
    return null;
  }
}

async function resolveMacPlatformUuid(): Promise<string | null> {
  try {
    const output = await execFileText('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    const matched = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/i);
    if (!matched) {
      return null;
    }
    return matched[1].trim();
  } catch {
    return null;
  }
}

async function resolveLinuxMachineId(): Promise<string | null> {
  const candidates = ['/etc/machine-id', '/var/lib/dbus/machine-id'];
  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, 'utf8');
      const normalized = raw.trim();
      if (normalized) {
        return normalized;
      }
    } catch {
      // continue
    }
  }
  return null;
}

export function normalizeAndHashHardwareId(raw: string): string {
  const normalized = normalizeRawMachineId(raw);
  if (!normalized) {
    return '';
  }
  return crypto
    .createHash('sha256')
    .update(`${HARDWARE_ID_CONTEXT}:${normalized}`)
    .digest('hex');
}

export async function resolveHardwareIdRaw(
  platformName: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platformName === 'win32') {
    return resolveWindowsMachineGuid();
  }
  if (platformName === 'darwin') {
    return resolveMacPlatformUuid();
  }
  if (platformName === 'linux') {
    return resolveLinuxMachineId();
  }
  return null;
}

export async function resolveHardwareId(
  platformName: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const override = process.env.MATCHACLAW_LICENSE_HARDWARE_ID_OVERRIDE?.trim();
  if (override) {
    const hashed = normalizeAndHashHardwareId(override);
    return hashed || null;
  }

  const raw = await resolveHardwareIdRaw(platformName);
  if (!raw) {
    return null;
  }
  const hashed = normalizeAndHashHardwareId(raw);
  return hashed || null;
}
