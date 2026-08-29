import { describe, expect, it, vi } from 'vitest';
import { RendererEventRouteRegistry } from '../../electron/main/renderer-event-routes';

import type {
  DirectRuntimeHostExit,
} from '../../electron/main/runtime-host-delivery/direct-host';
import {
  type RuntimeHostControlCommand,
  type RuntimeHostControlOutcome,
  type RuntimeHostSafeEvent,
} from '../../electron/main/runtime-host-delivery/control';

function succeeded(result: Record<string, unknown>): RuntimeHostControlOutcome {
  return { kind: 'succeeded', result };
}

function createEventBus() {
  const listeners = new Map<string, (payload: unknown) => void>();
  return {
    emit: vi.fn((eventName: string, payload: unknown) => {
      listeners.get(eventName)?.(payload);
    }),
    on: vi.fn((eventName: string, listener: (payload: unknown) => void) => {
      listeners.set(eventName, listener);
      return () => listeners.delete(eventName);
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createSessionDelta(overrides: Record<string, unknown> = {}) {
  return {
    sessionKey: 'session-1',
    routeKey: 'renderer-route:bound',
    epoch: 1,
    seq: 1,
    cursor: 1,
    changes: [{ kind: 'runtimeChanged', runtime: {
      phase: 'started', activeRunId: null, issue: null,
    } }],
    ...overrides,
  };
}

async function flushBridge(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function createRuntimeHost(input: {
  readonly snapshot?: RuntimeHostControlOutcome;
  readonly snapshots?: Array<RuntimeHostControlOutcome | Promise<RuntimeHostControlOutcome>>;
  readonly commandError?: Error;
}) {
  const snapshots = [...(input.snapshots ?? [])];
  let safeEventHandler: ((event: RuntimeHostSafeEvent) => void) | null = null;
  let exitHandler: ((exit: DirectRuntimeHostExit) => void) | null = null;
  let restartHandler: ((restart: { status: 'running'; recoveredAt: number }) => void) | null = null;
  const command = vi.fn(async (request: RuntimeHostControlCommand) => {
    if (input.commandError) throw input.commandError;
    const health = {
      state: {
        ok: true,
        lifecycle: 'ready',
        matcha: { lifecycle: 'idle' },
        openClaw: { lifecycle: 'running' },
      },
      health: {
        ok: true,
        lifecycle: 'ready',
        matcha: { lifecycle: 'idle' },
        openClaw: { lifecycle: 'running' },
      },
    };
    if (request.name === 'host.health') {
      return succeeded(health);
    }
    if (request.name === 'host.runtime.snapshot') {
      if (snapshots.length) {
        const nextSnapshot = snapshots.shift();
        if (nextSnapshot) return nextSnapshot;
      }
      return input.snapshot ?? succeeded({
        ...health,
        gateway: {
          availability: 'available',
          ok: true,
          timestampMs: 1_725_000_000_000,
          durationMs: 12,
          channelCount: 0,
          agentCount: 0,
          sessionCount: 0,
          heartbeatEnabled: true,
        },
        control: { ready: true, phase: 'ready', retryable: false },
        observedAtMs: 1_725_000_000_100,
      });
    }
    throw new Error('unexpected command');
  });

  return {
    command,
    onSafeEvent: vi.fn((handler: (event: RuntimeHostSafeEvent) => void) => {
      safeEventHandler = handler;
      return () => {
        safeEventHandler = null;
      };
    }),
    onExit: vi.fn((handler: (exit: DirectRuntimeHostExit) => void) => {
      exitHandler = handler;
      return () => {
        exitHandler = null;
      };
    }),
    onRestart: vi.fn((handler: (restart: { status: 'running'; recoveredAt: number }) => void) => {
      restartHandler = handler;
      return () => {
        restartHandler = null;
      };
    }),
    emitSafeEvent(event: RuntimeHostSafeEvent) {
      safeEventHandler?.(event);
    },
    emitExit(exit: DirectRuntimeHostExit) {
      exitHandler?.(exit);
    },
    emitRestart(restart: { status: 'running'; recoveredAt: number }) {
      restartHandler?.(restart);
    },
  };
}

describe('host event bridge', () => {
  it('只投影 Rust health、lifecycle 与 safe activity 标记', async () => {
    const runtimeHost = createRuntimeHost({});
    const eventBus = createEventBus();
    const send = vi.fn();
    const { registerHostEventBridge } = await import('../../electron/main/host-event-bridge');

    registerHostEventBridge({
      runtimeHost,
      hostEventBus: eventBus as never,
      getMainWindow: () => ({ webContents: { send } }) as never,
      rendererEventRoutes: { isMatchaRoute: () => false, release: vi.fn() } as never,
    });
    await flushBridge();

    expect(runtimeHost.command).toHaveBeenCalledWith({ name: 'host.health' });
    expect(eventBus.emit).toHaveBeenCalledWith('runtime-host:status', {
      status: 'running',
      hostLifecycle: 'ready',
      runtimeLifecycle: 'ready',
      updatedAt: expect.any(Number),
    });

    const gatewayStatusEmitsBeforeLifecycle = eventBus.emit.mock.calls
      .filter(([eventName]) => eventName === 'gateway:status')
      .length;
    runtimeHost.emitSafeEvent({
      type: 'openclaw.lifecycle',
      sequence: 7,
      hasRun: false,
      hasMessage: true,
      hasSessionActivity: false,
    });
    await flushBridge();

    expect(eventBus.emit).toHaveBeenCalledWith('openclaw:lifecycle', { active: true });
    expect(eventBus.emit.mock.calls
      .filter(([eventName]) => eventName === 'gateway:status')
      .length).toBeGreaterThan(gatewayStatusEmitsBeforeLifecycle);
    const payloads = eventBus.emit.mock.calls.map(([, payload]) => JSON.stringify(payload));
    for (const privateValue of [
      'endpoint',
      'token',
      'path',
      'pid',
      'sequence',
      'sessionId',
      'messageId',
      'runId',
      'rawPayload',
    ]) {
      expect(payloads.join('\n')).not.toContain(privateValue);
    }
    expect(send).toHaveBeenCalledWith('host:event', {
      eventName: 'openclaw:lifecycle',
      payload: { active: true },
    });
  });

  it('bridges Matcha lifecycle as independent app-server status without refreshing OpenClaw gateway', async () => {
    const runtimeHost = createRuntimeHost({});
    const eventBus = createEventBus();
    const send = vi.fn();
    const { registerHostEventBridge } = await import('../../electron/main/host-event-bridge');

    registerHostEventBridge({
      runtimeHost,
      hostEventBus: eventBus as never,
      getMainWindow: () => ({ webContents: { send } }) as never,
      rendererEventRoutes: { isMatchaRoute: () => false, release: vi.fn() } as never,
    });
    await flushBridge();
    eventBus.emit.mockClear();
    send.mockClear();

    runtimeHost.emitSafeEvent({
      type: 'matcha.lifecycle',
      lifecycle: 'running',
      ready: true,
      observedAtMs: 1_725_000_000_000,
    });
    await flushBridge();

    expect(eventBus.emit).toHaveBeenCalledWith('matcha-agent:status', {
      processState: 'running',
      port: null,
      pid: null,
      ready: true,
      lastError: null,
      updatedAt: 1_725_000_000_000,
    });
    expect(eventBus.emit.mock.calls.some(([eventName]) => eventName === 'gateway:status')).toBe(false);
    expect(send).toHaveBeenCalledWith('host:event', {
      eventName: 'matcha-agent:status',
      payload: {
        processState: 'running',
        port: null,
        pid: null,
        ready: true,
        lastError: null,
        updatedAt: 1_725_000_000_000,
      },
    });
  });

  it('将 parent callback team:event 原样投影为 Renderer 事件', async () => {
    const runtimeHost = createRuntimeHost({});
    const eventBus = createEventBus();
    const send = vi.fn();
    const { registerHostEventBridge } = await import('../../electron/main/host-event-bridge');

    registerHostEventBridge({
      runtimeHost,
      hostEventBus: eventBus as never,
      getMainWindow: () => ({ webContents: { send } }) as never,
      rendererEventRoutes: { isMatchaRoute: () => false, release: vi.fn() } as never,
    });

    const payload = {
      teamId: 'team-1',
      runId: 'run-1',
      event: {
        eventId: 'team-event-1',
        runId: 'run-1',
        sequence: 1,
        eventType: 'node_progressed',
        createdAt: 1_725_000_000_000,
        nodeExecutionId: 'node-exec-1',
      },
    };
    eventBus.emit('team:event', payload);

    expect(send).toHaveBeenCalledWith('host:event', {
      eventName: 'team:event',
      payload,
    });
  });

  it('将 Cron 终态安全投影为最小 Renderer 事件', async () => {
    const runtimeHost = createRuntimeHost({});
    const eventBus = createEventBus();
    const send = vi.fn();
    const { registerHostEventBridge } = await import('../../electron/main/host-event-bridge');

    registerHostEventBridge({
      runtimeHost,
      hostEventBus: eventBus as never,
      getMainWindow: () => ({ webContents: { send } }) as never,
      rendererEventRoutes: { isMatchaRoute: () => false, release: vi.fn() } as never,
    });
    runtimeHost.emitSafeEvent({
      type: 'openclaw.cron.execution',
      jobId: 'cron-job-1',
      runId: 'cron-run-1',
      status: 'failed',
    });

    expect(eventBus.emit).toHaveBeenCalledWith('openclaw:cron', {
      jobId: 'cron-job-1',
      runId: 'cron-run-1',
      status: 'failed',
    });
    expect(send).toHaveBeenCalledWith('host:event', {
      eventName: 'openclaw:cron',
      payload: { jobId: 'cron-job-1', runId: 'cron-run-1', status: 'failed' },
    });
    const serialized = JSON.stringify(eventBus.emit.mock.calls);
    for (const privateValue of ['payload', 'socket', 'sessionKey', 'token', 'workingDirectory', 'error']) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('在 Rust child replacement 后投影已恢复的 runtime-host restart 事件', async () => {
    const runtimeHost = createRuntimeHost({});
    const eventBus = createEventBus();
    const { registerHostEventBridge } = await import('../../electron/main/host-event-bridge');

    registerHostEventBridge({
      runtimeHost,
      hostEventBus: eventBus as never,
      getMainWindow: () => null,
      rendererEventRoutes: { isMatchaRoute: () => false, release: vi.fn() } as never,
    });
    runtimeHost.emitRestart({ status: 'running', recoveredAt: 123 });
    await flushBridge();

    expect(eventBus.emit).toHaveBeenCalledWith('runtime-host:restart', {
      status: 'running',
      recoveredAt: 123,
    });
  });

  it('在 Rust 报告 OpenClaw runtime 状态变迁时刷新 fresh gateway status 投影', async () => {
    const pending = deferred<RuntimeHostControlOutcome>();
    const runtimeHost = createRuntimeHost({
      snapshots: [pending.promise, succeeded({
        state: {
          ok: true,
          lifecycle: 'ready',
          matcha: { lifecycle: 'idle' },
          openClaw: { lifecycle: 'running' },
        },
        health: {
          ok: true,
          lifecycle: 'ready',
          matcha: { lifecycle: 'idle' },
          openClaw: { lifecycle: 'running' },
        },
        gateway: {
          availability: 'available',
          ok: true,
          timestampMs: 1_725_000_000_200,
          durationMs: 11,
          channelCount: 0,
          agentCount: 0,
          sessionCount: 0,
          heartbeatEnabled: true,
        },
        control: { ready: true, phase: 'ready', retryable: false },
        observedAtMs: 1_725_000_000_200,
      })],
    });
    const eventBus = createEventBus();
    const { registerHostEventBridge } = await import('../../electron/main/host-event-bridge');

    registerHostEventBridge({
      runtimeHost,
      hostEventBus: eventBus as never,
      getMainWindow: () => null,
      rendererEventRoutes: { isMatchaRoute: () => false, release: vi.fn() } as never,
    });
    await flushBridge();

    runtimeHost.emitSafeEvent({ type: 'openclaw.runtime' });
    await flushBridge();
    pending.resolve(succeeded({
      state: {
        ok: true,
        lifecycle: 'ready',
        matcha: { lifecycle: 'idle' },
        openClaw: { lifecycle: 'running' },
      },
      health: {
        ok: true,
        lifecycle: 'ready',
        matcha: { lifecycle: 'idle' },
        openClaw: { lifecycle: 'running' },
      },
      gateway: {
        availability: 'available',
        ok: false,
        timestampMs: 1_725_000_000_100,
        durationMs: 15,
        channelCount: 0,
        agentCount: 0,
        sessionCount: 0,
        heartbeatEnabled: true,
      },
      control: { ready: false, phase: 'starting', retryable: true },
      observedAtMs: 1_725_000_000_100,
    }));
    await flushBridge();

    expect(runtimeHost.command).toHaveBeenCalledTimes(4);
    expect(eventBus.emit.mock.calls.some(([eventName, payload]) => eventName === 'gateway:status'
      && payload && typeof payload === 'object'
      && (payload as Record<string, unknown>).processState === 'running'
      && (payload as Record<string, unknown>).gatewayReady === true
      && (payload as Record<string, unknown>).transportState === 'connected')).toBe(true);
    expect(JSON.stringify(eventBus.emit.mock.calls)).not.toContain('openclaw.runtime');
  });

  it('只通过现有 route binding 投影唯一 session.delta wire，并保留原始 delta 形状', async () => {
    const runtimeHost = createRuntimeHost({});
    const eventBus = createEventBus();
    const send = vi.fn();
    const routes = new RendererEventRouteRegistry();
    const routeKey = routes.issue({
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'matcha-agent',
        runtimeInstanceId: 'local',
      },
      agentId: 'agent-1',
      sessionKey: 'session-1',
    });
    const { registerHostEventBridge } = await import('../../electron/main/host-event-bridge');

    registerHostEventBridge({
      runtimeHost,
      hostEventBus: eventBus as never,
      getMainWindow: () => ({ webContents: { send } }) as never,
      rendererEventRoutes: routes,
    });
    const delta = createSessionDelta({ routeKey });
    runtimeHost.emitSafeEvent({ type: 'session.delta', delta });

    expect(eventBus.emit).toHaveBeenCalledWith('session.delta', delta);
    expect(send).toHaveBeenCalledWith('host:event', {
      eventName: 'session.delta',
      payload: delta,
    });
    expect(delta).not.toHaveProperty('endpoint');
    expect(delta).not.toHaveProperty('agentId');
  });

  it('将旧 session:update 里可解码的 delta 投影到唯一 session.delta 路径', async () => {
    const runtimeHost = createRuntimeHost({});
    const eventBus = createEventBus();
    const send = vi.fn();
    const routes = new RendererEventRouteRegistry();
    const routeKey = routes.issue({
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'matcha-agent',
        runtimeInstanceId: 'local',
      },
      agentId: 'agent-1',
      sessionKey: 'session-1',
    });
    const { registerHostEventBridge } = await import('../../electron/main/host-event-bridge');

    registerHostEventBridge({
      runtimeHost,
      hostEventBus: eventBus as never,
      getMainWindow: () => ({ webContents: { send } }) as never,
      rendererEventRoutes: routes,
    });
    const delta = createSessionDelta({ routeKey });

    eventBus.emit('session:update', { kind: 'delta', delta });
    eventBus.emit('session:update', { sessionUpdate: 'session_info_update', sessionKey: 'session-1', snapshot: { private: true } });

    expect(eventBus.emit).toHaveBeenCalledWith('session.delta', delta);
    expect(send).toHaveBeenCalledWith('host:event', {
      eventName: 'session.delta',
      payload: delta,
    });
    expect(send).not.toHaveBeenCalledWith('host:event', expect.objectContaining({
      eventName: 'session:update',
    }));
  });

  it('对严格 decode 失败、未绑定、已释放和 stale session.delta fail closed', async () => {
    const runtimeHost = createRuntimeHost({});
    const eventBus = createEventBus();
    const routes = new RendererEventRouteRegistry();
    const routeKey = routes.issue({
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
      },
      agentId: 'agent-1',
      sessionKey: 'session-1',
    });
    const { registerHostEventBridge } = await import('../../electron/main/host-event-bridge');

    registerHostEventBridge({
      runtimeHost,
      hostEventBus: eventBus as never,
      getMainWindow: () => null,
      rendererEventRoutes: routes,
    });

    runtimeHost.emitSafeEvent({
      type: 'session.delta',
      delta: createSessionDelta({ routeKey: 'renderer-route:missing' }),
    });
    runtimeHost.emitSafeEvent({
      type: 'session.delta',
      delta: createSessionDelta({ routeKey, sessionKey: 'session-stale' }),
    });
    runtimeHost.emitSafeEvent({
      type: 'session.delta',
      delta: { ...createSessionDelta({ routeKey }), extra: true },
    });
    routes.release(routeKey);
    runtimeHost.emitSafeEvent({
      type: 'session.delta',
      delta: createSessionDelta({ routeKey }),
    });

    expect(eventBus.emit).not.toHaveBeenCalledWith('session.delta', expect.anything());
  });

  it('在唯一 session.delta 的 run terminal 后释放 route，并拒绝后续 stale delta', async () => {
    const runtimeHost = createRuntimeHost({});
    const eventBus = createEventBus();
    const routes = new RendererEventRouteRegistry();
    const routeKey = routes.issue({
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'matcha-agent',
        runtimeInstanceId: 'local',
      },
      agentId: 'agent-1',
      sessionKey: 'session-1',
    });
    const { registerHostEventBridge } = await import('../../electron/main/host-event-bridge');

    registerHostEventBridge({
      runtimeHost,
      hostEventBus: eventBus as never,
      getMainWindow: () => null,
      rendererEventRoutes: routes,
    });
    runtimeHost.emitSafeEvent({
      type: 'session.delta',
      delta: createSessionDelta({
        routeKey,
        changes: [{ kind: 'runPhaseChanged', runId: 'run-1', phase: 'completed' }],
      }),
    });
    runtimeHost.emitSafeEvent({
      type: 'session.delta',
      delta: createSessionDelta({
        routeKey,
        seq: 2,
        cursor: 2,
        changes: [{ kind: 'runtimeChanged', runtime: {
          phase: 'started', activeRunId: null, issue: null,
        } }],
      }),
    });

    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).toHaveBeenCalledWith('session.delta', expect.objectContaining({ routeKey }));
    expect(routes.matchesSession(routeKey, 'session-1')).toBe(false);
  });

  it('在 terminal runtimeChanged 后释放 route，并拒绝后续 stale delta', async () => {
    const runtimeHost = createRuntimeHost({});
    const eventBus = createEventBus();
    const routes = new RendererEventRouteRegistry();
    const routeKey = routes.issue({
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
      },
      agentId: 'agent-1',
      sessionKey: 'session-1',
    });
    const { registerHostEventBridge } = await import('../../electron/main/host-event-bridge');

    registerHostEventBridge({
      runtimeHost,
      hostEventBus: eventBus as never,
      getMainWindow: () => null,
      rendererEventRoutes: routes,
    });
    runtimeHost.emitSafeEvent({
      type: 'session.delta',
      delta: createSessionDelta({
        routeKey,
        changes: [{ kind: 'runtimeChanged', runtime: {
          phase: 'failed', activeRunId: null, issue: 'unavailable',
        } }],
      }),
    });
    runtimeHost.emitSafeEvent({
      type: 'session.delta',
      delta: createSessionDelta({ routeKey, seq: 2, cursor: 2 }),
    });

    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).toHaveBeenCalledWith('session.delta', expect.objectContaining({ routeKey }));
    expect(routes.matchesSession(routeKey, 'session-1')).toBe(false);
  });

  it('将无效 control projection 与异常退出降格为固定错误', async () => {
    const runtimeHost = createRuntimeHost({
      snapshot: succeeded({ health: { ok: true, lifecycle: 'ready', openClaw: { lifecycle: 'running' }, endpoint: 'secret' } }),
    });
    const eventBus = createEventBus();
    const { registerHostEventBridge } = await import('../../electron/main/host-event-bridge');

    registerHostEventBridge({
      runtimeHost,
      hostEventBus: eventBus as never,
      getMainWindow: () => null,
      rendererEventRoutes: { isMatchaRoute: () => false, release: vi.fn() } as never,
    });
    await flushBridge();

    runtimeHost.emitExit({ kind: 'failed' });

    expect(eventBus.emit).toHaveBeenCalledWith(
      'runtime-host:error',
      { message: 'Runtime Host is unavailable.' },
    );
    expect(JSON.stringify(eventBus.emit.mock.calls)).not.toContain('secret');
  });

  it('仅在成功退出时投影 shutdown lifecycle', async () => {
    const runtimeHost = createRuntimeHost({});
    const eventBus = createEventBus();
    const { registerHostEventBridge } = await import('../../electron/main/host-event-bridge');

    registerHostEventBridge({
      runtimeHost,
      hostEventBus: eventBus as never,
      getMainWindow: () => null,
      rendererEventRoutes: { isMatchaRoute: () => false, release: vi.fn() } as never,
    });
    runtimeHost.emitExit({ kind: 'exited', code: 0, signal: null });

    expect(eventBus.emit).toHaveBeenCalledWith('runtime-host:status', {
      status: 'stopped',
      hostLifecycle: 'shutDown',
      runtimeLifecycle: 'shutDown',
      updatedAt: expect.any(Number),
    });
  });
});
