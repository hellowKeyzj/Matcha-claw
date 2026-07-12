import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeRuntimeHostHttpServer,
  createRuntimeHostHttpServer,
  createTransportStats,
  type RuntimeHostHttpServerDeps,
} from '../../runtime-host/composition/runtime-host-server';

let activeServer: Server | undefined;

afterEach(async () => {
  if (!activeServer) return;
  await closeRuntimeHostHttpServer(activeServer);
  activeServer = undefined;
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Runtime host test server did not bind to a TCP port.');
  }
  return (address as AddressInfo).port;
}

function startRuntimeHostServer(workerResponse: { status: number; data: unknown }) {
  const invoke = vi.fn(async () => workerResponse);
  const dispatchRuntimeRoute = vi.fn(async () => ({
    status: 200,
    data: { shouldNotBeReturned: true },
  }));
  const transportStats = createTransportStats();
  activeServer = createRuntimeHostHttpServer({
    port: 0,
    startedAtMs: 0,
    getLifecycleState: () => 'running',
    restartLifecycle: vi.fn(),
    createHealthPayload: vi.fn(),
    transportStats,
    teamWebhookToken: '',
    teamRuntimeService: { invoke: vi.fn() } as unknown as RuntimeHostHttpServerDeps['teamRuntimeService'],
    remoteFleetService: { invoke } as unknown as RuntimeHostHttpServerDeps['remoteFleetService'],
    nowMs: () => 0,
    nowIso: () => '2026-07-11T00:00:00.000Z',
    dispatchRuntimeRoute,
    shutdown: vi.fn(async () => {}),
  });

  return { dispatchRuntimeRoute, invoke, server: activeServer, transportStats };
}

describe('runtime-host RuntimeAgent ingress server boundary', () => {
  it('POSTs ingress directly to the Remote Fleet facade without a dispatch envelope', async () => {
    const workerResponse = {
      status: 200,
      data: {
        type: 'runtime-agent.heartbeat.response',
        requestId: 'heartbeat-request',
        agentId: 'agent-1',
        resultType: 'recorded',
      },
    };
    const { dispatchRuntimeRoute, invoke, server, transportStats } = startRuntimeHostServer(workerResponse);
    const port = await listen(server);
    const authorizationCredential = 'runtime-agent-authorization';
    const enrollmentCredential = 'runtime-agent-enrollment';
    const requestPayload = {
      type: 'runtime-agent.heartbeat',
      requestId: 'heartbeat-request',
      agentId: 'agent-1',
    };

    const response = await fetch(`http://127.0.0.1:${port}/api/remote-fleet/runtime-agent/ingress`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authorizationCredential}`,
        'content-type': 'application/json',
        'x-matchaclaw-runtime-agent-ingress-credential': enrollmentCredential,
      },
      body: JSON.stringify(requestPayload),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual(workerResponse.data);
    expect(body).not.toHaveProperty('success');
    expect(body).not.toHaveProperty('data');
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('ingestRuntimeAgentIngress', {
      rawRequest: requestPayload,
      authorizationCredential,
      enrollmentCredential,
    });
    expect(dispatchRuntimeRoute).not.toHaveBeenCalled();
    expect(transportStats.totalDispatchRequests).toBe(0);
  });

  it('returns the ingress typed 405 for a non-POST request without dispatching', async () => {
    const { dispatchRuntimeRoute, invoke, server, transportStats } = startRuntimeHostServer({
      status: 200,
      data: {},
    });
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/remote-fleet/runtime-agent/ingress`);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(405);
    expect(body).toEqual({
      type: 'runtime-agent.ingress.response',
      requestId: 'invalid-request',
      resultType: 'rejected',
      reason: 'invalid-request',
      message: 'RuntimeAgent ingress request is invalid.',
      receivedAt: '2026-07-11T00:00:00.000Z',
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(dispatchRuntimeRoute).not.toHaveBeenCalled();
    expect(transportStats.totalDispatchRequests).toBe(0);
  });
});
