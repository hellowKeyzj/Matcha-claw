import { badRequest, ok, type ApplicationResponse } from '../../common/application-response';
import {
  isCustomMediaCredential,
  toMatchaClawMediaModelRef,
} from '../../providers/custom-media-runtime-projection';
import {
  MODEL_CAPABILITIES,
} from '../../providers/provider-model-capabilities';
import type { ProviderModelsProjectionWorkflow } from './provider-models-projection-workflow';
import type { ProviderStorePort } from '../../providers/provider-store-repository';
import {
  getOptionalString,
  isRecord,
  normalizeProviderStoreForProjection,
  type ProviderProjectionKeyResolverPort,
} from '../../providers/provider-store-model';
import type { ModelCapability, ProviderModel } from '../../providers/provider-types';

const MODEL_CAPABILITY_SET = new Set<ModelCapability>(MODEL_CAPABILITIES);

export interface ProviderModelsOperationsWorkflowDeps {
  readonly credentials: ProviderStorePort;
  readonly projectionKeys: ProviderProjectionKeyResolverPort;
  readonly projectionWorkflow: Pick<
    ProviderModelsProjectionWorkflow,
    'readHydratedStore' | 'replaceCredentialModels' | 'removeCredentialModels' | 'syncRuntimeProjection'
  >;
}

export class ProviderModelsOperationsWorkflow {
  constructor(private readonly deps: ProviderModelsOperationsWorkflowDeps) {}

  async readAll(): Promise<{ models: Array<ProviderModel & { label?: string }> }> {
    const [store, accounts] = await Promise.all([
      this.deps.projectionWorkflow.readHydratedStore(),
      this.readNormalizedAccounts(),
    ]);
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
    const store = await this.deps.projectionWorkflow.readHydratedStore();
    return {
      credentialId: trimmed,
      models: store.models.filter((model) => model.credentialId === trimmed),
    };
  }

  async readSelectable(): Promise<{
    models: Array<ProviderModel & {
      providerKey: string;
      runtimeModelRef: string;
      label: string;
    }>;
  }> {
    const [store, accounts] = await Promise.all([
      this.deps.projectionWorkflow.readHydratedStore(),
      this.readNormalizedAccounts(),
    ]);
    const accountByCredentialId = new Map(accounts.map((account) => [account.accountId, account]));
    const models = store.models
      .map((model) => {
        const account = accountByCredentialId.get(model.credentialId);
        if (!account) return null;
        const label = getOptionalString(account.account.label) || account.vendorId || model.credentialId;
        const runtimeModelRef = isCustomMediaCredential(account.account)
          ? toMatchaClawMediaModelRef(account.providerKey, model.modelId)
          : `${account.providerKey}/${model.modelId}`;
        return {
          ...model,
          providerKey: account.providerKey,
          runtimeModelRef,
          label,
        };
      })
      .filter((model): model is ProviderModel & { providerKey: string; runtimeModelRef: string; label: string } => model !== null)
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
    const credentialStore = await this.deps.credentials.read();
    if (!isRecord(credentialStore.accounts[trimmed])) {
      return badRequest('credentialId 不存在');
    }

    try {
      await this.deps.projectionWorkflow.replaceCredentialModels(trimmed, credentialStore.accounts[trimmed], nextModels);
    } catch (error) {
      return badRequest(String(error));
    }
    return ok({ success: true, credentialId: trimmed, models: nextModels });
  }

  async removeCredentialModels(credentialId: string): Promise<void> {
    await this.deps.projectionWorkflow.removeCredentialModels(credentialId);
  }

  async syncRuntimeProjection(): Promise<void> {
    await this.deps.projectionWorkflow.syncRuntimeProjection();
  }

  private async readNormalizedAccounts() {
    const providerStore = await this.deps.credentials.read();
    const { accounts, storeModified } = normalizeProviderStoreForProjection(providerStore, this.deps.projectionKeys);
    if (storeModified) {
      await this.deps.credentials.write(providerStore);
    }
    return accounts;
  }
}

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
