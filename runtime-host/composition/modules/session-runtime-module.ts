import { SessionCommandService } from '../../application/sessions/session-command-service';
import { SessionCommandOperationsWorkflow } from '../../application/workflows/session-command/session-command-operations-workflow';
import { SessionGatewayIngressService } from '../../application/sessions/session-gateway-ingress-service';
import { SessionRuntimeService } from '../../application/sessions/service';
import {
  SessionCatalogService,
} from '../../application/sessions/session-catalog';
import {
  REFRESH_SESSION_CATALOG_JOB,
  createSessionCatalogJobPort,
  type SessionCatalogJobPort,
} from '../../application/sessions/session-catalog-jobs';
import {
  HYDRATE_SESSION_TIMELINE_JOB,
  createSessionHydrationJobPort,
  type SessionHydrationJobPort,
} from '../../application/sessions/session-hydration-jobs';
import { SessionMetadataRepository } from '../../application/sessions/session-metadata-repository';
import { SessionRuntimeStoreRepository } from '../../application/sessions/session-runtime-store-repository';
import { SessionRuntimeStorePersistenceWorkflow } from '../../application/workflows/session-runtime-store/session-runtime-store-persistence-workflow';
import { SessionRuntimeStateStore } from '../../application/sessions/session-runtime-state';
import { SessionPromptService } from '../../application/sessions/session-prompt-service';
import { SessionRunWorkflow } from '../../application/workflows/session-run/session-run-workflow';
import { SessionGatewayIngressWorkflow } from '../../application/workflows/session-gateway-ingress/session-gateway-ingress-workflow';
import { SessionHydrationWorkflow } from '../../application/workflows/session-hydration/session-hydration-workflow';
import { SessionLifecycleWorkflow } from '../../application/workflows/session-lifecycle/session-lifecycle-workflow';
import { SessionCatalogWorkflow } from '../../application/workflows/session-catalog/session-catalog-workflow';
import { SessionModelResolutionWorkflow } from '../../application/workflows/session-metadata/session-model-resolution-workflow';
import { SessionOperationResultWorkflow } from '../../application/workflows/session-operation/session-operation-result-workflow';
import { SessionStorageIndexWorkflow, type SessionStorageSessionIdentityResolverPort } from '../../application/workflows/session-storage/session-storage-index-workflow';
import { SessionStorageMutationWorkflow } from '../../application/workflows/session-storage/session-storage-mutation-workflow';
import { SessionStorageRepositoryWorkflow } from '../../application/workflows/session-storage/session-storage-repository-workflow';
import { SessionStorageTranscriptWorkflow } from '../../application/workflows/session-storage/session-storage-transcript-workflow';
import { SessionApprovalWorkflow } from '../../application/workflows/session-approval/session-approval-workflow';
import { SessionModelSelectionWorkflow } from '../../application/workflows/session-model-selection/session-model-selection-workflow';
import { SessionSnapshotWorkflow } from '../../application/workflows/session-snapshot/session-snapshot-workflow';
import { SessionSnapshotService } from '../../application/sessions/session-snapshot-service';
import { SessionStorageRepository } from '../../application/sessions/session-storage-repository';
import { SessionExecutionGraphRuntime } from '../../application/sessions/session-execution-graph-runtime';
import { SessionTimelineRuntime } from '../../application/sessions/session-timeline-runtime';
import { SessionOperationCoordinator } from '../../application/sessions/session-operation-coordinator';
import { SessionTranscriptTimelineLoader } from '../../application/sessions/session-transcript-timeline-loader';
import { createSessionApprovalCapabilityOperationRoutes } from '../../application/capabilities/approval/session-approval-capability';
import type { CapabilityOperationRoute } from '../../application/capabilities/contracts/capability-router';
import { createSessionModelSelectionCapabilityOperationRoutes } from '../../application/capabilities/model/session-model-capability';
import { createSessionManagementCapabilityOperationRoutes } from '../../application/capabilities/session/session-management-capability';
import { createSessionPromptCapabilityOperationRoutes } from '../../application/capabilities/session/session-prompt-capability';
import type { SessionConfigDirectoryPort, SessionExternalArtefactResolverPort } from '../../application/sessions/session-storage-repository';
import type { SessionDefaultModelResolverPort } from '../../application/sessions/session-metadata-repository';
import type { RuntimeClockPort, RuntimeFileSystemPort, RuntimeIdGeneratorPort } from '../../application/common/runtime-ports';
import type { RuntimeHostLogger } from '../../shared/logger';
import type { SessionUpdateEvent } from '../../shared/session-adapter-types';
import {
  createMatchaTerminalDeliveryTraceLogger,
  readMatchaTerminalDeliveryTraceContext,
} from '../../shared/matcha-terminal-delivery-trace';
import type { ParentGatewayForwardEventName } from '../../shared/parent-transport-contracts';
import {
  registerRuntimeJobDefinitions,
  type RuntimeJobDefinition,
  type RuntimeJobRegistry,
} from '../../core/jobs';
import {
  registerRuntimeLifecycleDefinitions,
  type RuntimeHostLifecycle,
} from '../../core/lifecycle';
import type { RuntimeHostContainer } from '../container';
import type {
  RuntimeLongTaskLookupPort,
  RuntimeLongTaskSubmissionPort,
} from '../../application/runtime-host/runtime-task-ports';
import type { AgentRuntimeRegistry } from '../../application/agent-runtime/contracts/agent-runtime-registry';
import type { RuntimeEndpointProfile } from '../../application/agent-runtime/contracts/runtime-endpoint-types';
import { nativeRuntimeEndpoint, connectorRuntimeEndpoint, validateSessionIdentity, type SessionIdentity } from '../../application/agent-runtime/contracts/runtime-address';

