import type { AppPluginManifest } from '../../../src/types/desktop/app-plugin';
import type { AppPluginCall } from '../../../src/types/desktop/app-plugin-sdk';
import type { MainHostApiContext } from '../context';
import { AppPluginError, MAX_APP_PLUGIN_ZIP_BYTES, requireDigest, requireObject, requirePluginId } from '../../main/app-plugins/package';
import type { AppPluginRuntimeStatusInput } from '../../main/app-plugins/agent-gateway';
import { HostApiBodyTooLarge, jsonResult, type HostApiRequest, type HostApiResponse, type HostApiRouteResult } from '../execution';

const operations = new Set(['inspect', 'import', 'enabled', 'uninstall', 'rollback', 'bundle', 'build', 'development', 'runtime-status', 'call']);
const MAX_BASE64_BYTES = 4 * Math.ceil(MAX_APP_PLUGIN_ZIP_BYTES / 3);

async function readBody(req: HostApiRequest, maximum: number): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = await req.readBytes(maximum, true);
  } catch (error) {
    const message = error instanceof HostApiBodyTooLarge ? 'App plugin request body is too large.'
      : req.signal.aborted ? 'App plugin request was interrupted.' : 'App plugin request could not be read.';
    throw new AppPluginError('invalid_package', message);
  }
  try { return JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')); }
  catch { throw new AppPluginError('invalid_package', 'App plugin request JSON is invalid.'); }
}

function requireString(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > maximum) {
    throw new AppPluginError('invalid_package', 'A required app plugin request string is invalid.');
  }
}

function readRuntimeStatus(value: unknown): AppPluginRuntimeStatusInput {
  const body = requireObject(value, ['pluginId', 'digest', 'entry', 'instanceId', 'state', 'message']);
  requirePluginId(body.pluginId);
  requireDigest(body.digest);
  requireString(body.entry, 200);
  requireString(body.instanceId, 128);
  if (!/^[A-Za-z0-9-]+$/.test(body.instanceId) || !['mounted', 'ready', 'error', 'disposed'].includes(body.state as string)
    || (body.message !== undefined && (typeof body.message !== 'string' || body.message.length > 512))) {
    throw new AppPluginError('invalid_package', 'Invalid app plugin runtime status.');
  }
  return body as unknown as AppPluginRuntimeStatusInput;
}

export async function handleAppPluginRoutes(
  req: HostApiRequest,
  url: URL,
  ctx: Pick<MainHostApiContext, 'appPlugins' | 'appPluginAgentGateway' | 'appPluginHost'>,
): Promise<HostApiRouteResult> {
  if (req.method === 'GET' && url.pathname === '/api/app-plugins') {
    try {
      const result = await ctx.appPlugins.list();
      return req.signal.aborted ? null : jsonResult(200, result);
    } catch (error) { return sendFailure(req, error); }
  }
  const operation = url.pathname.startsWith('/api/app-plugins/') ? url.pathname.slice('/api/app-plugins/'.length) : '';
  if (req.method !== 'POST' || !operations.has(operation)) return undefined;
  try {
    const maximum = operation === 'build' || operation === 'call' ? 2 * MAX_APP_PLUGIN_ZIP_BYTES
      : operation === 'inspect' || operation === 'import' ? MAX_BASE64_BYTES + 64 * 1024 : 64 * 1024;
    const value = await readBody(req, maximum);
    const owner = ctx.appPlugins;
    let result: unknown;
    switch (operation) {
      case 'inspect': {
        const body = requireObject(value, ['packageBase64']);
        requireString(body.packageBase64, MAX_BASE64_BYTES);
        result = await owner.inspect(body.packageBase64);
        break;
      }
      case 'import': {
        const body = requireObject(value, ['packageBase64', 'digest']);
        requireString(body.packageBase64, MAX_BASE64_BYTES);
        requireDigest(body.digest);
        // Origin is authority supplied by this manual route, never by request JSON.
        result = await owner.importPackage({ packageBase64: body.packageBase64, digest: body.digest, origin: 'manual' });
        break;
      }
      case 'enabled': {
        const body = requireObject(value, ['id', 'digest', 'enabled']);
        requirePluginId(body.id);
        requireDigest(body.digest);
        if (typeof body.enabled !== 'boolean') throw new AppPluginError('invalid_package', 'Plugin enabled must be a boolean.');
        result = await owner.setEnabled({ id: body.id, digest: body.digest, enabled: body.enabled });
        break;
      }
      case 'uninstall': {
        const body = requireObject(value, ['id', 'digest']);
        requirePluginId(body.id);
        requireDigest(body.digest);
        await owner.uninstall({ id: body.id, digest: body.digest });
        result = { success: true };
        break;
      }
      case 'rollback': {
        const body = requireObject(value, ['id', 'digest']);
        requirePluginId(body.id);
        requireDigest(body.digest);
        result = await owner.rollback({ id: body.id, digest: body.digest });
        break;
      }
      case 'bundle': {
        const body = requireObject(value, ['id', 'digest', 'entry']);
        requirePluginId(body.id);
        requireDigest(body.digest);
        requireString(body.entry, 200);
        result = await owner.bundle(body.id, body.digest, body.entry);
        break;
      }
      case 'build': {
        const body = requireObject(value, ['manifest', 'files']);
        result = await owner.build({ manifest: body.manifest as AppPluginManifest, files: body.files as Record<string, string> });
        break;
      }
      case 'development': {
        const body = requireObject(value, ['kind', 'pluginId']);
        if (body.kind !== 'reader' && body.kind !== 'connector' && body.kind !== 'application') throw new AppPluginError('invalid_package', 'Unknown app plugin development kind.');
        if (body.pluginId !== undefined) requirePluginId(body.pluginId);
        result = (await ctx.appPluginAgentGateway).createDevelopment({ kind: body.kind, pluginId: body.pluginId as string | undefined });
        break;
      }
      case 'call': {
        result = await ctx.appPluginHost.call(value as AppPluginCall, req.signal);
        break;
      }
      case 'runtime-status': {
        const input = readRuntimeStatus(value);
        // The gateway validates current enabled/digest/entry and owns only ephemeral, self-reported diagnostics.
        await (await ctx.appPluginAgentGateway).reportRuntimeStatus(input);
        result = { success: true };
        break;
      }
    }
    return req.signal.aborted ? null : jsonResult(200, result);
  } catch (error) {
    return sendFailure(req, error);
  }
}

function sendFailure(req: HostApiRequest, error: unknown): HostApiResponse | null {
  if (req.signal.aborted) return null;
  if (error instanceof AppPluginError) {
    const status = { invalid_package: 400, conflict: 409, not_found: 404, closed: 503, busy: 429 }[error.code];
    return jsonResult(status, { success: false, code: error.code, error: error.message });
  }
  return jsonResult(500, { success: false, error: 'App plugin operation failed. Please try again.' });
}
