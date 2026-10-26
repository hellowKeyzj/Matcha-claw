import { createHash, randomUUID } from 'node:crypto';
import { WORLD_OPERATIONS } from '../../../src/types/world';
import type { WorldRef } from '../../../src/types/world';
import { isWorldRef } from './events';
import type { RuntimeHostDeliveryIssuer } from '../runtime-host-delivery/issuer';
import {
  hasExactKeys, isJsonValue, isRecord, sendLoopbackJsonDelivery,
  type LoopbackJsonDelivery,
} from '../runtime-host-delivery/transport/client';
import { fetchLoopbackHttp } from '../../utils/loopback-http';
import { logger } from '../../utils/logger';
import { WorldPrivateAdmissionError } from './private-admission';
import {
  isWorldCredentialIdentity, requireWorldSourceCredential,
  WorldSourceCredentialError, type WorldCredentialIdentity,
} from './source-credentials';

export const WORLD_ROUTES = {
  query: '/api/world/query', command: '/api/world/command',
  operation: '/api/world/operation', peer: '/api/world/peer',
} as const;
export type WorldRoute = keyof typeof WORLD_ROUTES;
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export type WorldDelivery = LoopbackJsonDelivery
  | Readonly<{ outcome: 'not-attempted'; reason: 'invalid-request' | 'credential-missing'
    | 'credential-revision-conflict' | 'credential-unavailable' | 'authorization-denied' | 'authorization-unavailable' }>;

export interface WorldTransport {
  request(route: WorldRoute, body: unknown, signal?: AbortSignal, serializedBody?: string, admit?: () => Promise<void>): Promise<WorldDelivery>;
}

export function createWorldTransport(
  issuer: RuntimeHostDeliveryIssuer, port: number, fetcher: typeof fetch = fetchLoopbackHttp,
): WorldTransport {
  return {
    async request(route, input, signal, serializedBody, admit) {
      let body: unknown;
      let serialized: string;
      let binding: { world: WorldRef; capability: string } | undefined;
      try {
        // Parse metadata only. Public routes retain their original bytes for Rust's strict decoder.
        serialized = serializedBody ?? JSON.stringify(input);
        if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) return { outcome: 'not-attempted', reason: 'invalid-request' };
        body = JSON.parse(serialized);
        binding = requestBinding(route, body);
        if (!binding) return { outcome: 'not-attempted', reason: 'invalid-request' };
        if (route === 'command' && isRecord(body) && isRecord(body.command)
          && body.command.kind === 'configure_connection') {
          const connection = configuredConnection(body);
          if (!connection) return { outcome: 'not-attempted', reason: 'invalid-request' };
          if ((connection.connection.config as { kind: string }).kind !== 'plugin') {
            await requireWorldSourceCredential(connection.identity, connection.connection);
          }
        }
        if (admit) await admit();
        if (signal?.aborted) return { outcome: 'not-attempted' };
      } catch (error) {
        if (error instanceof WorldPrivateAdmissionError) return { outcome: 'not-attempted', reason: error.reason };
        if (error instanceof WorldSourceCredentialError) {
          return { outcome: 'not-attempted', reason: error.code === 'credential-missing'
            || error.code === 'credential-revision-conflict' ? error.code : 'credential-unavailable' };
        }
        return { outcome: 'not-attempted', reason: 'invalid-request' };
      }
      const path = WORLD_ROUTES[route];
      const delivery = await sendLoopbackJsonDelivery({
        port, path, method: 'POST', issuer, serializedBody: serialized, signal, timeoutMs: 120_000,
        fetcher: async (url, init) => {
          const response = await fetcher(url, init);
          return new Response(await boundedResponse(response), { status: response.status, headers: response.headers });
        },
        decision: {
          endpoint: path, scope: 'world', capability: binding.capability,
          subject: JSON.stringify({ tenantId: binding.world.tenantId, worldId: binding.world.worldId }),
          revision: `sha256:${createHash('sha256').update(serialized).digest('hex')}`,
        },
      });
      if (delivery.outcome !== 'response') return delivery;
      if (!responseEnvelope(delivery.response.body)) return { outcome: 'unknown', reason: 'invalid_response' };
      logWorldFailure(route, delivery.response.status, delivery.response.body);
      return delivery;
    },
  };
}

function requestBinding(route: WorldRoute, body: unknown): { world: WorldRef; capability: string } | undefined {
  if (!isRecord(body)) return undefined;
  const variant = route === 'query' ? body.query : route === 'command' ? body.command
    : route === 'peer' ? body.operation : body;
  const keys = route === 'query' ? ['world', 'query'] : route === 'command' ? ['world', 'requestId', 'command']
    : route === 'peer' ? ['world', 'requestId', 'operation'] : ['kind', 'request'];
  if (!hasExactKeys(body, keys) || !isRecord(variant) || !hasExactKeys(variant, ['kind', 'request'])
    || typeof variant.kind !== 'string' || !isRecord(variant.request)
    || ((route === 'command' || route === 'peer') && !identifier(body.requestId))) return undefined;
  const operations: Readonly<Record<string, string>> = WORLD_OPERATIONS[route];
  if (!Object.hasOwn(operations, variant.kind)) return undefined;
  const world = route !== 'operation' ? body.world
    : variant.kind === 'status' || variant.kind === 'result' ? variant.request.world
      : isRecord(variant.request.key) ? variant.request.key.world : undefined;
  if (!isWorldRef(world)) return undefined;
  return { world, capability: operations[variant.kind] };
}

