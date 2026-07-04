import { describe, expect, it, vi } from 'vitest';
import { runMatchaRuntimeCommand } from '../../runtime-host/application/runtime-cli/matcha-runtime-command';

const TEAM_RUN_SCOPE = JSON.stringify({
  kind: 'team-run',
  endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
  runId: 'run-1',
});
const TEAM_RUN_TARGET = JSON.stringify({ kind: 'team-run', runId: 'run-1' });
const TEAM_INPUT = JSON.stringify({ summary: 'done' });

function createOutput() {
  return { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };
}

describe('matcha runtime command', () => {
  it('displays help', async () => {
    const stdout = createOutput();
    const stderr = createOutput();

    const result = await runMatchaRuntimeCommand(['runtime', '--help'], { stdout, stderr });

    expect(result.exitCode).toBe(0);
    expect(stdout.chunks.join('')).toContain('matcha runtime invoke --id <capability>');
    expect(stderr.chunks).toEqual([]);
  });

  it('rejects missing required arguments', async () => {
    const stdout = createOutput();
    const stderr = createOutput();

    const result = await runMatchaRuntimeCommand(['runtime', 'invoke', '--operation', 'team.nodeEvent'], { stdout, stderr });

    expect(result.exitCode).toBe(2);
    expect(stderr.chunks.join('')).toContain('Missing required runtime invoke argument "--id <capability>"');
    expect(stdout.chunks).toEqual([]);
  });

  it('calls runtime-host capability dispatch', async () => {
    const stdout = createOutput();
    const stderr = createOutput();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { success: true, accepted: true } }),
    }));

    const result = await runMatchaRuntimeCommand([
      'runtime', 'invoke',
      '--id', 'team.runtime',
      '--scope', TEAM_RUN_SCOPE,
      '--operation', 'team.nodeEvent',
      '--target', TEAM_RUN_TARGET,
      '--input', TEAM_INPUT,
      '--runtime-host-url', 'http://127.0.0.1:3211/',
    ], { stdout, stderr, fetchImpl: fetchMock as never });

    expect(result.exitCode).toBe(0);
    expect(stderr.chunks).toEqual([]);
    expect(JSON.parse(stdout.chunks.join(''))).toEqual({ success: true, accepted: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('http://127.0.0.1:3211/dispatch');
    expect(JSON.parse(init.body)).toMatchObject({
      method: 'POST',
      route: '/api/capabilities/execute',
      payload: {
        id: 'team.runtime',
        operationId: 'team.nodeEvent',
        scope: JSON.parse(TEAM_RUN_SCOPE),
        target: JSON.parse(TEAM_RUN_TARGET),
        input: JSON.parse(TEAM_INPUT),
      },
    });
  });

  it('emits JSON envelopes in --json mode', async () => {
    const stdout = createOutput();
    const stderr = createOutput();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { success: true, accepted: true } }),
    }));

    const result = await runMatchaRuntimeCommand([
      'runtime', 'invoke',
      '--id', 'team.runtime',
      '--scope', TEAM_RUN_SCOPE,
      '--operation', 'team.nodeEvent',
      '--target', TEAM_RUN_TARGET,
      '--input', TEAM_INPUT,
      '--json',
    ], { stdout, stderr, fetchImpl: fetchMock as never });

    expect(result.exitCode).toBe(0);
    expect(stderr.chunks).toEqual([]);
    expect(JSON.parse(stdout.chunks.join(''))).toEqual({ success: true, data: { success: true, accepted: true } });
  });

  it('returns structured JSON errors in --json mode', async () => {
    const stdout = createOutput();
    const stderr = createOutput();
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ success: false, error: { code: 'NOT_FOUND', message: 'missing route' } }),
    }));

    const result = await runMatchaRuntimeCommand([
      'runtime', 'invoke',
      '--id', 'team.runtime',
      '--scope', TEAM_RUN_SCOPE,
      '--operation', 'team.nodeEvent',
      '--target', TEAM_RUN_TARGET,
      '--input', TEAM_INPUT,
      '--json',
    ], { stdout, stderr, fetchImpl: fetchMock as never });

    expect(result.exitCode).toBe(1);
    expect(stderr.chunks).toEqual([]);
    expect(JSON.parse(stdout.chunks.join(''))).toEqual({
      success: false,
      error: {
        kind: 'dispatchFailure',
        message: 'missing route',
        status: 404,
        code: 'NOT_FOUND',
      },
    });
  });
});
