/**
 * Provider models 应用服务。
 *
 * MatchaClaw 的模型事实源是 ProviderModel[]：
 *   { credentialId, modelId, capabilities, contextWindow?, maxTokens?, timeoutMs?, aspectRatio?, resolution?, quality? }
 *
 * OpenClaw 的 `models.providers.<providerKey>.models[]` 只是输出适配格式。
 */

import { badRequest, ok, type ApplicationResponse } from '../common/application-response';
import type { OpenClawProviderModelsService, OpenClawProviderModelsMap } from '../openclaw/openclaw-provider-models-service';
import type { OpenClawCustomMediaPluginConfigService, OpenClawCustomMediaProviderMap } from '../openclaw/openclaw-custom-media-plugin-config-service';
import type { ProviderStorePort } from './provider-store-repository';
import type { ProviderModelsStorePort } from './provider-models-store';
import type { CapabilityRoutingApplicationService } from './capability-routing-service';
import type { ModelCapability, ProviderModel } from './provider-types';
import {
  findDisallowedModelCapabilities,
  filterAllowedModelCapabilities,
  modelCapabilitiesToOpenClawInput,
  MODEL_CAPABILITIES,
  type ProviderCapabilityCredential,
} from './provider-model-capabilities';
import { getCustomMediaContract } from './custom-media-provider-contracts';
import { resolveRuntimeProviderConfigOverride } from './provider-runtime-sync-plan';
import { getLegacyOpenClawProviderKeys } from './provider-runtime-rules';
import {
  isCustomMediaCredential,
  toMatchaClawMediaModelRef,
} from './custom-media-openclaw';
import {
  getOptionalString,
  isRecord,
  type NormalizedProviderCredential,
  normalizeProviderStoreForRuntime,
} from './provider-store-model';

const MODEL_CAPABILITY_SET = new Set<ModelCapability>(MODEL_CAPABILITIES);

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function decodeCapabilities(value: unknown): ModelCapability[] | null {
  if (!Array.isArray(value)) return null;
  const capabilities: ModelCapability[] = [];
  const seen = new Set<ModelCapability>();
  for (const raw of value) {
    if (!MODEL_CAPABILITY_SET.has(raw as ModelCapability)) return null;
    const capability = raw as ModelCapability;
    if (seen.has(capability)) continue;
    seen.add(capability);
    capabilities.push(capability);
  }
  return capabilities.length > 0 ? capabilities : null;
}

function decodeModel(credentialId: string, value: unknown): ProviderModel | null {
  if (!isRecord(value)) return null;
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  const capabilities = decodeCapabilities(value.capabilities);
  if (!credentialId || !modelId || !capabilities) return null;
  const contextWindow = normalizePositiveInteger(value.contextWindow);
  const maxTokens = normalizePositiveInteger(value.maxTokens);
  const timeoutMs = normalizePositiveInteger(value.timeoutMs);
  const aspectRatio = normalizeOptionalString(value.aspectRatio);
  const resolution = normalizeOptionalString(value.resolution);
  const quality = normalizeOptionalString(value.quality);
  return {
    credentialId,
    modelId,
    capabilities,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(aspectRatio !== undefined ? { aspectRatio } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(quality !== undefined ? { quality } : {}),
  };
}

function decodeModelList(credentialId: string, value: unknown): ProviderModel[] | null {
  const rawList = isRecord(value) && Array.isArray(value.models) ? value.models : value;
  if (!Array.isArray(rawList)) return null;
  const out: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const raw of rawList) {
    const model = decodeModel(credentialId, raw);
    if (!model || seen.has(model.modelId)) return null;
    seen.add(model.modelId);
    out.push(model);
  }
  return out;
}

function inferCapabilitiesFromOpenClawModel(entry: Record<string, unknown>): ModelCapability[] {
  const capabilities: ModelCapability[] = ['chat'];
  const input = Array.isArray(entry.input) ? entry.input : [];
  if (input.some((item) => item === 'image')) {
    capabilities.push('imageUnderstand');
  }
  return capabilities;
}

