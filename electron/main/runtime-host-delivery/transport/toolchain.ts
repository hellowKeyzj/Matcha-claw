import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from './client';

const TOOLCHAIN_UNAVAILABLE = { success: false, error: 'Toolchain is unavailable' } as const;

export type ToolchainAvailability = 'available' | 'unavailable';
export type PythonReadiness = 'ready' | 'notReady' | 'unknown' | 'unavailable' | 'unsupported';
export type ToolchainPrepareOutcome = 'ready' | 'installed' | 'rejected' | 'unknown';

export type ToolchainStatus = Readonly<{
  uv: ToolchainAvailability;
  python: PythonReadiness;
}>;

export type ToolchainPrepare = Readonly<{
  outcome: ToolchainPrepareOutcome;
}>;

export type ToolchainStatusTransportResponse =
  | Readonly<{ status: 200; body: ToolchainStatus }>
  | Readonly<{ status: 503; body: typeof TOOLCHAIN_UNAVAILABLE }>;

export type ToolchainPrepareTransportResponse =
  | Readonly<{ status: 200; body: ToolchainPrepare }>
  | Readonly<{ status: 503; body: typeof TOOLCHAIN_UNAVAILABLE }>;

export interface ToolchainTransport {
  status(): Promise<ToolchainStatusTransportResponse>;
  prepare(timeoutMs: number): Promise<ToolchainPrepareTransportResponse>;
}

export function createToolchainTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): ToolchainTransport {
  return {
    async status(): Promise<ToolchainStatusTransportResponse> {
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: '/api/toolchain/status',
        issuer,
        decision: {
          endpoint: '/api/toolchain/status',
          scope: 'toolchain:read',
          capability: 'toolchain.status',
          subject: 'toolchain-status',
        },
        method: 'GET',
        fetcher,
      });
      if (response?.status === 200 && isToolchainStatus(response.body)) return { status: 200, body: response.body };
      return { status: 503, body: TOOLCHAIN_UNAVAILABLE };
    },

    async prepare(timeoutMs: number): Promise<ToolchainPrepareTransportResponse> {
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: '/api/toolchain/prepare',
        issuer,
        decision: {
          endpoint: '/api/toolchain/prepare',
          scope: 'toolchain:write',
          capability: 'toolchain.prepare',
          subject: 'toolchain-prepare',
        },
        method: 'POST',
        fetcher,
        timeoutMs,
        emptyContentLength: true,
      });
      if (response?.status === 200 && isToolchainPrepare(response.body)) return { status: 200, body: response.body };
      return { status: 503, body: TOOLCHAIN_UNAVAILABLE };
    },
  };
}

function isToolchainStatus(value: unknown): value is ToolchainStatus {
  return isRecord(value)
    && hasExactKeys(value, ['uv', 'python'])
    && isToolchainAvailability(value.uv)
    && isPythonReadiness(value.python);
}

function isToolchainPrepare(value: unknown): value is ToolchainPrepare {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'ready'
      || value.outcome === 'installed'
      || value.outcome === 'rejected'
      || value.outcome === 'unknown');
}

function isToolchainAvailability(value: unknown): value is ToolchainAvailability {
  return value === 'available' || value === 'unavailable';
}

function isPythonReadiness(value: unknown): value is PythonReadiness {
  return value === 'ready'
    || value === 'notReady'
    || value === 'unknown'
    || value === 'unavailable'
    || value === 'unsupported';
}
