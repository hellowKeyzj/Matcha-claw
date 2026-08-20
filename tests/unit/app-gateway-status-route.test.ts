import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleAppRoutes,
  readGatewayStatusProjection,
  readRuntimeHostStatusProjection,
} from '../../electron/api/routes/app';
import { handleGatewayRoutes } from '../../electron/api/routes/gateway';
import { PORTS } from '../../electron/utils/config';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}));

function succeeded(result: unknown) {
  return { kind: 'succeeded' as const, result };
}

function hostHealth(overrides: {
  openClawLifecycle?: string;
} = {}) {
  return {
    state: {
      ok: true,
      lifecycle: 'ready',
      matcha: { lifecycle: 'idle' },
      openClaw: { lifecycle: overrides.openClawLifecycle ?? 'running' },
    },
    health: {
      ok: true,
      lifecycle: 'ready',
      matcha: { lifecycle: 'idle' },
      openClaw: { lifecycle: overrides.openClawLifecycle ?? 'running' },
    },
  };
}

function runtimeSnapshot(overrides: {
  openClawLifecycle?: string;
  gateway?: unknown;
  control?: unknown;
  extra?: Record<string, unknown>;
  heartbeatEnabled?: boolean | null;
} = {}) {
  return {
    ...hostHealth(overrides),
    gateway: overrides.gateway ?? {
      availability: 'available',
      ok: true,
      timestampMs: 1_725_000_000_000,
      durationMs: 12,
      channelCount: 2,
      agentCount: 3,
      sessionCount: 4,
      heartbeatEnabled: true,
    },
    control: overrides.control ?? {
      ready: true,
      phase: 'ready',
      retryable: false,
    },
    observedAtMs: 1_725_000_000_100,
    ...overrides.extra,
  };
}

function request(method: string): IncomingMessage {
  return { method, headers: {} } as IncomingMessage;
}

function sseResponse() {
  const writes: string[] = [];
  const raw = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
  };
  return { raw: raw as unknown as ServerResponse, writes };
}

function jsonResponse() {
  const response = { statusCode: 200, body: null as unknown };
  return {
    response,
    raw: {
      get statusCode() { return response.statusCode; },
      set statusCode(value: number) { response.statusCode = value; },
      setHeader: vi.fn(),
      end: (content?: string) => {
        response.body = content ? JSON.parse(content) : null;
      },
    } as unknown as ServerResponse,
  };
}

function expectRuntimeSnapshotOnly(command: ReturnType<typeof vi.fn>) {
  expect(command.mock.calls).toEqual([[{ name: 'host.runtime.snapshot' }]]);
  expect(command).not.toHaveBeenCalledWith({ name: 'openclaw.control-ready' });
  expect(command).not.toHaveBeenCalledWith({ name: 'openclaw.gateway.health' });
  expect(command).not.toHaveBeenCalledWith({ name: 'openclaw.gateway.status' });
}

