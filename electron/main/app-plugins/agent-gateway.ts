import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AppPluginDevelopment, AppPluginKind, AppPluginManifest } from '../../../src/types/desktop/app-plugin';
import { sendJson } from '../../api/route-utils';
import { APP_PLUGIN_TOOLS, callAppPluginTool, type AppPluginToolOperations } from './agent-tools';
import { publishAppPluginMcp } from './mcp-projection';
import type { ApplicationPluginOwner } from './owner';
import { AppPluginError, requireDigest, requireObject, requirePluginId } from './package';

const GRANT_LIFETIME_MS = 30 * 60 * 1000;
const MAX_GRANTS = 128;
const MAX_OBSERVATIONS = 128;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

export interface AppPluginRuntimeStatusInput {
  pluginId: string;
  digest: string;
  entry: string;
  instanceId: string;
  state: 'mounted' | 'ready' | 'error' | 'disposed';
  message?: string;
}

export interface AppPluginAgentGateway {
  createDevelopment(input: { kind: AppPluginKind; pluginId?: string }): AppPluginDevelopment;
  reportRuntimeStatus(input: AppPluginRuntimeStatusInput): Promise<void>;
  close(): Promise<void>;
}

interface DevelopmentGrant {
  development: AppPluginDevelopment;
  boundId?: string;
  sourceDigest?: string;
  builtSourceDigest?: string;
  builtDigest?: string;
  busy: boolean;
}

type ReaderObservation = Omit<AppPluginRuntimeStatusInput, 'message'> & {
  observedAt: string;
  operation: symbol;
  pending: boolean;
};

function assertScope(manifest: AppPluginManifest, grant: DevelopmentGrant): void {
  const readers = !!manifest.contributes.readers?.length;
  const connectors = !!manifest.contributes.connectors?.length;
  if (grant.development.kind === 'reader' ? !readers || connectors : !connectors || readers) {
    throw new AppPluginError('invalid_package', 'Development is authorized for one plugin kind only; mixed or other-kind packages are not allowed.');
  }
  const id = grant.development.pluginId ?? grant.boundId;
  if (id && manifest.id !== id) throw new AppPluginError('conflict', 'The development request is bound to a different plugin identifier.');
}

async function readRequest(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new AppPluginError('invalid_package', 'App plugin tool input exceeds 32 MiB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch {
    throw new AppPluginError('invalid_package', 'App plugin tool input must be JSON.');
  }
}

