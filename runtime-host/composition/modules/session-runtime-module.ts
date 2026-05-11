import { resolveDeletedPath } from '../../application/sessions/deleted-path';
import { SessionCommandService } from '../../application/sessions/session-command-service';
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
import { SessionRuntimeStateStore } from '../../application/sessions/session-runtime-state';
import { SessionPromptService } from '../../application/sessions/session-prompt-service';
import { SessionSnapshotService } from '../../application/sessions/session-snapshot-service';
import { SessionStorageRepository } from '../../application/sessions/session-storage-repository';
import { SessionExecutionGraphRuntime } from '../../application/sessions/session-execution-graph-runtime';
import { SessionTimelineRuntime } from '../../application/sessions/session-timeline-runtime';
import { SessionTranscriptTimelineLoader } from '../../application/sessions/session-transcript-timeline-loader';
import type { OpenClawWorkspacePort } from '../../application/openclaw/openclaw-workspace-service';
import type { RuntimeClockPort, RuntimeFileSystemPort, RuntimeIdGeneratorPort } from '../../application/common/runtime-ports';
import type { GatewayChatPort, GatewayRpcPort } from '../../application/gateway/gateway-runtime-port';
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

export interface SessionRuntimeModule {
  readonly sessionRuntime: SessionRuntimeService;
  readonly sessionCatalog: SessionCatalogService;
}

export function registerSessionRuntimeModule(
  container: RuntimeHostContainer,
  gateway: () => GatewayChatPort & Pick<GatewayRpcPort, 'gatewayRpc'>,
): void {
  container.register('sessionStorageRepository', (scope) => new SessionStorageRepository({
    workspace: scope.resolve<OpenClawWorkspacePort>('openclaw.workspaceService'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('sessionRuntimeStoreRepository', (scope) => new SessionRuntimeStoreRepository({
    workspace: scope.resolve<OpenClawWorkspacePort>('openclaw.workspaceService'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('sessionMetadataRepository', (scope) => new SessionMetadataRepository({
    workspace: scope.resolve<OpenClawWorkspacePort>('openclaw.workspaceService'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('sessionCatalogService', (scope) => new SessionCatalogService({
    storageRepository: scope.resolve('sessionStorageRepository'),
    metadataRepository: scope.resolve('sessionMetadataRepository'),
  }));
  container.register('sessionCatalogJobs', (scope): SessionCatalogJobPort => createSessionCatalogJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
    scope.resolve<RuntimeLongTaskLookupPort>('runtime.taskLookup'),
  ));
  container.register('sessionRuntimeStateStore', (scope) => new SessionRuntimeStateStore({
    runtimeStore: scope.resolve('sessionRuntimeStoreRepository'),
  }));
  container.register('sessionTranscriptTimelineLoader', (scope) => new SessionTranscriptTimelineLoader({
    sessionStorage: scope.resolve('sessionStorageRepository'),
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
  container.register('sessionSnapshotService', (scope) => new SessionSnapshotService({
    stateStore: scope.resolve('sessionRuntimeStateStore'),
    sessionMetadata: scope.resolve('sessionMetadataRepository'),
    sessionStorage: scope.resolve('sessionStorageRepository'),
  }));
  container.register('sessionGatewayIngressService', (scope) => new SessionGatewayIngressService({
    stateStore: scope.resolve('sessionRuntimeStateStore'),
    timelineRuntime: scope.resolve('sessionTimelineRuntime'),
    snapshotService: scope.resolve('sessionSnapshotService'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('sessionHydrationJobAdapter', (scope): SessionHydrationJobPort => createSessionHydrationJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('sessionCommandService', (scope) => new SessionCommandService({
    resolveDeletedPath,
    sessionCatalog: scope.resolve('sessionCatalogService'),
    sessionCatalogJobs: scope.resolve<SessionCatalogJobPort>('sessionCatalogJobs'),
    sessionStorage: scope.resolve('sessionStorageRepository'),
    stateStore: scope.resolve('sessionRuntimeStateStore'),
    timelineRuntime: scope.resolve('sessionTimelineRuntime'),
    snapshotService: scope.resolve('sessionSnapshotService'),
    gateway: gateway(),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
    idGenerator: scope.resolve<RuntimeIdGeneratorPort>('runtime.idGenerator'),
    sessionHydrationJobs: scope.resolve('sessionHydrationJobAdapter'),
  }));
  container.register('sessionPromptService', (scope) => new SessionPromptService({
    stateStore: scope.resolve('sessionRuntimeStateStore'),
    timelineRuntime: scope.resolve('sessionTimelineRuntime'),
    snapshotService: scope.resolve('sessionSnapshotService'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    idGenerator: scope.resolve<RuntimeIdGeneratorPort>('runtime.idGenerator'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
    gateway: gateway(),
  }));
  container.register('sessionRuntimeService', (scope) => new SessionRuntimeService({
    sessionCatalog: scope.resolve('sessionCatalogService'),
    stateStore: scope.resolve('sessionRuntimeStateStore'),
    timelineRuntime: scope.resolve('sessionTimelineRuntime'),
    snapshotService: scope.resolve('sessionSnapshotService'),
    ingressService: scope.resolve('sessionGatewayIngressService'),
    commandService: scope.resolve('sessionCommandService'),
    promptService: scope.resolve('sessionPromptService'),
  }));
}

export function resolveSessionRuntimeModule(container: RuntimeHostContainer): SessionRuntimeModule {
  return {
    sessionRuntime: container.resolve('sessionRuntimeService'),
    sessionCatalog: container.resolve('sessionCatalogService'),
  };
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
