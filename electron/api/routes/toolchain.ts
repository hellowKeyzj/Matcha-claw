import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ToolchainPrepareTransportResponse,
  ToolchainStatusTransportResponse,
  ToolchainTransport,
} from '../../main/runtime-host-delivery/transport/toolchain';
import { sendJson } from '../route-utils';

const TOOLCHAIN_UNAVAILABLE = { success: false, error: 'Toolchain is unavailable' } as const;
const TOOLCHAIN_PREPARE_TIMEOUT_MS = 120_000;

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
      const response = projectToolchainPrepareOutcome(
        await toolchainTransport.prepare(TOOLCHAIN_PREPARE_TIMEOUT_MS),
      );
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

function projectToolchainPrepareOutcome(outcome: ToolchainPrepareTransportResponse): { status: number; body: unknown } {
  if (outcome.status !== 200) {
    return { status: 503, body: TOOLCHAIN_UNAVAILABLE };
  }
  switch (outcome.body.outcome) {
    case 'ready':
    case 'installed':
      return { status: 200, body: { success: true, outcome: outcome.body.outcome } };
    case 'rejected':
      return { status: 409, body: { success: false, error: 'Toolchain preparation was rejected' } };
    case 'unknown':
      return { status: 503, body: { success: false, error: 'Toolchain preparation outcome is unknown' } };
    default:
      return { status: 503, body: TOOLCHAIN_UNAVAILABLE };
  }
}
