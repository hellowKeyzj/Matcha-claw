import path from 'node:path';
import type { RuntimeDataRootPort, RuntimeFileSystemPort, RuntimeSystemEnvironmentPort } from '../common/runtime-ports';
import type { ExternalConnectorKind, ExternalMcpServerProgramSource } from './external-connector-model';

export type ExternalMcpConnectorKind = Extract<ExternalConnectorKind, 'mcp-stdio' | 'mcp-http'>;

export const MATCHA_SYSTEM_RUNTIME_MCP_PROGRAM_ID = 'system-runtime:matcha';
export const MATCHA_SYSTEM_RUNTIME_CONNECTOR_ID = 'matcha';

export interface ExternalMcpServerProgramDescriptor {
  readonly id: string;
  readonly source: ExternalMcpServerProgramSource;
  readonly displayName: string;
  readonly rootPath?: string;
  readonly manifestPath?: string;
  readonly entrypointPath?: string;
  readonly connectorKinds: readonly ExternalMcpConnectorKind[];
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly transport?: 'streamable-http' | 'sse';
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
}

export interface ExternalMcpServerProgramCatalogIssue {
  readonly source: ExternalMcpServerProgramSource;
  readonly path: string;
  readonly reason: string;
}

export interface ExternalMcpServerProgramCatalogSnapshot {
  readonly programs: readonly ExternalMcpServerProgramDescriptor[];
  readonly issues: readonly ExternalMcpServerProgramCatalogIssue[];
}

interface ExternalMcpServerProgramCatalogRoot {
  readonly source: ExternalMcpServerProgramSource;
  readonly rootPath: string;
  readonly layout: 'plugin' | 'mcp-app';
}

export class ExternalMcpServerProgramCatalog {
  constructor(private readonly deps: {
    readonly environment: Pick<RuntimeSystemEnvironmentPort, 'resourcesPath' | 'workingDir'>;
    readonly runtimeData: RuntimeDataRootPort;
    readonly fileSystem: RuntimeFileSystemPort;
  }) {}

