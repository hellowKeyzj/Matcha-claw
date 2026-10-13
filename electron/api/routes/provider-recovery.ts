import { shell } from 'electron';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProviderRecoveryTransport } from '../../main/runtime-host-delivery/transport/providers/recovery';
import { hasExactKeys, isRecord } from '../../main/runtime-host-delivery/transport/client';
import { parseJsonBody, sendJson } from '../route-utils';

const RECOVERY_PATH = '/api/providers/recovery';
const INVALID = { success: false, error: 'Provider recovery request is invalid' } as const;
const UNAVAILABLE = { success: false, error: 'Provider configuration recovery is unavailable' } as const;
const OPEN_FAILED = { success: false, error: 'Provider backup directory could not be opened' } as const;

export async function handleProviderRecoveryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ProviderRecoveryTransport,
): Promise<boolean> {
  const read = url.pathname === RECOVERY_PATH && req.method === 'GET';
  const acknowledge = url.pathname === `${RECOVERY_PATH}/acknowledge` && req.method === 'POST';
  const openBackup = url.pathname === `${RECOVERY_PATH}/open-backup` && req.method === 'POST';
  if (!read && !acknowledge && !openBackup) return false;
  if (url.search) {
    sendJson(res, 400, INVALID);
    return true;
  }
  if (!read) {
    try {
      const input = await parseJsonBody<unknown>(req);
      if (!isRecord(input) || !hasExactKeys(input, [])) {
        sendJson(res, 400, INVALID);
        return true;
      }
    } catch {
      sendJson(res, 400, INVALID);
      return true;
    }
  }
  try {
    if (acknowledge) {
      const response = await transport.acknowledge();
      sendJson(res, response.status, response.body);
      return true;
    }
    const response = await transport.read();
    if (!openBackup || response.status !== 200) {
      sendJson(res, response.status, response.body);
      return true;
    }
    if (response.body.recovery === null) {
      sendJson(res, 409, { success: false, error: 'No pending Provider backup directory' });
      return true;
    }
    const directory = await realpath(response.body.recovery.backupDirectory);
    if (!(await stat(directory)).isDirectory() || await shell.openPath(directory) !== '') {
      sendJson(res, 503, OPEN_FAILED);
      return true;
    }
    sendJson(res, 200, { success: true });
  } catch {
    sendJson(res, 503, openBackup ? OPEN_FAILED : UNAVAILABLE);
  }
  return true;
}
