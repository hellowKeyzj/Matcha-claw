import { SessionCatalogService, type SessionCatalogPort } from '../../../runtime-host/application/sessions/session-catalog';
import { SessionCommandService } from '../../../runtime-host/application/sessions/session-command-service';
import { SessionCommandOperationsWorkflow } from '../../../runtime-host/application/workflows/session-command/session-command-operations-workflow';
import { SessionGatewayIngressService } from '../../../runtime-host/application/sessions/session-gateway-ingress-service';
import { SessionMetadataRepository, type SessionMetadataPort } from '../../../runtime-host/application/sessions/session-metadata-repository';
import { OpenClawSessionArtefactResolver } from '../../../runtime-host/application/adapters/openclaw/runtime/openclaw-session-artefact-resolver';
import { OpenClawSessionMetadataResolver } from '../../../runtime-host/application/adapters/openclaw/runtime/openclaw-session-metadata-resolver';
import { SessionRuntimeStoreRepository, type SessionRuntimeStorePort } from '../../../runtime-host/application/sessions/session-runtime-store-repository';
import { SessionRuntimeStorePersistenceWorkflow } from '../../../runtime-host/application/workflows/session-runtime-store/session-runtime-store-persistence-workflow';
import { SessionRuntimeStateStore } from '../../../runtime-host/application/sessions/session-runtime-state';
import { SessionPromptService } from '../../../runtime-host/application/sessions/session-prompt-service';
import { SessionRunWorkflow } from '../../../runtime-host/application/workflows/session-run/session-run-workflow';
import { SessionGatewayIngressWorkflow } from '../../../runtime-host/application/workflows/session-gateway-ingress/session-gateway-ingress-workflow';
import { SessionHydrationWorkflow } from '../../../runtime-host/application/workflows/session-hydration/session-hydration-workflow';
import { SessionLifecycleWorkflow } from '../../../runtime-host/application/workflows/session-lifecycle/session-lifecycle-workflow';
import { SessionCatalogWorkflow } from '../../../runtime-host/application/workflows/session-catalog/session-catalog-workflow';
import { SessionModelResolutionWorkflow } from '../../../runtime-host/application/workflows/session-metadata/session-model-resolution-workflow';
import { SessionOperationResultWorkflow } from '../../../runtime-host/application/workflows/session-operation/session-operation-result-workflow';
import { SessionStorageIndexWorkflow, type SessionStorageSessionIdentityResolverPort } from '../../../runtime-host/application/workflows/session-storage/session-storage-index-workflow';
import { SessionStorageMutationWorkflow } from '../../../runtime-host/application/workflows/session-storage/session-storage-mutation-workflow';
import { SessionStorageRepositoryWorkflow } from '../../../runtime-host/application/workflows/session-storage/session-storage-repository-workflow';
import { SessionStorageTranscriptWorkflow } from '../../../runtime-host/application/workflows/session-storage/session-storage-transcript-workflow';
import { SessionApprovalWorkflow } from '../../../runtime-host/application/workflows/session-approval/session-approval-workflow';
import { SessionModelSelectionWorkflow } from '../../../runtime-host/application/workflows/session-model-selection/session-model-selection-workflow';
import { SessionSnapshotWorkflow } from '../../../runtime-host/application/workflows/session-snapshot/session-snapshot-workflow';
import { SessionRuntimeService } from '../../../runtime-host/application/sessions/service';
import { SessionSnapshotService } from '../../../runtime-host/application/sessions/session-snapshot-service';
import { SessionStorageRepository, type SessionStoragePort } from '../../../runtime-host/application/sessions/session-storage-repository';
import { SessionTranscriptTimelineLoader } from '../../../runtime-host/application/sessions/session-transcript-timeline-loader';
import { SessionExecutionGraphRuntime } from '../../../runtime-host/application/sessions/session-execution-graph-runtime';
import { SessionTimelineRuntime } from '../../../runtime-host/application/sessions/session-timeline-runtime';
import { SessionOperationCoordinator } from '../../../runtime-host/application/sessions/session-operation-coordinator';
import type { SessionHydrationJobPort } from '../../../runtime-host/application/sessions/session-hydration-jobs';
import type { SessionCatalogJobPort } from '../../../runtime-host/application/sessions/session-catalog-jobs';
import type { OpenClawWorkspacePort } from '../../../runtime-host/application/adapters/openclaw/infrastructure/openclaw-workspace-service';
import { createTestRuntimeFileSystem } from './runtime-file-system';
import { createTestRuntimeIdGenerator } from './runtime-id-generator';
import { AgentRuntimeRegistry } from '../../../runtime-host/application/agent-runtime/contracts/agent-runtime-registry';
import { OpenClawRuntimeAdapter } from '../../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-adapter';
import { createTestAcpClientConnector } from './acp-test-connector';
import { validateSessionIdentity, type SessionIdentity } from '../../../runtime-host/application/agent-runtime/contracts/runtime-address';
import { createOpenClawTestSessionIdentity } from './runtime-address-fixtures';
export { createOpenClawTestRuntimeContext, createOpenClawTestSessionIdentity, openClawTestRuntimeEndpoint, openClawTestRuntimeIdentity } from './runtime-address-fixtures';

