/**
 * Provider account public delivery and Renderer projection.
 *
 * Account facts come from the typed Host route; private credentials are queried
 * only through the Main-owned has-key projection.
 */
import { hostApiFetch } from '@/lib/host-api';
import {
  PROVIDER_TYPE_INFO,
  PROVIDER_TYPES,
  type ModelCapability,
  type ProviderAuthMode,
  type ProviderCredential,
  type ProviderType,
  type ProviderVendorCategory,
  type ProviderVendorInfo,
  type ProviderWithKeyInfo,
  type ProviderTypeInfo,
} from '@/lib/providers';

type AccountKind = 'chat' | 'media';
type AuthMode = 'apiKey' | 'oauthBrowser' | 'oauthDevice' | 'token' | 'cliReuse' | 'local';
type ApiProtocol = 'anthropicMessages' | 'googleGenerativeAi' | 'openAiCompletions' | 'openAiResponses';
type MediaProtocol = 'google' | 'openAi' | 'openRouter';

type PublicProviderAccount = Readonly<{
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  kind?: AccountKind;
  endpoint?: string;
  protocol?: ApiProtocol;
  mediaProtocol?: MediaProtocol;
  authMode: AuthMode;
  revision: number;
}>;

const MODEL_CAPABILITIES = new Set<ModelCapability>([
  'chat',
  'imageUnderstand',
  'imageGenerate',
  'videoGenerate',
  'musicGenerate',
  'tts',
  'transcribe',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

function isAuthMode(value: unknown): value is AuthMode {
  return value === 'apiKey' || value === 'oauthBrowser' || value === 'oauthDevice' || value === 'token' || value === 'cliReuse' || value === 'local';
}

function isProviderType(value: string): value is ProviderType {
  return (PROVIDER_TYPES as readonly string[]).includes(value);
}

function isAccount(value: unknown): value is PublicProviderAccount {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'provider', 'label', 'enabled', 'kind', 'endpoint', 'protocol', 'mediaProtocol', 'authMode', 'revision',
  ])) return false;
  const kind = value.kind ?? 'chat';
  return isIdentifier(value.id)
    && isIdentifier(value.provider)
    && typeof value.label === 'string'
    && value.label.trim().length > 0
    && typeof value.enabled === 'boolean'
    && (kind === 'chat' || kind === 'media')
    && (value.endpoint === undefined || (typeof value.endpoint === 'string' && value.endpoint.trim().length > 0))
    && (kind === 'media'
      ? value.protocol === undefined
        && (value.mediaProtocol === 'google' || value.mediaProtocol === 'openAi' || value.mediaProtocol === 'openRouter')
      : value.mediaProtocol === undefined
        && (value.protocol === undefined
          || value.protocol === 'anthropicMessages'
          || value.protocol === 'googleGenerativeAi'
          || value.protocol === 'openAiCompletions'
          || value.protocol === 'openAiResponses'))
    && isAuthMode(value.authMode)
    && typeof value.revision === 'number'
    && Number.isSafeInteger(value.revision)
    && value.revision > 0;
}

function authMode(value: AuthMode): ProviderCredential['authMode'] {
  switch (value) {
    case 'apiKey': return 'api_key';
    case 'oauthBrowser': return 'oauth_browser';
    case 'oauthDevice': return 'oauth_device';
    case 'token': return 'token';
    case 'cliReuse': return 'cli_reuse';
    case 'local': return 'local';
  }
}

function apiProtocol(value: ApiProtocol | undefined): ProviderCredential['apiProtocol'] {
  switch (value) {
    case 'anthropicMessages': return 'anthropic-messages';
    case 'googleGenerativeAi': return 'google-generative-ai';
    case 'openAiCompletions': return 'openai-completions';
    case 'openAiResponses': return 'openai-responses';
    default: return undefined;
  }
}

function mediaProtocol(value: MediaProtocol | undefined): ProviderCredential['mediaApiProtocol'] {
  switch (value) {
    case 'google': return 'google';
    case 'openAi': return 'openai';
    case 'openRouter': return 'openrouter';
    default: return undefined;
  }
}

function toProviderType(provider: string): ProviderType {
  return (isProviderVendorId(provider) ? provider : 'custom') as ProviderType;
}

