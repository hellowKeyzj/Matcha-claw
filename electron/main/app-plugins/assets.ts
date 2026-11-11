import { protocol } from 'electron';
import { extname } from 'node:path';
import type { ApplicationPluginOwner } from './owner';
import type { AppPluginDevelopmentOwner } from './development';
import type { AppDocumentResourcesOwner } from './document-resources';
import { AppPluginError, requireDigest, requirePluginId } from './package';

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.gz': 'application/gzip',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

export function registerAppPluginAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'matcha-app', privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
  } }]);
}

function parseAssetUrl(value: string): { pluginId: string; digest: string; path: string; developmentId?: string; revision?: number } {
  // Chromium may already normalize URLs; accept only canonical Map keys without further decoding.
  const match = /^matcha-app:\/\/([a-z0-9.-]+)\/([A-Za-z0-9._/-]+)$/.exec(value);
  if (!match || match[0] !== value) throw new AppPluginError('invalid_package', 'Invalid app plugin asset URL.');
  const pluginId = match[1];
  requirePluginId(pluginId);
  const parts = match[2].split('/');
  let developmentId: string | undefined;
  let revision: number | undefined;
  if (parts[0] === 'development') {
    parts.shift();
    developmentId = parts.shift();
    const version = parts.shift();
    if (!developmentId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(developmentId)
      || !version || !/^[1-9][0-9]*$/.test(version) || !Number.isSafeInteger(revision = Number(version))) {
      throw new AppPluginError('invalid_package', 'Invalid app plugin development asset URL.');
    }
  }
  const digest = parts.shift();
  requireDigest(digest);
  const path = parts.join('/');
  if (!path || path.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)
    || parts.some((part) => !part || part === '.' || part === '..' || part.endsWith('.')
      || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new AppPluginError('invalid_package', 'Invalid app plugin asset path.');
  }
  return { pluginId, digest, path, ...(developmentId ? { developmentId, revision } : {}) };
}

export function registerAppPluginAssets(options: {
  owner: ApplicationPluginOwner;
  development: () => Promise<AppPluginDevelopmentOwner>;
  documentResources: () => Pick<AppDocumentResourcesOwner, 'read'> | undefined;
}): () => void {
  protocol.handle('matcha-app', async (request) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET' } });
    try {
      if (/^matcha-app:\/\/document-[a-f0-9-]{36}\.invalid\//.test(request.url)) {
        const resources = options.documentResources();
        if (!resources) return new Response(null, { status: 404, headers });
        const resource = await resources.read(request.url);
        request.signal.throwIfAborted();
        return new Response(new Uint8Array(resource.bytes).buffer, { headers: { ...headers, 'Content-Type': resource.mimeType,
          'Content-Security-Policy': "sandbox allow-scripts allow-forms; object-src 'none'; frame-src 'none'",
          'Referrer-Policy': 'no-referrer' } });
      }
      const source = parseAssetUrl(request.url);
      const mime = MIME_TYPES[extname(source.path).toLowerCase()];
      // HTML stays in the opaque bundle/bootstrap bridge, never a scheme navigation.
      if (!mime || request.mode === 'navigate' || request.destination === 'document' || request.destination === 'iframe') {
        return new Response(null, { status: 403, headers });
      }
      const bytes = source.developmentId
        ? (await options.development()).readAsset({ developmentId: source.developmentId, revision: source.revision!,
          pluginId: source.pluginId, digest: source.digest, path: source.path })
        : await options.owner.readAsset(source.pluginId, source.digest, source.path);
      request.signal.throwIfAborted();
      return new Response(new Uint8Array(bytes).buffer, { headers: { ...headers, 'Content-Type': mime } });
    } catch (error) {
      const status = error instanceof AppPluginError
        ? error.code === 'not_found' ? 404 : error.code === 'invalid_package' ? 400 : 409 : 500;
      return new Response(null, { status, headers });
    }
  });
  return () => protocol.unhandle('matcha-app');
}
