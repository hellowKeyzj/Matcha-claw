import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const legacyWorkbenchPaths = [
  'runtime-host/api/routes/workbench-routes.ts',
  'runtime-host/application/workbench/bootstrap.ts',
  'runtime-host/application/workbench/service.ts',
];

const forbiddenProductionIdentifiers = [
  '/api/workbench/bootstrap',
  'WorkbenchService',
  'workbenchRoutes',
  'plugins.runtimeSnapshot',
];

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectSourceFiles(entryPath);
    }
    return /\.(?:rs|ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  }));
  return files.flat();
}

describe('legacy Workbench owner absence', () => {
  it('does not retain the unconsumed runtime snapshot owner or route', async () => {
    for (const legacyPath of legacyWorkbenchPaths) {
      expect(existsSync(path.join(process.cwd(), legacyPath))).toBe(false);
    }

    const productionRoots = ['electron', 'runtime-host', 'src'];
    const files = (await Promise.all(productionRoots.map((root) => collectSourceFiles(
      path.join(process.cwd(), root)
    )))).flat();
    const source = await Promise.all(files.map((file) => readFile(file, 'utf8')));

    for (const identifier of forbiddenProductionIdentifiers) {
      expect(source.some((content) => content.includes(identifier))).toBe(false);
    }
  });
});