function normalizeOpenClawModelForCatalog(
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
    capabilities: inferCapabilitiesFromOpenClawModel(entry),
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

export class ProviderModelsApplicationService {
  constructor(
    private readonly store: ProviderModelsStorePort,
    private readonly credentials: ProviderStorePort,
    private readonly writer: OpenClawProviderModelsService,
    private readonly customMediaWriter?: OpenClawCustomMediaPluginConfigService,
    private readonly capabilityRouting?: Pick<CapabilityRoutingApplicationService, 'pruneUnavailableModelRoutes'>,
  ) {}

  async readAll(): Promise<{ models: Array<ProviderModel & { label?: string }> }> {
    const [store, providerStore] = await Promise.all([
      this.readHydratedStore(),
      this.credentials.read(),
    ]);
    const { accounts, storeModified } = normalizeProviderStoreForRuntime(providerStore);
    if (storeModified) {
      await this.credentials.write(providerStore);
    }
    const accountByCredentialId = new Map(accounts.map((account) => [account.accountId, account]));
    return {
      models: store.models
        .map((model) => {
          const account = accountByCredentialId.get(model.credentialId);
          if (!account) return null;
          return {
            ...model,
            label: getOptionalString(account.account.label) || account.vendorId || model.credentialId,
          };
        })
        .filter((model): model is ProviderModel & { label?: string } => model !== null),
    };
  }

  async read(credentialId: string): Promise<{ credentialId: string; models: ProviderModel[] }> {
    const trimmed = credentialId.trim();
    const store = await this.readHydratedStore();
    return {
      credentialId: trimmed,
      models: store.models.filter((model) => model.credentialId === trimmed),
    };
  }

  async readSelectable(): Promise<{
    models: Array<ProviderModel & {
      providerKey: string;
      openClawModelRef: string;
      label: string;
    }>;
  }> {
    const [store, providerStore] = await Promise.all([
      this.readHydratedStore(),
      this.credentials.read(),
    ]);
    const { accounts, storeModified } = normalizeProviderStoreForRuntime(providerStore);
    if (storeModified) {
      await this.credentials.write(providerStore);
    }
    const accountByCredentialId = new Map(accounts.map((account) => [account.accountId, account]));
    const models = store.models
      .map((model) => {
        const account = accountByCredentialId.get(model.credentialId);
        if (!account) return null;
        const label = getOptionalString(account.account.label) || account.vendorId || model.credentialId;
        const openClawModelRef = isCustomMediaCredential(account.account)
          ? toMatchaClawMediaModelRef(account.providerKey, model.modelId)
          : `${account.providerKey}/${model.modelId}`;
        return {
          ...model,
          providerKey: account.providerKey,
          openClawModelRef,
          label,
        };
      })
      .filter((model): model is ProviderModel & { providerKey: string; openClawModelRef: string; label: string } => model !== null)
      .sort((left, right) => `${left.label} / ${left.modelId}`.localeCompare(`${right.label} / ${right.modelId}`));
    return { models };
  }

  async replace(credentialId: string, payload: unknown): Promise<ApplicationResponse> {
    const trimmed = credentialId.trim();
    if (!trimmed) {
      return badRequest('credentialId 必填');
    }
    const nextModels = decodeModelList(trimmed, payload);
    if (!nextModels) {
      return badRequest('provider models payload 无效');
    }
    const credentialStore = await this.credentials.read();
    if (!isRecord(credentialStore.accounts[trimmed])) {
      return badRequest('credentialId 不存在');
    }

    const store = await this.store.read();
    let validatedModels: ProviderModel[];
    try {
      validatedModels = this.validateModelsForCredential(trimmed, credentialStore.accounts[trimmed], nextModels);
    } catch (error) {
      return badRequest(String(error));
    }

    store.models = [
      ...store.models.filter((model) => model.credentialId !== trimmed),
      ...validatedModels,
    ];
    await this.store.write(store);
    await this.syncOpenClawModels(store.models);
    await this.capabilityRouting?.pruneUnavailableModelRoutes(store.models);
    return ok({ success: true, credentialId: trimmed, models: nextModels });
  }

  async removeCredentialModels(credentialId: string): Promise<void> {
    const store = await this.store.read();
    const next = store.models.filter((model) => model.credentialId !== credentialId);
    if (next.length === store.models.length) return;
    store.models = next;
    await this.store.write(store);
    await this.syncOpenClawModels(store.models);
    await this.capabilityRouting?.pruneUnavailableModelRoutes(store.models);
  }

  async syncOpenClaw(): Promise<void> {
    await this.syncOpenClawModels((await this.readHydratedStore()).models);
  }

  private async syncOpenClawModels(models: readonly ProviderModel[]): Promise<void> {
    const providerStore = await this.credentials.read();
    const { accounts, storeModified } = normalizeProviderStoreForRuntime(providerStore);
    if (storeModified) {
      await this.credentials.write(providerStore);
    }
    const providerMap: OpenClawProviderModelsMap = {};
    const customMediaProviderMap: OpenClawCustomMediaProviderMap = {};
    const writableProviderKeyByCredentialId = new Map<string, string>();
    const customMediaProviderKeyByCredentialId = new Map<string, string>();
    for (const { accountId, providerKey, account } of accounts) {
      if (isCustomMediaCredential(account)) {
        const mediaApiProtocol = typeof account.mediaApiProtocol === 'string' ? account.mediaApiProtocol.trim() : '';
        const mediaContract = getCustomMediaContract(mediaApiProtocol);
        const mediaBaseUrl = typeof account.baseUrl === 'string' ? account.baseUrl.trim().replace(/\/+$/, '') : '';
        if (!mediaBaseUrl || !mediaContract) continue;
        customMediaProviderKeyByCredentialId.set(accountId, providerKey);
        const replaceProviderKeys = getLegacyOpenClawProviderKeys(
          typeof account.vendorId === 'string' ? account.vendorId : '',
          accountId,
        );
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
      const override = resolveRuntimeProviderConfigOverride(providerKey, account);
      const effectiveBaseUrl = override?.baseUrl;
      const effectiveApi = override?.api;
      if (!effectiveBaseUrl || !effectiveApi) continue;
      writableProviderKeyByCredentialId.set(accountId, providerKey);
      const replaceProviderKeys = getLegacyOpenClawProviderKeys(
        typeof account.vendorId === 'string' ? account.vendorId : '',
        accountId,
      );
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
        input: modelCapabilitiesToOpenClawInput(model.capabilities),
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
      });
      providerMap[providerKey] = {
        ...entry,
        models: list,
      };
    }
    await this.writer.replaceAll(providerMap, validModelRefs);
    await this.customMediaWriter?.replaceAll(customMediaProviderMap);
  }

  private async readHydratedStore(): Promise<{ schemaVersion: 1; models: ProviderModel[] }> {
    const store = await this.store.read();
    if (store.models.length > 0) {
      return store;
    }
    const imported = await this.importOpenClawModels();
    if (imported.length === 0) {
      return store;
    }
    store.models = imported;
    await this.store.write(store);
    return store;
  }

  private async importOpenClawModels(): Promise<ProviderModel[]> {
    const providerStore = await this.credentials.read();
    const { accounts, storeModified } = normalizeProviderStoreForRuntime(providerStore);
    if (storeModified) {
      await this.credentials.write(providerStore);
    }
    const accountByProviderKey = new Map<string, NormalizedProviderCredential>();
    for (const account of accounts) {
      accountByProviderKey.set(account.providerKey, account);
    }
    const openClawModels = await this.writer.readAll();
    const customMediaModels = await this.customMediaWriter?.readAll() ?? {};
    const imported: ProviderModel[] = [];
    const seen = new Set<string>();
    for (const [providerKey, entries] of Object.entries(openClawModels)) {
      const account = accountByProviderKey.get(providerKey);
      if (!account) continue;
      for (const entry of entries) {
        const model = normalizeOpenClawModelForCatalog(account.accountId, entry);
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
    return imported;
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
}