function toCredential(account: PublicProviderAccount): ProviderCredential {
  const kind = account.kind ?? 'chat';
  return {
    id: account.id,
    vendorId: toProviderType(account.provider),
    providerKind: kind,
    label: account.label,
    authMode: authMode(account.authMode),
    ...(account.endpoint ? { baseUrl: account.endpoint } : {}),
    ...(kind === 'media'
      ? { mediaApiProtocol: mediaProtocol(account.mediaProtocol) }
      : { apiProtocol: apiProtocol(account.protocol) }),
    enabled: account.enabled,
    createdAt: '',
    updatedAt: '',
  };
}

function normalizeModelCapabilities(value: unknown): ModelCapability[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const out: ModelCapability[] = [];
  for (const raw of value) {
    if (!MODEL_CAPABILITIES.has(raw as ModelCapability) || out.includes(raw as ModelCapability)) return null;
    out.push(raw as ModelCapability);
  }
  return out.length > 0 ? out : null;
}

const VENDOR_CATEGORIES = new Set<ProviderVendorCategory>(['official', 'compatible', 'local', 'custom']);
const AUTH_MODES = new Set<ProviderAuthMode>(['api_key', 'oauth_device', 'oauth_browser', 'token', 'cli_reuse', 'local']);
const VENDOR_KEYS = [
  'id',
  'brandId',
  'apiProtocol',
  'endpointPresets',
  'name',
  'icon',
  'placeholder',
  'model',
  'requiresApiKey',
  'defaultBaseUrl',
  'showBaseUrl',
  'isOAuth',
  'supportsApiKey',
  'hideOAuthUi',
  'apiKeyUrl',
  'docsUrl',
  'docsUrlZh',
  'codePlan',
  'runtimeProviderKey',
  'category',
  'envVar',
  'supportedAuthModes',
  'defaultAuthMode',
  'supportsMultipleAccounts',
  'modelCapabilities',
] as const;

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0);
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function normalizeCodePlan(value: unknown): ProviderTypeInfo['codePlan'] | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const modelId = value.modelId;
  const baseUrl = value.baseUrl;
  if (typeof modelId !== 'string' || modelId.length === 0 || !optionalString(baseUrl)) return null;
  return {
    modelId,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

function isProviderVendorId(value: string): boolean {
  return isProviderType(value) || value === 'zai' || value === 'zai-global';
}

function isEndpointPresets(value: unknown): value is NonNullable<ProviderTypeInfo['endpointPresets']> {
  return Array.isArray(value) && value.length > 0 && value.every((preset) => isRecord(preset)
    && hasOnlyKeys(preset, ['id', 'label', 'baseUrl'])
    && typeof preset.id === 'string' && preset.id.length > 0
    && typeof preset.label === 'string' && preset.label.length > 0
    && typeof preset.baseUrl === 'string' && preset.baseUrl.length > 0);
}

function normalizeVendor(value: unknown): ProviderVendorInfo | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !VENDOR_KEYS.includes(key as typeof VENDOR_KEYS[number]))) {
    return null;
  }
  const id = value.id;
  const supportedAuthModes = value.supportedAuthModes;
  const defaultAuthMode = value.defaultAuthMode;
  const codePlan = normalizeCodePlan(value.codePlan);
  if (!isProviderVendorId(typeof id === 'string' ? id : '')
    || (value.brandId !== undefined && (typeof value.brandId !== 'string' || !isProviderType(value.brandId)))
    || (value.apiProtocol !== undefined && !['anthropic-messages', 'google-generative-ai', 'openai-completions', 'openai-responses'].includes(value.apiProtocol as string))
    || (value.endpointPresets !== undefined && !isEndpointPresets(value.endpointPresets))
    || typeof value.name !== 'string' || value.name.length === 0
    || typeof value.icon !== 'string' || value.icon.length === 0
    || typeof value.placeholder !== 'string' || value.placeholder.length === 0
    || typeof value.requiresApiKey !== 'boolean'
    || !optionalString(value.model)
    || !optionalString(value.defaultBaseUrl)
    || !optionalBoolean(value.showBaseUrl)
    || !optionalBoolean(value.isOAuth)
    || !optionalBoolean(value.supportsApiKey)
    || !optionalBoolean(value.hideOAuthUi)
    || !optionalString(value.apiKeyUrl)
    || !optionalString(value.docsUrl)
    || !optionalString(value.docsUrlZh)
    || codePlan === null
    || !optionalString(value.runtimeProviderKey)
    || !optionalString(value.envVar)
    || !VENDOR_CATEGORIES.has(value.category as ProviderVendorCategory)
    || !Array.isArray(supportedAuthModes)
    || supportedAuthModes.length === 0
    || supportedAuthModes.some((mode) => !AUTH_MODES.has(mode as ProviderAuthMode))
    || new Set(supportedAuthModes).size !== supportedAuthModes.length
    || !AUTH_MODES.has(defaultAuthMode as ProviderAuthMode)
    || !supportedAuthModes.includes(defaultAuthMode as ProviderAuthMode)
    || typeof value.supportsMultipleAccounts !== 'boolean') {
    return null;
  }
  const modelCapabilities = normalizeModelCapabilities(value.modelCapabilities);
  if (modelCapabilities === null) return null;
  return {
    id: id as ProviderType,
    ...(value.brandId !== undefined ? { brandId: value.brandId as ProviderType } : {}),
    ...(value.apiProtocol !== undefined ? { apiProtocol: value.apiProtocol as ProviderTypeInfo['apiProtocol'] } : {}),
    ...(isEndpointPresets(value.endpointPresets) ? { endpointPresets: value.endpointPresets } : {}),
    name: value.name,
    icon: value.icon,
    placeholder: value.placeholder,
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(modelCapabilities ? { modelCapabilities } : {}),
    requiresApiKey: value.requiresApiKey,
    ...(value.defaultBaseUrl !== undefined ? { defaultBaseUrl: value.defaultBaseUrl } : {}),
    ...(value.showBaseUrl !== undefined ? { showBaseUrl: value.showBaseUrl } : {}),
    ...(value.isOAuth !== undefined ? { isOAuth: value.isOAuth } : {}),
    ...(value.supportsApiKey !== undefined ? { supportsApiKey: value.supportsApiKey } : {}),
    ...(value.hideOAuthUi !== undefined ? { hideOAuthUi: value.hideOAuthUi } : {}),
    ...(value.apiKeyUrl !== undefined ? { apiKeyUrl: value.apiKeyUrl } : {}),
    ...(value.docsUrl !== undefined ? { docsUrl: value.docsUrl } : {}),
    ...(value.docsUrlZh !== undefined ? { docsUrlZh: value.docsUrlZh } : {}),
    ...(codePlan ? { codePlan } : {}),
    ...(value.runtimeProviderKey !== undefined ? { runtimeProviderKey: value.runtimeProviderKey } : {}),
    category: value.category as ProviderVendorCategory,
    ...(value.envVar !== undefined ? { envVar: value.envVar } : {}),
    supportedAuthModes: [...supportedAuthModes] as ProviderAuthMode[],
    defaultAuthMode: defaultAuthMode as ProviderAuthMode,
    supportsMultipleAccounts: value.supportsMultipleAccounts,
  };
}

