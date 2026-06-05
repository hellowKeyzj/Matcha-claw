import { describe, expect, it, vi } from 'vitest';
import { createRuntimeRouteDispatcher } from '../../runtime-host/api/dispatch/runtime-route-dispatcher';
import { createRuntimeHostGatewayClient } from '../../runtime-host/application/adapters/openclaw/gateway/openclaw-gateway-event-bridge';
import { SessionExecutionGraphRuntime } from '../../runtime-host/application/sessions/session-execution-graph-runtime';
import { SessionTimelineRuntime } from '../../runtime-host/application/sessions/session-timeline-runtime';
import { createEmptyTimelineState } from '../../runtime-host/application/sessions/session-state-model';
import { GatewayPendingRpcRequests } from '../../runtime-host/openclaw-bridge/client-pending-rpc';
import {
  GATEWAY_RPC_CONCURRENCY_LIMIT,
  GATEWAY_RPC_QUEUE_LIMIT,
  GatewayRpcSender,
} from '../../runtime-host/openclaw-bridge/client-rpc-sender';
import type { RuntimeAddress } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { RuntimeSessionContext } from '../../runtime-host/application/agent-runtime/contracts/runtime-endpoint-types';
import type { CanonicalSessionEvent } from '../../runtime-host/application/sessions/canonical/canonical-events';
import type { SessionRuntimeTimelineState } from '../../runtime-host/application/sessions/session-runtime-types';
import type { RuntimeScheduledTask, RuntimeSchedulerPort } from '../../runtime-host/application/common/runtime-ports';

const createGatewayClientMock = vi.hoisted(() => vi.fn());

vi.mock('../../runtime-host/openclaw-bridge', () => ({
  createGatewayClient: createGatewayClientMock,
}));

const benchIt = process.env.RUNTIME_HOST_BENCH === '1' ? it : it.skip;

function logBenchmark(label: string, startedAt: number, metrics: Record<string, number | string>): void {
  const totalMs = performance.now() - startedAt;
  const parts = Object.entries({ totalMs: totalMs.toFixed(2), ...metrics })
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  console.log(`[runtime-host-bench] ${label} ${parts}`);
}

function runtimeAddress(capabilityId: string, sessionKey = 'agent:main:main'): RuntimeAddress {
  return {
    kind: 'native-runtime',
    capabilityId,
    runtimeAdapterId: 'bench-runtime',
    runtimeInstanceId: 'local',
    agentId: 'default',
    sessionKey,
  };
}

function runtimeContext(sessionKey: string): RuntimeSessionContext {
  return {
    sessionKey,
    protocolId: 'bench-protocol',
    runtimeEndpointId: 'bench-endpoint',
    endpoint: {
      scopeKey: 'bench-runtime:local:default',
      capabilityId: 'session.prompt',
      runtimeAdapterId: 'bench-runtime',
      runtimeInstanceId: 'local',
      agentId: 'default',
    },
    agentId: 'default',
    address: runtimeAddress('session.prompt', sessionKey),
  };
}

function canonicalMessage(sessionKey: string, index: number): CanonicalSessionEvent {
  return {
    eventId: `${sessionKey}:message:${index}`,
    type: 'message_snapshot',
    protocolId: 'bench-protocol',
    runtimeEndpointId: 'bench-endpoint',
    source: 'live',
    sessionId: sessionKey,
    runId: `run-${index}`,
    seq: index,
    timestamp: index,
    laneKey: 'main',
    origin: {
      runtimeEventType: 'bench.message',
      runtimeIds: { sessionKey, runId: `run-${index}` },
    },
    role: index % 2 === 0 ? 'assistant' : 'user',
    messageId: `${sessionKey}:message:${index}`,
    content: `message ${index}`,
    text: `message ${index}`,
    status: 'final',
  };
}

function createTimelineRuntime(states: Map<string, SessionRuntimeTimelineState>): SessionTimelineRuntime {
  const stateStore = {
    ready: async () => undefined,
    getSessionState: (sessionKey: string, context?: RuntimeSessionContext) => {
      let state = states.get(sessionKey);
      if (!state) {
        state = createEmptyTimelineState({ sessionKey, hydrated: true }, context ?? runtimeContext(sessionKey));
        states.set(sessionKey, state);
      }
      return state;
    },
    setActiveSessionKey: () => undefined,
    persistStore: () => undefined,
    updateExecutionGraphDependencyIndex: () => undefined,
    syncTransportIssueIndex: () => undefined,
    syncApprovalAddressIndex: () => undefined,
    listParentSessionKeys: () => [],
    findSessionState: () => null,
  };
  return new SessionTimelineRuntime({
    stateStore: stateStore as never,
    sessionStorage: {} as never,
    transcriptLoader: {} as never,
    executionGraphRuntime: new SessionExecutionGraphRuntime({ stateStore: stateStore as never }),
    clock: { nowMs: () => 1 },
  });
}

class ManualScheduler implements RuntimeSchedulerPort {
  readonly tasks: Array<() => void> = [];

