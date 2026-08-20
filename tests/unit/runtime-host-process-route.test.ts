import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeHostControlError } from '../../electron/main/runtime-host-delivery/control';
import { handleRuntimeHostProcessRoutes } from '../../electron/api/routes/runtime-host-process';

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

function hostHealth() {
  return {
    state: {
      ok: true,
      lifecycle: 'ready',
      matcha: { lifecycle: 'failed' },
      openClaw: { lifecycle: 'failed' },
    },
    health: {
      ok: true,
      lifecycle: 'ready',
      matcha: { lifecycle: 'failed' },
      openClaw: { lifecycle: 'failed' },
    },
  };
}

describe('Runtime Host process routes', () => {
  it('projects Runtime Host status from host lifecycle, not peer failures', async () => {
    const command = vi.fn().mockResolvedValue({ kind: 'succeeded', result: hostHealth() });
    const fixture = createResponse();

    await expect(handleRuntimeHostProcessRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/runtime-host/status'),
      { runtimeHost: { command } } as never,
    )).resolves.toBe(true);

    expect(command).toHaveBeenCalledWith({ name: 'host.health' });
    expect(fixture.response.statusCode).toBe(200);
    expect(fixture.response.body).toMatchObject({
      status: 'running',
      hostLifecycle: 'ready',
      runtimeLifecycle: 'ready',
    });
  });

  it('does not project observation failure as confirmed shutdown', async () => {
    const command = vi.fn().mockRejectedValue(new Error('gateway probe timed out'));
    const fixture = createResponse();

    await expect(handleRuntimeHostProcessRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/runtime-host/status'),
      { runtimeHost: { command } } as never,
    )).resolves.toBe(true);

    expect(command).toHaveBeenCalledWith({ name: 'host.health' });
    expect(fixture.response.statusCode).toBe(503);
    expect(fixture.response.body).toEqual({
      status: 'error',
      hostLifecycle: 'ready',
      runtimeLifecycle: 'ready',
      updatedAt: expect.any(Number),
      error: 'Runtime Host status observation is unavailable.',
    });
  });

  it('restarts the lifecycle owner and preserves the public success envelope', async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    const fixture = createResponse();

    await expect(handleRuntimeHostProcessRoutes(
      createRequest('POST') as never,
      fixture.raw as never,
      new URL('http://localhost/api/runtime-host/restart'),
      { runtimeHost: { restart } } as never,
    )).resolves.toBe(true);

    expect(restart).toHaveBeenCalledOnce();
    expect(fixture.response.statusCode).toBe(200);
    expect(fixture.response.body).toEqual({ success: true });
  });

  it('maps unknown delivery without exposing private error details', async () => {
    const restart = vi.fn().mockRejectedValue(
      new RuntimeHostControlError('timeout-exceeded', 'unknown-delivery'),
    );
    const fixture = createResponse();

    await handleRuntimeHostProcessRoutes(
      createRequest('POST') as never,
      fixture.raw as never,
      new URL('http://localhost/api/runtime-host/restart'),
      { runtimeHost: { restart } } as never,
    );

    expect(fixture.response.statusCode).toBe(503);
    expect(fixture.response.body).toEqual({
      success: false,
      error: 'Runtime Host restart outcome is unknown',
    });
    expect(JSON.stringify(fixture.response.body)).not.toContain('timeout-exceeded');
  });

  it('does not claim other methods or paths', async () => {
    const restart = vi.fn();
    const fixture = createResponse();

    await expect(handleRuntimeHostProcessRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL('http://localhost/api/runtime-host/restart'),
      { runtimeHost: { restart } } as never,
    )).resolves.toBe(false);

    expect(restart).not.toHaveBeenCalled();
  });
});
