import { hostApiFetch } from '@/lib/host-api';
import type {
  ProviderAccount,
  ProviderType,
  ProviderVendorInfo,
  ProviderWithKeyInfo,
} from '@/lib/providers';

export interface ProviderSnapshot {
  accounts: ProviderAccount[];
  statuses: ProviderWithKeyInfo[];
  vendors: ProviderVendorInfo[];
  defaultAccountId: string | null;
}

export interface ProviderListItem {
  account: ProviderAccount;
  vendor?: ProviderVendorInfo;
  status?: ProviderWithKeyInfo;
}

function normalizeProviderSnapshot(value: unknown): ProviderSnapshot {
  const snapshot = value && typeof value === 'object'
    ? (value as Partial<ProviderSnapshot>)
    : {};
  return {
    accounts: Array.isArray(snapshot.accounts) ? snapshot.accounts : [],
    statuses: Array.isArray(snapshot.statuses) ? snapshot.statuses : [],
    vendors: Array.isArray(snapshot.vendors) ? snapshot.vendors : [],
    defaultAccountId: typeof snapshot.defaultAccountId === 'string' ? snapshot.defaultAccountId : null,
  };
}

export async function fetchProviderSnapshot(): Promise<ProviderSnapshot> {
  const snapshot = await hostApiFetch<ProviderSnapshot | undefined>('/api/provider-accounts');
  return normalizeProviderSnapshot(snapshot);
}

export function hasConfiguredCredentials(
  account: ProviderAccount,
  status?: ProviderWithKeyInfo,
): boolean {
  if (account.authMode === 'oauth_device' || account.authMode === 'oauth_browser' || account.authMode === 'local') {
    return true;
  }
  return status?.hasKey ?? false;
}

export function pickPreferredAccount(
  accounts: ProviderAccount[],
  defaultAccountId: string | null,
  vendorId: ProviderType | string,
  statusMap: Map<string, ProviderWithKeyInfo>,
): ProviderAccount | null {
  const sameVendor = accounts.filter((account) => account.vendorId === vendorId);
  if (sameVendor.length === 0) return null;

  return (
    (defaultAccountId ? sameVendor.find((account) => account.id === defaultAccountId) : undefined)
    || sameVendor.find((account) => hasConfiguredCredentials(account, statusMap.get(account.id)))
    || sameVendor[0]
  );
}

export function buildProviderAccountId(
  vendorId: ProviderType,
  existingAccountId: string | null,
  vendors: ProviderVendorInfo[],
): string {
  if (existingAccountId) {
    return existingAccountId;
  }

  const vendor = vendors.find((candidate) => candidate.id === vendorId);
  return vendor?.supportsMultipleAccounts ? `${vendorId}-${crypto.randomUUID()}` : vendorId;
}

export function buildProviderListItems(
  accounts: ProviderAccount[],
  statuses: ProviderWithKeyInfo[],
  vendors: ProviderVendorInfo[],
  defaultAccountId: string | null,
): ProviderListItem[] {
  const safeAccounts = Array.isArray(accounts) ? accounts : [];
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
      if (left.account.id === defaultAccountId) return -1;
      if (right.account.id === defaultAccountId) return 1;
      return right.account.updatedAt.localeCompare(left.account.updatedAt);
    });
}
