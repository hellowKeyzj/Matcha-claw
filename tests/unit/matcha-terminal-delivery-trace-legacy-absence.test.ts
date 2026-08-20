import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const legacyPath = 'runtime-host/shared/matcha-terminal-delivery-trace.ts';
const forbiddenProductionIdentifiers = [
  'MatchaTerminalDeliveryPhase',
  'MatchaTerminalDeliveryEventClass',
  'MatchaTerminalDeliveryTraceCorrelation',
  'MatchaTerminalDeliveryTraceContext',
  'MatchaTerminalDeliveryTraceStage',
  'MatchaTerminalDeliveryTraceRecord',
  'MatchaTerminalDeliveryTraceCorrelationFactory',
  'MatchaTerminalDeliveryTrace',
  'createMatchaTerminalDeliveryTraceLogger',
  'createMatchaTerminalDeliveryTraceCorrelationFactory',
  'readMatchaTerminalDeliveryTraceContext',
  'attachMatchaTerminalDeliveryTraceToEnvelope',
  'attachMatchaTerminalDeliveryTrace',
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

describe('O-105 Matcha terminal delivery trace absence', () => {
  it('keeps the deleted TypeScript-only trace contract and consumers absent', async () => {
    expect(existsSync(path.join(process.cwd(), legacyPath))).toBe(false);

    const productionRoots = ['electron', 'runtime-host', 'src'];
    const files = (await Promise.all(productionRoots.map((root) => collectSourceFiles(
      path.join(process.cwd(), root),
    )))).flat();
    const source = await Promise.all(files.map((file) => readFile(file, 'utf8')));

    for (const identifier of forbiddenProductionIdentifiers) {
      expect(source.some((content) => content.includes(identifier))).toBe(false);
    }
  });
});