  async snapshot(): Promise<ExternalMcpServerProgramCatalogSnapshot> {
    const programs: ExternalMcpServerProgramDescriptor[] = [createSystemRuntimeMcpServerProgram()];
    const issues: ExternalMcpServerProgramCatalogIssue[] = [];

    for (const root of this.resolveCatalogRoots()) {
      if (!await this.deps.fileSystem.exists(root.rootPath)) {
        continue;
      }
      try {
        programs.push(...await this.readRootPrograms(root, issues));
      } catch (error) {
        issues.push({
          source: root.source,
          path: root.rootPath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      programs: programs.sort((left, right) => left.id.localeCompare(right.id)),
      issues,
    };
  }

  private resolveCatalogRoots(): readonly ExternalMcpServerProgramCatalogRoot[] {
    const roots: ExternalMcpServerProgramCatalogRoot[] = [];
    const seen = new Set<string>();
    const addRoot = (source: ExternalMcpServerProgramSource, layout: 'plugin' | 'mcp-app', rootPath: string): void => {
      const resolvedPath = path.resolve(rootPath);
      const key = `${source}:${layout}:${resolvedPath}`;
      if (!seen.has(key)) {
        seen.add(key);
        roots.push({ source, layout, rootPath: resolvedPath });
      }
    };

    const resourcesPath = this.deps.environment.resourcesPath;
    for (const basePath of [
      resourcesPath ? path.join(resourcesPath, 'resources') : '',
      resourcesPath ?? '',
      path.join(this.deps.environment.workingDir, 'resources'),
    ].filter(Boolean)) {
      addRoot('bundled-plugin', 'plugin', path.join(basePath, 'external-connectors', 'builtin-plugins'));
      addRoot('bundled-mcp-app', 'mcp-app', path.join(basePath, 'external-connectors', 'builtin-mcp-apps'));
    }

    addRoot(
      'managed-local',
      'plugin',
      path.join(this.deps.runtimeData.getRuntimeDataRootDir(), 'external-connectors', 'mcp-server-programs'),
    );

    return roots;
  }

  private async readRootPrograms(
    root: ExternalMcpServerProgramCatalogRoot,
    issues: ExternalMcpServerProgramCatalogIssue[],
  ): Promise<readonly ExternalMcpServerProgramDescriptor[]> {
    const entries = await this.deps.fileSystem.listDirectory(root.rootPath);
    const directories = entries.filter((entry) => entry.isDirectory);
    const programs: ExternalMcpServerProgramDescriptor[] = [];

    for (const directory of directories) {
      const programRoot = path.join(root.rootPath, directory.name);
      if (root.layout === 'plugin') {
        programs.push(...await this.readPluginPrograms(root.source, programRoot, issues));
      } else {
        const appProgram = await this.readMcpAppProgram(root.source, programRoot, directory.name);
        if (appProgram) {
          programs.push(appProgram);
        }
      }
    }

    return programs;
  }

  private async readPluginPrograms(
    source: ExternalMcpServerProgramSource,
    programRoot: string,
    issues: ExternalMcpServerProgramCatalogIssue[],
  ): Promise<readonly ExternalMcpServerProgramDescriptor[]> {
    const manifestPath = path.join(programRoot, '.mcp.json');
    if (!await this.deps.fileSystem.exists(manifestPath)) {
      return [];
    }

    try {
      const manifest = readRecord(JSON.parse(await this.deps.fileSystem.readTextFile(manifestPath)));
      const mcpServers = readRecord(manifest.mcpServers);
      const pluginId = path.basename(programRoot);
      return Object.entries(mcpServers).flatMap(([serverName, serverValue]) => {
        const server = readRecord(serverValue);
        const descriptor = this.createProgramFromMcpServerManifest({
          source,
          pluginId,
          serverName,
          programRoot,
          manifestPath,
          server,
        });
        return descriptor ? [descriptor] : [];
      });
    } catch (error) {
      issues.push({
        source,
        path: manifestPath,
        reason: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private createProgramFromMcpServerManifest(input: {
    readonly source: ExternalMcpServerProgramSource;
    readonly pluginId: string;
    readonly serverName: string;
    readonly programRoot: string;
    readonly manifestPath: string;
    readonly server: Record<string, unknown>;
  }): ExternalMcpServerProgramDescriptor | null {
    const command = typeof input.server.command === 'string'
      ? resolveProgramRootToken(input.server.command, input.programRoot)
      : undefined;
    const url = typeof input.server.url === 'string' ? input.server.url : undefined;
    const args = Array.isArray(input.server.args)
      ? input.server.args.filter((arg): arg is string => typeof arg === 'string').map((arg) => resolveProgramRootToken(arg, input.programRoot))
      : undefined;

    if (!command && !url) {
      return null;
    }

    return {
      id: `${input.source}:${input.pluginId}:${input.serverName}`,
      source: input.source,
      displayName: input.serverName,
      rootPath: input.programRoot,
      manifestPath: input.manifestPath,
      connectorKinds: command ? ['mcp-stdio'] : ['mcp-http'],
      command,
      args,
      url,
      transport: readMcpHttpTransport(input.server.transport),
      envKeys: readRecordKeys(input.server.env),
      headerKeys: readRecordKeys(input.server.headers),
    };
  }

  private async readMcpAppProgram(
    source: ExternalMcpServerProgramSource,
    programRoot: string,
    appId: string,
  ): Promise<ExternalMcpServerProgramDescriptor | null> {
    const entrypointPath = path.join(programRoot, 'cli.cjs');
    if (!await this.deps.fileSystem.exists(entrypointPath)) {
      return null;
    }

    return {
      id: `${source}:${appId}`,
      source,
      displayName: appId,
      rootPath: programRoot,
      entrypointPath,
      connectorKinds: ['mcp-http'],
    };
  }
}

function createSystemRuntimeMcpServerProgram(): ExternalMcpServerProgramDescriptor {
  return {
    id: MATCHA_SYSTEM_RUNTIME_MCP_PROGRAM_ID,
    source: 'system-runtime',
    displayName: 'Matcha system runtime',
    connectorKinds: ['mcp-stdio'],
    command: 'matcha',
    args: ['system-runtime', 'mcp-stdio'],
  };
}

function resolveProgramRootToken(value: string, programRoot: string): string {
  const resolvedProgramRoot = path.resolve(programRoot);
  return value
    .replaceAll('${MATCHA_EXTERNAL_CONNECTOR_PROGRAM_ROOT}', resolvedProgramRoot)
    .replaceAll('${MATCHA_CONNECTOR_PROGRAM_ROOT}', resolvedProgramRoot);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readRecordKeys(value: unknown): readonly string[] | undefined {
  const keys = Object.keys(readRecord(value));
  return keys.length > 0 ? keys.sort() : undefined;
}

function readMcpHttpTransport(value: unknown): 'streamable-http' | 'sse' | undefined {
  return value === 'streamable-http' || value === 'sse' ? value : undefined;
}
