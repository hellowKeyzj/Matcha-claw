import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const legacyRouteIndexPath = join(projectRoot, 'runtime-host', 'api', 'dispatch', 'runtime-route-index.ts');
const forbiddenRouteIndexSymbols = [
  'runtime-route-index',
  'RuntimeRouteIndex',
  'createRuntimeRouteDispatcher',
];

function collectProductionSource(root: string): string[] {
  return readdirSync(join(projectRoot, root), { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(projectRoot, root, entry.name);
    if (entry.isDirectory()) {
      return collectNestedProductionSource(entryPath);
    }
    return /\.(?:[cm]?[jt]sx?|rs)$/.test(entry.name) ? [entryPath] : [];
  });
}

function collectNestedProductionSource(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) return collectNestedProductionSource(entryPath);
    return /\.(?:[cm]?[jt]sx?|rs)$/.test(entry.name) ? [entryPath] : [];
  });
}

describe('runtime route index deletion', () => {
  it('keeps the generic TypeScript route index unreachable from supported runtime sources', () => {
    expect(existsSync(legacyRouteIndexPath)).toBe(false);

    const sources = [
      ...collectProductionSource('electron'),
      ...collectProductionSource('src'),
      ...collectProductionSource('runtime-host'),
    ].map((path) => readFileSync(path, 'utf8'));

    for (const symbol of forbiddenRouteIndexSymbols) {
      expect(sources.some((source) => source.includes(symbol))).toBe(false);
    }
  });
});
