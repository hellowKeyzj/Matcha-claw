import path from 'node:path';
import { remoteFleetRoutes } from '../../api/routes/remote-fleet-routes';
import {
  FileRemoteFleetCredentialStore,
  WorkerBackedRemoteFleetService,
  createRemoteFleetBootstrapDispatcher,
  createRemoteFleetChainedSecretResolver,
  createRemoteFleetDockerBootstrapProvider,
  createRemoteFleetEnvironmentSecretResolver,
  createRemoteFleetHttpRuntimeAgentTransport,
  createRemoteFleetCustomTerminalProvider,
  createRemoteFleetK8sBootstrapProvider,
  createRemoteFleetRuntimeAgentTransportDispatcher,
  createRemoteFleetSshBootstrapProvider,
  createRemoteFleetSshTerminalProvider,
  createRemoteFleetTerminalDockerProvider,
  createRemoteFleetTerminalK8sProvider,
  createRemoteFleetVmTerminalProvider,
  type RemoteFleetBootstrapProvider,
  type RemoteFleetCapabilityRegistryPort,
  type RemoteFleetPort,
  type RemoteFleetSnapshot,
} from '../../application/remote-fleet';
import { REMOTE_FLEET_RUNTIME_AGENT_INGRESS_PATH } from '../../application/remote-fleet/remote-fleet-agent-ingress';
import { createRemoteFleetCapabilityOperationRoutes } from '../../application/remote-fleet/remote-fleet-capability-routes';
import { RemoteFleetTerminalManager } from '../../application/remote-fleet/remote-fleet-terminal-manager';
import {
  createRemoteFleetTerminalProviderRegistry,
  type RemoteFleetTerminalProvider,
} from '../../application/remote-fleet/remote-fleet-terminal-providers';
import type { CapabilityOperationRoute } from '../../application/capabilities/contracts/capability-router';
import type {
  RuntimeCommandExecutorPort,
  RuntimeDataRootPort,
  RuntimeHttpClientPort,
  RuntimeSystemEnvironmentPort,
  RuntimeTimerPort,
} from '../../application/common/runtime-ports';
import type { RuntimeHostLifecycle } from '../../core/lifecycle';
import type { RuntimeHostLogger } from '../../shared/logger';
import { registerRuntimeLifecycleDefinitions } from '../../core/lifecycle';
import type { ApplicationServiceRegistry } from '../application-service-registry';
import type { RuntimeHostContainer } from '../container';
import type { RuntimeHostRouteRegistry } from '../route-registry';
import { REMOTE_FLEET_SERVICE_TOKEN } from '../runtime-host-tokens';

export function registerRemoteFleetApplicationServices(
  container: RuntimeHostContainer,
  facades: ApplicationServiceRegistry,
): void {
  registerRemoteFleetBootstrapProviders(container);
  registerRemoteFleetTerminalProviders(container);
  container.register('remoteFleet.terminalManager', (scope) => {
    const runtimeDataRootDir = scope.resolve<RuntimeDataRootPort>('runtimeHost.runtimeDataRoot').getRuntimeDataRootDir();
    const credentialStore = new FileRemoteFleetCredentialStore({ runtimeDataRootDir });
    const secretResolver = createRemoteFleetChainedSecretResolver([
      credentialStore,
      createRemoteFleetEnvironmentSecretResolver({
        environment: scope.resolve<RuntimeSystemEnvironmentPort>('runtime.systemEnvironment'),
      }),
    ]);
    return new RemoteFleetTerminalManager({
      providers: createRemoteFleetTerminalProviderRegistry(scope.resolveContributions<RemoteFleetTerminalProvider>('remoteFleet.terminalProviders')),
      secretResolver,
      logger: scope.resolve<RuntimeHostLogger>('logger'),
    });
  });
  container.register('remoteFleet.service', (scope) => {
    const runtimeDataRootDir = scope.resolve<RuntimeDataRootPort>('runtimeHost.runtimeDataRoot').getRuntimeDataRootDir();
    const runtimeAgentIngressUrl = resolveRuntimeAgentIngressUrl(
      scope.resolve<RuntimeSystemEnvironmentPort>('runtime.systemEnvironment'),
    );
    const credentialStore = new FileRemoteFleetCredentialStore({ runtimeDataRootDir });
    const secretResolver = createRemoteFleetChainedSecretResolver([
      credentialStore,
      createRemoteFleetEnvironmentSecretResolver({
        environment: scope.resolve<RuntimeSystemEnvironmentPort>('runtime.systemEnvironment'),
      }),
    ]);
    const httpClient = scope.resolve<RuntimeHttpClientPort>('runtime.httpClient');
    const logger = scope.resolve<RuntimeHostLogger>('logger');
    const runtimeAgentDispatcher = createRemoteFleetRuntimeAgentTransportDispatcher({
      transport: createRemoteFleetHttpRuntimeAgentTransport({
        httpClient,
      }),
      secretResolver,
      logger,
    });
    const bootstrapDispatcher = createRemoteFleetBootstrapDispatcher({
      httpClient,
      commandExecutor: scope.resolve<RuntimeCommandExecutorPort>('runtime.commandExecutor'),
      timer: scope.resolve<RuntimeTimerPort>('runtime.timer'),
      logger,
      secretResolver,
      providers: scope.resolveContributions<RemoteFleetBootstrapProvider>('remoteFleet.bootstrapProviders'),
    });

    return new WorkerBackedRemoteFleetService({
      workerScriptPath: path.join(__dirname, '../../application/remote-fleet/infrastructure/worker/remote-fleet-worker-entry.js'),
      config: {
        runtimeDataRootDir,
        runtimeAgentIngressUrl,
      },
      capabilityRegistry: scope.resolve<RemoteFleetCapabilityRegistryPort>('agentRuntime.registry'),
      secretResolver,
      credentialWriter: {
        async writeCredential(input) {
          return await credentialStore.writeCredential(input);
        },
        async lookupWriteReceipt(input) {
          return await credentialStore.lookupWriteReceipt(input);
        },
      },
      runtimeAgentDispatcher,
      bootstrapDispatcher,
      terminalHost: scope.resolve<RemoteFleetTerminalManager>('remoteFleet.terminalManager'),
      logger,
    });
  });
  registerRemoteFleetCapabilityOperationRoutes(container);
  facades.registerContainerFacade('remote-fleet', REMOTE_FLEET_SERVICE_TOKEN, container);
}

