import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RuntimeHostControlOutcome } from '../../main/runtime-host-delivery/control';
import type { RuntimeHostApiContext } from '../context';
import { sendJson } from '../route-utils';

const TOOLCHAIN_UNAVAILABLE = 'Toolchain status is unavailable';

export async function handleToolchainRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RuntimeHostApiContext,
): Promise<boolean> {
  if (url.pathname !== '/api/toolchain/uv/check' || req.method !== 'GET') {
    return false;
  }

  try {
    const outcome = await ctx.runtimeHost.command({ name: 'openclaw.toolchain.status' });
    const installed = readUvAvailability(outcome);
    if (installed === null) {
      sendJson(res, 503, { success: false, error: TOOLCHAIN_UNAVAILABLE });
      return true;
    }
    sendJson(res, 200, installed);
  } catch {
    sendJson(res, 503, { success: false, error: TOOLCHAIN_UNAVAILABLE });
  }
  return true;
}

function readUvAvailability(outcome: RuntimeHostControlOutcome): boolean | null {
  if (outcome.kind !== 'succeeded' || !isRecord(outcome.result)) return null;
  const result = outcome.result.result;
  if (!isRecord(result) || !hasExactKeys(result, ['uv', 'python'])) return null;
  if (!['available', 'unavailable'].includes(String(result.uv))) {
    return null;
  }
  if (!['ready', 'notReady', 'unknown', 'unavailable', 'unsupported'].includes(String(result.python))) {
    return null;
  }
  return result.uv === 'available';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