function providerVendorCategory(info: ProviderTypeInfo): ProviderVendorCategory {
  if (info.id === 'custom') return 'custom';
  if (info.id === 'ollama') return 'local';
  if (info.id === 'openrouter' || info.id === 'siliconflow') return 'compatible';
  return 'official';
}

function providerVendorAuth(info: ProviderTypeInfo): Pick<ProviderVendorInfo, 'supportedAuthModes' | 'defaultAuthMode'> {
  if (info.id === 'ollama') return { supportedAuthModes: ['local'], defaultAuthMode: 'local' };
  if (info.id === 'minimax-portal' || info.id === 'minimax-portal-cn') {
    return { supportedAuthModes: ['oauth_device', 'api_key'], defaultAuthMode: 'oauth_device' };
  }
  if (info.id === 'qwen-portal') return { supportedAuthModes: ['oauth_device'], defaultAuthMode: 'oauth_device' };
  if (info.id === 'openai') return { supportedAuthModes: ['api_key', 'oauth_browser', 'oauth_device'], defaultAuthMode: 'api_key' };
  if (info.id === 'openrouter') return { supportedAuthModes: ['api_key', 'oauth_browser'], defaultAuthMode: 'api_key' };
  if (info.id === 'anthropic') return { supportedAuthModes: ['api_key', 'token', 'cli_reuse'], defaultAuthMode: 'api_key' };
  if (info.id === 'github-copilot') return { supportedAuthModes: ['oauth_device'], defaultAuthMode: 'oauth_device' };
  return { supportedAuthModes: ['api_key'], defaultAuthMode: 'api_key' };
}

function staticVendorProjection(): ProviderVendorInfo[] {
  return PROVIDER_TYPE_INFO.map((info) => {
    const auth = providerVendorAuth(info);
    return normalizeVendor({
      ...info,
      category: providerVendorCategory(info),
      ...auth,
      envVar: info.id === 'zai' || info.id === 'zai-global' ? 'ZAI_API_KEY' : undefined,
      supportsMultipleAccounts: info.id === 'zai' || info.id === 'zai-global' ? false : true,
    });
  }).filter((vendor): vendor is ProviderVendorInfo => vendor !== null);
}

