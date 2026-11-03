import { app } from 'electron';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { browserIabToolActions, type BrowserActionContext, type BrowserActionParams, type BrowserSessionCleanup } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
import { createBrowserToolCatalog } from '../../../packages/openclaw-browser-relay-plugin/src/application/browser-relay-tool';
import type { RuntimeHostLifecycle } from '../runtime-host-delivery/lifecycle-owner';
import { isIabInvocationId, isIabMatchaCapability, type IabMatchaCapability } from '../runtime-host-delivery/control';
import type { IabAutomation } from './contracts';
import { IabOpenClawRuns } from './openclaw-context';
import { acquireIabMatchaContext } from './matcha-context';
import { IabMatchaRuns } from './matcha-run';
import { getOpenClawConfigDir, getRuntimeHostStateDir } from '../../utils/paths';

const executeFile = promisify(execFile);
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function identity(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 16_384 && !value.includes('\0'); }

function decodeContext(value: unknown): BrowserActionContext {
  if (!record(value) || !identity(value.sessionKey) || !identity(value.agentId) || !identity(value.sessionId)
    || ['workspaceDir', 'runId', 'rootSessionKey', 'sessionGroupId'].some((key) => value[key] !== undefined && !identity(value[key]))) {
    throw Object.assign(new Error('A trusted OpenClaw session context is required'), { code: 'IAB_CONTEXT_INVALID' });
  }
  // Root/group hints are not authority: Main derives them from the installed SDK.
  return { agentId: value.agentId, sessionKey: value.sessionKey, sessionId: value.sessionId,
    ...(typeof value.workspaceDir === 'string' ? { workspaceDir: value.workspaceDir } : {}),
    ...(typeof value.runId === 'string' ? { runId: value.runId } : {}) };
}
function decode(value: unknown): { params: BrowserActionParams; context: BrowserActionContext } {
  if (!record(value) || !record(value.params) || typeof value.params.action !== 'string'
    || !browserIabToolActions.includes(value.params.action as BrowserActionParams['action'])) {
    throw Object.assign(new Error('A browser action and trusted OpenClaw session context are required'), { code: 'IAB_CONTEXT_INVALID' });
  }
  return { params: value.params as BrowserActionParams, context: decodeContext(value.context) };
}
function decodeCleanup(value: unknown): BrowserSessionCleanup {
  if (!record(value) || Object.keys(value).length !== 2 || !(value.scope === 'executor' || value.scope === 'group')) {
    throw Object.assign(new Error('A trusted browser run and cleanup scope are required'), { code: 'IAB_CONTEXT_INVALID' });
  }
  const context = decodeContext(value.context);
  if (!context.runId) throw Object.assign(new Error('Browser cleanup requires an admitted run'), { code: 'IAB_CONTEXT_INVALID' });
  return { context, scope: value.scope };
}
function decodeMatcha(value: unknown): { params: BrowserActionParams; capability: IabMatchaCapability; invocationId: string; inputMessageId: string } {
  if (!record(value) || Object.keys(value).length !== 4 || !record(value.params)
    || typeof value.params.action !== 'string' || !browserIabToolActions.includes(value.params.action as BrowserActionParams['action'])
    || !isIabMatchaCapability(value.capability) || !isIabInvocationId(value.invocationId) || !isIabInvocationId(value.inputMessageId)) {
    throw Object.assign(new Error('A browser action and native Matcha invocation capability are required'), { code: 'IAB_CONTEXT_INVALID' });
  }
  return { params: value.params as BrowserActionParams, capability: value.capability, invocationId: value.invocationId, inputMessageId: value.inputMessageId };
}
async function waitForCaller<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([pending, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('Browser request exceeds the input limit'), { code: 'IAB_REQUEST_TOO_LARGE' });
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
}
function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed) return;
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': bytes.length });
  response.end(bytes);
}

