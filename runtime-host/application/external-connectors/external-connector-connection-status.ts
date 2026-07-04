import type { RuntimeClockPort, RuntimeHttpClientPort } from '../common/runtime-ports';
import type { ExternalConnectorSpec } from './external-connector-model';

export type ExternalConnectorConnectionStatusResultType =
  | 'connected'
  | 'disconnected'
  | 'unsupported'
  | 'disabled'
  | 'unknown';

export interface ExternalConnectorConnectionStatus {
  readonly connectorId: string;
  readonly resultType: ExternalConnectorConnectionStatusResultType;
  readonly checkedAt?: string;
  readonly latencyMs?: number;
  readonly reason?: string;
  readonly safeProbe: boolean;
}

const DEFAULT_CONNECTION_PROBE_TIMEOUT_MS = 5000;
const MCP_PROTOCOL_VERSION = '2024-11-05';

export class ExternalConnectorConnectionProbeService {
  constructor(private readonly deps: {
    readonly httpClient: Pick<RuntimeHttpClientPort, 'request'>;
    readonly clock: Pick<RuntimeClockPort, 'nowMs' | 'toIsoString'>;
  }) {}

  async probe(connector: ExternalConnectorSpec): Promise<ExternalConnectorConnectionStatus> {
    const checkedAt = this.deps.clock.toIsoString(this.deps.clock.nowMs());
    if (connector.enabled === false) {
      return {
        connectorId: connector.id,
        resultType: 'disabled',
        checkedAt,
        reason: 'connector is disabled',
        safeProbe: false,
      };
    }

    if (connector.mcpServerProgram?.source === 'system-runtime') {
      return {
        connectorId: connector.id,
        resultType: 'unsupported',
        checkedAt,
        reason: 'system-runtime MCP is verified through downstream session status, not by a global runtime probe',
        safeProbe: false,
      };
    }

    if (connector.kind === 'mcp-http') {
      return await this.probeMcpHttpConnector(connector, checkedAt);
    }

    if (connector.kind === 'mcp-stdio') {
      return {
        connectorId: connector.id,
        resultType: 'unsupported',
        checkedAt,
        reason: 'external stdio MCP connectors require executing the configured command and are not probed automatically',
        safeProbe: false,
      };
    }

    return {
      connectorId: connector.id,
      resultType: 'unsupported',
      checkedAt,
      reason: `${connector.kind} connectors do not expose an automatic connectivity probe`,
      safeProbe: false,
    };
  }

  unknown(connectorId: string): ExternalConnectorConnectionStatus {
    return {
      connectorId,
      resultType: 'unknown',
      reason: 'connector has not been probed in this runtime session',
      safeProbe: false,
    };
  }

  private async probeMcpHttpConnector(
    connector: Extract<ExternalConnectorSpec, { kind: 'mcp-http' }>,
    checkedAt: string,
  ): Promise<ExternalConnectorConnectionStatus> {
    if (connector.secretHeaders && Object.keys(connector.secretHeaders).length > 0) {
      return {
        connectorId: connector.id,
        resultType: 'unsupported',
        checkedAt,
        reason: 'mcp-http connectors with secretHeaders require a private secret projection before probing',
        safeProbe: false,
      };
    }

    const startedAt = this.deps.clock.nowMs();
    try {
      const response = connector.transport === 'sse'
        ? await this.requestWithTimeout(connector.url, {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            ...(connector.headers ?? {}),
          },
        }, connector.connectionTimeoutMs)
        : await this.requestWithTimeout(connector.url, {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            ...(connector.headers ?? {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'matcha-connector-probe',
            method: 'initialize',
            params: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: 'matcha-connector-probe', version: '0.0.0' },
            },
          }),
        }, connector.connectionTimeoutMs);
      const latencyMs = Math.max(0, this.deps.clock.nowMs() - startedAt);
      if (!response.ok) {
        return {
          connectorId: connector.id,
          resultType: 'disconnected',
          checkedAt,
          latencyMs,
          reason: `probe returned HTTP ${response.status}`,
          safeProbe: true,
        };
      }
      if (connector.transport === 'sse') {
        return {
          connectorId: connector.id,
          resultType: 'connected',
          checkedAt,
          latencyMs,
          reason: 'SSE endpoint accepted the probe connection',
          safeProbe: true,
        };
      }

      const responseBody = await response.json().catch(() => null);
      if (isJsonRpcInitializeResponse(responseBody)) {
        return {
          connectorId: connector.id,
          resultType: 'connected',
          checkedAt,
          latencyMs,
          reason: 'MCP initialize probe succeeded',
          safeProbe: true,
        };
      }
      return {
        connectorId: connector.id,
        resultType: 'disconnected',
        checkedAt,
        latencyMs,
        reason: 'probe response was not a valid MCP initialize response',
        safeProbe: true,
      };
    } catch {
      return {
        connectorId: connector.id,
        resultType: 'disconnected',
        checkedAt,
        latencyMs: Math.max(0, this.deps.clock.nowMs() - startedAt),
        reason: 'probe request failed',
        safeProbe: true,
      };
    }
  }

  private async requestWithTimeout(url: string, init: RequestInit, timeoutMs: number | undefined) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs ?? DEFAULT_CONNECTION_PROBE_TIMEOUT_MS);
    try {
      return await this.deps.httpClient.request(url, {
        ...init,
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isJsonRpcInitializeResponse(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== '2.0') {
    return false;
  }
  return Boolean(record.result && typeof record.result === 'object' && !Array.isArray(record.result));
}