function createTestSessionStorageIdentityResolver(): SessionStorageSessionIdentityResolverPort {
  return {
    resolveStorageSessionIdentity: ({ agentId, sessionKey, sessionStoreEntry }) => {
      const stored = sessionStoreEntry?.sessionIdentity;
      if (validateSessionIdentity(stored) === null) {
        const identity = stored as SessionIdentity;
        if (identity.agentId === agentId && identity.sessionKey === sessionKey) {
          return identity;
        }
      }
      return createOpenClawTestSessionIdentity(sessionKey, agentId);
    },
  };
}

export interface TestSessionRuntimeServiceDeps {
  workspace: Pick<OpenClawWorkspacePort, 'getConfigDir'>;
  sessionCatalog?: SessionCatalogPort;
  sessionCatalogJobs?: Pick<SessionCatalogJobPort, 'submitRefreshCatalog' | 'getRefreshCatalogJob'>;
  sessionMetadata?: SessionMetadataPort;
  sessionStorage?: SessionStoragePort;
  sessionRuntimeStore?: SessionRuntimeStorePort;
  sessionHydrationJobs?: SessionHydrationJobPort;
  emitSessionUpdate?: ConstructorParameters<typeof SessionPromptService>[0]['emitSessionUpdate'];
  openclawBridge: {
    chatSend: (params: Record<string, unknown>) => Promise<unknown>;
    gatewayRpc?: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  };
  agentRuntimeRegistry?: AgentRuntimeRegistry;
  stopSessionEvents?: ConstructorParameters<typeof SessionLifecycleWorkflow>[0]['stopSessionEvents'];
}

export function createTestSessionCatalogService(input: {
  workspace: Pick<OpenClawWorkspacePort, 'getConfigDir'>;
  storageRepository?: SessionStoragePort;
  metadataRepository?: SessionMetadataPort;
  agentRuntimeRegistry?: AgentRuntimeRegistry;
}): SessionCatalogService {
  const fileSystem = createTestRuntimeFileSystem();
  const externalArtefactResolver = new OpenClawSessionArtefactResolver();
  const storageRepository = input.storageRepository ?? new SessionStorageRepository({
    repositoryWorkflow: new SessionStorageRepositoryWorkflow({
      indexWorkflow: new SessionStorageIndexWorkflow({
        workspace: input.workspace,
        fileSystem,
        sessionIdentityResolver: createTestSessionStorageIdentityResolver(),
      }),
      mutationWorkflow: new SessionStorageMutationWorkflow({
        fileSystem,
        externalArtefactResolver,
      }),
      transcriptWorkflow: new SessionStorageTranscriptWorkflow({
        fileSystem,
      }),
    }),
  });
  const metadataRepository = input.metadataRepository ?? new SessionMetadataRepository({
    modelResolutionWorkflow: new SessionModelResolutionWorkflow(),
  });
  const agentRuntimeRegistry = input.agentRuntimeRegistry ?? createTestAgentRuntimeRegistry({
    chatSend: async () => ({ success: true }),
    gatewayRpc: async () => ({}),
  });
  return new SessionCatalogService({
    catalogWorkflow: new SessionCatalogWorkflow({
      storageRepository,
      metadataRepository,
      agentRuntimeRegistry,
    }),
  });
}

