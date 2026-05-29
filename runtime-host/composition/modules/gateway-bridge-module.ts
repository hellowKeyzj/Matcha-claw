import {
  createOpenClawBridge,
  type OpenClawGatewayClient,
  type OpenClawBridge,
} from '../../openclaw-bridge';
import {
  registerRuntimeLifecycleDefinitions,
  type RuntimeHostLifecycle,
} from '../../core/lifecycle';
import type { OpenClawEnvironmentRepository } from '../../application/openclaw/openclaw-environment-repository';
import type {
  RuntimeSchedulerPort,
  RuntimeSystemEnvironmentPort,
  RuntimeTcpProbePort,
  RuntimeIdGeneratorPort,
  RuntimeClockPort,
  RuntimePlatform,
} from '../../application/common/runtime-ports';
import { parseGatewayPort } from '../../openclaw-bridge/client-auth';
import type {
  GatewayDeviceCryptoPort,
  GatewayDeviceIdentityRepositoryPort,
} from '../../openclaw-bridge/client-auth-ports';
import { buildInitialDiagnostics, createGatewayTransportIssue } from '../../openclaw-bridge/client-state';
import type { SessionRuntimeService } from '../../application/sessions/service';
import type { SettingsRepository } from '../../application/settings/store';
import {
  createRuntimeHostGatewayClient,
} from '../gateway-event-bridge';
import type { ParentTransportClient } from '../parent-transport-client';
import type { RuntimeHostContainer } from '../container';
import type { RuntimeRouteResponse } from '../../api/dispatch/runtime-route-dispatcher';
import type { RuntimeHostLogger } from '../../shared/logger';

export interface GatewayBridgeModule {
  readonly openclawBridge: OpenClawBridge;
  readonly close: () => void;
  readonly setSessionRuntime: (sessionRuntime: SessionRuntimeService) => void;
}

export interface GatewayBridgeModuleDeps {
  readonly parentTransport: ParentTransportClient;
  readonly dispatchRoute: (method: string, route: string, payload: unknown) => Promise<RuntimeRouteResponse | null>;
  readonly systemEnvironment: Pick<RuntimeSystemEnvironmentPort, 'getEnv' | 'platform'>;
  readonly clock: RuntimeClockPort;
  readonly scheduler: RuntimeSchedulerPort;
  readonly tcpProbe: RuntimeTcpProbePort;
  readonly logger?: RuntimeHostLogger;
}

interface RuntimeHostGatewayClient extends OpenClawGatewayClient {
  close: () => void;
}

function createUnavailableGatewayClient(reason: string, clock: RuntimeClockPort): RuntimeHostGatewayClient {
  const issue = createGatewayTransportIssue({
    message: reason,
    source: 'runtime',
    clock,
    code: 'GATEWAY_NOT_CONFIGURED',
  });

  return {
    inspectGatewayControlReadiness: async (methods) => ({
      ready: false,
      phase: 'unavailable',
      requiredMethods: methods,
      missingMethods: methods,
      retryable: false,
      code: 'GATEWAY_NOT_CONFIGURED',
      error: reason,
    }),
    ensureGatewayReady: async () => {
      throw new Error(reason);
    },
    ensureGatewayMethods: async () => {
      throw new Error(reason);
    },
    inspectGatewayMethodReadiness: async (methods) => ({
      ready: false,
      methods,
      missingMethods: methods,
    }),
    readGatewayCapabilities: async () => null,
    gatewayRpc: async () => {
      throw new Error(reason);
    },
    isGatewayRunning: async () => false,
    readGatewayConnectionState: async () => ({
      state: 'disconnected',
      portReachable: false,
      gatewayReady: false,
      healthSummary: 'unresponsive',
      transportEpoch: 0,
      lastError: reason,
      lastIssue: issue,
      diagnostics: buildInitialDiagnostics(),
      updatedAt: clock.nowMs(),
    }),
    buildSecurityAuditQueryParams: (url) => {
      const output: Record<string, string> = {};
      for (const [key, value] of url.searchParams.entries()) {
        if (!value) {
          continue;
        }
        output[key] = value;
      }
      return output;
    },
    close: () => undefined,
  };
}

