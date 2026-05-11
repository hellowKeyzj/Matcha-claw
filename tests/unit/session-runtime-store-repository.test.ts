import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionRuntimeStoreRepository } from '../../runtime-host/application/sessions/session-runtime-store-repository';
import { createTestRuntimeFileSystem } from './helpers/runtime-file-system';

describe('session runtime store repository', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('loads default state and persists active session key', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-runtime-store-'));
    tempDirs.push(configDir);
    const repository = new SessionRuntimeStoreRepository({
      workspace: { getConfigDir: () => configDir },
      fileSystem: createTestRuntimeFileSystem(),
    });

    expect(await repository.load()).toEqual({
      version: 3,
      activeSessionKey: null,
    });

    await repository.save({
      version: 3,
      activeSessionKey: 'agent:main:main',
    });

    expect(await repository.load()).toEqual({
      version: 3,
      activeSessionKey: 'agent:main:main',
    });
    expect(JSON.parse(await readFile(join(configDir, 'matchaclaw-session-runtime-store.json'), 'utf8'))).toEqual({
      version: 3,
      activeSessionKey: 'agent:main:main',
    });
  });
});
