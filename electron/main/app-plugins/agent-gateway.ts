import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AppPluginDevelopmentOwner } from './development';
import { appPluginResources, appResourceUri, appToolName } from '../../../src/types/desktop/app-plugin-sdk';
import type { AppToolResult } from '../../../src/types/desktop/app-plugin-sdk';
import type { AppToolManifest } from '../../../src/types/desktop/app-plugin';
import type { AppPluginHost } from './host';
import { sendJson } from '../../api/route-utils';
import { APP_PLUGIN_SDK, APP_PLUGIN_TOOLS, callAppPluginTool, type AppPluginToolOperations } from './agent-tools';
import { publishAppPluginMcp } from './mcp-projection';
import type { ApplicationPluginOwner } from './owner';
import { AppPluginError, MAX_APP_PLUGIN_ZIP_BYTES, requireDigest, requireObject, requirePluginId } from './package';

const MAX_OBSERVATIONS = 128;
const MAX_REQUEST_BYTES = Math.max(2 * MAX_APP_PLUGIN_ZIP_BYTES, 4 * Math.ceil(MAX_APP_PLUGIN_ZIP_BYTES / 3) + 64 * 1024);

export interface AppPluginRuntimeStatusInput {
  pluginId: string;
  digest: string;
  entry: string;
  instanceId: string;
  state: 'mounted' | 'ready' | 'error' | 'disposed';
  message?: string;
}

export interface AppPluginAgentGateway {
  readonly development: AppPluginDevelopmentOwner;
  preview(developmentId: string): void;
  forceClose(): Promise<void>;
  reportRuntimeStatus(input: AppPluginRuntimeStatusInput): Promise<void>;
  changed(): void;
  close(): Promise<void>;
}

type ReaderObservation = Omit<AppPluginRuntimeStatusInput, 'message'> & {
  observedAt: string;
  operation: symbol;
  pending: boolean;
};

function isModelVisibleTool(tool: AppToolManifest): boolean {
  const ui = tool._meta?.ui;
  if (!ui || typeof ui !== 'object' || Array.isArray(ui) || !('visibility' in ui)) return true;
  return !Array.isArray(ui.visibility) || ui.visibility.includes('model');
}

async function readRequest(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new AppPluginError('invalid_package', 'App plugin tool input exceeds the package request limit.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch {
    throw new AppPluginError('invalid_package', 'App plugin tool input must be JSON.');
  }
}

