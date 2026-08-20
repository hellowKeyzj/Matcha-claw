import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const legacyPath = 'runtime-host/api/dispatch/runtime-route-dispatcher.ts';
const prohibitedIdentifier = 'createRuntimeRouteDispatcher';

function collectProductionSource(root: string): string[] {
  return readdirSync(join(projectRoot, root), { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) return collectProductionSource(entryPath);
    if (/\.(?:[cm]?[jt]sx?|rs)$/.test(entry.name)) return [readFileSync(join(projectRoot, entryPath), 'utf8')];
    return [];
  });
}

describe('O-005 runtime route dispatcher absence', () => {
  it('keeps the obsolete generic Node route dispatcher absent', () => {
    expect(existsSync(join(projectRoot, legacyPath))).toBe(false);

    const sources = [
      ...collectProductionSource('electron'),
      ...collectProductionSource('src'),
      ...collectProductionSource('runtime-host'),
    ];
    expect(sources.some((source) => source.includes(prohibitedIdentifier))).toBe(false);
  });
});
