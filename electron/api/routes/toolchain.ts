import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import type {
  ToolchainStatusTransportResponse,
  ToolchainTransport,
} from '../../main/runtime-host-delivery/transport/toolchain';

const TOOLCHAIN_UNAVAILABLE = { success: false, error: 'Toolchain is unavailable' } as const;

export async function handleToolchainRoutes(
  req: HostApiRequest,
  url: URL,
  toolchainTransport: ToolchainTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname === '/api/toolchain/uv/check' && req.method === 'GET') {
    try {
      const response = projectToolchainStatusOutcome(
        await toolchainTransport.status(),
      );
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(503, TOOLCHAIN_UNAVAILABLE);
    }
  }

  if (url.pathname === '/api/toolchain/uv/prepare' && req.method === 'POST') {
    try {
      const response = await toolchainTransport.prepare();
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(503, TOOLCHAIN_UNAVAILABLE);
    }
  }

  return undefined;
}

function projectToolchainStatusOutcome(outcome: ToolchainStatusTransportResponse): { status: number; body: unknown } {
  if (outcome.status !== 200) {
    return { status: 503, body: TOOLCHAIN_UNAVAILABLE };
  }
  return { status: 200, body: { installed: outcome.body.uv === 'available' } };
}
