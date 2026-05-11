import type { OpenClawBridge } from '../openclaw-bridge';
import type { RuntimeHostPlatformFacade } from '../application/platform-runtime';
import type { PluginRuntimePort } from '../application/plugins/plugin-runtime-service';
import type { ParentShellPort } from '../application/runtime-host/parent-shell-port';
import type { RuntimeHostStatePort } from '../application/runtime-host/runtime-state';
import type { SessionRuntimeService } from '../application/sessions/service';
import type { ParentGatewayForwardEventName } from '../shared/parent-transport-contracts';
import type { RuntimeHostTransportStatsSnapshot } from './runtime-host-composition';
import type { OpenClawApplicationServices } from './modules/openclaw-application-module';
import type { OperationsApplicationServices } from './modules/operations-application-module';
import type { RuntimeApplicationServices } from './modules/runtime-application-module';
import type { RuntimeHostContainer } from './container';
import {
  registerRuntimeHostModuleServices,
  resolveRuntimeHostModuleServices,
} from './runtime-host-module-registry';

export interface RuntimeHostApplicationServicesContext {
  container: RuntimeHostContainer;
  runtimeState: {
    runtimeState: RuntimeHostStatePort['runtimeState'];
    runtimeHealth: (state: ReturnType<RuntimeHostStatePort['runtimeState']>) => unknown;
  };
  transportStats: {
    snapshot: () => RuntimeHostTransportStatsSnapshot;
  };
  pluginRuntime: PluginRuntimePort;
  openclawBridge: OpenClawBridge;
  sessionRuntime: SessionRuntimeService;
  platformRuntime: RuntimeHostPlatformFacade;
  parentShell: ParentShellPort;
  parentGatewayEvents: {
    emit: (eventName: ParentGatewayForwardEventName, payload: unknown) => Promise<void>;
  };
}

export interface RuntimeHostApplicationServices extends
  OpenClawApplicationServices,
  RuntimeApplicationServices,
  OperationsApplicationServices {
  readonly sessionRuntime: SessionRuntimeService;
}

export function registerRuntimeHostApplicationServices(context: RuntimeHostApplicationServicesContext): void {
  registerRuntimeHostModuleServices(context);
}

export function resolveRuntimeHostApplicationServices(container: RuntimeHostContainer): RuntimeHostApplicationServices {
  return container.resolve<RuntimeHostApplicationServices>('application.services');
}

export function composeRuntimeHostApplicationServices(
  context: RuntimeHostApplicationServicesContext,
): RuntimeHostApplicationServices {
  return resolveRuntimeHostModuleServices(context);
}