export async function startAppPluginAgentGateway(input: {
  owner: ApplicationPluginOwner;
  root: string;
}): Promise<AppPluginAgentGateway> {
  const { owner } = input;
  const token = randomBytes(32).toString('hex');
  const expectedToken = Buffer.from(`Bearer ${token}`);
  const grants = new Map<string, DevelopmentGrant>();
  const observations = new Map<string, ReaderObservation>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const ensureOpen = () => {
    if (closed) throw new AppPluginError('closed', 'The app plugin development gateway is closed.');
  };
  const withGrant = async <T>(requestId: string, action: (grant: DevelopmentGrant) => Promise<T>): Promise<T> => {
    ensureOpen();
    const grant = grants.get(requestId);
    if (!grant || Date.parse(grant.development.expiresAt) <= Date.now()) {
      if (grant && !grant.busy) grants.delete(requestId);
      throw new AppPluginError('conflict', 'The development request has expired, was consumed, or was not issued by the application UI.');
    }
    if (grant.busy) throw new AppPluginError('busy', 'Another operation is using this development request.');
    grant.busy = true;
    try { return await action(grant); } finally { grant.busy = false; }
  };
  const operations: AppPluginToolOperations = {
    owner,
    inspectInstalled: (requestId, sourceInput) => withGrant(requestId, async (grant) => {
      if (grant.development.pluginId !== sourceInput.pluginId) throw new AppPluginError('conflict', 'Installed source requires an edit request for this plugin.');
      const source = await owner.inspectInstalledSource({ id: sourceInput.pluginId, digest: sourceInput.digest });
      assertScope(source.manifest, grant);
      grant.sourceDigest = source.digest;
      return source;
    }),
    build: (requestId, buildInput) => withGrant(requestId, async (grant) => {
      assertScope(buildInput.manifest, grant);
      if (grant.development.pluginId) {
        const current = (await owner.list()).plugins.find((plugin) => plugin.manifest.id === grant.development.pluginId);
        if (!current) throw new AppPluginError('not_found', 'The package selected for editing is no longer installed.');
        assertScope(current.manifest, grant);
      }
      if (!grant.development.pluginId && !grant.boundId) {
        // Bind before the first await: concurrent builds cannot select different package ids.
        grant.boundId = buildInput.manifest.id;
      }
      if (!grant.development.pluginId && (await owner.list()).plugins.some((plugin) => plugin.manifest.id === grant.boundId)) {
        throw new AppPluginError('conflict', 'New plugin development cannot replace an already installed package. Start an edit request in the application UI.');
      }
      const build = await owner.build(buildInput);
      grant.builtDigest = build.digest;
      grant.builtSourceDigest = grant.sourceDigest;
      return build;
    }),
    install: (requestId, packageInput) => withGrant(requestId, async (grant) => {
      if (grant.development.pluginId && !grant.builtSourceDigest) {
        throw new AppPluginError('conflict', 'Inspect the installed source before building an edited package.');
      }
      if (!grant.builtDigest || grant.builtDigest !== packageInput.digest) {
        throw new AppPluginError('conflict', 'Install requires the digest returned by the latest successful build for this development request.');
      }
      const inspected = await owner.inspect(packageInput.packageBase64);
      assertScope(inspected.manifest, grant);
      if (inspected.digest !== packageInput.digest) throw new AppPluginError('conflict', 'The package digest does not match the authorized build.');
      if (!grant.development.pluginId && (await owner.list()).plugins.some((plugin) => plugin.manifest.id === grant.boundId)) {
        throw new AppPluginError('conflict', 'A package with the selected identifier is already installed.');
      }
      ensureOpen();
      if (Date.parse(grant.development.expiresAt) <= Date.now()) throw new AppPluginError('conflict', 'The development request has expired.');
      const installed = await owner.importPackage({
        ...packageInput, origin: 'agent',
        ...(grant.development.pluginId ? { expectedDigest: grant.builtSourceDigest } : { onlyIfNew: true }),
      });
      grants.delete(requestId);
      return installed;
    }),
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
        connectors: (plugin.manifest.contributes.connectors ?? []).map((connector) => ({ id: connector.id, runtime: 'not-observed', configurationOnly: true })),
        observation: 'Installation and enabled configuration do not prove rendering correctness or a connected MCP service.',
      };
    },
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    const presentedToken = Buffer.from(req.headers.authorization ?? '');
    if (req.headers.origin || presentedToken.length !== expectedToken.length || !timingSafeEqual(presentedToken, expectedToken)) {
      sendJson(res, 403, { error: 'App plugin gateway authorization failed.' });
      return;
    }
    if (closed || req.method !== 'POST' || req.url !== '/tools/call') {
      sendJson(res, closed ? 503 : 404, { error: 'App plugin tool endpoint unavailable.' });
      return;
    }
    if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      sendJson(res, 415, { error: 'App plugin tools require application/json.' });
      return;
    }
    try {
      const body = requireObject(await readRequest(req), ['name', 'arguments']);
      if (typeof body.name !== 'string' || !APP_PLUGIN_TOOLS.some((tool) => tool.name === body.name)) {
        throw new AppPluginError('invalid_package', 'Unknown app plugin tool.');
      }
      const result = await callAppPluginTool(body.name, body.arguments, operations);
      sendJson(res, 200, { result });
    } catch (error) {
      const expected = error instanceof AppPluginError;
      sendJson(res, expected ? 400 : 500, { error: expected ? error.message : 'App plugin tool failed; no installation success was confirmed.' });
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
    server.closeIdleConnections();
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer();
    throw new Error('App plugin gateway did not expose a loopback listener.');
  }
  let retire: () => Promise<void>;
  try {
    retire = await publishAppPluginMcp({ ...input, port: address.port, token });
  } catch (error) {
    await closeServer();
    throw error;
  }
  return {
    createDevelopment(developmentInput) {
      ensureOpen();
      const value = requireObject(developmentInput, ['kind', 'pluginId']);
      if (value.kind !== 'reader' && value.kind !== 'connector') throw new AppPluginError('invalid_package', 'Development requires reader or connector kind.');
      if (value.pluginId !== undefined) requirePluginId(value.pluginId);
      for (const [id, grant] of grants) {
        if (!grant.busy && Date.parse(grant.development.expiresAt) <= Date.now()) grants.delete(id);
      }
      if (grants.size >= MAX_GRANTS) throw new AppPluginError('busy', 'Too many active plugin development requests.');
      const development: AppPluginDevelopment = {
        requestId: randomUUID(), kind: value.kind,
        ...(value.pluginId === undefined ? {} : { pluginId: value.pluginId }),
        expiresAt: new Date(Date.now() + GRANT_LIFETIME_MS).toISOString(),
      };
      grants.set(development.requestId, { development, busy: false });
      return { ...development };
    },
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
    close() {
      if (!closing) {
        closed = true;
        grants.clear();
        observations.clear();
        closing = closeServer().finally(retire);
      }
      return closing;
    },
  };
}
