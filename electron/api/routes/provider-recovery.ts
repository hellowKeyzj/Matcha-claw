import { shell } from 'electron';
import { realpath, stat } from 'node:fs/promises';
import type { ProviderRecoveryTransport } from '../../main/runtime-host-delivery/transport/providers/recovery';
import { hasExactKeys, isRecord } from '../../main/runtime-host-delivery/transport/client';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const RECOVERY_PATH = '/api/providers/recovery';
const INVALID = { success: false, error: 'Provider recovery request is invalid' } as const;
const UNAVAILABLE = { success: false, error: 'Provider configuration recovery is unavailable' } as const;
const OPEN_FAILED = { success: false, error: 'Provider backup directory could not be opened' } as const;

export async function handleProviderRecoveryRoutes(
  req: HostApiRequest,
  url: URL,
  transport: ProviderRecoveryTransport,
): Promise<HostApiRouteResult> {
  const read = url.pathname === RECOVERY_PATH && req.method === 'GET';
  const acknowledge = url.pathname === `${RECOVERY_PATH}/acknowledge` && req.method === 'POST';
  const openBackup = url.pathname === `${RECOVERY_PATH}/open-backup` && req.method === 'POST';
  if (!read && !acknowledge && !openBackup) return undefined;
  if (url.search) {
    return jsonResult(400, INVALID);
  }
  if (!read) {
    try {
      const input = await req.readJson<unknown>();
      if (!isRecord(input) || !hasExactKeys(input, [])) {
        return jsonResult(400, INVALID);
      }
    } catch {
      return jsonResult(400, INVALID);
    }
  }
  try {
    if (acknowledge) {
      const response = await transport.acknowledge();
      return jsonResult(response.status, response.body);
    }
    const response = await transport.read();
    if (!openBackup || response.status !== 200) {
      return jsonResult(response.status, response.body);
    }
    if (response.body.recovery === null) {
      return jsonResult(409, { success: false, error: 'No pending Provider backup directory' });
    }
    const directory = await realpath(response.body.recovery.backupDirectory);
    if (!(await stat(directory)).isDirectory() || await shell.openPath(directory) !== '') {
      return jsonResult(503, OPEN_FAILED);
    }
    return jsonResult(200, { success: true });
  } catch {
    return jsonResult(503, openBackup ? OPEN_FAILED : UNAVAILABLE);
  }
}
