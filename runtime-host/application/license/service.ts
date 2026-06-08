const LICENSE_PREFIX = 'MATCHACLAW';
const LICENSE_PATTERN = /^MATCHACLAW-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/;
const CHECKSUM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CHECKSUM_CONTEXT = 'matchaclaw-license-v2';

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
  storedKey(): Promise<string | null>;
  validate(key: string, options?: { packagedOverride?: boolean }): Promise<LicenseValidationResult>;
  revalidate(): Promise<LicenseValidationResult>;
  clear(): Promise<void>;
}

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
  const segmentA = compactSeed.slice(0, 4);
  const segmentB = compactSeed.slice(4, 8);
  const segmentC = compactSeed.slice(8, 12);
  const payload = `${segmentA}-${segmentB}-${segmentC}`;
  const checksum = computeChecksumSegment(payload);
  return `${LICENSE_PREFIX}-${payload}-${checksum}`;
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
  const checksum = segments[4];
  const expectedChecksum = computeChecksumSegment(payload);
  if (checksum !== expectedChecksum) {
    return { valid: false, code: 'checksum_invalid', normalizedKey, mode: 'checksum', source: 'local' };
  }
  return { valid: true, code: 'valid', normalizedKey, mode: 'checksum', source: 'local' };
}

function readPayloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

function summarizeStoredKey(key: string | null): StoredLicenseKeySummary {
  if (!key) {
    return { hasStoredKey: false, masked: null, last4: null };
  }
  const normalizedKey = normalizeLicenseKey(key);
  const last4 = normalizedKey.slice(-4);
  return {
    hasStoredKey: true,
    masked: `${LICENSE_PREFIX}-****-****-****-${last4}`,
    last4,
  };
}

export function sanitizeLicenseValidationResult(result: LicenseValidationResult | null): LicenseValidationResult | null {
  if (!result) {
    return null;
  }
  const { normalizedKey, ...safeResult } = result;
  if (!normalizedKey) {
    return safeResult;
  }
  const summary = summarizeStoredKey(normalizedKey);
  return {
    ...safeResult,
    masked: summary.masked,
    last4: summary.last4,
  };
}

export function sanitizeLicenseGateSnapshot(snapshot: LicenseGateSnapshot): LicenseGateSnapshot {
  return {
    ...snapshot,
    lastValidation: sanitizeLicenseValidationResult(snapshot.lastValidation),
  };
}

export class LicenseService {
  constructor(private readonly runtime: LicenseRuntimePort) {}

  async gate() {
    return {
      status: 200,
      data: sanitizeLicenseGateSnapshot(await this.runtime.gate()),
    };
  }

  async storedKey() {
    return {
      status: 200,
      data: summarizeStoredKey(await this.runtime.storedKey()),
    };
  }

  async validate(payload: unknown) {
    const body = readPayloadRecord(payload);
    const key = typeof body.key === 'string' ? body.key : '';
    return {
      status: 200,
      data: sanitizeLicenseValidationResult(await this.runtime.validate(key)),
    };
  }

  async revalidate() {
    return {
      status: 200,
      data: sanitizeLicenseValidationResult(await this.runtime.revalidate()),
    };
  }

  async clear() {
    await this.runtime.clear();
    return {
      status: 200,
      data: { success: true },
    };
  }
}
