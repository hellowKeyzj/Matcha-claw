import { resolve } from 'node:path';
import type { ExternalConnectorSpec } from '../../../external-connectors/external-connector-model';
import type { ExternalConnectorProjectionSourcePort } from '../../../external-connectors/external-connector-service';
import type { OpenClawConfigRepositoryPort } from '../infrastructure/openclaw-config-repository';

export type ExternalConnectorOpenClawMcpProjectionResult =
  | {
    readonly resultType: 'projectable';
    readonly connectorId: string;
    readonly serverId: string;
    readonly server: Record<string, unknown>;
  }
  | {
    readonly resultType: 'notProjectable';
    readonly connectorId: string;
    readonly reason: string;
  };

const LEGACY_MATCHA_EXTERNAL_MCP_SERVER_ID_PREFIX = 'matcha-external.';
const LEGACY_MATCHA_SYSTEM_RUNTIME_OPENCLAW_MCP_SERVER_IDS = new Set(['matcha-system', 'matcha-system-runtime']);
const SYSTEM_RUNTIME_PROGRAM_SOURCE = 'system-runtime';
const SYSTEM_RUNTIME_MCP_STDIO_ARGS = Object.freeze(['system-runtime', 'mcp-stdio']);
const RUNTIME_HOST_MARKER_FILE_NAME = 'host-process.cjs';
const MAIN_CLI_FILE_NAME = 'main-cli.js';
const MAIN_CLI_RELATIVE_PATH = ['runtime-host', 'build', MAIN_CLI_FILE_NAME] as const;
const PACKAGED_MAIN_CLI_RELATIVE_PATH = ['app.asar', ...MAIN_CLI_RELATIVE_PATH] as const;

export class ExternalConnectorOpenClawMcpProjectionService {
  constructor(private readonly deps: {
    readonly connectors: ExternalConnectorProjectionSourcePort;
    readonly configRepository: OpenClawConfigRepositoryPort;
  }) {}

  async sync(): Promise<{
    readonly projected: readonly string[];
    readonly skipped: readonly ExternalConnectorOpenClawMcpProjectionResult[];
  }> {
    const connectors = await this.deps.connectors.listConnectorSpecs();
    const projections = await Promise.all(connectors.map((connector) => projectExternalConnectorToOpenClawMcpServer(connector)));
    const projectable = projections.filter(isProjectableProjection);
    const skipped = projections.filter((projection) => projection.resultType === 'notProjectable');

    await this.deps.configRepository.patchSection('mcp', (mcpValue, config) => {
      const mcp = readRecord(mcpValue);
      const servers = readRecord(mcp.servers);
      const nextManagedServerIds = new Set(projectable.map((projection) => projection.serverId));
      let changed = false;

      for (const serverId of Object.keys(servers)) {
        if (isStaleOpenClawMcpServerId(serverId, nextManagedServerIds)) {
          delete servers[serverId];
          changed = true;
        }
      }

      for (const projection of projectable) {
        const current = servers[projection.serverId];
        if (!isDeepEqual(current, projection.server)) {
          servers[projection.serverId] = projection.server;
          changed = true;
        }
      }

      if (!changed) {
        return { result: undefined, value: mcpValue, changed: false };
      }
      markRestartCommand(config);
      return {
        result: undefined,
        value: {
          ...mcp,
          servers,
        },
        changed: true,
      };
    });

    return {
      projected: projectable.map((projection) => projection.connectorId),
      skipped,
    };
  }
}