export interface SessionRuntimeModule {
  readonly sessionRuntime: SessionRuntimeService;
  readonly sessionCatalog: SessionCatalogService;
}

function emitSessionUpdateWithTerminalTrace(
  parentGatewayEvents: { emit: (eventName: ParentGatewayForwardEventName, payload: unknown) => Promise<void> } | undefined,
  terminalDeliveryTrace: ReturnType<typeof createMatchaTerminalDeliveryTraceLogger>,
  event: SessionUpdateEvent,
): void {
  const terminalTrace = readMatchaTerminalDeliveryTraceContext(event);
  if (!terminalTrace) {
    void parentGatewayEvents?.emit('session:update', event).catch(() => undefined);
    return;
  }
  terminalDeliveryTrace({
    stage: 'session_update_emit_started',
    ...terminalTrace,
  });
  void parentGatewayEvents?.emit('session:update', event).then(
    () => terminalDeliveryTrace({
      stage: 'session_update_emit_resolved',
      ...terminalTrace,
    }),
    (error) => terminalDeliveryTrace({
      stage: 'session_update_emit_rejected',
      ...terminalTrace,
      errorCategory: error instanceof Error ? 'error' : 'non_error',
    }),
  );
}

class AgentNamespaceSessionStorageIdentityResolver implements SessionStorageSessionIdentityResolverPort {
  constructor(private readonly registry: AgentRuntimeRegistry) {}

  resolveStorageSessionIdentity(input: {
    agentId: string;
    sessionKey: string;
    sessionStoreEntry: Record<string, unknown> | null;
  }): SessionIdentity | null {
    const stored = this.readStoredSessionIdentity(input.sessionStoreEntry, input.agentId, input.sessionKey);
    if (stored) {
      return stored;
    }
    const endpoint = this.registry.listEndpoints().find((candidate) => (
      candidate.capabilities.chat
      && candidate.storage?.namespace === 'agent'
      && candidate.keying?.namespace === 'agent'
      && (candidate.agentIds.includes(input.agentId) || candidate.acceptsDynamicAgents === true)
    ));
    return endpoint ? this.buildSessionIdentity(endpoint, input.agentId, input.sessionKey) : null;
  }

  private readStoredSessionIdentity(entry: Record<string, unknown> | null, agentId: string, sessionKey: string): SessionIdentity | null {
    const candidate = entry?.sessionIdentity;
    if (candidate === undefined) {
      return null;
    }
    if (validateSessionIdentity(candidate) !== null) {
      return null;
    }
    const identity = candidate as SessionIdentity;
    return identity.agentId === agentId && identity.sessionKey === sessionKey ? identity : null;
  }

