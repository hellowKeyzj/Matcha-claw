import type { RuntimeJobSnapshot } from '../../../common/runtime-contracts';
import { RUNTIME_REFRESH_JOB_COOLDOWN_MS } from '../../../common/runtime-job-throttle';
import type { RuntimeClockPort } from '../../../common/runtime-ports';
import type { GatewayConnectionPort, GatewayRpcPort } from '../../../gateway/gateway-runtime-port';
import type { RuntimeLongTaskSubmissionPort } from '../../../runtime-host/runtime-task-ports';
import type { ExternalConnectorSpec } from '../../../external-connectors/external-connector-model';
import type {
  ExternalConnectorDownstreamStatus,
  ExternalConnectorDownstreamStatusContext,
  ExternalConnectorDownstreamStatusProvider,
} from '../../../external-connectors/external-connector-downstream-status';
import {
  buildOpenClawMcpServerId,
  projectExternalConnectorToOpenClawMcpServer,
} from './external-connector-openclaw-mcp-projection';

export const OPENCLAW_MCP_SERVER_STATUS_REFRESH_JOB = 'externalConnectors.openclawMcpStatusRefresh';

const OPENCLAW_STATUS_METHOD = 'mcpServerStatus/list';
const OPENCLAW_STATUS_TIMEOUT_MS = 30000;
const OPENCLAW_STATUS_PAGE_LIMIT = 100;

interface OpenClawMcpServerStatusEntry {
  readonly name: string;
  readonly toolCount?: number;
  readonly launchSummary?: string;
  readonly available?: boolean;
}

export type OpenClawMcpServerStatusRefreshJobPayload = {
  readonly sessionKey: string;
};

type OpenClawMcpServerStatusRefreshJobResult =
  | { readonly resultType: 'available'; readonly servers: readonly OpenClawMcpServerStatusEntry[] }
  | { readonly resultType: 'unavailable'; readonly reason: string };

type OpenClawMcpServerStatusResult =
  | { readonly resultType: 'available'; readonly servers: ReadonlyMap<string, OpenClawMcpServerStatusEntry> }
  | { readonly resultType: 'unavailable'; readonly reason: string };

export class ExternalConnectorOpenClawMcpStatusProvider implements ExternalConnectorDownstreamStatusProvider {
  readonly adapterId = 'openclaw';

  constructor(private readonly deps: {
    readonly gateway: Pick<GatewayRpcPort, 'gatewayRpc'> & Pick<GatewayConnectionPort, 'readGatewayCapabilities'>;
    readonly clock: Pick<RuntimeClockPort, 'nowMs' | 'toIsoString'>;
    readonly jobs: Pick<RuntimeLongTaskSubmissionPort, 'submit'>;
  }) {}

  async listStatuses(
    connectors: readonly ExternalConnectorSpec[],
    context: ExternalConnectorDownstreamStatusContext,
  ): Promise<readonly ExternalConnectorDownstreamStatus[]> {
    const checkedAt = this.deps.clock.toIsoString(this.deps.clock.nowMs());
    const baseStatuses = await Promise.all(connectors.map((connector) => this.createBaseStatus(connector, checkedAt, context)));
    const projectableStatuses = baseStatuses.filter((status) => status.resultType === 'pending');
    if (projectableStatuses.length === 0) {
      return baseStatuses;
    }

    const serverStatusResult = this.readCachedOpenClawMcpServerStatuses(context);
    if (serverStatusResult.resultType === 'unavailable') {
      return baseStatuses.map((status) => (
        status.resultType === 'pending'
          ? {
            ...status,
            resultType: serverStatusResult.reason === 'refreshing'
              ? 'pending'
              : 'unknown',
            reason: serverStatusResult.reason === 'refreshing'
              ? 'OpenClaw MCP status refresh is running in the background'
              : serverStatusResult.reason,
            details: serverStatusResult.reason === 'refreshing'
              ? { ...status.details, refreshJobId: serverStatusResult.jobId }
              : status.details,
          }
          : status
      ));
    }

    return baseStatuses.map((status) => {
      if (status.resultType !== 'pending') {
        return status;
      }
      const serverId = status.details?.serverId;
      const server = serverId ? serverStatusResult.servers.get(serverId) : undefined;
      if (!server) {
        return {
          ...status,
          resultType: 'disconnected',
          reason: 'OpenClaw MCP status listing succeeded but did not include the projected server for this connector',
        };
      }
      if (server.available === false) {
        return {
          ...status,
          resultType: 'disconnected',
          reason: 'OpenClaw reported this MCP server as unavailable for the current adapter status query',
          details: {
            ...status.details,
            toolCount: server.toolCount,
            launchSummary: server.launchSummary,
          },
        };
      }
      return {
        ...status,
        resultType: 'connected',
        reason: 'OpenClaw MCP status reported the server as available',
        details: {
          ...status.details,
          toolCount: server.toolCount,
          launchSummary: server.launchSummary,
        },
      };
    });
  }

  private async createBaseStatus(
    connector: ExternalConnectorSpec,
    checkedAt: string,
    context: ExternalConnectorDownstreamStatusContext,
  ): Promise<ExternalConnectorDownstreamStatus> {
    if (connector.enabled === false) {
      return {
        connectorId: connector.id,
        displayName: connector.displayName,
        adapterId: this.adapterId,
        targetKind: 'session',
        resultType: 'disabled',
        checkedAt,
        reason: 'connector is disabled',
        details: { sessionKey: context.sessionIdentity.sessionKey },
      };
    }

    const projection = await projectExternalConnectorToOpenClawMcpServer(connector);
    if (projection.resultType === 'notProjectable') {
      return {
        connectorId: connector.id,
        displayName: connector.displayName,
        adapterId: this.adapterId,
        targetKind: 'session',
        resultType: 'unsupported',
        checkedAt,
        reason: projection.reason,
        details: { sessionKey: context.sessionIdentity.sessionKey },
      };
    }

    return {
      connectorId: connector.id,
      displayName: connector.displayName,
      adapterId: this.adapterId,
      targetKind: 'session',
      resultType: 'pending',
      checkedAt,
      reason: 'waiting for OpenClaw session MCP status',
      details: {
        serverId: buildOpenClawMcpServerId(connector.id),
        sessionKey: context.sessionIdentity.sessionKey,
      },
    };
  }

