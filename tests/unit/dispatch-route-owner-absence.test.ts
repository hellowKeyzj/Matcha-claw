import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const legacyPath = 'runtime-host/api/dispatch/dispatch-route-handler.ts';
const prohibitedSources = [
  'handleDispatchRoute',
  'dispatchRuntimeRoute',
  'parseDispatchEnvelope',
  'DISPATCH_ENVELOPE_MAX_BODY_BYTES',
  'Dispatch failure:',
];

function collectProductionSource(root: string): string[] {
  return readdirSync(join(projectRoot, root), { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return collectProductionSource(path);
    if (/\.(?:[cm]?[jt]sx?|rs)$/.test(entry.name)) return [readFileSync(join(projectRoot, path), 'utf8')];
    return [];
  });
}

describe('O-003 dispatch route owner absence', () => {
  it('keeps the unauthorised generic route and its unsafe error projection absent', () => {
    expect(existsSync(join(projectRoot, legacyPath))).toBe(false);

    const sources = [
      ...collectProductionSource('electron'),
      ...collectProductionSource('src'),
      ...collectProductionSource('runtime-host'),
    ];
    for (const source of prohibitedSources) {
      expect(sources.some((content) => content.includes(source))).toBe(false);
    }
  });
});
