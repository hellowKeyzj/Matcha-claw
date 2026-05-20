import { hostApiFetch } from '@/lib/host-api';
import type {
  ModelCapability,
  ProviderCredential,
  ProviderType,
  ProviderVendorInfo,
  ProviderWithKeyInfo,
} from '@/lib/providers';

export interface ProviderSnapshot {
  credentials: ProviderCredential[];
  statuses: ProviderWithKeyInfo[];
  vendors: ProviderVendorInfo[];
}

const MODEL_CAPABILITIES = new Set<ModelCapability>([
  'chat',
  'imageUnderstand',
  'imageGenerate',
  'videoGenerate',
  'musicGenerate',
  'tts',
  'transcribe',
]);

function normalizeModelCapabilities(value: unknown): ModelCapability[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ModelCapability[] = [];
  for (const raw of value) {
    if (!MODEL_CAPABILITIES.has(raw as ModelCapability) || out.includes(raw as ModelCapability)) continue;
    out.push(raw as ModelCapability);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeVendor(value: unknown): ProviderVendorInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const vendor = value as ProviderVendorInfo & { modelCapabilities?: unknown };
  const modelCapabilities = normalizeModelCapabilities(vendor.modelCapabilities);
  return {
    ...vendor,
    ...(modelCapabilities ? { modelCapabilities } : {}),
  };
}

export interface ProviderListItem {
  account: ProviderCredential;
  vendor?: ProviderVendorInfo;
  status?: ProviderWithKeyInfo;
}

export function normalizeProviderSnapshot(value: unknown): ProviderSnapshot {
  const snapshot = value && typeof value === 'object'
    ? (value as Partial<ProviderSnapshot>)
    : {};
  return {
    credentials: Array.isArray((snapshot as { credentials?: unknown }).credentials)
      ? (snapshot as { credentials: ProviderCredential[] }).credentials
      : [],
    statuses: Array.isArray(snapshot.statuses) ? snapshot.statuses : [],
    vendors: Array.isArray(snapshot.vendors)
      ? snapshot.vendors.map((vendor) => normalizeVendor(vendor)).filter((vendor): vendor is ProviderVendorInfo => vendor !== null)
      : [],
  };
}

export async function fetchProviderSnapshot(): Promise<ProviderSnapshot> {
  const snapshot = await hostApiFetch<ProviderSnapshot | undefined>('/api/provider-accounts');
  return normalizeProviderSnapshot(snapshot);
}

export function hasConfiguredCredentials(
  account: ProviderCredential,
  status?: ProviderWithKeyInfo,
): boolean {
  if (account.authMode === 'oauth_device' || account.authMode === 'oauth_browser' || account.authMode === 'local') {
    return true;
  }
  return status?.hasKey ?? false;
}

export function buildProviderCredentialId(
  vendorId: ProviderType,
  existingAccountId: string | null,
  vendors: ProviderVendorInfo[],
): string {
  if (existingAccountId) {
    return existingAccountId;
  }

  const vendor = vendors.find((candidate) => candidate.id === vendorId);
  if (vendor?.supportsMultipleAccounts === false) {
    return vendorId;
  }
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
    .map((account) => ({
      account,
      vendor: vendorMap.get(account.vendorId),
      status: statusMap.get(account.id),
    }))
    .sort((left, right) => {
      return right.account.updatedAt.localeCompare(left.account.updatedAt);
    });
}
