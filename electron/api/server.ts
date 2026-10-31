import { randomBytes } from 'node:crypto';
import { addAbortListener, errorMonitor } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { getPort } from '../utils/config';
import { logger } from '../utils/logger';
import { isTraceEnabled, startupTrace } from '../utils/trace-logger';
import { HOST_API_STARTUP_PATHS, HOST_API_STARTUP_TRACE_HEADER } from '../../src/lib/host-api-transport-contract';
import type { HostApiServerContext } from './context';
import { handleAppRoutes } from './routes/app';
import { proxyFleetRuntimeAgentIngress, proxyFleetTerminalStreamUpgrade } from '../main/runtime-host-delivery/transport/fleet';
import { isHostApiProxyWebSocketRoute, isHostApiQueryTokenAllowedRoute, getHostApiRequestDependency, isMainOwnedRoute } from './route-boundary';
import { requireJsonContentType, sendJson, setCorsHeaders } from './route-utils';
import { isSessionTraceEnabled, logSessionTrace, readTraceHeader } from '../main/runtime-host-delivery/transport/sessions/trace';
import { createHostApiDispatcher } from './dispatcher';
import type { HostApiDispatcher } from './execution';
import { createHttpApiRequest, writeHttpApiResponse } from './http-adapter';

export type HostApiConnection = Readonly<{
  baseUrl: string;
  token: string;
}>;

let hostApiToken = '';
let hostApiBaseUrl = '';
let resolveHostApiReady: (() => void) | null = null;
let rejectHostApiReady: ((error: Error) => void) | null = null;
let hostApiReadyPromise: Promise<void>;
let isHostApiReadySettled = false;
let hostApiServerGeneration = 0;

function createHostApiReadyBarrier(): void {
  isHostApiReadySettled = false;
  hostApiReadyPromise = new Promise((resolve, reject) => {
    resolveHostApiReady = () => {
      isHostApiReadySettled = true;
      resolve();
    };
    rejectHostApiReady = (error) => {
      isHostApiReadySettled = true;
      reject(error);
    };
  });
  void hostApiReadyPromise.catch(() => undefined);
}

function prepareHostApiReadyBarrier(): number {
  hostApiServerGeneration += 1;
  if (isHostApiReadySettled) {
    createHostApiReadyBarrier();
  }
  return hostApiServerGeneration;
}

createHostApiReadyBarrier();

export function getHostApiToken(): string {
  return hostApiToken;
}

export function getHostApiBaseUrl(): string {
  return hostApiBaseUrl;
}

export async function waitForHostApiReady(): Promise<void> {
  await hostApiReadyPromise;
}

export async function readHostApiConnection(): Promise<HostApiConnection> {
  await waitForHostApiReady();
  return { baseUrl: hostApiBaseUrl, token: hostApiToken };
}

function isRequestClosed(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): boolean {
  return signal.aborted || req.aborted || req.socket?.destroyed || res.destroyed || res.writableEnded;
}

