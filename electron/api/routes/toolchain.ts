import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RuntimeHostControlOutcome } from '../../main/runtime-host-delivery/control';
import type { RuntimeHostApiContext } from '../context';
import { sendJson } from '../route-utils';

const TOOLCHAIN_UNAVAILABLE = { success: false, error: 'Toolchain is unavailable' } as const;
const TOOLCHAIN_PREPARE_TIMEOUT_MS = 120_000;

export async function handleToolchainRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RuntimeHostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/toolchain/uv/check' && req.method === 'GET') {
    try {
      const response = projectToolchainStatusOutcome(
        await ctx.runtimeHost.command({ name: 'host.toolchain.status' }),
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
        await ctx.runtimeHost.command({ name: 'host.toolchain.prepare' }, { timeoutMs: TOOLCHAIN_PREPARE_TIMEOUT_MS }),
      );
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, TOOLCHAIN_UNAVAILABLE);
    }
    return true;
  }

  return false;
}

function projectToolchainStatusOutcome(outcome: RuntimeHostControlOutcome): { status: number; body: unknown } {
  if (outcome.kind !== 'succeeded' || !isRecord(outcome.result)) {
    return { status: 503, body: TOOLCHAIN_UNAVAILABLE };
  }
  const result = outcome.result.result;
  if (!isRecord(result) || !hasExactKeys(result, ['uv', 'python'])) {
    return { status: 503, body: TOOLCHAIN_UNAVAILABLE };
  }
  if (!['available', 'unavailable'].includes(String(result.uv))) {
    return { status: 503, body: TOOLCHAIN_UNAVAILABLE };
  }
  if (!['ready', 'notReady', 'unknown', 'unavailable', 'unsupported'].includes(String(result.python))) {
    return { status: 503, body: TOOLCHAIN_UNAVAILABLE };
  }
  return { status: 200, body: { installed: result.uv === 'available' } };
}

function projectToolchainPrepareOutcome(outcome: RuntimeHostControlOutcome): { status: number; body: unknown } {
  if (outcome.kind !== 'succeeded' || !isRecord(outcome.result)) {
    return { status: 503, body: TOOLCHAIN_UNAVAILABLE };
  }
  const result = outcome.result.result;
  if (!isRecord(result) || !hasExactKeys(result, ['outcome'])) {
    return { status: 503, body: TOOLCHAIN_UNAVAILABLE };
  }
  switch (result.outcome) {
    case 'ready':
    case 'installed':
      return { status: 200, body: { success: true, outcome: result.outcome } };
    case 'rejected':
      return { status: 409, body: { success: false, error: 'Toolchain preparation was rejected' } };
    case 'unknown':
      return { status: 503, body: { success: false, error: 'Toolchain preparation outcome is unknown' } };
    default:
      return { status: 503, body: TOOLCHAIN_UNAVAILABLE };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