function createTestAgentRuntimeRegistry(openclawBridge: { chatSend: (payload: unknown) => Promise<unknown>; gatewayRpc: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown> }): AgentRuntimeRegistry {
  const agentRuntimeRegistry = new AgentRuntimeRegistry({ gateway: () => openclawBridge });
  agentRuntimeRegistry.register({
    runtimeAdapters: [new OpenClawRuntimeAdapter()],
    protocolConnectors: [createTestAcpClientConnector()],
  });
  return agentRuntimeRegistry;
}

export function createTestSessionRuntimeService(deps: TestSessionRuntimeServiceDeps): SessionRuntimeService {
  const fileSystem = createTestRuntimeFileSystem();
  const idGenerator = createTestRuntimeIdGenerator();
  const clock = {
    nowMs: () => 1_700_000_000_000,
    nowIso: () => '2023-11-14T22:13:20.000Z',
  };
  const externalArtefactResolver = new OpenClawSessionArtefactResolver();
  const sessionStorage = deps.sessionStorage ?? new SessionStorageRepository({
    repositoryWorkflow: new SessionStorageRepositoryWorkflow({
      indexWorkflow: new SessionStorageIndexWorkflow({
        workspace: deps.workspace,
        fileSystem,
        sessionIdentityResolver: createTestSessionStorageIdentityResolver(),
      }),
      mutationWorkflow: new SessionStorageMutationWorkflow({
        fileSystem,
        externalArtefactResolver,
      }),
      transcriptWorkflow: new SessionStorageTranscriptWorkflow({
        fileSystem,
      }),
    }),
  });
  const sessionMetadata = deps.sessionMetadata ?? new SessionMetadataRepository({
    modelResolutionWorkflow: new SessionModelResolutionWorkflow({
      defaultModelResolver: new OpenClawSessionMetadataResolver({
        read: async () => {
          try {
            return JSON.parse(await fileSystem.readTextFile(`${deps.workspace.getConfigDir()}/openclaw.json`)) as Record<string, unknown>;
          } catch {
            return {};
          }
        },
      }),
    }),
  });
  const sessionRuntimeStore = deps.sessionRuntimeStore ?? new SessionRuntimeStoreRepository({
    persistenceWorkflow: new SessionRuntimeStorePersistenceWorkflow({
      workspace: deps.workspace,
      fileSystem,
    }),
  });
  const operationCoordinator = new SessionOperationCoordinator(new SessionOperationResultWorkflow());
  const agentRuntimeRegistry = deps.agentRuntimeRegistry ?? createTestAgentRuntimeRegistry(deps.openclawBridge);
  const sessionCatalog = deps.sessionCatalog ?? new SessionCatalogService({
    catalogWorkflow: new SessionCatalogWorkflow({
      storageRepository: sessionStorage,
      metadataRepository: sessionMetadata,
      agentRuntimeRegistry,
    }),
  });
  const stateStore = new SessionRuntimeStateStore({
    runtimeStore: sessionRuntimeStore,
    agentRuntimeRegistry,
  });
  const transcriptLoader = new SessionTranscriptTimelineLoader({
    sessionStorage,
    agentRuntimeRegistry,
  });
  const executionGraphRuntime = new SessionExecutionGraphRuntime({
    stateStore,
  });
  const timelineRuntime = new SessionTimelineRuntime({
    stateStore,
    sessionStorage,
    transcriptLoader,
    executionGraphRuntime,
    clock,
  });
  const snapshotService = new SessionSnapshotService({
    snapshotWorkflow: new SessionSnapshotWorkflow({
      stateStore,
      sessionMetadata,
      sessionStorage,
    }),
  });
  const ingressWorkflow = new SessionGatewayIngressWorkflow({
    stateStore,
    timelineRuntime,
    snapshotService,
    clock,
    agentRuntimeRegistry,
  });
  const ingressService = new SessionGatewayIngressService({
    ingressWorkflow,
    emitSessionUpdate: deps.emitSessionUpdate,
  });
  const sessionHydrationWorkflow = new SessionHydrationWorkflow({
    stateStore,
    timelineRuntime,
    snapshotService,
    agentRuntimeRegistry,
    operationCoordinator,
    sessionHydrationJobs: deps.sessionHydrationJobs ?? {
      submitSessionHydration: ({ sessionKey, snapshot }) => ({
        success: true,
        job: {
          id: `test-session-hydration:${sessionKey}:${snapshot.kind}`,
          type: 'sessions.hydrateTimeline',
          status: 'queued',
          queuedAt: clock.nowMs(),
          attempts: 0,
          maxAttempts: 1,
        },
      }),
    },
  });
  const sessionApprovalWorkflow = new SessionApprovalWorkflow({
    stateStore,
    timelineRuntime,
    snapshotService,
    agentRuntimeRegistry,
    operationCoordinator,
    clock,
    emitSessionUpdate: deps.emitSessionUpdate,
  });
  const sessionModelSelectionWorkflow = new SessionModelSelectionWorkflow({
    stateStore,
    timelineRuntime,
    snapshotService,
    agentRuntimeRegistry,
    operationCoordinator,
  });
  const sessionCatalogJobs = deps.sessionCatalogJobs ?? {
    submitRefreshCatalog: () => ({
      success: true,
      job: {
        id: 'test-session-catalog-refresh',
        type: 'sessions.refreshCatalog',
        queue: 'low',
        status: 'succeeded',
        queuedAt: clock.nowMs(),
        finishedAt: clock.nowMs(),
        attempts: 1,
        maxAttempts: 1,
      },
    }),
    getRefreshCatalogJob: () => null,
  };
  const sessionLifecycleWorkflow = new SessionLifecycleWorkflow({
    sessionCatalog,
    sessionCatalogJobs,
    sessionStorage,
    stateStore,
    timelineRuntime,
    snapshotService,
    agentRuntimeRegistry,
    clock,
    idGenerator,
    stopSessionEvents: deps.stopSessionEvents,
  });
  const commandService = new SessionCommandService({
    operationsWorkflow: new SessionCommandOperationsWorkflow({
      stateStore,
      sessionLifecycleWorkflow,
      sessionHydrationWorkflow,
      sessionApprovalWorkflow,
      sessionModelSelectionWorkflow,
    }),
  });
  const sessionRunWorkflow = new SessionRunWorkflow({
    stateStore,
    timelineRuntime,
    snapshotService,
    fileSystem,
    clock,
    agentRuntimeRegistry,
    operationCoordinator,
    ingestEndpointConversationEvent: (endpoint, payload) => ingressService.consumeEndpointConversationEvent(endpoint, payload),
    emitSessionUpdate: deps.emitSessionUpdate,
  });
  const promptService = new SessionPromptService({
    idGenerator,
    sessionRunWorkflow,
  });

  return new SessionRuntimeService({
    sessionCatalog,
    stateStore,
    timelineRuntime,
    snapshotService,
    ingressService,
    commandService,
    promptService,
    operationCoordinator,
  });
}
