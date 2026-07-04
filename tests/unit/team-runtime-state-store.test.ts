import { describe, expect, it } from 'vitest';
import { FileTeamRuntimeStateStore } from '../../runtime-host/application/team-runtime/team-runtime-state-store';
import type { RuntimeDirectoryEntry } from '../../runtime-host/application/common/runtime-ports';

class MemoryTeamRuntimeFileSystem {
  readonly files = new Map<string, string>();
  readonly removedFiles: string[] = [];

  async ensureDirectory(_pathname: string): Promise<void> {}

  async listDirectory(pathname: string): Promise<RuntimeDirectoryEntry[]> {
    const prefix = `${normalizePath(pathname)}/`;
    const names = new Set<string>();
    for (const filePath of this.files.keys()) {
      const normalized = normalizePath(filePath);
      if (!normalized.startsWith(prefix)) continue;
      const relativePath = normalized.slice(prefix.length);
      if (relativePath.includes('/')) continue;
      names.add(relativePath);
    }
    if (names.size === 0) throw notFoundError(pathname);
    return Array.from(names).sort().map((name) => ({ name, isFile: true, isDirectory: false }));
  }

  async readTextFile(pathname: string): Promise<string> {
    const value = this.files.get(normalizePath(pathname));
    if (value === undefined) throw notFoundError(pathname);
    return value;
  }

  async writeTextFile(pathname: string, content: string): Promise<void> {
    this.files.set(normalizePath(pathname), content);
  }

  async removeFile(pathname: string): Promise<void> {
    this.removedFiles.push(normalizePath(pathname));
    this.files.delete(normalizePath(pathname));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const value = this.files.get(normalizePath(oldPath));
    if (value === undefined) throw notFoundError(oldPath);
    this.files.set(normalizePath(newPath), value);
    this.files.delete(normalizePath(oldPath));
  }
}

describe('FileTeamRuntimeStateStore', () => {
  it('reads and writes TeamRun state only under the canonical runtime root', async () => {
    const fileSystem = new MemoryTeamRuntimeFileSystem();
    const store = new FileTeamRuntimeStateStore({
      runtimeData: { getRuntimeDataRootDir: () => '/current' },
      fileSystem: fileSystem as never,
    });

    await expect(store.readTeamInstance('team-1')).resolves.toBeNull();
    await expect(store.readRunState('run-1')).resolves.toBeNull();
    await expect(store.listTeamInstances()).resolves.toEqual([]);

    await store.writeTeamInstance('team-1', { teamId: 'team-1', runs: [{ runId: 'run-1' }] });
    await store.writeRunState('run-1', { run: { runId: 'run-1', status: 'created' } });

    await expect(store.readTeamInstance('team-1')).resolves.toEqual({ teamId: 'team-1', runs: [{ runId: 'run-1' }] });
    await expect(store.readRunState('run-1')).resolves.toEqual({ run: { runId: 'run-1', status: 'created' } });
    await expect(store.listTeamInstances()).resolves.toEqual([{ teamId: 'team-1', runs: [{ runId: 'run-1' }] }]);
    expect(JSON.parse(fileSystem.files.get(normalizePath('/current/team-runtime/teams/team-1.json')) ?? '{}')).toEqual({ teamId: 'team-1', runs: [{ runId: 'run-1' }] });
    expect(JSON.parse(fileSystem.files.get(normalizePath('/current/team-runtime/runs/run-1.json')) ?? '{}')).toEqual({ run: { runId: 'run-1', status: 'created' } });
  });
});

function normalizePath(pathname: string): string {
  return pathname.replace(/\\/g, '/');
}

function notFoundError(pathname: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, open '${pathname}'`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}