function resolveRuntimeAgentIngressUrl(environment: RuntimeSystemEnvironmentPort): string | undefined {
  const value = environment.getEnv('MATCHACLAW_REMOTE_FLEET_AGENT_INGRESS_URL');
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.href.includes('?')
      || url.href.includes('#')
      || url.pathname !== REMOTE_FLEET_RUNTIME_AGENT_INGRESS_PATH
    ) {
      throw new Error('invalid runtime agent ingress URL');
    }
    return value;
  } catch {
    throw new Error('MATCHACLAW_REMOTE_FLEET_AGENT_INGRESS_URL must be a valid RuntimeAgent ingress URL.');
  }
}

function registerRemoteFleetBootstrapProviders(container: RuntimeHostContainer): void {
  container.contribute('remoteFleet.bootstrapProviders', () => createRemoteFleetSshBootstrapProvider());
  container.contribute('remoteFleet.bootstrapProviders', () => createRemoteFleetDockerBootstrapProvider());
  container.contribute('remoteFleet.bootstrapProviders', () => createRemoteFleetK8sBootstrapProvider());
}

function registerRemoteFleetTerminalProviders(container: RuntimeHostContainer): void {
  container.contribute('remoteFleet.terminalProviders', () => createRemoteFleetSshTerminalProvider());
  container.contribute('remoteFleet.terminalProviders', () => createRemoteFleetVmTerminalProvider());
  container.contribute('remoteFleet.terminalProviders', () => createRemoteFleetTerminalDockerProvider());
  container.contribute('remoteFleet.terminalProviders', (scope) => createRemoteFleetTerminalK8sProvider({
    httpClient: scope.resolve<RuntimeHttpClientPort>('runtime.httpClient'),
  }));
  container.contribute('remoteFleet.terminalProviders', (scope) => createRemoteFleetCustomTerminalProvider({
    capabilityReader: {
      async readSnapshot() {
        const response = await scope.resolve<RemoteFleetPort>('remoteFleet.service').invoke('snapshot', {});
        return response.status === 200 ? response.data as RemoteFleetSnapshot : undefined;
      },
    },
  }));
}

function registerRemoteFleetCapabilityOperationRoutes(container: RuntimeHostContainer): void {
  container.contribute('agentRuntime.capabilityOperationRoutes', (scope): readonly CapabilityOperationRoute[] => (
    createRemoteFleetCapabilityOperationRoutes({
      remoteFleetService: scope.resolve<RemoteFleetPort>('remoteFleet.service'),
    })
  ));
}

export function registerRemoteFleetApplicationLifecycle(
  container: RuntimeHostContainer,
  deps: {
    readonly lifecycle: RuntimeHostLifecycle;
  },
): void {
  registerRuntimeLifecycleDefinitions(deps.lifecycle, {
    cleanupTasks: [
      {
        name: 'remote-fleet.worker',
        run: () => {
          closeRemoteFleetWorker(container);
        },
      },
      {
        name: 'remote-fleet.terminal-manager',
        run: () => {
          container.resolve<RemoteFleetTerminalManager>('remoteFleet.terminalManager').dispose();
        },
      },
    ],
  });
}

function closeRemoteFleetWorker(container: RuntimeHostContainer): void {
  void container.resolve<RemoteFleetPort>('remoteFleet.service').close?.();
}

export function registerRemoteFleetRoutes(
  routes: RuntimeHostRouteRegistry,
  deps: {
    readonly remoteFleetService: RemoteFleetPort;
  },
): void {
  routes.registerDefinitions('remote_fleet', remoteFleetRoutes, {
    remoteFleetService: deps.remoteFleetService,
  });
}
