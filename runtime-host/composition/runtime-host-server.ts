import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { handleDispatchRoute } from '../api/dispatch/dispatch-route-handler';
import type { RuntimeRouteResponse } from '../api/dispatch/runtime-route-dispatcher-types';
import { sendJson } from '../api/common/http';
import { createTeamRuntimeWebhookHandler, isTeamRuntimeWebhookPath } from '../api/routes/team-runtime-webhook-routes';
import {
  TRANSPORT_VERSION,
} from '../shared/runtime-host-constants';
import type { RuntimeLifecycleState } from '../application/common/runtime-contracts';
import type { RemoteFleetPort } from '../application/remote-fleet/remote-fleet-service';
import {
  createRuntimeAgentIngressRejectedResponse,
  REMOTE_FLEET_RUNTIME_AGENT_INGRESS_PATH,
} from '../application/remote-fleet/remote-fleet-agent-ingress';
import { createRuntimeAgentIngressRouteHandler } from '../api/routes/remote-fleet-runtime-agent-ingress-route';
import type { TeamRuntimePort } from '../application/team-runtime/team-runtime-port';
import type { RuntimeHostLogger } from '../shared/logger';

export interface RuntimeHostTransportStats {
  totalDispatchRequests: number;
  runtimeRouteHandled: number;
  unhandledRouteCount: number;
  badRequestRejected: number;
  dispatchInternalError: number;
}

export interface RuntimeHostHttpServerDeps {
  readonly port: number;
  readonly startedAtMs: number;
  readonly getLifecycleState: () => RuntimeLifecycleState;
  readonly restartLifecycle: () => void;
  readonly createHealthPayload: (lifecycle: RuntimeLifecycleState, startedAtMs: number) => unknown;
  readonly transportStats: RuntimeHostTransportStats;
  readonly logger?: RuntimeHostLogger;
  readonly teamWebhookToken: string | (() => string | Promise<string>);
  readonly teamRuntimeService: TeamRuntimePort;
  readonly remoteFleetService: Pick<RemoteFleetPort, 'invoke'>;
  readonly nowMs: () => number;
  readonly nowIso: () => string;
  readonly terminalStream?: {
    attachWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> | boolean;
  };
  readonly dispatchRuntimeRoute: (
    method: string,
    route: string,
    payload: unknown,
  ) => Promise<RuntimeRouteResponse | null>;
  readonly shutdown: (exitCode?: number) => Promise<void>;
}

export function createTransportStats(): RuntimeHostTransportStats {
  return {
    totalDispatchRequests: 0,
    runtimeRouteHandled: 0,
    unhandledRouteCount: 0,
    badRequestRejected: 0,
    dispatchInternalError: 0,
  };
}

function isWebhookTokenAuthorized(actualToken: string, expectedToken: string): boolean {
  if (!actualToken || !expectedToken) return false;
  const actualDigest = createHash('sha256').update(actualToken).digest();
  const expectedDigest = createHash('sha256').update(expectedToken).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function createWebhookBodyHasher(): { update: (chunk: Uint8Array) => void; digest: () => string } {
  const hash = createHash('sha256');
  return {
    update: (chunk) => { hash.update(chunk); },
    digest: () => hash.digest('hex'),
  };
}

function createWebhookRequestId(): string {
  return `team-webhook-request:${randomUUID()}`;
}

export function createRuntimeHostHttpServer(deps: RuntimeHostHttpServerDeps): Server {
  const handleTeamRuntimeWebhook = createTeamRuntimeWebhookHandler({
    token: deps.teamWebhookToken,
    teamRuntimeService: deps.teamRuntimeService,
    isWebhookTokenAuthorized,
    createWebhookBodyHasher,
    createWebhookRequestId,
  });
  const handleRuntimeAgentIngress = createRuntimeAgentIngressRouteHandler({
    remoteFleetService: deps.remoteFleetService,
    nowIso: deps.nowIso,
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', `http://127.0.0.1:${deps.port}`);

    if (method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, deps.createHealthPayload(deps.getLifecycleState(), deps.startedAtMs));
      return;
    }

    if (method === 'POST' && url.pathname === '/lifecycle/restart') {
      deps.restartLifecycle();
      sendJson(res, 200, { version: TRANSPORT_VERSION, success: true, lifecycle: deps.getLifecycleState() });
      return;
    }

    if (method === 'POST' && url.pathname === '/lifecycle/stop') {
      sendJson(res, 200, { version: TRANSPORT_VERSION, success: true, lifecycle: 'stopped' });
      void deps.shutdown(0);
      return;
    }

    if (isTeamRuntimeWebhookPath(url.pathname)) {
      void handleTeamRuntimeWebhook(req, res).catch((error) => {
        deps.logger?.warn('[team-webhook] request failed', { error: String(error) });
        sendJson(res, 500, { success: false, error: 'TeamRun webhook failed.' });
      });
      return;
    }

    if (url.pathname === REMOTE_FLEET_RUNTIME_AGENT_INGRESS_PATH) {
      void handleRuntimeAgentIngress(req, res).catch(() => {
        sendJson(res, 503, createRuntimeAgentIngressRejectedResponse(
          undefined,
          'runtime-unavailable',
          deps.nowIso(),
        ));
      });
      return;
    }

    if (method === 'POST' && url.pathname === '/dispatch') {
      handleDispatchRoute(req, res, {
        transportStats: deps.transportStats,
        logger: deps.logger,
        dispatchRuntimeRoute: deps.dispatchRuntimeRoute,
      });
      return;
    }

    sendJson(res, 404, {
      version: TRANSPORT_VERSION,
      success: false,
      status: 404,
      error: {
        code: 'NOT_FOUND',
        message: `No route for ${method} ${url.pathname}`,
      },
    });
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${deps.port}`);
    if (!deps.terminalStream || !url.pathname.startsWith('/api/remote-fleet/terminal/')) {
      socket.destroy();
      return;
    }
    void Promise.resolve(deps.terminalStream.attachWebSocket(req, socket, head)).then((handled) => {
      if (!handled && !socket.destroyed) {
        socket.destroy();
      }
    }).catch((error) => {
      deps.logger?.warn('[remote-fleet:terminal] upgrade failed', { error: error instanceof Error ? error.message : String(error) });
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
  });

  return server;
}

export function closeRuntimeHostHttpServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
