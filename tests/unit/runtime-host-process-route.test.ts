import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
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

  it('admits a restart through the lifecycle owner without claiming success', async () => {
    const admission = { accepted: true, restartId: '11111111-1111-4111-8111-111111111111' };
    const restart = vi.fn().mockReturnValue(admission);
    const fixture = createResponse();

    await expect(handleRuntimeHostProcessRoutes(
      createRequest('POST') as never,
      fixture.raw as never,
      new URL('http://localhost/api/runtime-host/restart'),
      { runtimeHost: { admitRestart: restart } } as never,
    )).resolves.toBe(true);

    expect(restart).toHaveBeenCalledOnce();
    expect(fixture.response.statusCode).toBe(202);
    expect(fixture.response.body).toEqual(admission);
  });

  it('observes unknown delivery without claiming restart success', async () => {
    const restartId = '11111111-1111-4111-8111-111111111111';
    const result = { restartId, status: 'unknown', error: 'Runtime Host restart outcome is unknown' };
    const readRestart = vi.fn().mockReturnValue(result);
    const fixture = createResponse();

    await handleRuntimeHostProcessRoutes(
      createRequest('GET') as never,
      fixture.raw as never,
      new URL(`http://localhost/api/runtime-host/restart?restartId=${restartId}`),
      { runtimeHost: { readRestart } } as never,
    );

    expect(readRestart).toHaveBeenCalledWith(restartId);
    expect(fixture.response.statusCode).toBe(200);
    expect(fixture.response.body).toEqual(result);
    expect(JSON.stringify(fixture.response.body)).not.toContain('timeout-exceeded');
  });

  it('does not claim other methods or paths', async () => {
    const restart = vi.fn();
    const fixture = createResponse();

    await expect(handleRuntimeHostProcessRoutes(
      createRequest('PUT') as never,
      fixture.raw as never,
      new URL('http://localhost/api/runtime-host/restart'),
      { runtimeHost: { restart } } as never,
    )).resolves.toBe(false);

    expect(restart).not.toHaveBeenCalled();
  });
});
