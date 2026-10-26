import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppPluginManifest } from '../../../src/types/desktop/app-plugin';
import type { MainHostApiContext } from '../context';
import { AppPluginError, requireDigest, requireObject, requirePluginId } from '../../main/app-plugins/package';
import type { AppPluginRuntimeStatusInput } from '../../main/app-plugins/agent-gateway';
import { sendJson } from '../route-utils';

const operations = new Set(['inspect', 'import', 'enabled', 'uninstall', 'rollback', 'bundle', 'build', 'development', 'runtime-status']);

function readBody(req: IncomingMessage, maximum: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = (error: Error) => {
      cleanup();
      req.resume();
      reject(error);
    };
    const onError = () => fail(new AppPluginError('invalid_package', 'App plugin request could not be read.'));
    const onAborted = () => fail(new AppPluginError('invalid_package', 'App plugin request was interrupted.'));
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maximum) {
        fail(new AppPluginError('invalid_package', 'App plugin request body is too large.'));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new AppPluginError('invalid_package', 'App plugin request JSON is invalid.')); }
    };
    if (Number(req.headers['content-length']) > maximum) {
      fail(new AppPluginError('invalid_package', 'App plugin request body is too large.'));
      return;
    }
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
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
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: Pick<MainHostApiContext, 'appPlugins' | 'appPluginAgentGateway'>,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/app-plugins') {
    try { sendJson(res, 200, await ctx.appPlugins.list()); }
    catch (error) { sendFailure(res, error); }
    return true;
  }
  const operation = url.pathname.startsWith('/api/app-plugins/') ? url.pathname.slice('/api/app-plugins/'.length) : '';
  if (req.method !== 'POST' || !operations.has(operation)) return false;
  try {
    const maximum = operation === 'build' ? 32 * 1024 * 1024
      : operation === 'inspect' || operation === 'import' ? 12 * 1024 * 1024 : 64 * 1024;
    const value = await readBody(req, maximum);
    const owner = ctx.appPlugins;
    let result: unknown;
    switch (operation) {
      case 'inspect': {
        const body = requireObject(value, ['packageBase64']);
        requireString(body.packageBase64, 12 * 1024 * 1024);
        result = await owner.inspect(body.packageBase64);
        break;
      }
      case 'import': {
        const body = requireObject(value, ['packageBase64', 'digest']);
        requireString(body.packageBase64, 12 * 1024 * 1024);
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
        if (body.kind !== 'reader' && body.kind !== 'connector') throw new AppPluginError('invalid_package', 'Unknown app plugin development kind.');
        if (body.pluginId !== undefined) requirePluginId(body.pluginId);
        result = (await ctx.appPluginAgentGateway).createDevelopment({ kind: body.kind, pluginId: body.pluginId as string | undefined });
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
    sendJson(res, 200, result);
  } catch (error) {
    sendFailure(res, error);
  }
  return true;
}

function sendFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof AppPluginError) {
    const status = { invalid_package: 400, conflict: 409, not_found: 404, closed: 503, busy: 429 }[error.code];
    sendJson(res, status, { success: false, code: error.code, error: error.message });
    return;
  }
  sendJson(res, 500, { success: false, error: 'App plugin operation failed. Please try again.' });
}