export function configuredConnection(body: unknown): {
  identity: WorldCredentialIdentity; connection: Record<string, unknown>;
} | undefined {
  if (!isRecord(body) || !requestBinding('command', body) || !isWorldRef(body.world) || !isRecord(body.command)
    || body.command.kind !== 'configure_connection' || !isRecord(body.command.request)
    || !hasKeys(body.command.request, ['connection'], ['expectedRevision'])) return undefined;
  const connection = body.command.request.connection;
  if (!isRecord(connection) || !hasExactKeys(connection, ['world', 'id', 'revision', 'sourceId', 'name', 'scope', 'connector', 'config'])
    || !isWorldRef(connection.world) || connection.world.tenantId !== body.world.tenantId
    || connection.world.worldId !== body.world.worldId || !isRecord(connection.config)
    || !hasExactKeys(connection.config, ['kind', 'config']) || !isRecord(connection.config.config)) return undefined;
  const config = connection.config.config;
  if (connection.config.kind === 'postgres') {
    if (!hasKeys(config, ['host', 'port', 'database', 'schema', 'tls', 'resources', 'declaredCapabilities'], ['logical'])) return undefined;
  } else if (connection.config.kind === 'http_json') {
    if (!hasKeys(config, ['origin', 'readPath', 'resources', 'declaredCapabilities'], ['schemaPath', 'queryPath', 'writePath', 'inspectPath', 'changes'])) return undefined;
  } else if (connection.config.kind === 'plugin') {
    if (!hasExactKeys(config, ['resources', 'declaredCapabilities'])) return undefined;
  } else return undefined;
  if (connection.config.kind === 'http_json') {
    try {
      if (typeof config.origin !== 'string') return undefined;
      const origin = new URL(config.origin);
      if (origin.username || origin.password) return undefined;
    } catch { return undefined; }
  }
  const identity = { world: body.world, connectionId: connection.id, revision: connection.revision };
  return isWorldCredentialIdentity(identity) ? { identity, connection } : undefined;
}

function hasKeys(value: Record<string, unknown>, required: string[], optional: string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
}
function responseEnvelope(value: unknown): boolean {
  return isRecord(value) && (value.success === true
    ? hasExactKeys(value, ['success', 'data']) && isJsonValue(value.data, new Set())
    : value.success === false && hasExactKeys(value, ['success', 'error']) && isRecord(value.error)
      && typeof value.error.code === 'string' && typeof value.error.message === 'string'
      && identifier(value.error.diagnosticId) && isRecord(value.error.details)
      && isRecord(value.error.recovery) && isJsonValue(value.error, new Set()));
}
function logWorldFailure(route: WorldRoute, status: number, body: unknown): void {
  if (!isRecord(body) || body.success !== false || !isRecord(body.error)) return;
  const failure = body.error;
  const stage = failure.stage;
  const recoveryKind = isRecord(failure.recovery) ? failure.recovery.kind : undefined;
  logger.warn('[World] Request failed', {
    route, status,
    ...(typeof failure.code === 'string' && /^world\.[a-z_]{1,96}$/.test(failure.code) ? { code: failure.code } : {}),
    ...(identifier(failure.diagnosticId) ? { diagnosticId: failure.diagnosticId } : {}),
    ...(typeof stage === 'string' && ['decode', 'admission', 'read', 'parse', 'generate', 'resolve', 'validate', 'compile', 'prepare', 'execute', 'verify', 'commit', 'activate', 'migrate', 'drain', 'stop', 'recover', 'disclose'].includes(stage) ? { stage } : {}),
    ...(typeof recoveryKind === 'string' && ['none', 'correct_input', 'refresh', 'rebase', 'supply_dependency', 'restore_credential', 'retry_read', 'resume_operation', 'read_commit', 'read_transfer', 'inspect_effect', 'request_evidence', 'manual_review'].includes(recoveryKind) ? { recoveryKind } : {}),
  });
}
async function boundedResponse(response: Response): Promise<string> {
  if (!response.body) throw new Error('World response is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('World response exceeds the byte limit');
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Main-origin delivery failure, not a claim that a Rust transaction was rolled back. */
export function worldDeliveryFailure(code: string, unknown: boolean): unknown {
  return { success: false, error: {
    code, stage: unknown ? 'recover' : 'decode',
    message: unknown ? '世界操作结果尚未确认，请重新读取状态后再处理。' : '世界请求未发送，请检查输入或连接凭证。',
    diagnosticId: randomUUID(), details: { kind: 'transport', failure: unknown ? 'disconnected' : 'contract_data' },
    recovery: { kind: unknown ? 'refresh' : 'none' },
  } };
}
