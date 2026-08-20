import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const deletedAcpPaths = [
  'runtime-host/composition/modules/acp-connector-module.ts',
  'runtime-host/application/agent-runtime/protocol-connectors/acp',
  'runtime-host/integrations/acp',
];
const residualIdentifiers = [
  'acp-connector',
  'registerAcpConnectorModule',
  'AcpClientConnector',
  'AcpJsonRpc',
  'acp-json-rpc',
  'ACP_',
  'Claude ACP',
  'Hermes ACP',
];

function collectProductionSources(root: string): string[] {
  return readdirSync(join(projectRoot, root), { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) return collectProductionSources(entryPath);
    if (!/\.(?:[cm]?[jt]sx?|rs)$/.test(entry.name)) return [];
    return [readFileSync(join(projectRoot, entryPath), 'utf8')];
  });
}

describe('ACP connector module deletion', () => {
  it('keeps the deleted no-consumer ACP connector unreachable from supported roots', () => {
    for (const deletedPath of deletedAcpPaths) {
      expect(existsSync(join(projectRoot, deletedPath))).toBe(false);
    }

    const sources = [
      ...collectProductionSources('electron'),
      ...collectProductionSources('src'),
      ...collectProductionSources('runtime-host'),
    ];
    for (const identifier of residualIdentifiers) {
      expect(sources.some((source) => source.includes(identifier))).toBe(false);
    }

    const workspace = readFileSync(join(projectRoot, 'runtime-host', 'Cargo.toml'), 'utf8');
    expect(workspace).not.toMatch(/^\s*(?:"?[^"\n]*acp[^"\n]*"?|[^#\n]*\bacp\b)/im);
  });
});
