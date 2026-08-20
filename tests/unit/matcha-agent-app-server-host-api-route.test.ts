import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeHostControlError } from '../../electron/main/runtime-host-delivery/control';
import { handleMatchaAgentAppServerRoutes } from '../../electron/api/routes/matcha-agent-app-server';

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

function lifecycleOutcome(lifecycle: string) {
  return { kind: 'succeeded' as const, result: { result: { lifecycle } } };
}

function statusOutcome(lifecycle: string, ready: boolean) {
  return {
    kind: 'succeeded' as const,
    result: { result: { lifecycle, ready, observedAtMs: 1_725_000_000_000 } },
  };
}

describe('Matcha Agent app server Host API routes', () => {
  it('projects the sealed lifecycle status without private process details', async () => {
    const command = vi.fn().mockResolvedValue(statusOutcome('running', true));
    const fixture = createResponse();

    await expect(handleMatchaAgentAppServerRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/matcha-agent/app-server/status'),
      { runtimeHost: { command } } as never,
    )).resolves.toBe(true);

    expect(command).toHaveBeenCalledWith({ name: 'matcha.lifecycle.status' });
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
    const command = vi.fn().mockResolvedValue({
      kind: 'succeeded',
      result: { result: { lifecycle: 'running', pid: 4321, path: 'E:/private/matcha' } },
    });
    const fixture = createResponse();

    await handleMatchaAgentAppServerRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/matcha-agent/app-server/status'),
      { runtimeHost: { command } } as never,
    );

    expect(fixture.response.statusCode).toBe(503);
    expect(fixture.response.body).toEqual({
      success: false,
      error: 'Matcha Agent app server status is unavailable',
    });
    expect(JSON.stringify(fixture.response.body)).not.toContain('E:/private/matcha');
  });

  it('accepts a sealed restart result and does not invoke legacy lifecycle commands', async () => {
    const command = vi.fn().mockResolvedValue(lifecycleOutcome('starting'));
    const fixture = createResponse();

    await handleMatchaAgentAppServerRoutes(
      createRequest('POST') as never,
      fixture.raw as never,
      new URL('http://localhost/api/matcha-agent/app-server/restart'),
      { runtimeHost: { command } } as never,
    );

    expect(command).toHaveBeenCalledWith({ name: 'matcha.lifecycle.restart' });
    expect(command).not.toHaveBeenCalledWith({ name: 'matcha.lifecycle.start' });
    expect(fixture.response.statusCode).toBe(200);
    expect(fixture.response.body).toEqual({ success: true });
  });

  it('maps a timed-out restart result to unknown delivery', async () => {
    const command = vi.fn().mockResolvedValue({ kind: 'timed-out' });
    const fixture = createResponse();

    await handleMatchaAgentAppServerRoutes(
      createRequest('POST') as never,
      fixture.raw as never,
      new URL('http://localhost/api/matcha-agent/app-server/restart'),
      { runtimeHost: { command } } as never,
    );

    expect(fixture.response.statusCode).toBe(503);
    expect(fixture.response.body).toEqual({
      success: false,
      error: 'Matcha Agent app server restart outcome is unknown',
    });
  });

  it('reports uncertain restart delivery without claiming success', async () => {
    const command = vi.fn().mockRejectedValue(
      new RuntimeHostControlError('timeout-exceeded', 'unknown-delivery'),
    );
    const fixture = createResponse();

    await handleMatchaAgentAppServerRoutes(
      createRequest('POST') as never,
      fixture.raw as never,
      new URL('http://localhost/api/matcha-agent/app-server/restart'),
      { runtimeHost: { command } } as never,
    );

    expect(fixture.response.statusCode).toBe(503);
    expect(fixture.response.body).toEqual({
      success: false,
      error: 'Matcha Agent app server restart outcome is unknown',
    });
  });

  it('does not claim other Matcha Agent app-server paths or methods', async () => {
    const command = vi.fn();
    const fixture = createResponse();

    await expect(handleMatchaAgentAppServerRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/matcha-agent/app-server/restart'),
      { runtimeHost: { command } } as never,
    )).resolves.toBe(false);

    expect(command).not.toHaveBeenCalled();
  });
});
