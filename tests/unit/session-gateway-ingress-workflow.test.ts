import { describe, expect, it } from 'vitest';
import { SessionGatewayIngressWorkflow } from '../../runtime-host/application/workflows/session-gateway-ingress/session-gateway-ingress-workflow';
import { SessionRuntimeStateStore } from '../../runtime-host/application/sessions/session-runtime-state';
import { SessionTimelineRuntime } from '../../runtime-host/application/sessions/session-timeline-runtime';
import { SessionExecutionGraphRuntime } from '../../runtime-host/application/sessions/session-execution-graph-runtime';
import { SessionSnapshotService } from '../../runtime-host/application/sessions/session-snapshot-service';
import { SessionSnapshotWorkflow } from '../../runtime-host/application/workflows/session-snapshot/session-snapshot-workflow';
import { MatchaAgentProtocolAdapter } from '../../runtime-host/application/adapters/matcha-agent/runtime';
import {
  MATCHA_AGENT_RUNTIME_ADAPTER_ID,
  MATCHA_AGENT_RUNTIME_ENDPOINT_ID,
  MATCHA_AGENT_RUNTIME_INSTANCE_ID,
  MATCHA_AGENT_RUNTIME_PROTOCOL_ID,
} from '../../runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-runtime-identity';
import { createRuntimeSessionContext } from '../../runtime-host/application/agent-runtime/contracts/runtime-session-context';
import type { CanonicalSessionEvent } from '../../runtime-host/application/sessions/canonical/canonical-events';
import type { RuntimeSessionContext } from '../../runtime-host/application/agent-runtime/contracts/runtime-endpoint-types';
import type { RuntimeEndpointRef } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { SessionRuntimeStorePort } from '../../runtime-host/application/sessions/session-runtime-store-repository';
import type { SessionStoragePort } from '../../runtime-host/application/sessions/session-storage-repository';
import type { MatchaTerminalDeliveryTrace } from '../../runtime-host/shared/matcha-terminal-delivery-trace';
import { createOpenClawTestRuntimeContext, openClawTestRuntimeEndpoint } from './helpers/runtime-address-fixtures';

const clock = {
  nowMs: () => 1_700_000_000_000,
  nowIso: () => '2023-11-14T22:13:20.000Z',
};

function createRuntimeStore(): SessionRuntimeStorePort {
  return {
    load: async () => ({ version: 3, activeSessionKey: null }),
    save: async () => undefined,
  };
}

function createSessionStorage(): SessionStoragePort {
  return {
    loadCatalog: async () => [],
    saveCatalog: async () => undefined,
    findStorageDescriptor: async () => null,
    readTranscriptMessages: async function* () {},
    readTranscriptText: async () => '',
    deleteSession: async () => undefined,
    renameSession: async () => ({ success: true }),
    archiveSession: async () => ({ success: true }),
  };
}

function baseEvent(eventId: string, seq: number, context: RuntimeSessionContext): Pick<CanonicalSessionEvent, 'eventId' | 'protocolId' | 'runtimeEndpointId' | 'source' | 'sessionId' | 'runId' | 'seq' | 'timestamp' | 'laneKey' | 'origin'> {
  return {
    eventId,
    protocolId: context.protocolId,
    runtimeEndpointId: context.runtimeEndpointId,
    source: 'live',
    sessionId: context.sessionKey,
    runId: 'run-final-usage',
    seq,
    timestamp: 1_700_000_000_000 + seq,
    laneKey: 'main',
    origin: {
      runtimeEventType: 'test',
      runtimeIds: {
        sessionKey: context.sessionKey,
        runId: 'run-final-usage',
      },
    },
  };
}

