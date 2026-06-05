import type { ProviderModelsStorePort } from '../../providers/provider-models-store';
import type { ProviderStorePort } from '../../providers/provider-store-repository';
import type { ModelCapability, ProviderModel } from '../../providers/provider-types';
import {
  findDisallowedModelCapabilities,
  filterAllowedModelCapabilities,
  modelCapabilitiesToRuntimeInput,
  type ProviderCapabilityCredential,
} from '../../providers/provider-model-capabilities';
import { getCustomMediaContract } from '../../providers/custom-media-provider-contracts';
import { resolveRuntimeConfigProviderOverride, type ProviderProjectionPolicyPort } from '../../providers/provider-projection-sync-plan';
import {
  getOptionalString,
  isRecord,
  type NormalizedProviderCredential,
  normalizeProviderStoreForProjection,
  type ProviderProjectionKeyResolverPort,
} from '../../providers/provider-store-model';
import {
  isCustomMediaCredential,
  toMatchaClawMediaModelRef,
} from '../../providers/custom-media-runtime-projection';
import type {
  CustomMediaProviderProjectionPort,
  ProviderModelsAgentIdentityPort,
  ProviderModelsAgentProjectionPort,
  ProviderModelsProjectionPort,
} from '../../providers/provider-models-service';
import type { CapabilityRoutingApplicationService } from '../../providers/capability-routing-service';

const RUNTIME_ZERO_MODEL_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

export type RuntimeConfigProviderModelEntry = {
  readonly modelId: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly input?: readonly string[];
};

export type RuntimeConfigProviderModelsMap = Record<string, RuntimeConfigProviderModelEntry[]>;

export type RuntimeCustomMediaProviderEntry = {
  readonly modelId: string;
  readonly capabilities: readonly string[];
  readonly timeoutMs?: number;
  readonly aspectRatio?: string;
  readonly resolution?: string;
  readonly quality?: string;
};

export type RuntimeCustomMediaProviderMap = Record<string, RuntimeCustomMediaProviderEntry[]>;

export type RuntimeConfigProviderModelsProjectionMap = Record<string, {
  baseUrl: string;
  api: string;
  replaceProviderKeys?: readonly string[];
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  authHeader?: string;
  models: Array<{
    modelId: string;
    input: string[];
    contextWindow?: number;
    maxTokens?: number;
    cost: typeof RUNTIME_ZERO_MODEL_COST;
  }>;
}>;

export type RuntimeCustomMediaProjectionMap = Record<string, {
  label: string;
  baseUrl: string;
  apiProtocol: string;
  headers?: Record<string, string>;
  replaceProviderKeys?: readonly string[];
  models: Array<{
    modelId: string;
    capabilities: readonly ModelCapability[];
    timeoutMs?: number;
    aspectRatio?: string;
    resolution?: string;
    quality?: string;
  }>;
}>;

