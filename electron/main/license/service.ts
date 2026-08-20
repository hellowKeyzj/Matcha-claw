const LICENSE_PREFIX = 'MATCHACLAW';
const LICENSE_PATTERN = /^MATCHACLAW-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/;
const CHECKSUM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CHECKSUM_CONTEXT = 'matchaclaw-license-v1';

export type LicenseValidationCode =
  | 'valid'
  | 'empty'
  | 'format_invalid'
  | 'service_unconfigured'
  | 'network_error'
  | 'server_rejected'
  | 'cache_grace_valid'
  | 'expired'
  | 'device_mismatch'
  | 'not_allowed'
  | 'checksum_invalid';

export type LicenseGateState = 'checking' | 'granted' | 'blocked';

export interface LicenseValidationResult {
  valid: boolean;
  code: LicenseValidationCode;
  normalizedKey?: string;
  masked?: string | null;
  last4?: string | null;
  mode: 'online' | 'cache' | 'allowlist' | 'checksum' | 'none';
  source?: 'server' | 'cache' | 'local';
  message?: string;
  expiresAt?: string | null;
  refreshAfterSec?: number;
  offlineGraceUntilMs?: number;
}

export interface LicenseGateSnapshot {
  state: LicenseGateState;
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

export interface LicenseRuntimePort {
  gate(): Promise<LicenseGateSnapshot>;
  storedKey(): Promise<string | StoredLicenseKeySummary | null>;
  validate(key: string, options?: { packagedOverride?: boolean }): Promise<LicenseValidationResult>;
  revalidate(): Promise<LicenseValidationResult>;
  clear(): Promise<void>;
}

export type LicenseRuntime = LicenseRuntimePort;

function stableHash(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function computeChecksumSegment(payload: string): string {
  const seed = `${CHECKSUM_CONTEXT}:${payload}`;
  let state = stableHash(seed);
  let checksum = '';
  for (let index = 0; index < 4; index += 1) {
    state = Math.imul(state ^ (index + 1), 1103515245) + 12345;
    checksum += CHECKSUM_ALPHABET[(state >>> 0) % CHECKSUM_ALPHABET.length];
  }
  return checksum;
}

function parseAllowlist(rawAllowlist: string): Set<string> {
  if (!rawAllowlist.trim()) {
    return new Set<string>();
  }
  const keys = rawAllowlist
    .split(/[\s,;]+/)
    .map((item) => normalizeLicenseKey(item))
    .filter((item) => LICENSE_PATTERN.test(item));
  return new Set(keys);
}

export function normalizeLicenseKey(rawKey: string): string {
  return rawKey.trim().toUpperCase();
}

export function buildLicenseKey(payloadSeed: string): string {
  const compactSeed = payloadSeed.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compactSeed.length !== 12) {
    throw new Error('payloadSeed must contain exactly 12 letters/digits');
  }
  const payload = `${compactSeed.slice(0, 4)}-${compactSeed.slice(4, 8)}-${compactSeed.slice(8, 12)}`;
  return `${LICENSE_PREFIX}-${payload}-${computeChecksumSegment(payload)}`;
}

export function validateLicenseKeyLocally(
  rawKey: string,
  options?: { allowlistEnv?: string },
): LicenseValidationResult {
  const normalizedKey = normalizeLicenseKey(rawKey);
  if (!normalizedKey) {
    return { valid: false, code: 'empty', mode: 'none' };
  }
  if (!LICENSE_PATTERN.test(normalizedKey)) {
    return { valid: false, code: 'format_invalid', mode: 'none' };
  }

  const allowlist = parseAllowlist(options?.allowlistEnv ?? '');
  if (allowlist.size > 0) {
    if (allowlist.has(normalizedKey)) {
      return { valid: true, code: 'valid', normalizedKey, mode: 'allowlist', source: 'local' };
    }
    return { valid: false, code: 'not_allowed', normalizedKey, mode: 'allowlist', source: 'local' };
  }

  const segments = normalizedKey.split('-');
  const payload = `${segments[1]}-${segments[2]}-${segments[3]}`;
  if (segments[4] !== computeChecksumSegment(payload)) {
    return { valid: false, code: 'checksum_invalid', normalizedKey, mode: 'checksum', source: 'local' };
  }
  return { valid: true, code: 'valid', normalizedKey, mode: 'checksum', source: 'local' };
}

function summarizeStoredKey(
  key: string | StoredLicenseKeySummary | null,
): StoredLicenseKeySummary {
  if (!key) {
    return { hasStoredKey: false, masked: null, last4: null };
  }
  if (typeof key !== 'string') {
    return {
      hasStoredKey: key.hasStoredKey,
      masked: key.masked,
      last4: key.last4,
    };
  }
  const normalizedKey = normalizeLicenseKey(key);
  if (!normalizedKey) {
    return { hasStoredKey: false, masked: null, last4: null };
  }
  const last4 = normalizedKey.slice(-4);
  return {
    hasStoredKey: true,
    masked: `${LICENSE_PREFIX}-****-****-****-${last4}`,
    last4,
  };
}

export function sanitizeLicenseValidationResult(
  result: LicenseValidationResult | null,
): LicenseValidationResult | null {
  if (!result) {
    return null;
  }
  const summary = result.normalizedKey ? summarizeStoredKey(result.normalizedKey) : null;
  return {
    valid: result.valid,
    code: result.code,
    mode: result.mode,
    ...(result.source === undefined ? {} : { source: result.source }),
    ...(summary
      ? { masked: summary.masked, last4: summary.last4 }
      : result.masked === undefined ? {} : { masked: result.masked }),
    ...(summary || result.last4 === undefined ? {} : { last4: result.last4 }),
    ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
    ...(result.refreshAfterSec === undefined ? {} : { refreshAfterSec: result.refreshAfterSec }),
    ...(result.offlineGraceUntilMs === undefined
      ? {}
      : { offlineGraceUntilMs: result.offlineGraceUntilMs }),
  };
}

export function sanitizeLicenseGateSnapshot(snapshot: LicenseGateSnapshot): LicenseGateSnapshot {
  return {
    state: snapshot.state,
    reason: snapshot.reason,
    checkedAtMs: snapshot.checkedAtMs,
    hasStoredKey: snapshot.hasStoredKey,
    hasUsableCache: snapshot.hasUsableCache,
    nextRevalidateAtMs: snapshot.nextRevalidateAtMs,
    lastValidation: sanitizeLicenseValidationResult(snapshot.lastValidation),
    renewalAlert: snapshot.renewalAlert,
  };
}

export class LicenseService {
  constructor(private readonly runtime: LicenseRuntimePort) {}

  async gate(): Promise<LicenseGateSnapshot> {
    return sanitizeLicenseGateSnapshot(await this.runtime.gate());
  }

  async storedKey(): Promise<StoredLicenseKeySummary> {
    return summarizeStoredKey(await this.runtime.storedKey());
  }

  async validate(key: string): Promise<LicenseValidationResult | null> {
    return sanitizeLicenseValidationResult(await this.runtime.validate(key));
  }

  async revalidate(): Promise<LicenseValidationResult | null> {
    return sanitizeLicenseValidationResult(await this.runtime.revalidate());
  }

  async clear(): Promise<{ success: true }> {
    await this.runtime.clear();
    return { success: true };
  }
}
