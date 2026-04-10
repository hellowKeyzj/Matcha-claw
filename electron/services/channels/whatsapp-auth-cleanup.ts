import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fsPath } from '../../utils/fs-path';

export function resolveWhatsAppAuthDir(accountId: string, homeDir = homedir()): string {
  const normalizedAccountId = accountId.trim() || 'default';
  return join(homeDir, '.openclaw', 'credentials', 'whatsapp', normalizedAccountId);
}

export function cleanupWhatsAppAuthDir(authDir: string): {
  removedAuthDir: boolean;
  removedParentDir: boolean;
} {
  const safeAuthDir = fsPath(authDir);
  if (!existsSync(safeAuthDir)) {
    return { removedAuthDir: false, removedParentDir: false };
  }

  rmSync(safeAuthDir, { recursive: true, force: true });
  let removedParentDir = false;

  const parentDir = dirname(authDir);
  const safeParentDir = fsPath(parentDir);
  if (existsSync(safeParentDir)) {
    const remainingEntries = readdirSync(safeParentDir);
    if (remainingEntries.length === 0) {
      rmSync(safeParentDir, { recursive: true, force: true });
      removedParentDir = true;
    }
  }

  return {
    removedAuthDir: true,
    removedParentDir,
  };
}
