import { SessionCatalogService, type SessionCatalogPort } from '../../../runtime-host/application/sessions/session-catalog';
import { SessionCommandService } from '../../../runtime-host/application/sessions/session-command-service';
import { SessionGatewayIngressService } from '../../../runtime-host/application/sessions/session-gateway-ingress-service';
import { SessionMetadataRepository, type SessionMetadataPort } from '../../../runtime-host/application/sessions/session-metadata-repository';
import { SessionRuntimeStoreRepository, type SessionRuntimeStorePort } from '../../../runtime-host/application/sessions/session-runtime-store-repository';
import { SessionRuntimeStateStore } from '../../../runtime-host/application/sessions/session-runtime-state';
import { SessionPromptService } from '../../../runtime-host/application/sessions/session-prompt-service';
import { SessionRuntimeService } from '../../../runtime-host/application/sessions/service';
import { SessionSnapshotService } from '../../../runtime-host/application/sessions/session-snapshot-service';
import { SessionStorageRepository, type SessionStoragePort } from '../../../runtime-host/application/sessions/session-storage-repository';
import { SessionTranscriptTimelineLoader } from '../../../runtime-host/application/sessions/session-transcript-timeline-loader';
import { SessionExecutionGraphRuntime } from '../../../runtime-host/application/sessions/session-execution-graph-runtime';
import { SessionTimelineRuntime } from '../../../runtime-host/application/sessions/session-timeline-runtime';
import { SessionOperationCoordinator } from '../../../runtime-host/application/sessions/session-operation-coordinator';
import type { SessionHydrationJobPort } from '../../../runtime-host/application/sessions/session-hydration-jobs';
import type { SessionCatalogJobPort } from '../../../runtime-host/application/sessions/session-catalog-jobs';
import { PendingApprovalStore } from '../../../runtime-host/application/sessions/pending-approval-store';
import type { OpenClawWorkspacePort } from '../../../runtime-host/application/openclaw/openclaw-workspace-service';
import { createTestRuntimeFileSystem } from './runtime-file-system';
import { createTestRuntimeIdGenerator } from './runtime-id-generator';

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
}

export function createTestSessionCatalogService(input: {
  workspace: Pick<OpenClawWorkspacePort, 'getConfigDir'>;
  storageRepository?: SessionStoragePort;
  metadataRepository?: SessionMetadataPort;
}): SessionCatalogService {
  const fileSystem = createTestRuntimeFileSystem();
  const storageRepository = input.storageRepository ?? new SessionStorageRepository({
    workspace: input.workspace,
    fileSystem,
  });
  const metadataRepository = input.metadataRepository ?? new SessionMetadataRepository({
    workspace: input.workspace,
    fileSystem,
  });
  return new SessionCatalogService({
    storageRepository,
    metadataRepository,
  });
}

export function createTestSessionRuntimeService(deps: TestSessionRuntimeServiceDeps): SessionRuntimeService {
  const fileSystem = createTestRuntimeFileSystem();
  const idGenerator = createTestRuntimeIdGenerator();
  const clock = {
    nowMs: () => 1_700_000_000_000,
    nowIso: () => '2023-11-14T22:13:20.000Z',
  };
  const sessionStorage = deps.sessionStorage ?? new SessionStorageRepository({
    workspace: deps.workspace,
    fileSystem,
  });
  const sessionMetadata = deps.sessionMetadata ?? new SessionMetadataRepository({
    workspace: deps.workspace,
    fileSystem,
  });
  const sessionRuntimeStore = deps.sessionRuntimeStore ?? new SessionRuntimeStoreRepository({
    workspace: deps.workspace,
    fileSystem,
  });
  const sessionCatalog = deps.sessionCatalog ?? new SessionCatalogService({
    storageRepository: sessionStorage,
    metadataRepository: sessionMetadata,
  });
  const stateStore = new SessionRuntimeStateStore({
    runtimeStore: sessionRuntimeStore,
  });
  const operationCoordinator = new SessionOperationCoordinator();
  const transcriptLoader = new SessionTranscriptTimelineLoader({
    sessionStorage,
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
    stateStore,
    sessionMetadata,
    sessionStorage,
  });
  const ingressService = new SessionGatewayIngressService({
    stateStore,
    timelineRuntime,
    snapshotService,
    clock,
  });
  const commandService = new SessionCommandService({
    sessionCatalog,
    sessionCatalogJobs: deps.sessionCatalogJobs ?? {
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
    },
    sessionStorage,
    stateStore,
    timelineRuntime,
    snapshotService,
    gateway: deps.openclawBridge,
    pendingApprovals: new PendingApprovalStore({ clock }),
    operationCoordinator,
    clock,
    idGenerator,
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
  const promptService = new SessionPromptService({
    stateStore,
    timelineRuntime,
    snapshotService,
    fileSystem,
    idGenerator,
    clock,
    gateway: deps.openclawBridge,
    operationCoordinator,
    emitSessionUpdate: deps.emitSessionUpdate,
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