  private buildSessionIdentity(endpoint: RuntimeEndpointProfile, agentId: string, sessionKey: string): SessionIdentity {
    if (endpoint.runtimeAdapterId) {
      return {
        endpoint: nativeRuntimeEndpoint({
          runtimeAdapterId: endpoint.runtimeAdapterId,
          runtimeInstanceId: endpoint.runtimeInstanceId ?? endpoint.id,
        }),
        agentId,
        sessionKey,
      };
    }
    if (!endpoint.connectorId) {
      throw new Error(`Runtime endpoint cannot address sessions: ${endpoint.id}`);
    }
    return {
      endpoint: connectorRuntimeEndpoint({
        protocolId: endpoint.protocolId,
        connectorId: endpoint.connectorId,
        endpointId: endpoint.id,
      }),
      agentId,
      sessionKey,
    };
  }
}

export function registerSessionRuntimeModule(
  container: RuntimeHostContainer,
  parentGatewayEvents?: {
    emit: (eventName: ParentGatewayForwardEventName, payload: unknown) => Promise<void>;
  },
): void {
  container.register('sessionStorageSessionIdentityResolver', (scope) => new AgentNamespaceSessionStorageIdentityResolver(
    scope.resolve<AgentRuntimeRegistry>('sessionAgentRuntimeRegistry'),
  ));
  container.register('sessionStorageIndexWorkflow', (scope) => new SessionStorageIndexWorkflow({
    workspace: scope.resolve<SessionConfigDirectoryPort>('sessionConfigDirectory'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    sessionIdentityResolver: scope.resolve<SessionStorageSessionIdentityResolverPort>('sessionStorageSessionIdentityResolver'),
  }));
  container.register('sessionStorageMutationWorkflow', (scope) => new SessionStorageMutationWorkflow({
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    externalArtefactResolver: scope.resolve<SessionExternalArtefactResolverPort>('sessionExternalArtefactResolver'),
  }));
  container.register('sessionStorageTranscriptWorkflow', (scope) => new SessionStorageTranscriptWorkflow({
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('sessionStorageRepositoryWorkflow', (scope) => new SessionStorageRepositoryWorkflow({
    indexWorkflow: scope.resolve<SessionStorageIndexWorkflow>('sessionStorageIndexWorkflow'),
    mutationWorkflow: scope.resolve<SessionStorageMutationWorkflow>('sessionStorageMutationWorkflow'),
    transcriptWorkflow: scope.resolve<SessionStorageTranscriptWorkflow>('sessionStorageTranscriptWorkflow'),
  }));
  container.register('sessionStorageRepository', (scope) => new SessionStorageRepository({
    repositoryWorkflow: scope.resolve<SessionStorageRepositoryWorkflow>('sessionStorageRepositoryWorkflow'),
  }));
  container.register('sessionRuntimeStorePersistenceWorkflow', (scope) => new SessionRuntimeStorePersistenceWorkflow({
    workspace: scope.resolve<SessionConfigDirectoryPort>('sessionConfigDirectory'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('sessionRuntimeStoreRepository', (scope) => new SessionRuntimeStoreRepository({
    persistenceWorkflow: scope.resolve<SessionRuntimeStorePersistenceWorkflow>('sessionRuntimeStorePersistenceWorkflow'),
  }));
  container.register('sessionModelResolutionWorkflow', (scope) => new SessionModelResolutionWorkflow({
    defaultModelResolver: scope.resolve<SessionDefaultModelResolverPort>('sessionDefaultModelResolver'),
  }));
  container.register('sessionMetadataRepository', (scope) => new SessionMetadataRepository({
    modelResolutionWorkflow: scope.resolve<SessionModelResolutionWorkflow>('sessionModelResolutionWorkflow'),
  }));
  container.register('sessionCatalogWorkflow', (scope) => new SessionCatalogWorkflow({
    storageRepository: scope.resolve('sessionStorageRepository'),
    metadataRepository: scope.resolve('sessionMetadataRepository'),
    agentRuntimeRegistry: scope.resolve('sessionAgentRuntimeRegistry'),
  }));
  container.register('sessionCatalogService', (scope) => new SessionCatalogService({
    catalogWorkflow: scope.resolve<SessionCatalogWorkflow>('sessionCatalogWorkflow'),
  }));
  container.register('sessionCatalogJobs', (scope): SessionCatalogJobPort => createSessionCatalogJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
    scope.resolve<RuntimeLongTaskLookupPort>('runtime.taskLookup'),
  ));
  container.register('sessionOperationResultWorkflow', () => new SessionOperationResultWorkflow());
  container.register('sessionOperationCoordinator', (scope) => new SessionOperationCoordinator(
    scope.resolve<SessionOperationResultWorkflow>('sessionOperationResultWorkflow'),
  ));
  container.register('sessionAgentRuntimeRegistry', (scope): AgentRuntimeRegistry => scope.resolve<AgentRuntimeRegistry>('agentRuntime.registry'));
  container.register('sessionRuntimeStateStore', (scope) => new SessionRuntimeStateStore({
    runtimeStore: scope.resolve('sessionRuntimeStoreRepository'),
    agentRuntimeRegistry: scope.resolve('sessionAgentRuntimeRegistry'),
    logger: scope.resolve<RuntimeHostLogger>('logger'),
  }));
  container.register('sessionTranscriptTimelineLoader', (scope) => new SessionTranscriptTimelineLoader({
    sessionStorage: scope.resolve('sessionStorageRepository'),
    agentRuntimeRegistry: scope.resolve('sessionAgentRuntimeRegistry'),
  }));
  container.register('sessionExecutionGraphRuntime', (scope) => new SessionExecutionGraphRuntime({
    stateStore: scope.resolve('sessionRuntimeStateStore'),
  }));
  container.register('sessionTimelineRuntime', (scope) => new SessionTimelineRuntime({
    stateStore: scope.resolve('sessionRuntimeStateStore'),
    sessionStorage: scope.resolve('sessionStorageRepository'),
    transcriptLoader: scope.resolve('sessionTranscriptTimelineLoader'),
    executionGraphRuntime: scope.resolve('sessionExecutionGraphRuntime'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('sessionSnapshotWorkflow', (scope) => new SessionSnapshotWorkflow({
    stateStore: scope.resolve('sessionRuntimeStateStore'),
    sessionMetadata: scope.resolve('sessionMetadataRepository'),
    sessionStorage: scope.resolve('sessionStorageRepository'),
  }));
  container.register('sessionSnapshotService', (scope) => new SessionSnapshotService({
    snapshotWorkflow: scope.resolve<SessionSnapshotWorkflow>('sessionSnapshotWorkflow'),
  }));
  container.register('sessionGatewayIngressWorkflow', (scope) => {
    const logger = scope.resolve<RuntimeHostLogger>('logger');
    return new SessionGatewayIngressWorkflow({
      stateStore: scope.resolve('sessionRuntimeStateStore'),
      timelineRuntime: scope.resolve('sessionTimelineRuntime'),
      snapshotService: scope.resolve('sessionSnapshotService'),
      clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
      logger,
      terminalDeliveryTrace: createMatchaTerminalDeliveryTraceLogger(logger),
      agentRuntimeRegistry: scope.resolve('sessionAgentRuntimeRegistry'),
    });
  });
  container.register('sessionGatewayIngressService', (scope) => {
    const terminalDeliveryTrace = createMatchaTerminalDeliveryTraceLogger(scope.resolve<RuntimeHostLogger>('logger'));
    return new SessionGatewayIngressService({
      ingressWorkflow: scope.resolve<SessionGatewayIngressWorkflow>('sessionGatewayIngressWorkflow'),
      emitSessionUpdate: (event) => {
        emitSessionUpdateWithTerminalTrace(parentGatewayEvents, terminalDeliveryTrace, event);
      },
    });
  });
  container.register('sessionHydrationJobAdapter', (scope): SessionHydrationJobPort => createSessionHydrationJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('sessionHydrationWorkflow', (scope) => new SessionHydrationWorkflow({
    stateStore: scope.resolve('sessionRuntimeStateStore'),
    timelineRuntime: scope.resolve('sessionTimelineRuntime'),
    snapshotService: scope.resolve('sessionSnapshotService'),
    agentRuntimeRegistry: scope.resolve('sessionAgentRuntimeRegistry'),
    operationCoordinator: scope.resolve('sessionOperationCoordinator'),
    sessionHydrationJobs: scope.resolve('sessionHydrationJobAdapter'),
  }));
  container.register('sessionApprovalWorkflow', (scope) => new SessionApprovalWorkflow({
    stateStore: scope.resolve('sessionRuntimeStateStore'),
    timelineRuntime: scope.resolve('sessionTimelineRuntime'),
    snapshotService: scope.resolve('sessionSnapshotService'),
    agentRuntimeRegistry: scope.resolve('sessionAgentRuntimeRegistry'),
    operationCoordinator: scope.resolve('sessionOperationCoordinator'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
    emitSessionUpdate: (event) => {
      void parentGatewayEvents?.emit('session:update', event).catch(() => undefined);
    },
  }));
  container.register('sessionModelSelectionWorkflow', (scope) => new SessionModelSelectionWorkflow({
    stateStore: scope.resolve('sessionRuntimeStateStore'),
    timelineRuntime: scope.resolve('sessionTimelineRuntime'),
    snapshotService: scope.resolve('sessionSnapshotService'),
    agentRuntimeRegistry: scope.resolve('sessionAgentRuntimeRegistry'),
    operationCoordinator: scope.resolve('sessionOperationCoordinator'),
  }));
  container.register('sessionLifecycleWorkflow', (scope) => new SessionLifecycleWorkflow({
    sessionCatalog: scope.resolve('sessionCatalogService'),
    sessionCatalogJobs: scope.resolve<SessionCatalogJobPort>('sessionCatalogJobs'),
    sessionStorage: scope.resolve('sessionStorageRepository'),
    stateStore: scope.resolve('sessionRuntimeStateStore'),
    timelineRuntime: scope.resolve('sessionTimelineRuntime'),
    snapshotService: scope.resolve('sessionSnapshotService'),
    agentRuntimeRegistry: scope.resolve('sessionAgentRuntimeRegistry'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
    idGenerator: scope.resolve<RuntimeIdGeneratorPort>('runtime.idGenerator'),
    stopSessionEvents: (context) => {
      const transport = scope.resolve('sessionAgentRuntimeRegistry').resolveTransport(context);
      transport.stopSessionEvents?.(context);
    },
  }));
  container.register('sessionCommandOperationsWorkflow', (scope) => new SessionCommandOperationsWorkflow({
    stateStore: scope.resolve('sessionRuntimeStateStore'),
    sessionLifecycleWorkflow: scope.resolve('sessionLifecycleWorkflow'),
    sessionHydrationWorkflow: scope.resolve('sessionHydrationWorkflow'),
    sessionApprovalWorkflow: scope.resolve('sessionApprovalWorkflow'),
    sessionModelSelectionWorkflow: scope.resolve('sessionModelSelectionWorkflow'),
  }));
  container.register('sessionCommandService', (scope) => new SessionCommandService({
    operationsWorkflow: scope.resolve('sessionCommandOperationsWorkflow'),
  }));
  container.register('sessionRunWorkflow', (scope) => {
    const logger = scope.resolve<RuntimeHostLogger>('logger');
    const terminalDeliveryTrace = createMatchaTerminalDeliveryTraceLogger(logger);
    return new SessionRunWorkflow({
      stateStore: scope.resolve('sessionRuntimeStateStore'),
      timelineRuntime: scope.resolve('sessionTimelineRuntime'),
      snapshotService: scope.resolve('sessionSnapshotService'),
      fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
      clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
      agentRuntimeRegistry: scope.resolve('sessionAgentRuntimeRegistry'),
      operationCoordinator: scope.resolve('sessionOperationCoordinator'),
      workspaceResolver: scope.resolve('openclaw.workspaceService'),
      ingestEndpointConversationEvent: (endpoint, payload) => scope.resolve<SessionGatewayIngressService>('sessionGatewayIngressService')
        .consumeEndpointConversationEvent(endpoint, payload),
      logger,
      terminalDeliveryTrace,
      emitSessionUpdate: (event) => {
        emitSessionUpdateWithTerminalTrace(parentGatewayEvents, terminalDeliveryTrace, event);
      },
    });
  });
  container.register('sessionPromptService', (scope) => new SessionPromptService({
    idGenerator: scope.resolve<RuntimeIdGeneratorPort>('runtime.idGenerator'),
    sessionRunWorkflow: scope.resolve('sessionRunWorkflow'),
  }));
  registerSessionRuntimeCapabilityOperationRoutes(container);
  container.register('sessionRuntimeService', (scope) => new SessionRuntimeService({
    sessionCatalog: scope.resolve('sessionCatalogService'),
    stateStore: scope.resolve('sessionRuntimeStateStore'),
    timelineRuntime: scope.resolve('sessionTimelineRuntime'),
    snapshotService: scope.resolve('sessionSnapshotService'),
    ingressService: scope.resolve('sessionGatewayIngressService'),
    commandService: scope.resolve('sessionCommandService'),
    promptService: scope.resolve('sessionPromptService'),
    operationCoordinator: scope.resolve('sessionOperationCoordinator'),
  }));
  container.register('session.runtime', (scope): SessionRuntimeService => scope.resolve<SessionRuntimeService>('sessionRuntimeService'));
}

export function resolveSessionRuntimeModule(container: RuntimeHostContainer): SessionRuntimeModule {
  return {
    sessionRuntime: container.resolve('sessionRuntimeService'),
    sessionCatalog: container.resolve('sessionCatalogService'),
  };
}

function registerSessionRuntimeCapabilityOperationRoutes(container: RuntimeHostContainer): void {
  container.contribute('agentRuntime.capabilityOperationRoutes', (scope): readonly CapabilityOperationRoute[] => [
    ...createSessionPromptCapabilityOperationRoutes({
      commandService: scope.resolve('sessionCommandService'),
      promptService: scope.resolve('sessionPromptService'),
    }),
    ...createSessionApprovalCapabilityOperationRoutes({
      commandService: scope.resolve('sessionCommandService'),
    }),
    ...createSessionManagementCapabilityOperationRoutes({
      commandService: scope.resolve('sessionCommandService'),
    }),
    ...createSessionModelSelectionCapabilityOperationRoutes({
      commandService: scope.resolve('sessionCommandService'),
    }),
  ]);
}

export function registerSessionRuntimeJobs(
  module: SessionRuntimeModule,
  deps: {
    readonly jobRegistry: RuntimeJobRegistry;
  },
): void {
  registerRuntimeJobDefinitions(deps.jobRegistry, createSessionRuntimeJobDefinitions(module));
}

function createSessionRuntimeJobDefinitions(
  module: SessionRuntimeModule,
): readonly RuntimeJobDefinition[] {
  return [
    {
      type: REFRESH_SESSION_CATALOG_JOB,
      handler: async () => {
        await module.sessionRuntime.refreshSessionCatalog();
      },
    },
    {
      type: HYDRATE_SESSION_TIMELINE_JOB,
      handler: async (payload) => {
        return await module.sessionRuntime.executeSessionHydration(payload);
      },
    },
  ];
}

export function registerSessionRuntimeLifecycle(
  container: RuntimeHostContainer,
  _module: SessionRuntimeModule,
  deps: {
    readonly lifecycle: RuntimeHostLifecycle;
  },
): void {
  registerRuntimeLifecycleDefinitions(deps.lifecycle, {
    cleanupTasks: [
      {
        name: 'sessions.runtime-state',
        run: async () => {
          await container.resolve<SessionRuntimeStateStore>('sessionRuntimeStateStore').flushPersistedStore();
        },
      },
    ],
    backgroundServices: [
      {
        name: 'sessions.catalog-refresh',
        start: () => {
          container.resolve<SessionCatalogJobPort>('sessionCatalogJobs').submitRefreshCatalog();
        },
      },
    ],
  });
}