function createGatewayClientForEnvironment(deps: {
  readonly parentTransport: ParentTransportClient;
  readonly dispatchRoute: (method: string, route: string, payload: unknown) => Promise<RuntimeRouteResponse | null>;
  readonly getSessionRuntime: () => SessionRuntimeService | null;
  readonly runtimeHostDataDir: string;
  readonly rawGatewayPort: string;
  readonly readGatewayToken: () => Promise<string>;
  readonly platform: RuntimePlatform;
  readonly clock: RuntimeClockPort;
  readonly idGenerator: RuntimeIdGeneratorPort;
  readonly identityRepository: GatewayDeviceIdentityRepositoryPort;
  readonly deviceCrypto: GatewayDeviceCryptoPort;
  readonly scheduler: RuntimeSchedulerPort;
  readonly tcpProbe: RuntimeTcpProbePort;
  readonly logger?: RuntimeHostLogger;
}): RuntimeHostGatewayClient {
  try {
    const gatewayPort = parseGatewayPort(deps.rawGatewayPort);
    return createRuntimeHostGatewayClient({
      parentTransport: deps.parentTransport,
      dispatchRoute: deps.dispatchRoute,
      getSessionRuntime: deps.getSessionRuntime,
      runtimeHostDataDir: deps.runtimeHostDataDir,
      gatewayPort,
      readGatewayToken: deps.readGatewayToken,
      platform: deps.platform,
      clock: deps.clock,
      idGenerator: deps.idGenerator,
      identityRepository: deps.identityRepository,
      deviceCrypto: deps.deviceCrypto,
      scheduler: deps.scheduler,
      tcpProbe: deps.tcpProbe,
      logger: deps.logger,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createUnavailableGatewayClient(message, deps.clock);
  }
}

export function registerGatewayBridgeModule(
  container: RuntimeHostContainer,
  deps: GatewayBridgeModuleDeps,
): void {
  let sessionRuntimeService: SessionRuntimeService | null = null;
  container.register('gateway.bridgeClient', (scope) => {
    const environmentRepository = scope.resolve<Pick<OpenClawEnvironmentRepository, 'getRuntimeHostDataDir'>>('openclaw.environmentRepository');
    const settingsRepository = scope.resolve<Pick<SettingsRepository, 'getAll'>>('settings.repository');
    return createGatewayClientForEnvironment({
      parentTransport: deps.parentTransport,
      dispatchRoute: deps.dispatchRoute,
      getSessionRuntime: () => sessionRuntimeService,
      runtimeHostDataDir: environmentRepository.getRuntimeHostDataDir(),
      rawGatewayPort: deps.systemEnvironment.getEnv('MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT'),
      readGatewayToken: async () => {
        const settings = await settingsRepository.getAll();
        return typeof settings.gatewayToken === 'string' ? settings.gatewayToken : '';
      },
      platform: deps.systemEnvironment.platform,
      clock: deps.clock,
      idGenerator: scope.resolve<RuntimeIdGeneratorPort>('runtime.idGenerator'),
      identityRepository: scope.resolve<GatewayDeviceIdentityRepositoryPort>('gateway.deviceIdentityRepository'),
      deviceCrypto: scope.resolve<GatewayDeviceCryptoPort>('gateway.deviceCrypto'),
      scheduler: deps.scheduler,
      tcpProbe: deps.tcpProbe,
      logger: deps.logger,
    });
  });
  container.register('gateway.openclawBridge', (scope) => createOpenClawBridge(
    scope.resolve<RuntimeHostGatewayClient>('gateway.bridgeClient'),
  ));
  container.register('gateway.bridge', (scope): GatewayBridgeModule => {
    const gatewayClient = scope.resolve<RuntimeHostGatewayClient>('gateway.bridgeClient');
    return {
      openclawBridge: scope.resolve<OpenClawBridge>('gateway.openclawBridge'),
      close: () => {
        gatewayClient.close();
      },
      setSessionRuntime: (sessionRuntime) => {
        sessionRuntimeService = sessionRuntime;
      },
    };
  });
}

export function resolveGatewayBridgeModule(container: RuntimeHostContainer): GatewayBridgeModule {
  return container.resolve('gateway.bridge');
}

export function registerGatewayBridgeLifecycle(
  module: GatewayBridgeModule,
  deps: {
    readonly lifecycle: RuntimeHostLifecycle;
  },
): void {
  registerRuntimeLifecycleDefinitions(deps.lifecycle, {
    cleanupTasks: [
      {
        name: 'gateway.bridge',
        run: () => module.close(),
      },
    ],
  });
}
