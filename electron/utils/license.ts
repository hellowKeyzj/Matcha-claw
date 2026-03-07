import crypto from 'node:crypto';
import path from 'node:path';
import { loadOrCreateDeviceIdentity } from './device-identity';
import { proxyAwareFetch } from './proxy-fetch';
import { BUILTIN_LICENSE_ENDPOINT, BUILTIN_LICENSE_MODE, BUILTIN_LICENSE_PRODUCT } from './license-config';

const LICENSE_PREFIX = 'MATCHACLAW';
const LICENSE_PATTERN = /^MATCHACLAW-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/;
const CHECKSUM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CHECKSUM_CONTEXT = 'matchaclaw-license-v1';
const LICENSE_CACHE_VERSION = 1;

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

export interface LicenseValidationResult {
  valid: boolean;
  code: LicenseValidationCode;
  normalizedKey?: string;
  mode: 'online' | 'cache' | 'allowlist' | 'checksum' | 'none';
  source?: 'server' | 'cache' | 'local';
  message?: string;
  expiresAt?: string | null;
}

type LicensePolicyMode = 'online-required' | 'online-optional' | 'offline-local';

interface LicenseRuntimeConfig {
  policyMode: LicensePolicyMode;
  endpoint: string | null;
  product: string;
  timeoutMs: number;
  offlineGraceHours: number;
  allowlistEnv: string;
}

interface CachedLicenseState {
  version: number;
  keyHash: string;
  deviceId: string;
  activatedAtMs: number;
  lastValidatedAtMs: number;
  offlineGraceUntilMs: number;
  expiresAtMs: number | null;
  licenseId?: string;
  plan?: string;
}

interface LicenseServerPayload {
  licenseKey: string;
  product: string;
  deviceId: string;
  appVersion: string;
  platform: string;
  machineName: string;
}

interface LicenseServerResponse {
  valid?: boolean;
  code?: string;
  message?: string;
  licenseId?: string;
  plan?: string;
  expiresAt?: string | null;
  refreshAfterSec?: number;
  offlineGraceHours?: number;
}