function createWorkflow(input: {
  canonicalEvents: CanonicalSessionEvent[];
  context: RuntimeSessionContext;
  eventAdapter?: {
    canTranslate: (payload: unknown, context: RuntimeSessionContext) => boolean;
    translate: (payload: unknown, context: RuntimeSessionContext) => CanonicalSessionEvent[];
  };
  terminalDeliveryTrace?: MatchaTerminalDeliveryTrace;
  onAdapterTranslate?: () => void;
}) {
  const protocol = {
    protocolId: input.context.protocolId,
    eventAdapter: input.eventAdapter ?? {
      canTranslate: () => true,
      translate: () => {
        input.onAdapterTranslate?.();
        return input.canonicalEvents;
      },
    },

    replayAdapter: {
      replayTranscript: () => [],
    },
    identityPolicy: {
      buildMessageId: () => 'message-id',
    },
  };
  const endpoint = {
    scopeKey: input.context.endpoint.scopeKey,
    protocolId: input.context.protocolId,
    runtimeEndpointId: input.context.runtimeEndpointId,
  };
  const agentRuntimeRegistry = {
    resolveEndpointForRef: () => endpoint,
    getProtocol: () => protocol,
    resolveSessionContextByEndpointSessionId: (_endpoint: RuntimeEndpointRef, endpointSessionId: string) => (
      endpointSessionId === input.context.endpointSessionId ? input.context : null
    ),
    rememberSessionIdentity: () => input.context,
    resolveSessionContext: () => input.context,
    resolveApprovalNotificationsForEndpoint: () => null,
  };
  const stateStore = new SessionRuntimeStateStore({
    runtimeStore: createRuntimeStore(),
    agentRuntimeRegistry: agentRuntimeRegistry as never,
  });
  const executionGraphRuntime = new SessionExecutionGraphRuntime({
    stateStore,
  });
  const sessionStorage = createSessionStorage();
  const timelineRuntime = new SessionTimelineRuntime({
    stateStore,
    sessionStorage,
    transcriptLoader: {
      readCanonicalReplayEvents: async () => [],
    } as never,
    executionGraphRuntime,
    clock,
  });
  const snapshotService = new SessionSnapshotService({
    snapshotWorkflow: new SessionSnapshotWorkflow({
      stateStore,
      sessionMetadata: {
        resolveSessionModel: async () => null,
      },
      sessionStorage,
    }),
  });

  return new SessionGatewayIngressWorkflow({
    stateStore,
    timelineRuntime,
    snapshotService,
    clock,
    agentRuntimeRegistry: agentRuntimeRegistry as never,
    terminalDeliveryTrace: input.terminalDeliveryTrace,
  });
}

function createMatchaRuntimeContext() {
  return createRuntimeSessionContext({
    identity: {
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: MATCHA_AGENT_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: MATCHA_AGENT_RUNTIME_INSTANCE_ID,
      },
      agentId: 'matcha',
      sessionKey: 'matcha-agent:session:fixture',
    },
    protocolId: MATCHA_AGENT_RUNTIME_PROTOCOL_ID,
    runtimeEndpointId: MATCHA_AGENT_RUNTIME_ENDPOINT_ID,
    endpointSessionId: 'fixture',
  });
}

const matchaRuntimeEndpoint: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: MATCHA_AGENT_RUNTIME_ADAPTER_ID,
  runtimeInstanceId: MATCHA_AGENT_RUNTIME_INSTANCE_ID,
};

