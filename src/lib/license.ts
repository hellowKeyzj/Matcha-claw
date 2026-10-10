import { hostApiFetch } from './host-api';

export interface LicenseValidationResult {
  valid: boolean;
  code: string;
  mode: 'online' | 'cache' | 'allowlist' | 'checksum' | 'none';
  source?: 'server' | 'cache' | 'local';
  masked?: string | null;
  last4?: string | null;
  expiresAt?: string | null;
  refreshAfterSec?: number;
  offlineGraceUntilMs?: number;
}

export interface LicenseGateSnapshot {
  state: 'checking' | 'granted' | 'blocked';
  reason: string;
  checkedAtMs: number;
  hasStoredKey: boolean;
  hasUsableCache: boolean;
  nextRevalidateAtMs: number | null;
  lastValidation: LicenseValidationResult | null;
  renewalAlert: 'near_expiry_renew_failed' | null;
}

export interface StoredLicenseKeySummary {
  hasStoredKey: boolean;
  masked: string | null;
  last4: string | null;
}

export function fetchLicenseGate(): Promise<LicenseGateSnapshot> {
  return hostApiFetch('/api/license/gate');
}

export function fetchStoredLicenseKey(): Promise<StoredLicenseKeySummary> {
  return hostApiFetch('/api/license/stored-key');
}

export function validateLicense(key: string): Promise<LicenseValidationResult> {
  return hostApiFetch('/api/license/validate', { method: 'POST', body: JSON.stringify({ key }) });
}

export function revalidateLicense(): Promise<LicenseValidationResult> {
  return hostApiFetch('/api/license/revalidate', { method: 'POST' });
}

export function clearLicense(): Promise<{ success: boolean }> {
  return hostApiFetch('/api/license/clear', { method: 'POST' });
}