  private readCachedOpenClawMcpServerStatuses(context: ExternalConnectorDownstreamStatusContext): OpenClawMcpServerStatusResult | { readonly resultType: 'unavailable'; readonly reason: 'refreshing'; readonly jobId: string } {
    const sessionKey = context.sessionIdentity.sessionKey;
    const submitted = this.deps.jobs.submit(OPENCLAW_MCP_SERVER_STATUS_REFRESH_JOB, { sessionKey }, {
      queue: 'low',
      dedupeKey: buildOpenClawMcpStatusRefreshDedupeKey(sessionKey),
      dedupeCooldownMs: RUNTIME_REFRESH_JOB_COOLDOWN_MS,
    });
    const submittedResult = readRefreshJobResult(submitted.job);
    return submittedResult ?? { resultType: 'unavailable', reason: 'refreshing', jobId: submitted.job.id };
  }

  async refreshOpenClawMcpServerStatusesForJob(payload: OpenClawMcpServerStatusRefreshJobPayload): Promise<OpenClawMcpServerStatusRefreshJobResult> {
    const result = await this.listOpenClawMcpServerStatuses(payload.sessionKey);
    return result.resultType === 'available'
      ? { resultType: 'available', servers: Array.from(result.servers.values()) }
      : result;
  }

  private async listOpenClawMcpServerStatuses(sessionKey: string): Promise<OpenClawMcpServerStatusResult> {
    const servers = new Map<string, OpenClawMcpServerStatusEntry>();
    let capabilities: Awaited<ReturnType<GatewayConnectionPort['readGatewayCapabilities']>>;
    try {
      capabilities = await this.deps.gateway.readGatewayCapabilities(OPENCLAW_STATUS_TIMEOUT_MS);
    } catch {
      return {
        resultType: 'unavailable',
        reason: 'OpenClaw gateway capabilities are unavailable for this session',
      };
    }
    if (!capabilities?.methods.includes(OPENCLAW_STATUS_METHOD)) {
      return {
        resultType: 'unavailable',
        reason: 'OpenClaw gateway does not expose MCP status for this adapter',
      };
    }

    let cursor: unknown;
    try {
      do {
        const response = await this.deps.gateway.gatewayRpc(OPENCLAW_STATUS_METHOD, {
          sessionKey,
          cursor: typeof cursor === 'string' ? cursor : undefined,
          limit: OPENCLAW_STATUS_PAGE_LIMIT,
          detail: 'toolsAndAuthOnly',
        }, OPENCLAW_STATUS_TIMEOUT_MS);
        const page = readMcpServerStatusPage(response);
        for (const entry of page.data) {
          servers.set(entry.name, entry);
        }
        cursor = page.nextCursor;
      } while (typeof cursor === 'string' && cursor.length > 0);
      return { resultType: 'available', servers };
    } catch {
      return {
        resultType: 'unavailable',
        reason: 'OpenClaw MCP status is unavailable for this session',
      };
    }
  }
}

function buildOpenClawMcpStatusRefreshDedupeKey(sessionKey: string): string {
  return `${OPENCLAW_MCP_SERVER_STATUS_REFRESH_JOB}:${sessionKey}`;
}

function readRefreshJobResult(job: RuntimeJobSnapshot): OpenClawMcpServerStatusResult | null {
  if (job.status !== 'succeeded') {
    return null;
  }
  const result = readRecord(job.result);
  if (result.resultType === 'available') {
    const servers = new Map<string, OpenClawMcpServerStatusEntry>();
    const entries = Array.isArray(result.servers) ? result.servers : [];
    for (const entry of entries) {
      const server = readMcpServerStatusEntry(entry);
      if (server) {
        servers.set(server.name, server);
      }
    }
    return { resultType: 'available', servers };
  }
  if (result.resultType === 'unavailable') {
    return { resultType: 'unavailable', reason: readString(result.reason) || 'OpenClaw MCP status is unavailable for this session' };
  }
  return null;
}

function readMcpServerStatusPage(value: unknown): {
  readonly data: readonly OpenClawMcpServerStatusEntry[];
  readonly nextCursor?: string;
} {
  const record = readRecord(value);
  const rawEntries = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.servers)
      ? record.servers
      : [];
  return {
    data: rawEntries.map(readMcpServerStatusEntry).filter((entry): entry is OpenClawMcpServerStatusEntry => entry !== null),
    nextCursor: typeof record.nextCursor === 'string' && record.nextCursor.trim() ? record.nextCursor.trim() : undefined,
  };
}

function readMcpServerStatusEntry(value: unknown): OpenClawMcpServerStatusEntry | null {
  const record = readRecord(value);
  const name = readString(record.name) || readString(record.id) || readString(record.serverName);
  if (!name) {
    return null;
  }
  const toolCount = readNumber(record.toolCount) ?? (
    Array.isArray(record.tools) ? record.tools.length : undefined
  );
  return {
    name,
    ...(toolCount !== undefined ? { toolCount } : {}),
    ...(readString(record.launchSummary) ? { launchSummary: readString(record.launchSummary) } : {}),
    ...(typeof record.available === 'boolean' ? { available: record.available } : {}),
  };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