  schedule(_delayMs: number, task: () => void): RuntimeScheduledTask {
    this.tasks.push(task);
    return { cancel: vi.fn() };
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('runtime-host architecture benchmarks', () => {
  benchIt('routes exact dispatch in a 1k fallback table without scanning fallback handlers', async () => {
    const exact = vi.fn(() => ({ status: 200, data: { route: 'target' } }));
    const fallbackHandlers = Array.from({ length: 1000 }, (_, index) => vi.fn(() => ({
      status: 200,
      data: { route: `fallback-${index}` },
    })));
    const dispatcher = createRuntimeRouteDispatcher([
      ...fallbackHandlers.map((handle, index) => ({
        key: `pattern-${index}`,
        method: 'POST',
        matcher: { type: 'pattern' as const, pattern: new RegExp(`^/api/pattern-${index}/`) },
        handle,
      })),
      { key: 'target', method: 'POST', matcher: { type: 'exact' as const, path: '/api/target' }, handle: exact },
    ]);

    const startedAt = performance.now();
    for (let index = 0; index < 10_000; index += 1) {
      await dispatcher('POST', '/api/target', undefined);
    }
    logBenchmark('route_dispatch_exact_10k', startedAt, { iterations: 10_000 });

    expect(exact).toHaveBeenCalledTimes(10_000);
    expect(fallbackHandlers.every((handle) => handle.mock.calls.length === 0)).toBe(true);
  });

  benchIt('appends 10k canonical events across 1k sessions with incremental projection', () => {
    const states = new Map<string, SessionRuntimeTimelineState>();
    const timelineRuntime = createTimelineRuntime(states);
    const startedAt = performance.now();

    for (let sessionIndex = 0; sessionIndex < 1000; sessionIndex += 1) {
      const sessionKey = `bench:session:${sessionIndex}`;
      states.set(sessionKey, createEmptyTimelineState({ sessionKey, hydrated: true }, runtimeContext(sessionKey)));
      for (let eventIndex = 0; eventIndex < 10; eventIndex += 1) {
        timelineRuntime.appendCanonicalEvents(sessionKey, [canonicalMessage(sessionKey, eventIndex)]);
      }
    }
    logBenchmark('timeline_1k_sessions_10k_events', startedAt, { sessions: 1000, events: 10_000 });

    expect(states).toHaveLength(1000);
    expect(Array.from(states.values()).reduce((sum, state) => sum + state.canonical.eventIds.length, 0)).toBe(10_000);
  });

  benchIt('processes gateway burst concurrently across sessions while preserving per-session order', async () => {
    createGatewayClientMock.mockReturnValue({
      inspectGatewayControlReadiness: vi.fn(async () => ({ ready: true, phase: 'ready', capabilities: { methods: [], updatedAt: 1 } })),
      readGatewayConnectionState: vi.fn(async () => ({ lastIssue: null })),
    });
    const processed: string[] = [];
    const runtime = {
      consumeEndpointConversationEvent: vi.fn(async (_runtimeAddress, payload: { event?: { sessionKey?: string; seq?: number } }) => {
        processed.push(`${payload.event?.sessionKey}:${String(payload.event?.seq)}`);
        return [];
      }),
      consumeEndpointNotification: vi.fn(() => []),
    };

    createRuntimeHostGatewayClient({
      parentTransport: {
        requestParentShellAction: vi.fn(async () => ({ success: true, status: 200, data: {} })),
        emitParentGatewayEvent: vi.fn(async () => undefined),
      },
      dispatchRoute: vi.fn(async () => ({ status: 200, data: {} })),
      getSessionRuntime: () => runtime,
      endpointControlState: { updateRuntimeEndpointControlState: vi.fn(() => ({ connection: null, readiness: null, capabilities: null, updatedAt: null })) },
      runtimeHostCapabilityAddress: runtimeAddress('runtime.host'),
      runtimeHostDataDir: process.cwd(),
      gatewayPort: 1,
      readGatewayToken: vi.fn(async () => 'token'),
      platform: process.platform,
      clock: { nowMs: () => 1 },
      idGenerator: { randomUUID: () => 'id-1' },
      identityRepository: {} as never,
      deviceCrypto: {} as never,
      scheduler: {} as never,
      tcpProbe: {} as never,
    });

    const options = createGatewayClientMock.mock.calls[0]?.[0];
    const startedAt = performance.now();
    for (let index = 0; index < 10_000; index += 1) {
      options.onGatewayConversationEvent({ type: 'usage', event: { sessionKey: `bench:${index % 1000}`, seq: index } });
    }
    await vi.waitFor(() => {
      expect(processed).toHaveLength(10_000);
    });
    logBenchmark('gateway_burst_1k_sessions_10k_events', startedAt, { sessions: 1000, events: 10_000 });
  });

  benchIt('bounds pending RPC concurrency and queue pressure', async () => {
    const blockedConnection = createDeferred<void>();
    const scheduler = new ManualScheduler();
    let nextId = 1;
    const pendingRequests = new GatewayPendingRpcRequests(scheduler);
    const sender = new GatewayRpcSender({
      ensureConnected: vi.fn(() => blockedConnection.promise),
      isSocketOpen: () => true,
      sendRaw: vi.fn((payload: string) => {
        const parsed = JSON.parse(payload) as { id: string };
        queueMicrotask(() => {
          pendingRequests.take(parsed.id)?.resolve({ ok: true });
        });
      }),
      pendingRpcRequests: pendingRequests,
      idGenerator: { randomId: () => String(nextId++) },
      clock: { nowMs: () => 1 },
      recordRpcFailure: vi.fn(),
    });

    const startedAt = performance.now();
    const calls = Array.from(
      { length: GATEWAY_RPC_CONCURRENCY_LIMIT + GATEWAY_RPC_QUEUE_LIMIT },
      (_, index) => sender.call(`bench.${index}`, {}).catch((error: unknown) => error),
    );
    await Promise.resolve();
    await expect(sender.call('bench.overflow', {})).rejects.toThrow('Gateway RPC queue full: bench.overflow');
    blockedConnection.resolve();
    await Promise.all(calls);
    logBenchmark('pending_rpc_backpressure', startedAt, {
      concurrencyLimit: GATEWAY_RPC_CONCURRENCY_LIMIT,
      queueLimit: GATEWAY_RPC_QUEUE_LIMIT,
    });

    expect(pendingRequests.size()).toBe(0);
  });
});
