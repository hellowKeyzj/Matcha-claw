/**
 * Provider models 应用服务。
 *
 * MatchaClaw 的模型事实源是 ProviderModel[]：
 *   { credentialId, modelId, capabilities, contextWindow?, maxTokens?, timeoutMs?, aspectRatio?, resolution?, quality? }
 *
 * runtime model projection 只是输出适配格式。
 */

import type { ApplicationResponse } from '../common/application-response';
import type { ProviderModelsOperationsWorkflow } from '../workflows/provider-model/provider-models-operations-workflow';
import type {
  RuntimeCustomMediaProjectionMap,
  RuntimeCustomMediaProviderMap,
  RuntimeConfigProviderModelsMap,
  RuntimeConfigProviderModelsProjectionMap,
} from '../workflows/provider-model/provider-models-projection-workflow';
import type { ProviderModel } from './provider-types';

export interface ProviderModelsProjectionPort {
  readAll(): Promise<RuntimeConfigProviderModelsMap>;
  replaceAll(providerMap: RuntimeConfigProviderModelsProjectionMap, validModelRefs: readonly string[]): Promise<void>;
}

export interface CustomMediaProviderProjectionPort {
  readAll(): Promise<RuntimeCustomMediaProviderMap>;
  replaceAll(providerMap: RuntimeCustomMediaProjectionMap): Promise<void>;
}

export interface ProviderModelsAgentIdentityPort {
  discoverAgentIds(): Promise<string[]>;
}

export interface ProviderModelsAgentProjectionPort {
  upsertProviderInAgentModels(input: {
    agentIds: readonly string[];
    provider: string;
    entry: Record<string, unknown>;
  }): Promise<void>;
}

export interface ProviderModelsApplicationServiceDeps {
  readonly operationsWorkflow: Pick<
    ProviderModelsOperationsWorkflow,
    'readAll' | 'read' | 'readSelectable' | 'replace' | 'removeCredentialModels' | 'syncRuntimeProjection'
  >;
}

export class ProviderModelsApplicationService {
  constructor(private readonly deps: ProviderModelsApplicationServiceDeps) {}

  async readAll(): Promise<{ models: Array<ProviderModel & { label?: string }> }> {
    return await this.deps.operationsWorkflow.readAll();
  }

  async read(credentialId: string): Promise<{ credentialId: string; models: ProviderModel[] }> {
    return await this.deps.operationsWorkflow.read(credentialId);
  }

  async readSelectable(): Promise<{
    models: Array<ProviderModel & {
      providerKey: string;
      runtimeModelRef: string;
      label: string;
    }>;
  }> {
    return await this.deps.operationsWorkflow.readSelectable();
  }

  async replace(credentialId: string, payload: unknown): Promise<ApplicationResponse> {
    return await this.deps.operationsWorkflow.replace(credentialId, payload);
  }

  async removeCredentialModels(credentialId: string): Promise<void> {
    await this.deps.operationsWorkflow.removeCredentialModels(credentialId);
  }

  async syncRuntimeProjection(): Promise<void> {
    await this.deps.operationsWorkflow.syncRuntimeProjection();
  }
}