export interface ProviderSnapshot {
  credentials: ProviderCredential[];
  statuses: ProviderWithKeyInfo[];
  vendors: ProviderVendorInfo[];
  revisions: Record<string, number>;
}

export interface ProviderListItem {
  account: ProviderCredential;
  vendor?: ProviderVendorInfo;
  status?: ProviderWithKeyInfo;
}

export function normalizeProviderSnapshot(value: unknown): ProviderSnapshot {
  const snapshot = isRecord(value) ? value : {};
  const revisions = isRecord(snapshot.revisions)
    ? Object.fromEntries(Object.entries(snapshot.revisions).filter(([, revision]) => (
      typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0
    ))) as Record<string, number>
    : {};
  return {
    credentials: Array.isArray(snapshot.credentials) ? snapshot.credentials as ProviderCredential[] : [],
    statuses: Array.isArray(snapshot.statuses) ? snapshot.statuses as ProviderWithKeyInfo[] : [],
    vendors: Array.isArray(snapshot.vendors)
      ? snapshot.vendors.map(normalizeVendor).filter((vendor): vendor is ProviderVendorInfo => vendor !== null)
      : [],
    revisions,
  };
}

export async function fetchProviderSnapshot(): Promise<ProviderSnapshot> {
  const payload = await hostApiFetch<unknown>('/api/provider-accounts');
  const rawAccounts = isRecord(payload) && Array.isArray(payload.accounts) ? payload.accounts : [];
  const accounts = rawAccounts.filter(isAccount);
  if (accounts.length !== rawAccounts.length) {
    return { credentials: [], statuses: [], vendors: [], revisions: {} };
  }

  const statuses = await Promise.all(accounts.map(async (account) => {
    let hasKey = account.authMode !== 'apiKey' && account.authMode !== 'token';
    if (account.authMode === 'apiKey' || account.authMode === 'token') {
      try {
        const result = await hostApiFetch<unknown>(
          `/api/provider-accounts/${encodeURIComponent(account.id)}/has-api-key`,
        );
        hasKey = isRecord(result) && result.hasKey === true;
      } catch {
        // A missing private status is not evidence that the credential is absent.
      }
    }
    return {
      id: account.id,
      name: account.label,
      type: toProviderType(account.provider),
      providerKind: account.kind ?? 'chat',
      enabled: account.enabled,
      createdAt: '',
      updatedAt: '',
      hasKey,
      keyMasked: hasKey ? '****' : null,
    } satisfies ProviderWithKeyInfo;
  }));

  return {
    credentials: accounts.map(toCredential),
    statuses,
    vendors: staticVendorProjection(),
    revisions: Object.fromEntries(accounts.map((account) => [account.id, account.revision])),
  };
}

export function hasConfiguredCredentials(
  account: ProviderCredential,
  status?: ProviderWithKeyInfo,
): boolean {
  if (account.authMode === 'oauth_device' || account.authMode === 'oauth_browser' || account.authMode === 'cli_reuse' || account.authMode === 'local') {
    return true;
  }
  return status?.hasKey ?? false;
}

export function buildProviderCredentialId(
  vendorId: ProviderType | string,
  existingAccountId: string | null,
  vendors: ProviderVendorInfo[],
): string {
  if (existingAccountId) return existingAccountId;
  const vendor = vendors.find((candidate) => candidate.id === vendorId);
  if (vendorId === 'zai-global') return 'zai';
  if (vendor?.supportsMultipleAccounts === false) return vendorId;
  return `${vendorId}-${crypto.randomUUID()}`;
}

export function buildProviderListItems(
  credentials: ProviderCredential[],
  statuses: ProviderWithKeyInfo[],
  vendors: ProviderVendorInfo[],
): ProviderListItem[] {
  const safeAccounts = Array.isArray(credentials) ? credentials : [];
  const safeStatuses = Array.isArray(statuses) ? statuses : [];
  const safeVendors = Array.isArray(vendors) ? vendors : [];
  const vendorMap = new Map(safeVendors.map((vendor) => [vendor.id, vendor]));
  const statusMap = new Map(safeStatuses.map((status) => [status.id, status]));
  return safeAccounts
    .map((account) => ({ account, vendor: vendorMap.get(account.vendorId), status: statusMap.get(account.id) }))
    .sort((left, right) => right.account.updatedAt.localeCompare(left.account.updatedAt));
}
