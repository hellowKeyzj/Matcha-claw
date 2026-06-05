import type { ApplicationResponse } from '../common/application-response';
import type { CapabilityRouting } from './provider-types';
import type { ProviderModel } from './provider-types';
import type { ProviderCapabilityRoutingWorkflow } from '../workflows/provider-capability-routing/provider-capability-routing-workflow';

export type CapabilityRoutingProjectionModelRef = {
  providerKey: string;
  modelId: string;
};

export type CapabilityRoutingProjectionRoute = {
  primary: CapabilityRoutingProjectionModelRef;
  fallbacks: CapabilityRoutingProjectionModelRef[];
  timeoutMs?: number;
};

export type CapabilityRoutingProjectionValue = {
  chat?: CapabilityRoutingProjectionRoute;
  imageUnderstand?: CapabilityRoutingProjectionRoute;
  imageGenerate?: CapabilityRoutingProjectionRoute;
  videoGenerate?: CapabilityRoutingProjectionRoute;
  musicGenerate?: CapabilityRoutingProjectionRoute;
  tts?: { providerKey: string };
};

export interface CapabilityRoutingProjectionPort {
  read(): Promise<CapabilityRoutingProjectionValue>;
  replace(value: CapabilityRoutingProjectionValue): Promise<void>;
}

export interface CapabilityRoutingApplicationServiceDeps {
  readonly routingWorkflow: Pick<
    ProviderCapabilityRoutingWorkflow,
    'read' | 'write' | 'syncRuntimeProjection' | 'removeCredentialRoutes' | 'pruneUnavailableModelRoutes'
  >;
}

export class CapabilityRoutingApplicationService {
  constructor(private readonly deps: CapabilityRoutingApplicationServiceDeps) {}

  async read(): Promise<CapabilityRouting> {
    return await this.deps.routingWorkflow.read();
  }

  async write(payload: unknown): Promise<ApplicationResponse> {
    return await this.deps.routingWorkflow.write(payload);
  }

  async syncRuntimeProjection(): Promise<void> {
    await this.deps.routingWorkflow.syncRuntimeProjection();
  }

  async removeCredentialRoutes(credentialId: string): Promise<void> {
    await this.deps.routingWorkflow.removeCredentialRoutes(credentialId);
  }

  async pruneUnavailableModelRoutes(models: readonly ProviderModel[]): Promise<void> {
    await this.deps.routingWorkflow.pruneUnavailableModelRoutes(models);
  }
}