export async function startAppPluginAgentGateway(input: {
  owner: ApplicationPluginOwner;
  host: AppPluginHost;
  root: string;
  sdkArchive: string;
  onPreview(developmentId: string): void;
}): Promise<AppPluginAgentGateway> {
  const { owner, host } = input;
  const catalogIdentity = randomUUID();
  const catalogWaiters = new Set<() => void>();
  const requests = new Set<AbortController>();
  const notifyChanged = () => { for (const wake of catalogWaiters) wake(); };
  const waitForCatalogChange = (revision: string | null, signal: AbortSignal) => {
    let wake = () => undefined as void;
    const promise = new Promise<void>((resolve) => { wake = resolve; });
    const timer = revision === null ? undefined : setTimeout(wake, 25_000);
    if (revision !== null) catalogWaiters.add(wake);
    signal.addEventListener('abort', wake, { once: true });
    return { promise, close() { clearTimeout(timer); catalogWaiters.delete(wake); signal.removeEventListener('abort', wake); } };
  };
  const token = randomBytes(32).toString('hex');
  const expectedToken = Buffer.from(`Bearer ${token}`);
  const development = new AppPluginDevelopmentOwner({ root: input.root, owner, host });
  const observations = new Map<string, ReaderObservation>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const ensureOpen = () => {
    if (closed) throw new AppPluginError('closed', 'The app plugin development gateway is closed.');
  };
  const preview = (developmentId: string) => {
    ensureOpen();
    development.credentials(developmentId);
    input.onPreview(developmentId);
  };
  let port = 0;
  const operations: AppPluginToolOperations = {
    owner,
    sdk: (developmentId) => {
      ensureOpen();
      const credentials = development.credentials(developmentId ?? development.create().developmentId);
      const baseUrl = `http://127.0.0.1:${port}/development/${credentials.developmentId}`;
      return { ...APP_PLUGIN_SDK, development: { ...credentials, baseUrl }, sdk: { url: `${baseUrl}/sdk` } };
    },
    build: (developmentId, value) => development.build(developmentId, value),
    install: (developmentId, value) => development.install(developmentId, value),
    developmentStatus: (developmentId) => development.status(developmentId),
    status: async (pluginId) => {
      const plugin = (await owner.list()).plugins.find((candidate) => candidate.manifest.id === pluginId);
      if (!plugin) {
        for (const [key, value] of observations) if (value.pluginId === pluginId) observations.delete(key);
        return { pluginId, installed: false, runtime: 'not-mounted', observation: 'No installed package.' };
      }
      const readers = (plugin.manifest.contributes.readers ?? []).map((reader) => {
        const key = JSON.stringify([pluginId, reader.entry]);
        const observation = observations.get(key);
        if (observation && (!plugin.enabled || observation.digest !== plugin.digest)) observations.delete(key);
        const current = plugin.enabled && observation?.digest === plugin.digest && !observation.pending ? observation : undefined;
        return {
          entry: reader.entry,
          state: !plugin.enabled || current?.state === 'disposed' ? 'not-mounted' : current?.state ?? 'not-observed',
          ...(current ? { observedAt: current.observedAt, evidence: current.state === 'ready' ? 'plugin-self-report' : 'reader-host-observation' } : {}),
          ...(current?.state === 'error' ? { message: 'Reader reported an error. Open the reader in the application for details.' } : {}),
          semanticallyVerified: false,
        };
      });
      return {
        pluginId, installed: true, digest: plugin.digest, enabled: plugin.enabled,
        runtime: !plugin.enabled ? 'not-mounted' : readers.length ? 'see-reader-observations' : 'not-observed',
        readers,
        applications: plugin.manifest.contributes.applications ?? [],
        tools: plugin.manifest.contributes.tools ?? [],
        connectors: (plugin.manifest.contributes.connectors ?? []).map((connector) => ({ id: connector.id, runtime: 'not-observed', configurationOnly: true })),
        observation: 'Installation and enabled configuration do not prove rendering correctness or a connected MCP service.',
      };
    },
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const developmentPath = /^\/development\/([a-f0-9-]{36})(?:\/(sdk|package|status|preview|call|install|inspect|act))?$/.exec(url.pathname);
    const presentedToken = Buffer.from(req.headers.authorization ?? '');
    try {
      if (req.headers.origin) throw new Error('Origin is not accepted.');
      if (developmentPath) {
        const bearer = req.headers.authorization;
        if (!bearer?.startsWith('Bearer ')) throw new Error('Missing development credential.');
        development.authorize(developmentPath[1], bearer.slice(7));
      } else if (presentedToken.length !== expectedToken.length || !timingSafeEqual(presentedToken, expectedToken)) {
        throw new Error('Missing gateway credential.');
      }
    } catch {
      sendJson(res, 403, { error: 'App plugin gateway authorization failed.' });
      return;
    }
    if (closed) { sendJson(res, 503, { error: 'App plugin gateway is closing.' }); return; }
    if (requests.size >= 128) { sendJson(res, 429, { error: 'Too many app plugin gateway requests.' }); return; }
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('App plugin caller disconnected.'));
    requests.add(controller);
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      if (developmentPath) {
        const developmentId = developmentPath[1];
        const operation = developmentPath[2];
        let result: unknown;
        if (req.method === 'GET' && operation === 'sdk') {
          const bytes = await readFile(input.sdkArchive);
          if (!controller.signal.aborted) {
            res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': bytes.length });
            res.end(bytes);
          }
          return;
        }
        if (req.method === 'GET' && operation === 'status') result = development.status(developmentId);
        else if (req.method === 'DELETE' && !operation) {
          await development.stop(developmentId);
          result = { state: development.status(developmentId).state };
        } else if (req.method === 'POST' && operation === 'package') {
          if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/zip') {
            throw new AppPluginError('invalid_package', 'Development uploads require application/zip.');
          }
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const value of req) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            size += chunk.length;
            if (size > MAX_APP_PLUGIN_ZIP_BYTES) throw new AppPluginError('invalid_package', 'Development ZIP exceeds the package limit.');
            chunks.push(chunk);
          }
          result = await development.upload(developmentId, Buffer.concat(chunks));
        } else if (req.method === 'POST' && ['preview', 'call', 'install', 'inspect', 'act'].includes(operation ?? '')) {
          if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
            throw new AppPluginError('invalid_package', 'Development commands require application/json.');
          }
          const value = await readRequest(req);
          if (operation === 'preview') {
            requireObject(value, []);
            preview(developmentId);
            result = { success: true };
          } else if (operation === 'call') {
            const body = requireObject(value, ['name', 'arguments']);
            if (typeof body.name !== 'string' || !body.arguments || typeof body.arguments !== 'object' || Array.isArray(body.arguments)) {
              throw new AppPluginError('invalid_package', 'A development call requires a name and arguments object.');
            }
            result = await development.call({ developmentId, name: body.name, arguments: body.arguments as Record<string, unknown> }, controller.signal);
          } else if (operation === 'install') {
            const body = requireObject(value, ['digest']);
            requireDigest(body.digest);
            result = await development.install(developmentId, { digest: body.digest });
          } else if (operation === 'inspect') {
            const body = requireObject(value, ['entry']);
            if (body.entry !== undefined && typeof body.entry !== 'string') throw new AppPluginError('invalid_package', 'Invalid preview entry.');
            result = await development.inspect(developmentId, controller.signal, body.entry as string | undefined);
          } else {
            const body = requireObject(value, ['type', 'id', 'value', 'entry']);
            const { entry, ...action } = body;
            if (entry !== undefined && typeof entry !== 'string') throw new AppPluginError('invalid_package', 'Invalid preview entry.');
            if ((action.type !== 'click' && action.type !== 'fill') || typeof action.id !== 'string'
              || (action.value !== undefined && typeof action.value !== 'string')) {
              throw new AppPluginError('invalid_package', 'Invalid preview action.');
            }
            result = await development.act(developmentId, { type: action.type, id: action.id, value: action.value }, controller.signal, entry as string | undefined);
          }
        } else {
          sendJson(res, 404, { error: 'Development endpoint unavailable.' });
          return;
        }
        if (!controller.signal.aborted) sendJson(res, 200, result);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/catalog') {
        const revision = url.searchParams.get('revision');
        const wake = waitForCatalogChange(revision, controller.signal);
        let catalog;
        try {
          catalog = await owner.list();
          if (revision === `${catalogIdentity}:${catalog.revision}`) {
            await wake.promise;
            catalog = await owner.list();
          }
        } finally { wake.close(); }
        if (controller.signal.aborted) return;
        const current = `${catalogIdentity}:${catalog.revision}`;
        if (revision === current) { res.writeHead(204); res.end(); return; }
        const enabled = catalog.plugins.filter((plugin) => plugin.enabled);
        sendJson(res, 200, { revision: current, tools: [...APP_PLUGIN_TOOLS,
          ...enabled.flatMap((plugin) => (plugin.manifest.contributes.tools ?? []).filter(isModelVisibleTool).map((tool) => ({ ...tool, name: appToolName(plugin.manifest.id, tool.name) })))],
        resources: enabled.flatMap((plugin) => appPluginResources(plugin.manifest)) });
        return;
      }
      if (req.method !== 'POST' || !['/tools/call', '/resources/read'].includes(url.pathname)) {
        sendJson(res, 404, { error: 'App plugin endpoint unavailable.' }); return;
      }
      if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        sendJson(res, 415, { error: 'App plugin requests require application/json.' }); return;
      }
      const value = await readRequest(req);
      if (url.pathname === '/resources/read') {
        const body = requireObject(value, ['uri']);
        const plugins = (await owner.list()).plugins.filter((plugin) => plugin.enabled);
        for (const plugin of plugins) for (const application of plugin.manifest.contributes.applications ?? []) {
          if (body.uri !== appResourceUri(plugin.manifest.id, application.id)) continue;
          const { html } = await owner.bundle(plugin.manifest.id, plugin.digest, application.entry);
          sendJson(res, 200, { result: { contents: [{ uri: body.uri, mimeType: 'text/html;profile=mcp-app', text: html }] } });
          return;
        }
        throw new AppPluginError('not_found', 'Application resource is not available.');
      }
      const body = requireObject(value, ['name', 'arguments']);
      if (typeof body.name !== 'string') throw new AppPluginError('invalid_package', 'Tool name must be a string.');
      let result: AppToolResult;
      if (APP_PLUGIN_TOOLS.some((tool) => tool.name === body.name)) {
        const value = await callAppPluginTool(body.name, body.arguments, operations);
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } else {
        const plugins = (await owner.list()).plugins.filter((plugin) => plugin.enabled);
        const match = plugins.flatMap((plugin) => (plugin.manifest.contributes.tools ?? []).map((tool) => ({ plugin, tool })))
          .find(({ plugin, tool }) => isModelVisibleTool(tool) && appToolName(plugin.manifest.id, tool.name) === body.name);
        if (!match) throw new AppPluginError('not_found', 'App plugin tool is not available.');
        result = await host.call({ id: match.plugin.manifest.id, digest: match.plugin.digest, name: match.tool.name,
          arguments: body.arguments as Record<string, unknown> }, controller.signal);
      }
      if (!controller.signal.aborted) sendJson(res, 200, { result });
    } catch (error) {
      const expected = error instanceof AppPluginError;
      const status = expected ? { invalid_package: 400, conflict: 409, not_found: 404, closed: 503, busy: 429 }[error.code] : 500;
      if (!controller.signal.aborted) sendJson(res, status, { error: expected ? error.message : 'App plugin operation failed; external effects may already have occurred.' });
    } finally {
      requests.delete(controller);
      req.off('aborted', abort);
      res.off('close', abort);
    }
  };
  const server = createServer({ requestTimeout: 60_000, headersTimeout: 10_000, maxHeaderSize: 8 * 1024 }, (req, res) => {
    void handle(req, res).catch(() => res.destroy());
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const closeServer = () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer();
    throw new Error('App plugin gateway did not expose a loopback listener.');
  }
  port = address.port;
  let retire: () => Promise<void>;
  try {
    retire = await publishAppPluginMcp({ ...input, port: address.port, token });
  } catch (error) {
    await closeServer();
    throw error;
  }
  return {
    development,
    preview,
    forceClose: () => development.forceClose(),
    async reportRuntimeStatus(statusInput) {
      ensureOpen();
      const status = requireObject(statusInput, ['pluginId', 'digest', 'entry', 'instanceId', 'state', 'message']);
      requirePluginId(status.pluginId);
      requireDigest(status.digest);
      if (typeof status.entry !== 'string' || status.entry.length > 200
        || typeof status.instanceId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(status.instanceId)
        || !['mounted', 'ready', 'error', 'disposed'].includes(status.state as string)
        || (status.message !== undefined && (typeof status.message !== 'string' || status.message.length > 512))) {
        throw new AppPluginError('invalid_package', 'Invalid reader runtime status.');
      }
      const key = JSON.stringify([status.pluginId, status.entry]);
      const previous = observations.get(key);
      if (status.state !== 'mounted' && previous && (previous.instanceId !== status.instanceId || previous.digest !== status.digest)) return;
      if (status.state !== 'mounted' && status.state !== 'disposed' && !previous) return;
      if (previous?.instanceId === status.instanceId && previous.digest === status.digest && previous.state === 'disposed') return;
      const observation: ReaderObservation = {
        pluginId: status.pluginId, digest: status.digest, entry: status.entry, instanceId: status.instanceId,
        state: status.state as AppPluginRuntimeStatusInput['state'], observedAt: new Date().toISOString(),
        operation: Symbol(), pending: status.state !== 'disposed',
      };
      if (!observations.has(key) && observations.size >= MAX_OBSERVATIONS) observations.delete(observations.keys().next().value!);
      // Reserve arrival order before awaiting the owner; disposed is a terminal tombstone even if mount is still validating.
      observations.set(key, observation);
      if (status.state === 'disposed') return;
      const plugin = (await owner.list()).plugins.find((candidate) => candidate.manifest.id === status.pluginId);
      if (observations.get(key)?.operation !== observation.operation) return;
      if (!plugin) {
        observations.delete(key);
        throw new AppPluginError('not_found', 'The reader package is not installed.');
      }
      if (!plugin.enabled || plugin.digest !== status.digest || !plugin.manifest.contributes.readers?.some((reader) => reader.entry === status.entry)) {
        observations.delete(key);
        throw new AppPluginError('conflict', 'Reader runtime status does not match the current enabled package.');
      }
      ensureOpen();
      observation.pending = false;
    },
    changed: notifyChanged,
    close() {
      if (!closing) {
        closed = true;
        for (const request of requests) request.abort();
        notifyChanged();
        observations.clear();
        closing = closeServer().finally(() => development.close()).finally(retire);
      }
      return closing;
    },
  };
}
