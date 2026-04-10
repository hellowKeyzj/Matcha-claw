import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupWhatsAppAuthDir,
  resolveWhatsAppAuthDir,
} from '../../electron/services/channels/whatsapp-auth-cleanup';

describe('whatsapp auth cleanup', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) {
        continue;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('清理账号目录后，若父目录为空则一并删除', async () => {
    const home = await mkdtemp(join(tmpdir(), 'matchaclaw-wa-cleanup-'));
    tempDirs.push(home);
    const authDir = resolveWhatsAppAuthDir('default', home);
    await mkdir(authDir, { recursive: true });
    await writeFile(join(authDir, 'creds.json'), '{}', 'utf8');

    const result = cleanupWhatsAppAuthDir(authDir);

    expect(result).toEqual({ removedAuthDir: true, removedParentDir: true });
    expect(existsSync(authDir)).toBe(false);
    expect(existsSync(join(home, '.openclaw', 'credentials', 'whatsapp'))).toBe(false);
  });

  it('只清理目标账号目录，不影响其他账号目录', async () => {
    const home = await mkdtemp(join(tmpdir(), 'matchaclaw-wa-cleanup-'));
    tempDirs.push(home);
    const existingAuthDir = resolveWhatsAppAuthDir('existing', home);
    const canceledAuthDir = resolveWhatsAppAuthDir('new-account', home);
    await mkdir(existingAuthDir, { recursive: true });
    await mkdir(canceledAuthDir, { recursive: true });

    const result = cleanupWhatsAppAuthDir(canceledAuthDir);

    expect(result).toEqual({ removedAuthDir: true, removedParentDir: false });
    expect(existsSync(canceledAuthDir)).toBe(false);
    expect(existsSync(existingAuthDir)).toBe(true);
  });

  it('目录不存在时返回无变更', async () => {
    const home = await mkdtemp(join(tmpdir(), 'matchaclaw-wa-cleanup-'));
    tempDirs.push(home);
    const missingAuthDir = resolveWhatsAppAuthDir('missing', home);

    const result = cleanupWhatsAppAuthDir(missingAuthDir);

    expect(result).toEqual({ removedAuthDir: false, removedParentDir: false });
  });
});