async function publish(port: number, token: string): Promise<() => Promise<void>> {
  const id = randomUUID();
  const directory = join(app.getPath('userData'), 'iab-agent', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const { stdout } = await executeFile(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new Error('Cannot determine the private browser bridge owner');
    await executeFile(join(system, 'icacls.exe'), [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true });
  } else await chmod(directory, 0o700);
  const discovery = join(directory, 'discovery.json');
  const contents = JSON.stringify({ identity: id, port, token });
  const descriptors = [
    join(getOpenClawConfigDir(), 'plugins', 'browser-relay', 'iab.json'),
    join(getRuntimeHostStateDir(), 'iab-agent.json'),
  ];
  const descriptorContents = JSON.stringify({ discovery });
  const published: { path: string; contents: string }[] = [];
  const retire = async () => {
    for (const entry of published.reverse()) {
      try { if (await readFile(entry.path, 'utf8') === entry.contents) await unlink(entry.path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try { await rmdir(directory); } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  };
  try {
    await writeFile(discovery, contents, { flag: 'wx', mode: 0o600 });
    published.push({ path: discovery, contents });
    for (const descriptor of descriptors) {
      await mkdir(dirname(descriptor), { recursive: true, mode: 0o700 });
      // Inspect the previous descriptor before retiring a stale application-owned publication.
      try {
        const previous: unknown = JSON.parse(await readFile(descriptor, 'utf8'));
        if (!record(previous) || typeof previous.discovery !== 'string') throw new Error('Invalid existing browser bridge descriptor');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const temporary = `${descriptor}.${id}.tmp`;
      try {
        await writeFile(temporary, descriptorContents, { flag: 'wx', mode: 0o600 });
        await rename(temporary, descriptor);
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      }
      published.push({ path: descriptor, contents: descriptorContents });
    }
    return retire;
  } catch (error) { await retire(); throw error; }
}

/** Private browser adapter transport. It exposes no CDP socket, renderer token or arbitrary target. */
export async function startIabAgentBridge(input: {
  automation: IabAutomation;
  cleanupSession(executorId: string, principalId: string, scope: 'executor' | 'group'): Promise<void>;
  ready: Promise<void>;
  isEnabled(): Promise<boolean>;
  controlSignal(): AbortSignal;
  assertControlCurrent(): void;
  runtime(): Promise<Pick<RuntimeHostLifecycle, 'command' | 'onDisconnect'>>;
}) {
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${token}`);
  const requests = new Set<AbortController>();
  const inflight = new Set<Promise<void>>();
  const openclawRuns = new IabOpenClawRuns(input.cleanupSession);
  const matchaRuns = new IabMatchaRuns(input.cleanupSession);
  let closed = false;
  const server = createServer((request, response) => {
    const pending = (async () => {
      const received = Buffer.from(request.headers.authorization ?? '');
      if (closed || request.headers.origin !== undefined || received.length !== authorization.length || !timingSafeEqual(received, authorization)) {
        request.resume(); json(response, 403, { error: { code: 'IAB_BRIDGE_DENIED', message: 'Browser bridge access denied' } }); return;
      }
      const catalog = request.method === 'GET' && request.url === '/matcha/catalog';
      const matcha = request.url === '/matcha/browser';
      const sessionEnd = request.url === '/browser/session-end';
      if (!catalog && (request.method !== 'POST' || !matcha && !sessionEnd && request.url !== '/browser'
        || !request.headers['content-type']?.startsWith('application/json'))) {
        request.resume(); json(response, 400, { error: { code: 'IAB_REQUEST_INVALID', message: 'Invalid browser bridge request' } }); return;
      }
      const controller = new AbortController();
      const modeSignal = input.controlSignal();
      const signal = AbortSignal.any([controller.signal, modeSignal]);
      requests.add(controller);
      const abort = () => controller.abort(new Error('Browser caller disconnected'));
      const close = () => { if (!response.writableEnded) abort(); };
      request.once('aborted', abort);
      response.once('close', close);
      try {
        if (!sessionEnd) input.assertControlCurrent();
        if (catalog) {
          request.resume();
          const enabled = await waitForCaller(input.isEnabled(), signal);
          input.assertControlCurrent(); signal.throwIfAborted();
          const tool = createBrowserToolCatalog('iab');
          json(response, 200, { tools: enabled ? [{ name: tool.name, description: tool.description, inputSchema: tool.parameters }] : [] });
          return;
        }
        const payload = await body(request);
        if (sessionEnd) {
          // Cleanup remains available after mode changes and caller disconnects.
          await openclawRuns.end(decodeCleanup(payload));
          json(response, 200, { result: { released: true } });
          return;
        }
        await waitForCaller(input.ready, signal);
        if (closed || !await waitForCaller(input.isEnabled(), signal)) throw Object.assign(new Error('Agent control of the in-app browser is disabled'), { code: 'IAB_DISABLED' });
        input.assertControlCurrent(); signal.throwIfAborted();
        if (matcha) {
          const decoded = decodeMatcha(payload);
          const runtime = await waitForCaller(input.runtime(), signal);
          const lease = await acquireIabMatchaContext({ ...decoded, runtime, signal, runs: matchaRuns });
          try {
            lease.context.assertCurrent();
            const result = await input.automation.handleRequest(decoded.params, lease.context, lease.signal);
            lease.signal.throwIfAborted();
            await lease.release();
            json(response, 200, { result });
          } catch (error) {
            try { await lease.release(); }
            catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Browser action cleanup could not be confirmed', { cause: cleanupError }); }
            throw error;
          }
        } else {
          const decoded = decode(payload);
          const result = await openclawRuns.execute(decoded.context, signal, (context, current) => {
            context.assertCurrent();
            return input.automation.handleRequest(decoded.params, context, current);
          });
          signal.throwIfAborted();
          json(response, 200, { result });
        }
      } catch (error) {
        const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'IAB_ACTION_FAILED';
        // Owner errors are actionable; filesystem and transport diagnostics remain private.
        json(response, 400, { error: { code, message: error instanceof Error && code.startsWith('IAB_') ? error.message : 'The browser action could not be completed' } });
      } finally {
        request.off('aborted', abort); response.off('close', close); requests.delete(controller);
      }
    })();
    inflight.add(pending);
    void pending.finally(() => inflight.delete(pending)).catch(() => { response.destroy(); });
  });
  server.requestTimeout = 300_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Browser bridge listener is unavailable');
  let retire: () => Promise<void>;
  try { retire = await publish(address.port, token); }
  catch (error) { server.close(); server.closeAllConnections(); throw error; }
  let closing: Promise<void> | undefined;
  return {
    close(): Promise<void> {
      return closing ??= (async () => {
        closed = true;
        for (const controller of requests) controller.abort(new Error('Browser bridge is closing'));
        const stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        server.closeAllConnections();
        const drainingRuns = Promise.allSettled([openclawRuns.close(), matchaRuns.close()]);
        await Promise.allSettled([...inflight]);
        const outcomes = await drainingRuns;
        try {
          await stopped;
          const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected').map((outcome) => outcome.reason);
          if (failures.length) throw new AggregateError(failures, 'Browser run cleanup could not be confirmed');
        } finally { await retire(); }
      })();
    },
  };
}
