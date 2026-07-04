import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExternalMcpServerProgramCatalog } from '../../runtime-host/application/external-connectors/external-mcp-server-program-catalog';
import type { RuntimeDirectoryEntry, RuntimeFileStat, RuntimeFileSystemPort } from '../../runtime-host/application/common/runtime-ports';

function normalizePath(value: string): string {
  return path.resolve(value).replaceAll('\\', '/');
}

function createFileSystemFixture(input: {
  readonly directories: Record<string, readonly RuntimeDirectoryEntry[]>;
  readonly files: Record<string, string>;
}): RuntimeFileSystemPort {
  const directories = new Map(Object.entries(input.directories).map(([key, value]) => [normalizePath(key), value]));
  const files = new Map(Object.entries(input.files).map(([key, value]) => [normalizePath(key), value]));
  return {
    exists: async (pathname) => directories.has(normalizePath(pathname)) || files.has(normalizePath(pathname)),
    ensureDirectory: async () => {},
    listDirectory: async (pathname) => directories.get(normalizePath(pathname)) ?? [],
    readTextFile: async (pathname) => {
      const content = files.get(normalizePath(pathname));
      if (content === undefined) {
        throw new Error(`Missing fixture file: ${pathname}`);
      }
      return content;
    },
    readTextFileLines: async function* () {},
    readBinaryFile: async () => new Uint8Array(),
    writeTextFile: async () => {},
    writeBinaryFile: async () => {},
    writeTextFileExclusive: async () => true,
    copyFile: async () => {},
    removeFile: async () => {},
    removeDirectory: async () => {},
    rename: async () => {},
    realPath: async (pathname) => pathname,
    stat: async (): Promise<RuntimeFileStat> => ({ isFile: true, isDirectory: false, size: 0, mtimeMs: 0 }),
  };
}

describe('ExternalMcpServerProgramCatalog', () => {
  it('includes the Matcha system runtime MCP server program', async () => {
    const catalog = new ExternalMcpServerProgramCatalog({
      environment: { resourcesPath: null, workingDir: 'E:/repo' },
      runtimeData: { getRuntimeDataRootDir: () => 'C:/MatchaClaw/data' },
      fileSystem: createFileSystemFixture({ directories: {}, files: {} }),
    });

    await expect(catalog.snapshot()).resolves.toEqual({
      issues: [],
      programs: [{
        id: 'system-runtime:matcha',
        source: 'system-runtime',
        displayName: 'Matcha system runtime',
        connectorKinds: ['mcp-stdio'],
        command: 'matcha',
        args: ['system-runtime', 'mcp-stdio'],
      }],
    });
  });

  it('discovers bundled plugin .mcp.json programs', async () => {
    const resourcesPath = 'C:/MatchaClaw/resources';
    const pluginRoot = path.join(resourcesPath, 'resources', 'external-connectors', 'builtin-plugins', 'weixinpay');
    const pluginCatalogRoot = path.dirname(pluginRoot);
    const manifestPath = path.join(pluginRoot, '.mcp.json');
    const catalog = new ExternalMcpServerProgramCatalog({
      environment: { resourcesPath, workingDir: 'E:/repo' },
      runtimeData: { getRuntimeDataRootDir: () => 'C:/MatchaClaw/data' },
      fileSystem: createFileSystemFixture({
        directories: {
          [pluginCatalogRoot]: [{ name: 'weixinpay', isDirectory: true, isFile: false }],
        },
        files: {
          [manifestPath]: JSON.stringify({
            mcpServers: {
              weixinpay: {
                command: '${MATCHA_EXTERNAL_CONNECTOR_PROGRAM_ROOT}/bin/run-node',
                args: ['${MATCHA_EXTERNAL_CONNECTOR_PROGRAM_ROOT}/dist/mcp-server.mjs'],
                env: { WECHATPAY_PAYSIGN_SERVICE_ID: 'agentpay' },
              },
            },
          }),
        },
      }),
    });

    await expect(catalog.snapshot()).resolves.toEqual({
      issues: [],
      programs: [
        expect.objectContaining({
          id: 'bundled-plugin:weixinpay:weixinpay',
          source: 'bundled-plugin',
          displayName: 'weixinpay',
          rootPath: path.resolve(pluginRoot),
          manifestPath: path.resolve(manifestPath),
          connectorKinds: ['mcp-stdio'],
          command: `${path.resolve(pluginRoot)}/bin/run-node`,
          args: [`${path.resolve(pluginRoot)}/dist/mcp-server.mjs`],
          envKeys: ['WECHATPAY_PAYSIGN_SERVICE_ID'],
        }),
        expect.objectContaining({ id: 'system-runtime:matcha' }),
      ],
    });
  });

  it('discovers bundled MCP app entrypoints', async () => {
    const resourcesPath = 'C:/MatchaClaw/resources';
    const appRoot = path.join(resourcesPath, 'resources', 'external-connectors', 'builtin-mcp-apps', 'ardot-mcp-app');
    const appCatalogRoot = path.dirname(appRoot);
    const entrypointPath = path.join(appRoot, 'cli.cjs');
    const catalog = new ExternalMcpServerProgramCatalog({
      environment: { resourcesPath, workingDir: 'E:/repo' },
      runtimeData: { getRuntimeDataRootDir: () => 'C:/MatchaClaw/data' },
      fileSystem: createFileSystemFixture({
        directories: {
          [appCatalogRoot]: [{ name: 'ardot-mcp-app', isDirectory: true, isFile: false }],
        },
        files: {
          [entrypointPath]: 'module.exports = {};',
        },
      }),
    });

    await expect(catalog.snapshot()).resolves.toMatchObject({
      issues: [],
      programs: [
        {
          id: 'bundled-mcp-app:ardot-mcp-app',
          source: 'bundled-mcp-app',
          displayName: 'ardot-mcp-app',
          rootPath: path.resolve(appRoot),
          entrypointPath: path.resolve(entrypointPath),
          connectorKinds: ['mcp-http'],
        },
        {
          id: 'system-runtime:matcha',
          source: 'system-runtime',
          displayName: 'Matcha system runtime',
          connectorKinds: ['mcp-stdio'],
          command: 'matcha',
          args: ['system-runtime', 'mcp-stdio'],
        },
      ],
    });
  });
});