describe('app gateway status delivery', () => {
  it('uses one runtime snapshot command and preserves the public status DTO', async () => {
    const command = vi.fn().mockResolvedValue(succeeded(runtimeSnapshot()));

    await expect(readGatewayStatusProjection({ command } as never)).resolves.toEqual({
      processState: 'running',
      port: PORTS.OPENCLAW_GATEWAY,
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
      lastAliveAt: 1_725_000_000_000,
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      },
      updatedAt: 1_725_000_000_100,
    });
    expectRuntimeSnapshotOnly(command);
  });

  it('accepts null heartbeatEnabled while keeping gateway available', async () => {
    const command = vi.fn().mockResolvedValue(succeeded(runtimeSnapshot({
      heartbeatEnabled: null,
    })));

    await expect(readGatewayStatusProjection({ command } as never)).resolves.toEqual({
      processState: 'running',
      port: PORTS.OPENCLAW_GATEWAY,
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
      lastAliveAt: 1_725_000_000_000,
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      },
      updatedAt: 1_725_000_000_100,
    });
    expectRuntimeSnapshotOnly(command);
  });

  it('projects Runtime Host status from host snapshot only', async () => {
    const command = vi.fn().mockResolvedValue(succeeded(hostHealth({
      openClawLifecycle: 'failed',
    })));

    await expect(readRuntimeHostStatusProjection({ command } as never)).resolves.toMatchObject({
      status: 'running',
      hostLifecycle: 'ready',
      runtimeLifecycle: 'ready',
    });
    expect(command).toHaveBeenCalledWith({ name: 'host.health' });
  });

  it('maps control readiness and unavailable gateway states without inventing telemetry', async () => {
    const degradedCommand = vi.fn().mockResolvedValue(succeeded(runtimeSnapshot({
      gateway: {
        availability: 'available',
        ok: false,
        timestampMs: 20,
        durationMs: 0,
        channelCount: 0,
        agentCount: 0,
        sessionCount: 0,
        heartbeatEnabled: false,
      },
      control: { ready: false, phase: 'starting', retryable: true },
    })));
    const unavailableCommand = vi.fn().mockResolvedValue(succeeded(runtimeSnapshot({
      openClawLifecycle: 'failed',
      gateway: { availability: 'unavailable' },
      control: { ready: false, phase: 'unavailable', retryable: false },
    })));

    await expect(readGatewayStatusProjection({ command: degradedCommand } as never)).resolves.toEqual({
      processState: 'control_connecting',
      port: PORTS.OPENCLAW_GATEWAY,
      gatewayReady: false,
      healthSummary: 'degraded',
      transportState: 'reconnecting',
      portReachable: true,
      lastAliveAt: 20,
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      },
      updatedAt: 1_725_000_000_100,
    });
    await expect(readGatewayStatusProjection({ command: unavailableCommand } as never)).resolves.toEqual({
      processState: 'error',
      port: PORTS.OPENCLAW_GATEWAY,
      gatewayReady: false,
      healthSummary: 'unresponsive',
      transportState: 'disconnected',
      portReachable: false,
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      },
      updatedAt: 1_725_000_000_100,
    });
    const unavailable = await readGatewayStatusProjection({ command: unavailableCommand } as never);
    expect(unavailable).not.toHaveProperty('lastRpcSuccessAt');
    expect(unavailable).not.toHaveProperty('lastRpcFailureAt');
    expect(unavailable).not.toHaveProperty('lastRpcFailureMethod');
    expectRuntimeSnapshotOnly(degradedCommand);
    expect(unavailableCommand.mock.calls).toEqual([
      [{ name: 'host.runtime.snapshot' }],
      [{ name: 'host.runtime.snapshot' }],
    ]);
    expect(unavailableCommand).not.toHaveBeenCalledWith({ name: 'openclaw.control-ready' });
    expect(unavailableCommand).not.toHaveBeenCalledWith({ name: 'openclaw.gateway.health' });
    expect(unavailableCommand).not.toHaveBeenCalledWith({ name: 'openclaw.gateway.status' });
  });

  it('keeps the last known gateway status when a later observation fails', async () => {
    const firstCommand = vi.fn().mockResolvedValue(succeeded(runtimeSnapshot()));
    const failedCommand = vi.fn().mockRejectedValue(new Error('gateway observation timed out'));

    const first = await readGatewayStatusProjection({ command: firstCommand } as never);
    await expect(readGatewayStatusProjection({ command: failedCommand } as never)).resolves.toEqual(first);
    expectRuntimeSnapshotOnly(firstCommand);
    expectRuntimeSnapshotOnly(failedCommand);
  });

  it('keeps the last known gateway status when a later observation times out', async () => {
    const firstCommand = vi.fn().mockResolvedValue(succeeded(runtimeSnapshot()));
    const timedOutCommand = vi.fn().mockResolvedValue({ kind: 'timed-out' });

    const first = await readGatewayStatusProjection({ command: firstCommand } as never);
    await expect(readGatewayStatusProjection({ command: timedOutCommand } as never)).resolves.toEqual(first);
    expectRuntimeSnapshotOnly(firstCommand);
    expectRuntimeSnapshotOnly(timedOutCommand);
  });

  it('fails closed for unexpected or private snapshot fields', async () => {
    const command = vi.fn().mockResolvedValue(succeeded(runtimeSnapshot({
      extra: { path: 'E:/private/runtime-host', token: 'private-token' },
    })));

    await expect(readGatewayStatusProjection({ command } as never)).resolves.toBeNull();
    expectRuntimeSnapshotOnly(command);
  });

  it('serves /api/gateway/status from host.runtime.snapshot only', async () => {
    const command = vi.fn().mockResolvedValue(succeeded(runtimeSnapshot({
      gateway: {
        availability: 'available',
        ok: false,
        timestampMs: 1_725_000_000_050,
        durationMs: 7,
        channelCount: 1,
        agentCount: 2,
        sessionCount: 3,
        heartbeatEnabled: true,
      },
      control: { ready: false, phase: 'starting', retryable: true },
    })));
    const fixture = jsonResponse();

    await expect(handleGatewayRoutes(
      request('GET'),
      fixture.raw,
      new URL('http://127.0.0.1/api/gateway/status'),
      { runtimeHost: { command } } as never,
    )).resolves.toBe(true);

    expect(fixture.response.statusCode).toBe(200);
    expect(fixture.response.body).toEqual({
      processState: 'control_connecting',
      port: PORTS.OPENCLAW_GATEWAY,
      gatewayReady: false,
      healthSummary: 'degraded',
      transportState: 'reconnecting',
      portReachable: true,
      lastAliveAt: 1_725_000_000_050,
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      },
      updatedAt: 1_725_000_000_100,
    });
    expectRuntimeSnapshotOnly(command);
  });

  it('keeps the SSE headers and gateway:status event contract', async () => {
    const command = vi.fn(() => Promise.resolve(succeeded(runtimeSnapshot())));
    const eventBus = { addSseClient: vi.fn() };
    const response = sseResponse();

    await expect(handleAppRoutes(
      request('GET'),
      response.raw,
      new URL('http://127.0.0.1/api/events'),
      { eventBus, runtimeHost: { command } } as never,
    )).resolves.toBe(true);

    expect(response.raw.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    expect(response.writes[0]).toBe(': connected\n\n');
    expect(response.writes[1]).toContain('event: gateway:status\n');
    expect(response.writes[1]).toContain('"processState":"running"');
    expect(response.writes[2]).toContain('event: runtime-host:status\n');
    expect(response.writes[2]).toContain('"status":"running"');
    expect(eventBus.addSseClient).toHaveBeenCalledWith(response.raw);
    expectRuntimeSnapshotOnly(command);
  });

  it('falls back to host health for SSE runtime-host status when snapshot observation fails', async () => {
    const seedCommand = vi.fn().mockResolvedValue(succeeded(runtimeSnapshot()));
    await readGatewayStatusProjection({ command: seedCommand } as never);
    const command = vi.fn((command: { name: string }) => command.name === 'host.health'
      ? Promise.resolve(succeeded(hostHealth()))
      : Promise.reject(new Error('gateway observation timed out')));
    const eventBus = { addSseClient: vi.fn() };
    const response = sseResponse();

    await expect(handleAppRoutes(
      request('GET'),
      response.raw,
      new URL('http://127.0.0.1/api/events'),
      { eventBus, runtimeHost: { command } } as never,
    )).resolves.toBe(true);

    expect(response.writes[1]).toContain('event: gateway:status\n');
    expect(response.writes[1]).toContain('"processState":"running"');
    expect(response.writes[2]).toContain('event: runtime-host:status\n');
    expect(response.writes[2]).toContain('"status":"running"');
    expect(command).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenCalledWith({ name: 'host.runtime.snapshot' });
    expect(command).toHaveBeenCalledWith({ name: 'host.health' });
  });
});