export function createHostApiRequestHandler(ctx: HostApiServerContext, port: number, dispatch = createHostApiDispatcher(ctx)) {
  const { runtime, signal } = ctx;

  return async (req: IncomingMessage, res: ServerResponse) => {
    const traceId = isSessionTraceEnabled() ? readTraceHeader(req.headers) : null;
    const traceActive = traceId !== null && req.url?.split(/[?#]/, 1)[0] === '/api/capabilities/execute';
    const traceStartedAt = traceActive ? Date.now() : 0;
    const startupPath = isTraceEnabled() ? req.url?.split(/[?#]/, 1)[0] ?? '' : '';
    const startupTracing = isTraceEnabled() && req.method === 'GET' && HOST_API_STARTUP_PATHS.has(startupPath);
    const startupStartedAt = startupTracing ? performance.now() : 0;
    const startupHeader = startupTracing ? req.headers[HOST_API_STARTUP_TRACE_HEADER.toLowerCase()] : null;
    const requestIdHash = typeof startupHeader === 'string' && /^[a-f0-9]{8}$/.test(startupHeader) ? startupHeader : null;
    const traceStartup = (phase: string, detail?: () => Record<string, unknown>): void => {
      if (!startupTracing) return;
      startupTrace('electron.hostapi.server', phase, () => ({
        path: startupPath, method: 'GET', requestIdHash,
        elapsedMs: Math.round(performance.now() - startupStartedAt), ...detail?.(),
      }));
    };
    let startupStage: 'auth' | 'dispatch' | null = null;
    if (startupTracing) {
      const terminal = (phase: string, outcome: 'finished' | 'aborted' | 'failed'): void => {
        res.removeListener('finish', finished);
        res.removeListener('close', closed);
        res.removeListener(errorMonitor, failed);
        traceStartup(phase, () => ({ outcome, status: res.statusCode }));
      };
      const finished = () => terminal('res.finish', 'finished');
      const closed = () => terminal('res.close', res.writableFinished ? 'finished' : 'aborted');
      const failed = () => terminal('res.error', 'failed');
      res.once('finish', finished);
      res.once('close', closed);
      res.once(errorMonitor, failed);
    }
    const trace = (stage: string, payload?: () => Record<string, unknown>): void => {
      if (!traceActive) return;
      logSessionTrace(`electron.hostapi.server.${stage}`, traceId, {
        path: '/api/capabilities/execute', elapsedMs: Date.now() - traceStartedAt, ...payload?.(),
      });
    };
    trace('received');
    traceStartup('received');
    try {
      const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : undefined;
      setCorsHeaders(res, origin);

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (requestUrl.pathname === '/api/remote-fleet/runtime-agent/ingress') {
        const { runtimeHostTransportPort } = await runtime;
        if (isRequestClosed(req, res, signal)) return;
        proxyFleetRuntimeAgentIngress(runtimeHostTransportPort, req, res);
        return;
      }

      trace('auth.start');
      startupStage = 'auth';
      traceStartup('auth.start');
      if (hostApiToken) {
        const authHeader = typeof req.headers?.authorization === 'string'
          ? req.headers.authorization
          : '';
        const bearerToken = authHeader.startsWith('Bearer ')
          ? authHeader.slice(7)
          : '';
        const queryToken = isHostApiQueryTokenAllowedRoute(req.method, requestUrl.pathname)
          ? requestUrl.searchParams.get('token') || ''
          : '';
        const presentedToken = bearerToken || queryToken;
        if (!presentedToken || presentedToken !== hostApiToken) {
          trace('auth.end', () => ({ outcome: 'rejected', status: 401 }));
          traceStartup('auth.end', () => ({ outcome: 'rejected', status: 401 }));
          startupStage = null;
          sendJson(res, 401, { success: false, error: 'Unauthorized' });
          return;
        }
      }

      trace('auth.end', () => ({ outcome: hostApiToken ? 'accepted' : 'not-required' }));
      traceStartup('auth.end', () => ({ outcome: hostApiToken ? 'accepted' : 'not-required' }));
      startupStage = null;

      if (!requireJsonContentType(req)) {
        sendJson(res, 415, { success: false, error: 'Content-Type must be application/json' });
        return;
      }

      const dependency = getHostApiRequestDependency(req.method ?? '', requestUrl.pathname);
      if (dependency === null) {
        if (isMainOwnedRoute(requestUrl.pathname)) {
          sendJson(res, 500, {
            success: false,
            error: `Main-owned route is not registered: ${req.method} ${requestUrl.pathname}`,
          });
          return;
        }
        sendJson(res, 404, { success: false, error: `No route for ${req.method} ${requestUrl.pathname}` });
        return;
      }

      traceStartup('boundary.pass');
      trace('dispatch.start');
      startupStage = 'dispatch';
      traceStartup('dispatch.start');
      if (isRequestClosed(req, res, signal)) return;
      let handled = false;
      if (requestUrl.pathname === '/api/events') {
        const deps = await runtime;
        if (isRequestClosed(req, res, signal)) return;
        handled = await handleAppRoutes(req, res, requestUrl, { ...ctx, ...deps });
      } else {
        const adapter = createHttpApiRequest(req, res, ctx.sessionObservers);
        try {
          const response = await dispatch(adapter.request, requestUrl);
          if (!response || isRequestClosed(req, res, signal)) return;
          writeHttpApiResponse(res, response);
          handled = true;
        } finally {
          adapter.dispose();
        }
      }
      const outcome = handled ? { outcome: 'handled', status: res.statusCode } : { outcome: 'unhandled' };
      trace('dispatch.end', () => outcome);
      traceStartup('dispatch.end', () => outcome);
      startupStage = null;
      if (handled) return;
      if (isMainOwnedRoute(requestUrl.pathname)) {
        sendJson(res, 500, {
          success: false,
          error: `Main-owned route is not registered: ${req.method} ${requestUrl.pathname}`,
        });
        return;
      }
      sendJson(res, 404, { success: false, error: `No route for ${req.method} ${requestUrl.pathname}` });
    } catch {
      if (isRequestClosed(req, res, signal)) return;
      trace('failure', () => ({ outcome: 'failed', status: 500 }));
      if (startupStage) traceStartup(`${startupStage}.end`, () => ({ outcome: 'failed', status: 500 }));
      traceStartup('error', () => ({ code: 'REQUEST_FAILED', status: 500 }));
      logger.error('Host API request failed.');
      sendJson(res, 500, { success: false, error: 'Host API request failed.' });
    }
  };
}

export function startHostApiServer(
  ctx: HostApiServerContext,
  port?: number,
  dispatch?: HostApiDispatcher,
): Server {
  const resolvedPort = Number.isFinite(port) && (port ?? 0) > 0
    ? Number(port)
    : getPort('MATCHACLAW_HOST_API');
  const readyGeneration = prepareHostApiReadyBarrier();
  hostApiToken = randomBytes(32).toString('hex');
  hostApiBaseUrl = '';

  const server = createServer(createHostApiRequestHandler(ctx, resolvedPort, dispatch));

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${resolvedPort}`);
    if (ctx.signal.aborted || !isHostApiProxyWebSocketRoute(requestUrl.pathname)) {
      socket.destroy();
      return;
    }
    const abortListener = addAbortListener(ctx.signal, () => socket.destroy());
    const cleanup = () => {
      abortListener[Symbol.dispose]();
      socket.off('close', cleanup);
    };
    socket.once('close', cleanup);
    void ctx.runtime.then(({ runtimeHostTransportPort }) => {
      if (ctx.signal.aborted || req.aborted || socket.destroyed || !server.listening) {
        socket.destroy();
        return;
      }
      proxyFleetTerminalStreamUpgrade(runtimeHostTransportPort, req, socket, head);
    }).catch(() => socket.destroy()).finally(cleanup);
  });

  const bindStartedAt = isTraceEnabled() ? performance.now() : 0;
  server.on('error', (error: NodeJS.ErrnoException) => {
    startupTrace('electron.hostapi.bind', 'error', () => ({
      code: error.code === 'EADDRINUSE' || error.code === 'EACCES' ? error.code : 'SERVER_ERROR',
      elapsedMs: Math.round(performance.now() - bindStartedAt),
    }));
    if (!server.listening && readyGeneration === hostApiServerGeneration) {
      rejectHostApiReady?.(error);
    }
    if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
      logger.error(
        `Host API server failed to bind port ${resolvedPort}: ${error.message}. ` +
        'You can override it with MATCHACLAW_PORT_MATCHACLAW_HOST_API.',
      );
      return;
    }
    logger.error('Host API server error:', error);
  });

  startupTrace('electron.hostapi.bind', 'start');
  server.listen(resolvedPort, '127.0.0.1', () => {
    startupTrace('electron.hostapi.bind', 'listening', () => ({ elapsedMs: Math.round(performance.now() - bindStartedAt) }));
    const address = server.address() as AddressInfo | null;
    const listeningPort = address?.port ?? resolvedPort;
    const listeningBaseUrl = `http://127.0.0.1:${listeningPort}`;
    if (readyGeneration === hostApiServerGeneration) {
      hostApiBaseUrl = listeningBaseUrl;
      resolveHostApiReady?.();
    }
    logger.info(`Host API server listening on ${listeningBaseUrl}`);
  });

  return server;
}

export async function waitForHostApiServerListening(server: Server): Promise<Server> {
  if (server.listening) {
    return server;
  }

  await new Promise<void>((resolve, reject) => {
    const handleListening = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const handleClose = () => handleError(new Error('Host API server closed before listening.'));
    const cleanup = () => {
      server.off('listening', handleListening);
      server.off('error', handleError);
      server.off('close', handleClose);
    };

    server.once('listening', handleListening);
    server.once('error', handleError);
    server.once('close', handleClose);
  });

  return server;
}