export function normalizeLicenseKey(rawKey: string): string {
  return rawKey.trim().toUpperCase();
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

function computeChecksumSegment(payload: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${CHECKSUM_CONTEXT}:${payload}`)
    .digest();

  let checksum = '';
  for (let i = 0; i < 4; i += 1) {
    checksum += CHECKSUM_ALPHABET[digest[i] % CHECKSUM_ALPHABET.length];
  }
  return checksum;
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
  options?: { allowlistEnv?: string }
): LicenseValidationResult {
  const normalizedKey = normalizeLicenseKey(rawKey);
  if (!normalizedKey) {
    return { valid: false, code: 'empty', mode: 'none' };
  }

  if (!LICENSE_PATTERN.test(normalizedKey)) {
    return { valid: false, code: 'format_invalid', mode: 'none' };
  }

  const allowlist = parseAllowlist(options?.allowlistEnv ?? process.env.MATCHACLAW_LICENSE_KEYS ?? '');
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

function parsePositiveNumber(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolvePolicyMode(explicitMode: string | undefined, packaged: boolean): LicensePolicyMode {
  const normalized = explicitMode?.trim().toLowerCase();
  if (normalized === 'online-required') return 'online-required';
  if (normalized === 'online-optional') return 'online-optional';
  if (normalized === 'offline-local') return 'offline-local';
  if (BUILTIN_LICENSE_MODE) {
    return BUILTIN_LICENSE_MODE;
  }
  return packaged ? 'online-required' : 'online-optional';
}

function resolveLicenseRuntimeConfig(packagedOverride?: boolean): LicenseRuntimeConfig {
  const packaged = typeof packagedOverride === 'boolean'
    ? packagedOverride
    : Boolean(process.env.MATCHACLAW_APP_PACKAGED === '1');

  const policyMode = resolvePolicyMode(process.env.MATCHACLAW_LICENSE_MODE, packaged);
  const endpoint = process.env.MATCHACLAW_LICENSE_ENDPOINT?.trim() || BUILTIN_LICENSE_ENDPOINT || null;

  return {
    policyMode,
    endpoint,
    product: process.env.MATCHACLAW_LICENSE_PRODUCT?.trim() || BUILTIN_LICENSE_PRODUCT,
    timeoutMs: parsePositiveNumber(process.env.MATCHACLAW_LICENSE_TIMEOUT_MS, 8000),
    offlineGraceHours: parsePositiveNumber(process.env.MATCHACLAW_LICENSE_OFFLINE_GRACE_HOURS, 72),
    allowlistEnv: process.env.MATCHACLAW_LICENSE_KEYS ?? '',
  };
}

function parseIsoDateToMs(input?: string | null): number | null {
  if (!input) return null;
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return timestamp;
}

function hashLicenseKey(normalizedKey: string): string {
  return crypto
    .createHash('sha256')
    .update(`license-key:${normalizedKey}`)
    .digest('hex');
}

async function getAppRuntimeInfo(): Promise<{ packaged: boolean; version: string; machineName: string; userDataDir: string | null }> {
  if (!process.versions.electron) {
    return {
      packaged: process.env.MATCHACLAW_APP_PACKAGED === '1',
      version: process.env.npm_package_version ?? '0.0.0',
      machineName: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown-host',
      userDataDir: null,
    };
  }

  try {
    const { app } = await import('electron');
    return {
      packaged: app.isPackaged,
      version: app.getVersion(),
      machineName: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown-host',
      userDataDir: app.getPath('userData'),
    };
  } catch {
    return {
      packaged: true,
      version: process.env.npm_package_version ?? '0.0.0',
      machineName: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown-host',
      userDataDir: null,
    };
  }
}

async function getLicenseStore() {
  const Store = (await import('electron-store')).default;
  return new Store<{ cachedState?: CachedLicenseState | null }>({
    name: 'matchaclaw-license',
    defaults: {
      cachedState: null,
    },
  });
}

async function loadCachedState(): Promise<CachedLicenseState | null> {
  try {
    const store = await getLicenseStore();
    const state = store.get('cachedState');
    if (!state || typeof state !== 'object') {
      return null;
    }
    if ((state as CachedLicenseState).version !== LICENSE_CACHE_VERSION) {
      return null;
    }
    return state as CachedLicenseState;
  } catch {
    return null;
  }
}

async function saveCachedState(state: CachedLicenseState): Promise<void> {
  const store = await getLicenseStore();
  store.set('cachedState', state);
}

async function readOrCreateDeviceId(userDataDir: string | null): Promise<string> {
  if (!userDataDir) {
    return 'unknown-device';
  }
  const identityFilePath = path.join(userDataDir, 'matchaclaw-license-device-identity.json');
  const identity = await loadOrCreateDeviceIdentity(identityFilePath);
  return identity.deviceId;
}

async function callLicenseServer(
  endpoint: string,
  payload: LicenseServerPayload,
  timeoutMs: number
): Promise<LicenseServerResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await proxyAwareFetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = await response.json() as LicenseServerResponse;
    if (!response.ok) {
      return {
        valid: false,
        code: body.code || `http_${response.status}`,
        message: body.message || `HTTP ${response.status}`,
      };
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function isCacheEntryUsable(
  cache: CachedLicenseState,
  expectedKeyHash: string,
  currentDeviceId: string,
  nowMs: number
): LicenseValidationResult | null {
  if (cache.keyHash !== expectedKeyHash) {
    return null;
  }
  if (cache.deviceId !== currentDeviceId) {
    return {
      valid: false,
      code: 'device_mismatch',
      mode: 'cache',
      source: 'cache',
    };
  }
  if (cache.expiresAtMs != null && nowMs > cache.expiresAtMs) {
    return {
      valid: false,
      code: 'expired',
      mode: 'cache',
      source: 'cache',
      expiresAt: new Date(cache.expiresAtMs).toISOString(),
    };
  }
  if (nowMs <= cache.offlineGraceUntilMs) {
    return {
      valid: true,
      code: 'cache_grace_valid',
      mode: 'cache',
      source: 'cache',
      expiresAt: cache.expiresAtMs ? new Date(cache.expiresAtMs).toISOString() : null,
    };
  }
  return null;
}

export async function validateLicenseKey(
  rawKey: string,
  options?: { packagedOverride?: boolean }
): Promise<LicenseValidationResult> {
  const localEarly = validateLicenseKeyLocally(rawKey, { allowlistEnv: '' });
  if (localEarly.code === 'empty' || localEarly.code === 'format_invalid') {
    return localEarly;
  }

  const normalizedKey = localEarly.normalizedKey as string;
  const runtime = await getAppRuntimeInfo();
  const config = resolveLicenseRuntimeConfig(typeof options?.packagedOverride === 'boolean'
    ? options.packagedOverride
    : runtime.packaged);

  if (config.policyMode === 'offline-local') {
    return validateLicenseKeyLocally(normalizedKey, { allowlistEnv: config.allowlistEnv });
  }

  if (!config.endpoint) {
    if (config.policyMode === 'online-required') {
      return {
        valid: false,
        code: 'service_unconfigured',
        normalizedKey,
        mode: 'none',
      };
    }
    return validateLicenseKeyLocally(normalizedKey, { allowlistEnv: config.allowlistEnv });
  }

  const deviceId = await readOrCreateDeviceId(runtime.userDataDir);
  const keyHash = hashLicenseKey(normalizedKey);
  const nowMs = Date.now();

  try {
    const serverResult = await callLicenseServer(
      config.endpoint,
      {
        licenseKey: normalizedKey,
        product: config.product,
        deviceId,
        appVersion: runtime.version,
        platform: process.platform,
        machineName: runtime.machineName,
      },
      config.timeoutMs
    );

    if (!serverResult.valid) {
      return {
        valid: false,
        code: 'server_rejected',
        normalizedKey,
        mode: 'online',
        source: 'server',
        message: serverResult.message || serverResult.code || 'license rejected',
      };
    }

    const expiresAtMs = parseIsoDateToMs(serverResult.expiresAt);
    if (expiresAtMs != null && nowMs > expiresAtMs) {
      return {
        valid: false,
        code: 'expired',
        normalizedKey,
        mode: 'online',
        source: 'server',
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    }

    const offlineGraceHours = serverResult.offlineGraceHours != null
      ? Math.max(serverResult.offlineGraceHours, 1)
      : config.offlineGraceHours;
    const refreshAfterSec = serverResult.refreshAfterSec != null
      ? Math.max(serverResult.refreshAfterSec, 60)
      : offlineGraceHours * 3600;
    const offlineGraceUntilMs = nowMs + (refreshAfterSec * 1000);

    await saveCachedState({
      version: LICENSE_CACHE_VERSION,
      keyHash,
      deviceId,
      activatedAtMs: nowMs,
      lastValidatedAtMs: nowMs,
      offlineGraceUntilMs,
      expiresAtMs,
      licenseId: serverResult.licenseId,
      plan: serverResult.plan,
    });

    return {
      valid: true,
      code: 'valid',
      normalizedKey,
      mode: 'online',
      source: 'server',
      expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
    };
  } catch (error) {
    const cachedState = await loadCachedState();
    if (cachedState) {
      const cachedDecision = isCacheEntryUsable(cachedState, keyHash, deviceId, nowMs);
      if (cachedDecision) {
        return {
          ...cachedDecision,
          normalizedKey,
        };
      }
    }

    if (config.policyMode === 'online-optional') {
      return validateLicenseKeyLocally(normalizedKey, { allowlistEnv: config.allowlistEnv });
    }

    return {
      valid: false,
      code: 'network_error',
      normalizedKey,
      mode: 'online',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
