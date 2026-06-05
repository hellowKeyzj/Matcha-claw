import { ApplicationServiceRegistry } from './application-service-registry';
import type { RuntimeHostContainer } from './container';
import {
  connectRuntimeHostModuleServices,
  registerRuntimeHostModuleServices,
} from './runtime-host-module-registry';

export interface RuntimeHostApplicationServicesContext {
  container: RuntimeHostContainer;
  facades: ApplicationServiceRegistry;
}

export function createApplicationServiceRegistry(): ApplicationServiceRegistry {
  return new ApplicationServiceRegistry();
}

export function registerRuntimeHostApplicationServices(context: RuntimeHostApplicationServicesContext): void {
  registerRuntimeHostModuleServices(context);
  connectRuntimeHostModuleServices(context);
}
