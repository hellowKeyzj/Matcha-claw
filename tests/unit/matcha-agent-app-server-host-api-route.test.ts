import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleMatchaAgentAppServerRoutes } from '../../electron/api/routes/matcha-agent-app-server';
import { MATCHA_AGENT_RUNTIME_ENDPOINT } from '../../electron/main/runtime-host-delivery/transport/runtime-control';

function createRequest(method: string) {
  return Object.assign(Readable.from([]), { method, headers: {} });
}

function createResponse() {
  const response = { statusCode: 200, body: null as unknown };
  return {
    response,
    raw: {
      get statusCode() { return response.statusCode; },
      set statusCode(value: number) { response.statusCode = value; },
      setHeader: vi.fn(),
      end: (content?: string) => { response.body = content ? JSON.parse(content) : null; },
    },
  };
}

function lifecycleResponse(lifecycle: string) {
  return { status: 200 as const, body: { result: { lifecycle } } };
}

function statusResponse(lifecycle: string) {
  return {
    status: 200 as const,
    body: { result: { lifecycle } },
  };
}

function context(runtimeControlTransport: Record<string, unknown>, command = vi.fn()) {
  return {
    runtimeHost: { command },
    runtimeHostTransports: { runtimeControlTransport },
  } as never;
}

describe('Matcha Agent app server Host API routes', () => {
  it('projects the sealed lifecycle status without private process details', async () => {
    const lifecycleStatus = vi.fn().mockResolvedValue(statusResponse('running'));
    const command = vi.fn();
    const fixture = createResponse();

    await expect(handleMatchaAgentAppServerRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/matcha-agent/app-server/status'),
      context({ lifecycleStatus }, command),
    )).resolves.toBe(true);

    expect(lifecycleStatus).toHaveBeenCalledWith(MATCHA_AGENT_RUNTIME_ENDPOINT);
    expect(command).not.toHaveBeenCalledWith({ name: 'matcha.lifecycle.status' });
    expect(fixture.response.statusCode).toBe(200);
    expect(fixture.response.body).toMatchObject({
      processState: 'running',
      port: null,
      pid: null,
      ready: true,
      lastError: null,
    });
    expect(fixture.response.body).toHaveProperty('updatedAt', expect.any(Number));
  });

  it('rejects unexpected status control results without exposing native details', async () => {
    const lifecycleStatus = vi.fn().mockResolvedValue({
      status: 200,
      body: { result: { lifecycle: 'running', pid: 4321, path: 'E:/private/matcha' } },
    });
    const command = vi.fn();
    const fixture = createResponse();

    await handleMatchaAgentAppServerRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/matcha-agent/app-server/status'),
      context({ lifecycleStatus }, command),
    );

    expect(command).not.toHaveBeenCalledWith({ name: 'matcha.lifecycle.status' });
    expect(fixture.response.statusCode).toBe(503);
    expect(fixture.response.body).toEqual({
      success: false,
      error: 'Matcha Agent app server status is unavailable',
    });
    expect(JSON.stringify(fixture.response.body)).not.toContain('E:/private/matcha');
  });

  it('accepts a sealed restart result and does not invoke legacy lifecycle commands', async () => {
    const lifecycleRestart = vi.fn().mockResolvedValue(lifecycleResponse('starting'));
    const command = vi.fn();
    const fixture = createResponse();

    await handleMatchaAgentAppServerRoutes(
      createRequest('POST') as never,
      fixture.raw as never,
      new URL('http://localhost/api/matcha-agent/app-server/restart'),
      context({ lifecycleRestart }, command),
    );

    expect(lifecycleRestart).toHaveBeenCalledWith(MATCHA_AGENT_RUNTIME_ENDPOINT);
    expect(command).not.toHaveBeenCalledWith({ name: 'matcha.lifecycle.restart' });
    expect(command).not.toHaveBeenCalledWith({ name: 'matcha.lifecycle.start' });
    expect(fixture.response.statusCode).toBe(200);
    expect(fixture.response.body).toEqual({ success: true });
  });

  it('maps an unavailable restart response to unknown delivery', async () => {
    const lifecycleRestart = vi.fn().mockResolvedValue({
      status: 503,
      body: { success: false, error: 'Runtime control is unavailable' },
    });
    const command = vi.fn();
    const fixture = createResponse();

    await handleMatchaAgentAppServerRoutes(
      createRequest('POST') as never,
      fixture.raw as never,
      new URL('http://localhost/api/matcha-agent/app-server/restart'),
      context({ lifecycleRestart }, command),
    );

    expect(command).not.toHaveBeenCalledWith({ name: 'matcha.lifecycle.restart' });
    expect(fixture.response.statusCode).toBe(503);
    expect(fixture.response.body).toEqual({
      success: false,
      error: 'Matcha Agent app server restart outcome is unknown',
    });
  });

  it('reports runtime-control restart failures without claiming success', async () => {
    const lifecycleRestart = vi.fn().mockRejectedValue(new Error('transport failed'));
    const command = vi.fn();
    const fixture = createResponse();

    await handleMatchaAgentAppServerRoutes(
      createRequest('POST') as never,
      fixture.raw as never,
      new URL('http://localhost/api/matcha-agent/app-server/restart'),
      context({ lifecycleRestart }, command),
    );

    expect(command).not.toHaveBeenCalledWith({ name: 'matcha.lifecycle.restart' });
    expect(fixture.response.statusCode).toBe(500);
    expect(fixture.response.body).toEqual({
      success: false,
      error: 'Matcha Agent app server restart failed',
    });
  });

  it('does not claim other Matcha Agent app-server paths or methods', async () => {
    const command = vi.fn();
    const lifecycleStatus = vi.fn();
    const lifecycleRestart = vi.fn();
    const fixture = createResponse();

    await expect(handleMatchaAgentAppServerRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/matcha-agent/app-server/restart'),
      context({ lifecycleStatus, lifecycleRestart }, command),
    )).resolves.toBe(false);

    expect(command).not.toHaveBeenCalled();
    expect(lifecycleStatus).not.toHaveBeenCalled();
    expect(lifecycleRestart).not.toHaveBeenCalled();
  });
});