describe('SessionGatewayIngressWorkflow', () => {
  it('keeps session_info_update phase final when usage follows a final lifecycle event in the same canonical batch', async () => {
    const context = createOpenClawTestRuntimeContext('agent:main:main');
    const canonicalEvents: CanonicalSessionEvent[] = [{
      ...baseEvent('lifecycle-final', 1, context),
      type: 'lifecycle',
      phase: 'final',
      runPhase: 'done',
      error: null,
    }, {
      ...baseEvent('usage', 2, context),
      type: 'usage',
      payload: { inputTokens: 12, outputTokens: 34 },
    }];
    const workflow = createWorkflow({ canonicalEvents, context });

    const [update] = await workflow.consumeEndpointConversationEvent(openClawTestRuntimeEndpoint, {
      sessionKey: context.endpointSessionId,
    });

    expect(update).toMatchObject({
      sessionUpdate: 'session_info_update',
      sessionKey: 'agent:main:main',
      runId: 'run-final-usage',
      phase: 'final',
      error: null,
      snapshot: {
        runtime: {
          activeRunId: null,
          runPhase: 'done',
        },
        usage: [{
          id: 'usage',
          sessionKey: 'agent:main:main',
          runId: 'run-final-usage',
          payload: { inputTokens: 12, outputTokens: 34 },
        }],
      },
    });
    expect(update?.sessionUpdate).toBe('session_info_update');
    if (update?.sessionUpdate !== 'session_info_update') {
      throw new Error('Expected session_info_update');
    }
    expect(update.phase).not.toBe('unknown');
    expect(update.snapshot.runtime.runPhase).toBe('done');
    expect(update.snapshot.runtime.activeRunId).toBeNull();
  });

  it('rejects a top-level sessionId without a sessionKey before invoking the adapter', async () => {
    const context = createOpenClawTestRuntimeContext('agent:main:main');
    let adapterTranslateCalls = 0;
    const workflow = createWorkflow({
      canonicalEvents: [],
      context,
      onAdapterTranslate: () => {
        adapterTranslateCalls += 1;
      },
    });

    const updates = await workflow.consumeEndpointConversationEvent(openClawTestRuntimeEndpoint, {
      sessionId: context.endpointSessionId,
      event: {},
      params: {},
    });

    expect(updates).toEqual([]);
    expect(adapterTranslateCalls).toBe(0);
  });

  it('applies a Matcha terminal envelope through canonical lifecycle commit and preserves opaque trace metadata', async () => {
    const context = createMatchaRuntimeContext();
    const traceRecords: Parameters<MatchaTerminalDeliveryTrace>[0][] = [];
    const trace = {
      bridgeTraceId: 'matcha-bridge-1',
      runTraceId: 'matcha-run-1',
      eventClass: 'terminal' as const,
      terminalPhase: 'final' as const,
    };
    const workflow = createWorkflow({
      canonicalEvents: [],
      context,
      eventAdapter: new MatchaAgentProtocolAdapter().eventAdapter,
      terminalDeliveryTrace: (record) => traceRecords.push(record),
    });

    const [update] = await workflow.consumeEndpointConversationEvent(matchaRuntimeEndpoint, {
      eventId: 'fixture-event',
      sessionKey: context.endpointSessionId,
      sessionId: context.endpointSessionId,
      seq: 1,
      runId: 'fixture-run',
      createdAt: '2026-07-12T00:00:00.000Z',
      event: {
        type: 'run.completed',
        runId: 'fixture-run',
        usage: { outputTokens: 1 },
      },
      _meta: {
        matchaTerminalDelivery: trace,
      },
    });

    expect(traceRecords).toEqual([{ stage: 'canonical_terminal_applied', ...trace }]);
    expect(update).toMatchObject({
      sessionUpdate: 'session_info_update',
      phase: 'final',
      snapshot: {
        runtime: {
          activeRunId: null,
        },
      },
      _meta: {
        matchaTerminalDelivery: trace,
      },
    });
    expect(update?.sessionUpdate).toBe('session_info_update');
    if (update?.sessionUpdate !== 'session_info_update') {
      throw new Error('Expected session_info_update');
    }
    expect(update._meta?.matchaTerminalDelivery).toEqual(trace);
  });

  it('does not apply terminal trace hooks for non-Matcha or mismatched Matcha terminal metadata', async () => {
    const traceRecords: Parameters<MatchaTerminalDeliveryTrace>[0][] = [];
    const nonMatchaTrace = {
      bridgeTraceId: 'matcha-bridge-2',
      runTraceId: 'matcha-run-2',
      eventClass: 'terminal' as const,
      terminalPhase: 'final' as const,
    };
    const mismatchedTrace = {
      bridgeTraceId: 'matcha-bridge-3',
      runTraceId: 'matcha-run-3',
      eventClass: 'terminal' as const,
      terminalPhase: 'error' as const,
    };
    const openClawContext = createOpenClawTestRuntimeContext('agent:main:main');
    const openClawWorkflow = createWorkflow({
      canonicalEvents: [{
        ...baseEvent('lifecycle-final', 1, openClawContext),
        type: 'lifecycle',
        phase: 'final',
        runPhase: 'done',
        error: null,
      }],
      context: openClawContext,
      terminalDeliveryTrace: (record) => traceRecords.push(record),
    });
    const matchaContext = createMatchaRuntimeContext();
    const matchaWorkflow = createWorkflow({
      canonicalEvents: [],
      context: matchaContext,
      eventAdapter: new MatchaAgentProtocolAdapter().eventAdapter,
      terminalDeliveryTrace: (record) => traceRecords.push(record),
    });

    const [openClawUpdate] = await openClawWorkflow.consumeEndpointConversationEvent(openClawTestRuntimeEndpoint, {
      sessionKey: openClawContext.endpointSessionId,
      _meta: {
        matchaTerminalDelivery: nonMatchaTrace,
      },
    });
    const [matchaUpdate] = await matchaWorkflow.consumeEndpointConversationEvent(matchaRuntimeEndpoint, {
      eventId: 'fixture-event',
      sessionKey: matchaContext.endpointSessionId,
      sessionId: matchaContext.endpointSessionId,
      seq: 1,
      runId: 'fixture-run',
      createdAt: '2026-07-12T00:00:00.000Z',
      event: {
        type: 'run.completed',
        runId: 'fixture-run',
      },
      _meta: {
        matchaTerminalDelivery: mismatchedTrace,
      },
    });

    expect(traceRecords).toEqual([]);
    expect(openClawUpdate).toMatchObject({
      sessionUpdate: 'session_info_update',
      phase: 'final',
    });
    expect(matchaUpdate).toMatchObject({
      sessionUpdate: 'session_info_update',
      phase: 'final',
    });
    expect(openClawUpdate?._meta).toBeUndefined();
    expect(matchaUpdate?._meta).toBeUndefined();
  });
});
