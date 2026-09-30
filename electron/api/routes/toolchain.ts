import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ToolchainStatusTransportResponse,
  ToolchainTransport,
} from '../../main/runtime-host-delivery/transport/toolchain';
import { sendJson } from '../route-utils';

const TOOLCHAIN_UNAVAILABLE = { success: false, error: 'Toolchain is unavailable' } as const;

export async function handleToolchainRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  toolchainTransport: ToolchainTransport,
): Promise<boolean> {
  if (url.pathname === '/api/toolchain/uv/check' && req.method === 'GET') {
    try {
      const response = projectToolchainStatusOutcome(
        await toolchainTransport.status(),
      );
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, TOOLCHAIN_UNAVAILABLE);
    }
    return true;
  }

  if (url.pathname === '/api/toolchain/uv/prepare' && req.method === 'POST') {
    try {
      const response = await toolchainTransport.prepare();
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, TOOLCHAIN_UNAVAILABLE);
    }
    return true;
  }

  return false;
}

function projectToolchainStatusOutcome(outcome: ToolchainStatusTransportResponse): { status: number; body: unknown } {
  if (outcome.status !== 200) {
    return { status: 503, body: TOOLCHAIN_UNAVAILABLE };
  }
  return { status: 200, body: { installed: outcome.body.uv === 'available' } };
}
