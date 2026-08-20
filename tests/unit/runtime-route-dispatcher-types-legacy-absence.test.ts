import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const legacyPath = 'runtime-host/api/dispatch/runtime-route-dispatcher-types.ts';
const forbiddenProductionIdentifiers = [
  'RuntimeRouteRequest',
  'RuntimeRouteHandler',
  'RuntimeRouteHandlerEntry',
  'RuntimeRouteMatcher',
];

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(entryPath);
    return /\.(?:rs|ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  }));
  return files.flat();
}

describe('legacy runtime route dispatcher type absence', () => {
  it('does not retain the unconsumed dispatcher contract or references', async () => {
    expect(existsSync(path.join(process.cwd(), legacyPath))).toBe(false);

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