export interface ProviderModelsProjectionWorkflowDeps {
  readonly store: ProviderModelsStorePort;
  readonly credentials: ProviderStorePort;
  readonly writer: ProviderModelsProjectionPort;
  readonly customMediaWriter: CustomMediaProviderProjectionPort;
  readonly capabilityRouting: Pick<CapabilityRoutingApplicationService, 'pruneUnavailableModelRoutes'>;
  readonly authRepository: ProviderModelsAgentIdentityPort;
  readonly agentModels: ProviderModelsAgentProjectionPort;
  readonly projectionKeys: ProviderProjectionKeyResolverPort;
  readonly projectionPolicy: ProviderProjectionPolicyPort;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function inferCapabilitiesFromRuntimeProjectionModel(entry: Record<string, unknown>): ModelCapability[] {
  const capabilities: ModelCapability[] = ['chat'];
  const input = Array.isArray(entry.input) ? entry.input : [];
  if (input.some((item) => item === 'image')) {
    capabilities.push('imageUnderstand');
  }
  return capabilities;
}

function normalizeRuntimeProjectionModelForCatalog(
  credentialId: string,
  entry: { readonly modelId: string; readonly contextWindow?: number; readonly maxTokens?: number; readonly input?: readonly string[] },
): ProviderModel | null {
  const modelId = entry.modelId.trim();
  if (!credentialId || !modelId) return null;
  const contextWindow = normalizePositiveInteger(entry.contextWindow);
  const maxTokens = normalizePositiveInteger(entry.maxTokens);
  return {
    credentialId,
    modelId,
    capabilities: inferCapabilitiesFromRuntimeProjectionModel(entry),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

function toCapabilityCredential(account: Record<string, unknown>): ProviderCapabilityCredential | null {
  const vendorId = typeof account.vendorId === 'string' ? account.vendorId : '';
  if (!vendorId) return null;
  const apiProtocol = typeof account.apiProtocol === 'string' ? account.apiProtocol : undefined;
  const providerKind = account.providerKind === 'media' ? 'media' : 'chat';
  const mediaApiProtocol = typeof account.mediaApiProtocol === 'string' ? account.mediaApiProtocol : undefined;
  return {
    vendorId: vendorId as ProviderCapabilityCredential['vendorId'],
    ...(apiProtocol ? { apiProtocol: apiProtocol as ProviderCapabilityCredential['apiProtocol'] } : {}),
    providerKind,
    ...(mediaApiProtocol ? { mediaApiProtocol: mediaApiProtocol as ProviderCapabilityCredential['mediaApiProtocol'] } : {}),
  };
}

export class ProviderModelsProjectionWorkflow {
  constructor(private readonly deps: ProviderModelsProjectionWorkflowDeps) {}

  async readHydratedStore(): Promise<{ schemaVersion: 1; models: ProviderModel[] }> {
    const store = await this.deps.store.read();
    if (store.models.length > 0) {
      return store;
    }
    const imported = await this.importRuntimeProjectionModels();
    if (imported.length === 0) {
      return store;
    }
    store.models = imported;
    await this.deps.store.write(store);
    return store;
  }

  async replaceCredentialModels(
    credentialId: string,
    credential: Record<string, unknown>,
    nextModels: readonly ProviderModel[],
  ): Promise<ProviderModel[]> {
    const store = await this.deps.store.read();
    const validatedModels = this.validateModelsForCredential(credentialId, credential, nextModels);
    store.models = [
      ...store.models.filter((model) => model.credentialId !== credentialId),
      ...validatedModels,
    ];
    await this.deps.store.write(store);
    await this.syncRuntimeModelProjection(store.models);
    await this.deps.capabilityRouting.pruneUnavailableModelRoutes(store.models);
    return validatedModels;
  }

  async removeCredentialModels(credentialId: string): Promise<void> {
    const store = await this.deps.store.read();
    const next = store.models.filter((model) => model.credentialId !== credentialId);
    if (next.length === store.models.length) return;
    store.models = next;
    await this.deps.store.write(store);
    await this.syncRuntimeModelProjection(store.models);
    await this.deps.capabilityRouting.pruneUnavailableModelRoutes(store.models);
  }

  async syncRuntimeProjection(): Promise<void> {
    await this.syncRuntimeModelProjection((await this.readHydratedStore()).models);
  }

  private validateModelsForCredential(
    credentialId: string,
    credential: Record<string, unknown>,
    models: readonly ProviderModel[],
  ): ProviderModel[] {
    const validated: ProviderModel[] = [];
    for (const model of models) {
      const capabilityCredential = toCapabilityCredential(credential);
      if (!capabilityCredential) {
        throw new Error(`${credentialId}/${model.modelId} credential 参数无效`);
      }
      const disallowed = findDisallowedModelCapabilities(capabilityCredential, model.capabilities);
      if (disallowed.length > 0) {
        throw new Error(`${credentialId}/${model.modelId} 不支持这些模型能力: ${disallowed.join(', ')}`);
      }
      validated.push(model);
    }
    return validated;
  }

  private async syncRuntimeModelProjection(models: readonly ProviderModel[]): Promise<void> {
    const providerStore = await this.deps.credentials.read();
    const { accounts, storeModified } = normalizeProviderStoreForProjection(providerStore, this.deps.projectionKeys);
    if (storeModified) {
      await this.deps.credentials.write(providerStore);
    }
    const providerMap: RuntimeConfigProviderModelsProjectionMap = {};
    const customMediaProviderMap: RuntimeCustomMediaProjectionMap = {};
    const writableProviderKeyByCredentialId = new Map<string, string>();
    const customMediaProviderKeyByCredentialId = new Map<string, string>();
    for (const { accountId, providerKey, account } of accounts) {
      if (isCustomMediaCredential(account)) {
        const mediaApiProtocol = typeof account.mediaApiProtocol === 'string' ? account.mediaApiProtocol.trim() : '';
        const mediaContract = getCustomMediaContract(mediaApiProtocol);
        const mediaBaseUrl = typeof account.baseUrl === 'string' ? account.baseUrl.trim().replace(/\/+$/, '') : '';
        if (!mediaBaseUrl || !mediaContract) continue;
        customMediaProviderKeyByCredentialId.set(accountId, providerKey);
        const replaceProviderKeys = this.deps.projectionPolicy.getReplaceProviderKeys({
          vendorId: typeof account.vendorId === 'string' ? account.vendorId : '',
          accountId,
        });
        customMediaProviderMap[providerKey] = {
          label: getOptionalString(account.label) ?? providerKey,
          baseUrl: mediaBaseUrl,
          apiProtocol: mediaContract.id,
          ...(isRecord(account.headers) ? { headers: account.headers as Record<string, string> } : {}),
          ...(replaceProviderKeys.length > 0 ? { replaceProviderKeys } : {}),
          models: [],
        };
        continue;
      }
      const override = resolveRuntimeConfigProviderOverride(providerKey, account, this.deps.projectionPolicy);
      const effectiveBaseUrl = override?.baseUrl;
      const effectiveApi = override?.api;
      if (!effectiveBaseUrl || !effectiveApi) continue;
      writableProviderKeyByCredentialId.set(accountId, providerKey);
      const replaceProviderKeys = this.deps.projectionPolicy.getReplaceProviderKeys({
        vendorId: typeof account.vendorId === 'string' ? account.vendorId : '',
        accountId,
      });
      providerMap[providerKey] = {
        baseUrl: effectiveBaseUrl,
        api: effectiveApi,
        ...(replaceProviderKeys.length > 0 ? { replaceProviderKeys } : {}),
        ...(override?.apiKeyEnv ? { apiKeyEnv: override.apiKeyEnv } : {}),
        ...(override?.headers ? { headers: override.headers } : {}),
        ...(override?.authHeader !== undefined ? { authHeader: override.authHeader } : {}),
        models: [],
      };
    }
    const validModelRefs: string[] = [];
    for (const model of models) {
      const customMediaProviderKey = customMediaProviderKeyByCredentialId.get(model.credentialId);
      if (customMediaProviderKey) {
        const entry = customMediaProviderMap[customMediaProviderKey];
        if (!entry) continue;
        validModelRefs.push(toMatchaClawMediaModelRef(customMediaProviderKey, model.modelId));
        customMediaProviderMap[customMediaProviderKey] = {
          ...entry,
          models: [
            ...entry.models,
            {
              modelId: model.modelId,
              capabilities: model.capabilities,
              ...(model.timeoutMs !== undefined ? { timeoutMs: model.timeoutMs } : {}),
              ...(model.aspectRatio !== undefined ? { aspectRatio: model.aspectRatio } : {}),
              ...(model.resolution !== undefined ? { resolution: model.resolution } : {}),
              ...(model.quality !== undefined ? { quality: model.quality } : {}),
            },
          ],
        };
        continue;
      }
      const providerKey = writableProviderKeyByCredentialId.get(model.credentialId);
      if (!providerKey) continue;
      const entry = providerMap[providerKey];
      if (!entry) continue;
      validModelRefs.push(`${providerKey}/${model.modelId}`);
      const list = [...entry.models];
      list.push({
        modelId: model.modelId,
        input: modelCapabilitiesToRuntimeInput(model.capabilities),
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
        cost: RUNTIME_ZERO_MODEL_COST,
      });
      providerMap[providerKey] = {
        ...entry,
        models: list,
      };
    }
    await this.deps.writer.replaceAll(providerMap, validModelRefs);
    await this.deps.customMediaWriter.replaceAll(customMediaProviderMap);
    const agentIds = await this.deps.authRepository.discoverAgentIds();
    for (const [provider, entry] of Object.entries(providerMap)) {
      await this.deps.agentModels.upsertProviderInAgentModels({
        agentIds,
        provider,
        entry: {
          baseUrl: entry.baseUrl,
          api: entry.api,
          ...(entry.headers ? { headers: entry.headers } : {}),
          ...(entry.authHeader !== undefined ? { authHeader: entry.authHeader } : {}),
          models: entry.models.map((model) => ({
            id: model.modelId,
            input: model.input,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            cost: model.cost,
          })),
        },
      });
    }
  }

  private async importRuntimeProjectionModels(): Promise<ProviderModel[]> {
    const providerStore = await this.deps.credentials.read();
    const { accounts, storeModified } = normalizeProviderStoreForProjection(providerStore, this.deps.projectionKeys);
    if (storeModified) {
      await this.deps.credentials.write(providerStore);
    }
    const accountByProviderKey = new Map<string, NormalizedProviderCredential>();
    for (const account of accounts) {
      accountByProviderKey.set(account.providerKey, account);
    }
    const runtimeModels = await this.deps.writer.readAll();
    const customMediaModels = await this.deps.customMediaWriter?.readAll() ?? {};
    const imported: ProviderModel[] = [];
    const seen = new Set<string>();
    this.importTextRuntimeProjectionModels(runtimeModels, accountByProviderKey, imported, seen);
    this.importCustomMediaRuntimeProjectionModels(customMediaModels, accountByProviderKey, imported, seen);
    return imported;
  }

  private importTextRuntimeProjectionModels(
    runtimeModels: RuntimeConfigProviderModelsMap,
    accountByProviderKey: Map<string, NormalizedProviderCredential>,
    imported: ProviderModel[],
    seen: Set<string>,
  ): void {
    for (const [providerKey, entries] of Object.entries(runtimeModels)) {
      const account = accountByProviderKey.get(providerKey);
      if (!account) continue;
      for (const entry of entries) {
        const model = normalizeRuntimeProjectionModelForCatalog(account.accountId, entry);
        if (!model) continue;
        const capabilityCredential = toCapabilityCredential(account.account);
        if (!capabilityCredential) continue;
        const allowedCapabilities = filterAllowedModelCapabilities(capabilityCredential, model.capabilities);
        if (allowedCapabilities.length === 0) continue;
        const allowedModel = { ...model, capabilities: allowedCapabilities };
        const key = `${allowedModel.credentialId}\n${allowedModel.modelId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        imported.push(allowedModel);
      }
    }
  }

  private importCustomMediaRuntimeProjectionModels(
    customMediaModels: RuntimeCustomMediaProviderMap,
    accountByProviderKey: Map<string, NormalizedProviderCredential>,
    imported: ProviderModel[],
    seen: Set<string>,
  ): void {
    for (const [providerKey, entries] of Object.entries(customMediaModels)) {
      const account = accountByProviderKey.get(providerKey);
      if (!account || !isCustomMediaCredential(account.account)) continue;
      for (const entry of entries) {
        const modelId = entry.modelId.trim();
        if (!modelId) continue;
        const capabilityCredential = toCapabilityCredential(account.account);
        if (!capabilityCredential) continue;
        const allowedCapabilities = filterAllowedModelCapabilities(capabilityCredential, entry.capabilities as ModelCapability[]);
        if (allowedCapabilities.length === 0) continue;
        const model: ProviderModel = {
          credentialId: account.accountId,
          modelId,
          capabilities: allowedCapabilities,
          ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
          ...(entry.aspectRatio !== undefined ? { aspectRatio: entry.aspectRatio } : {}),
          ...(entry.resolution !== undefined ? { resolution: entry.resolution } : {}),
          ...(entry.quality !== undefined ? { quality: entry.quality } : {}),
        };
        const key = `${model.credentialId}\n${model.modelId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        imported.push(model);
      }
    }
  }
}