export async function projectExternalConnectorToOpenClawMcpServer(
  connector: ExternalConnectorSpec,
): Promise<ExternalConnectorOpenClawMcpProjectionResult> {
  if (connector.enabled === false) {
    return notProjectable(connector.id, 'connector is disabled');
  }

  if (connector.kind === 'mcp-stdio') {
    if (connector.secretEnv && Object.keys(connector.secretEnv).length > 0) {
      return notProjectable(connector.id, 'mcp-stdio connectors with secretEnv require a private secret projection');
    }
    const server = connector.mcpServerProgram?.source === SYSTEM_RUNTIME_PROGRAM_SOURCE
      ? buildSystemRuntimeMcpStdioServer(connector)
      : withoutUndefined({
        command: connector.command,
        args: connector.args ? [...connector.args] : undefined,
        env: connector.env ? { ...connector.env } : undefined,
        cwd: connector.cwd,
      });
    return {
      resultType: 'projectable',
      connectorId: connector.id,
      serverId: buildOpenClawMcpServerId(connector.id),
      server,
    };
  }

  if (connector.kind === 'mcp-http') {
    if (connector.secretHeaders && Object.keys(connector.secretHeaders).length > 0) {
      return notProjectable(connector.id, 'mcp-http connectors with secretHeaders require a private secret projection');
    }
    return {
      resultType: 'projectable',
      connectorId: connector.id,
      serverId: buildOpenClawMcpServerId(connector.id),
      server: withoutUndefined({
        url: connector.url,
        transport: connector.transport ?? 'streamable-http',
        headers: connector.headers ? { ...connector.headers } : undefined,
        connectionTimeoutMs: connector.connectionTimeoutMs,
      }),
    };
  }

  return notProjectable(connector.id, `${connector.kind} connectors are Matcha-owned and cannot be projected to OpenClaw MCP config directly`);
}

function isProjectableProjection(
  projection: ExternalConnectorOpenClawMcpProjectionResult,
): projection is Extract<ExternalConnectorOpenClawMcpProjectionResult, { resultType: 'projectable' }> {
  return projection.resultType === 'projectable';
}

function notProjectable(connectorId: string, reason: string): ExternalConnectorOpenClawMcpProjectionResult {
  return { resultType: 'notProjectable', connectorId, reason };
}

export function buildOpenClawMcpServerId(connectorId: string): string {
  return connectorId;
}

function isStaleOpenClawMcpServerId(serverId: string, nextManagedServerIds: ReadonlySet<string>): boolean {
  if (nextManagedServerIds.has(serverId)) {
    return false;
  }
  return LEGACY_MATCHA_SYSTEM_RUNTIME_OPENCLAW_MCP_SERVER_IDS.has(serverId)
    || serverId.startsWith(LEGACY_MATCHA_EXTERNAL_MCP_SERVER_ID_PREFIX);
}

function buildSystemRuntimeMcpStdioServer(
  connector: Extract<ExternalConnectorSpec, { kind: 'mcp-stdio' }>,
): Record<string, unknown> {
  const cli = resolveSystemRuntimeMcpCliEntrypoint();
  return withoutUndefined({
    command: cli.command,
    args: [...cli.args, ...SYSTEM_RUNTIME_MCP_STDIO_ARGS],
    env: {
      ...connector.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
    cwd: connector.cwd,
  });
}

function resolveSystemRuntimeMcpCliEntrypoint(): { readonly command: string; readonly args: readonly string[] } {
  return {
    command: resolve(process.execPath),
    args: [resolveSystemRuntimeMainCliPath()],
  };
}

function resolveSystemRuntimeMainCliPath(): string {
  const explicitCli = process.env.MATCHACLAW_MAIN_CLI_ENTRY?.trim();
  if (explicitCli) {
    return resolve(explicitCli);
  }

  const candidates = process.env.MATCHACLAW_APP_PACKAGED === '1'
    ? getPackagedMainCliCandidates()
    : getDevelopmentMainCliCandidates();
  return candidates[0];
}

function getPackagedMainCliCandidates(): readonly string[] {
  return uniquePaths([
    resolve(process.resourcesPath, ...PACKAGED_MAIN_CLI_RELATIVE_PATH),
    resolve(process.resourcesPath, ...MAIN_CLI_RELATIVE_PATH),
  ]);
}

function getDevelopmentMainCliCandidates(): readonly string[] {
  return uniquePaths([
    resolve(process.cwd(), ...MAIN_CLI_RELATIVE_PATH),
    ...getModuleLookupPaths().map((modulePath) => resolve(modulePath, '..', ...MAIN_CLI_RELATIVE_PATH)),
  ]);
}

function getModuleLookupPaths(): readonly string[] {
  const paths = (module as NodeJS.Module & { paths?: string[] }).paths;
  return Array.isArray(paths) ? paths : [];
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map((item) => resolve(item)))];
}

function markRestartCommand(config: Record<string, unknown>): void {
  const commands = (
    config.commands && typeof config.commands === 'object' && !Array.isArray(config.commands)
      ? { ...(config.commands as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  commands.restart = true;
  config.commands = commands;
}

function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
