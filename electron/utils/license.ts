import crypto from 'node:crypto';
import path from 'node:path';
import { loadOrCreateDeviceIdentity } from './device-identity';
import { proxyAwareFetch } from './proxy-fetch';
import { resolveHardwareId } from './hardware-id';
import {
  readEncryptedLicenseKey,
  removeEncryptedLicenseFile,
  writeEncryptedLicenseKey,
} from './license-secret';
import { BUILTIN_LICENSE_ENDPOINT, BUILTIN_LICENSE_MODE, BUILTIN_LICENSE_PRODUCT } from './license-config';

const LICENSE_PREFIX = 'MATCHACLAW';
const LICENSE_PATTERN = /^MATCHACLAW-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/;
const CHECKSUM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CHECKSUM_CONTEXT = 'matchaclaw-license-v1';
const LICENSE_CACHE_VERSION = 1;
const LICENSE_SECRET_FILE_NAME = 'license-secret.enc.json';
const REVALIDATE_RETRY_BASE_SEC = 30 * 60;
const REVALIDATE_RETRY_MAX_SEC = 6 * 60 * 60;
const REVALIDATE_RETRY_JITTER_RATIO = 0.2;
const STARTUP_PROACTIVE_RENEW_THRESHOLD_MS = 24 * 60 * 60 * 1000;

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
  installId?: string;
  hardwareId?: string | null;
  activatedAtMs: number;
  lastValidatedAtMs: number;
  offlineGraceUntilMs: number;
  expiresAtMs: number | null;
  refreshAfterSec?: number;
  licenseId?: string;
  plan?: string;
}

interface LicenseServerPayload {
  licenseKey: string;
  product: string;
  deviceId: string;
  installId: string;
  hardwareId?: string;
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

interface RuntimeInfo {
  packaged: boolean;
  version: string;
  machineName: string;
  userDataDir: string | null;
}

interface ClientIdentity {
  installId: string;
  hardwareId: string | null;
}

const licenseGateSnapshot: LicenseGateSnapshot = {
  state: 'checking',
  reason: 'init',
  checkedAtMs: Date.now(),
  hasStoredKey: false,
  hasUsableCache: false,
  nextRevalidateAtMs: null,
  lastValidation: null,
  renewalAlert: null,
};

let gateBootstrapStarted = false;
let gateBootstrapPromise: Promise<void> | null = null;
let revalidateTimer: NodeJS.Timeout | null = null;
let hardwareIdPromise: Promise<string | null> | null = null;
let revalidateFailureCount = 0;

function setGateSnapshot(patch: Partial<LicenseGateSnapshot>): void {
  Object.assign(licenseGateSnapshot, patch, {
    checkedAtMs: Date.now(),
  });
}

function clearRevalidateTimer(): void {
  if (revalidateTimer) {
    clearTimeout(revalidateTimer);
    revalidateTimer = null;
  }
}

function armRevalidateTimer(afterSec: number): void {
  clearRevalidateTimer();
  const delayMs = Math.max(60, Math.floor(afterSec)) * 1000;
  licenseGateSnapshot.nextRevalidateAtMs = Date.now() + delayMs;
  revalidateTimer = setTimeout(() => {
    void forceRevalidateStoredLicense('timer');
  }, delayMs);
}

function resetRevalidateRetryState(): void {
  revalidateFailureCount = 0;
}

function computeRetryDelaySec(): number {
  const exponent = Math.min(revalidateFailureCount, 4);
  const baseDelaySec = Math.min(REVALIDATE_RETRY_BASE_SEC * (2 ** exponent), REVALIDATE_RETRY_MAX_SEC);
  const jitterRange = Math.max(1, Math.floor(baseDelaySec * REVALIDATE_RETRY_JITTER_RATIO));
  const jitter = Math.floor((Math.random() * ((jitterRange * 2) + 1)) - jitterRange);
  return Math.max(60, baseDelaySec + jitter);
}

function scheduleRevalidateRetry(): void {
  const delaySec = computeRetryDelaySec();
  revalidateFailureCount = Math.min(revalidateFailureCount + 1, 32);
  armRevalidateTimer(delaySec);
}

function getLicenseSecretFilePath(userDataDir: string): string {
  return path.join(userDataDir, LICENSE_SECRET_FILE_NAME);
}

function buildSecretMaterial(identity: ClientIdentity, product: string): string {
  return `${product}|${identity.installId}|${CHECKSUM_CONTEXT}`;
}

export function normalizeLicenseKey(rawKey: string): string {
  return rawKey.trim().toUpperCase();
}

function normalizeDeviceId(rawDeviceId: string): string {
  return (rawDeviceId || '').trim().toLowerCase();
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
  options?: { allowlistEnv?: string },
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

async function getAppRuntimeInfo(): Promise<RuntimeInfo> {
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

async function getHardwareIdCached(): Promise<string | null> {
  if (!hardwareIdPromise) {
    hardwareIdPromise = resolveHardwareId().catch(() => null);
  }
  return hardwareIdPromise;
}

async function readClientIdentity(userDataDir: string | null): Promise<ClientIdentity> {
  if (!userDataDir) {
    return {
      installId: 'unknown-device',
      hardwareId: await getHardwareIdCached(),
    };
  }
  const identityFilePath = path.join(userDataDir, 'matchaclaw-license-device-identity.json');
  const identity = await loadOrCreateDeviceIdentity(identityFilePath);
  return {
    installId: normalizeDeviceId(identity.deviceId),
    hardwareId: await getHardwareIdCached(),
  };
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
    const typed = state as CachedLicenseState;
    if (typed.version !== LICENSE_CACHE_VERSION) {
      return null;
    }
    if (!typed.deviceId || !typed.keyHash) {
      return null;
    }
    return typed;
  } catch {
    return null;
  }
}

async function saveCachedState(state: CachedLicenseState): Promise<void> {
  const store = await getLicenseStore();
  store.set('cachedState', state);
}

async function clearCachedState(): Promise<void> {
  const store = await getLicenseStore();
  store.set('cachedState', null);
}

function isCacheUsable(
  cache: CachedLicenseState,
  options: {
    expectedKeyHash?: string;
    currentInstallId: string;
    nowMs: number;
  },
): LicenseValidationResult | null {
  if (options.expectedKeyHash && cache.keyHash !== options.expectedKeyHash) {
    return null;
  }

  const cacheInstallId = normalizeDeviceId(cache.installId || cache.deviceId);
  if (cacheInstallId !== options.currentInstallId) {
    return {
      valid: false,
      code: 'device_mismatch',
      mode: 'cache',
      source: 'cache',
    };
  }

  if (cache.expiresAtMs != null && options.nowMs > cache.expiresAtMs) {
    return {
      valid: false,
      code: 'expired',
      mode: 'cache',
      source: 'cache',
      expiresAt: new Date(cache.expiresAtMs).toISOString(),
    };
  }

  if (options.nowMs <= cache.offlineGraceUntilMs) {
    const remainingMs = cache.offlineGraceUntilMs - options.nowMs;
    return {
      valid: true,
      code: 'cache_grace_valid',
      mode: 'cache',
      source: 'cache',
      expiresAt: cache.expiresAtMs ? new Date(cache.expiresAtMs).toISOString() : null,
      refreshAfterSec: Math.max(60, Math.ceil(remainingMs / 1000)),
      offlineGraceUntilMs: cache.offlineGraceUntilMs,
    };
  }

  return null;
}

function isNearExpiryWindow(cache: CachedLicenseState | null, installId: string, nowMs: number): boolean {
  if (!cache) {
    return false;
  }
  const cacheInstallId = normalizeDeviceId(cache.installId || cache.deviceId);
  if (cacheInstallId !== installId) {
    return false;
  }
  return (cache.offlineGraceUntilMs - nowMs) <= STARTUP_PROACTIVE_RENEW_THRESHOLD_MS;
}

function didOnlineRenewSucceed(result: LicenseValidationResult): boolean {
  return result.valid && result.code === 'valid' && result.source === 'server';
}

function shouldShowRenewalAlert(result: LicenseValidationResult, nearExpiryWindow: boolean): boolean {
  if (!nearExpiryWindow) {
    return false;
  }
  return !didOnlineRenewSucceed(result);
}

function shouldScheduleRenewRetry(result: LicenseValidationResult, nearExpiryWindow: boolean): boolean {
  if (result.code === 'network_error') {
    return true;
  }
  if (result.code === 'cache_grace_valid') {
    return nearExpiryWindow;
  }
  return false;
}

async function callLicenseServer(
  endpoint: string,
  payload: LicenseServerPayload,
  timeoutMs: number,
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

    const rawText = await response.text();
    let body: LicenseServerResponse = {};
    if (rawText.trim()) {
      try {
        body = JSON.parse(rawText) as LicenseServerResponse;
      } catch {
        body = {
          valid: false,
          code: 'invalid_response',
          message: rawText.trim(),
        };
      }
    }

    if (!response.ok) {
      return {
        valid: false,
        code: body.code || `http_${response.status}`,
        message: body.message || `HTTP ${response.status}`,
      };
    }

    if (typeof body.valid !== 'boolean') {
      return {
        valid: false,
        code: 'invalid_response',
        message: body.message || 'invalid response from license service',
      };
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function persistLicenseSecret(
  runtime: RuntimeInfo,
  config: LicenseRuntimeConfig,
  identity: ClientIdentity,
  normalizedKey: string,
): Promise<boolean> {
  if (!runtime.userDataDir) {
    return false;
  }
  const filePath = getLicenseSecretFilePath(runtime.userDataDir);
  const material = buildSecretMaterial(identity, config.product);
  try {
    await writeEncryptedLicenseKey(filePath, normalizedKey, material);
    return true;
  } catch {
    return false;
  }
}

async function readStoredLicenseKey(
  runtime: RuntimeInfo,
  config: LicenseRuntimeConfig,
  identity: ClientIdentity,
): Promise<string | null> {
  if (!runtime.userDataDir) {
    return null;
  }
  const filePath = getLicenseSecretFilePath(runtime.userDataDir);
  const material = buildSecretMaterial(identity, config.product);
  return readEncryptedLicenseKey(filePath, material);
}

function getRecentValidatedLicenseKeyFromSnapshot(): string | null {
  const candidate = licenseGateSnapshot.lastValidation;
  if (!candidate?.valid) {
    return null;
  }
  if (!candidate.normalizedKey) {
    return null;
  }
  const normalized = normalizeLicenseKey(candidate.normalizedKey);
  if (!LICENSE_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

async function readStoredLicenseKeyWithRecovery(
  runtime: RuntimeInfo,
  config: LicenseRuntimeConfig,
  identity: ClientIdentity,
): Promise<string | null> {
  const stored = await readStoredLicenseKey(runtime, config, identity);
  if (stored) {
    return stored;
  }

  const fallback = getRecentValidatedLicenseKeyFromSnapshot();
  if (!fallback) {
    return null;
  }

  // 本地密文损坏/不可读时，用最近一次成功授权的 key 自愈重建密文文件。
  await persistLicenseSecret(runtime, config, identity, fallback);
  return fallback;
}

function markGateFromValidation(
  validation: LicenseValidationResult,
  options: {
    hasStoredKey: boolean;
    hasUsableCache: boolean;
  },
): void {
  if (validation.valid) {
    if (validation.code === 'valid') {
      resetRevalidateRetryState();
    }
    setGateSnapshot({
      state: 'granted',
      reason: validation.code,
      hasStoredKey: options.hasStoredKey,
      hasUsableCache: options.hasUsableCache,
      lastValidation: validation,
      renewalAlert: validation.code === 'valid' ? null : licenseGateSnapshot.renewalAlert,
    });
    if (validation.refreshAfterSec) {
      armRevalidateTimer(validation.refreshAfterSec);
    }
    return;
  }

  setGateSnapshot({
    state: 'blocked',
    reason: validation.code,
    hasStoredKey: options.hasStoredKey,
    hasUsableCache: options.hasUsableCache,
    lastValidation: validation,
    nextRevalidateAtMs: null,
  });
  clearRevalidateTimer();
}

export async function validateLicenseKey(
  rawKey: string,
  options?: { packagedOverride?: boolean },
): Promise<LicenseValidationResult> {
  const localEarly = validateLicenseKeyLocally(rawKey, { allowlistEnv: '' });
  if (localEarly.code === 'empty' || localEarly.code === 'format_invalid') {
    markGateFromValidation(localEarly, { hasStoredKey: licenseGateSnapshot.hasStoredKey, hasUsableCache: false });
    return localEarly;
  }

  const normalizedKey = localEarly.normalizedKey as string;
  const runtime = await getAppRuntimeInfo();
  const config = resolveLicenseRuntimeConfig(typeof options?.packagedOverride === 'boolean'
    ? options.packagedOverride
    : runtime.packaged);
  const identity = await readClientIdentity(runtime.userDataDir);

  if (config.policyMode === 'offline-local') {
    const local = validateLicenseKeyLocally(normalizedKey, { allowlistEnv: config.allowlistEnv });
    if (local.valid) {
      const stored = await persistLicenseSecret(runtime, config, identity, normalizedKey);
      markGateFromValidation(local, { hasStoredKey: stored, hasUsableCache: false });
    } else {
      markGateFromValidation(local, { hasStoredKey: licenseGateSnapshot.hasStoredKey, hasUsableCache: false });
    }
    return local;
  }

  if (!config.endpoint) {
    if (config.policyMode === 'online-required') {
      const result: LicenseValidationResult = {
        valid: false,
        code: 'service_unconfigured',
        normalizedKey,
        mode: 'none',
      };
      markGateFromValidation(result, { hasStoredKey: licenseGateSnapshot.hasStoredKey, hasUsableCache: false });
      return result;
    }
    const local = validateLicenseKeyLocally(normalizedKey, { allowlistEnv: config.allowlistEnv });
    if (local.valid) {
      const stored = await persistLicenseSecret(runtime, config, identity, normalizedKey);
      markGateFromValidation(local, { hasStoredKey: stored, hasUsableCache: false });
    } else {
      markGateFromValidation(local, { hasStoredKey: licenseGateSnapshot.hasStoredKey, hasUsableCache: false });
    }
    return local;
  }

  const keyHash = hashLicenseKey(normalizedKey);
  const nowMs = Date.now();

  try {
    const serverResult = await callLicenseServer(
      config.endpoint,
      {
        licenseKey: normalizedKey,
        product: config.product,
        deviceId: identity.installId,
        installId: identity.installId,
        ...(identity.hardwareId ? { hardwareId: identity.hardwareId } : {}),
        appVersion: runtime.version,
        platform: process.platform,
        machineName: runtime.machineName,
      },
      config.timeoutMs,
    );

    if (!serverResult.valid) {
      const rejected: LicenseValidationResult = {
        valid: false,
        code: 'server_rejected',
        normalizedKey,
        mode: 'online',
        source: 'server',
        message: serverResult.message || serverResult.code || 'license rejected',
      };
      markGateFromValidation(rejected, {
        hasStoredKey: licenseGateSnapshot.hasStoredKey,
        hasUsableCache: false,
      });
      return rejected;
    }

    const expiresAtMs = parseIsoDateToMs(serverResult.expiresAt);
    if (expiresAtMs != null && nowMs > expiresAtMs) {
      const expired: LicenseValidationResult = {
        valid: false,
        code: 'expired',
        normalizedKey,
        mode: 'online',
        source: 'server',
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
      markGateFromValidation(expired, {
        hasStoredKey: licenseGateSnapshot.hasStoredKey,
        hasUsableCache: false,
      });
      return expired;
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
      deviceId: identity.installId,
      installId: identity.installId,
      hardwareId: identity.hardwareId,
      activatedAtMs: nowMs,
      lastValidatedAtMs: nowMs,
      offlineGraceUntilMs,
      expiresAtMs,
      refreshAfterSec,
      licenseId: serverResult.licenseId,
      plan: serverResult.plan,
    });

    const stored = await persistLicenseSecret(runtime, config, identity, normalizedKey);
    const success: LicenseValidationResult = {
      valid: true,
      code: 'valid',
      normalizedKey,
      mode: 'online',
      source: 'server',
      expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
      refreshAfterSec,
      offlineGraceUntilMs,
    };
    markGateFromValidation(success, { hasStoredKey: stored, hasUsableCache: true });
    return success;
  } catch (error) {
    const cachedState = await loadCachedState();
    if (cachedState) {
      const cachedDecision = isCacheUsable(cachedState, {
        expectedKeyHash: keyHash,
        currentInstallId: identity.installId,
        nowMs,
      });
      if (cachedDecision) {
        const stored = await persistLicenseSecret(runtime, config, identity, normalizedKey);
        const cachedResult = {
          ...cachedDecision,
          normalizedKey,
        };
        markGateFromValidation(cachedResult, { hasStoredKey: stored, hasUsableCache: true });
        return cachedResult;
      }
    }

    if (config.policyMode === 'online-optional') {
      const local = validateLicenseKeyLocally(normalizedKey, { allowlistEnv: config.allowlistEnv });
      if (local.valid) {
        const stored = await persistLicenseSecret(runtime, config, identity, normalizedKey);
        markGateFromValidation(local, { hasStoredKey: stored, hasUsableCache: false });
      } else {
        markGateFromValidation(local, { hasStoredKey: licenseGateSnapshot.hasStoredKey, hasUsableCache: false });
      }
      return local;
    }

    const networkError: LicenseValidationResult = {
      valid: false,
      code: 'network_error',
      normalizedKey,
      mode: 'online',
      message: error instanceof Error ? error.message : String(error),
    };
    markGateFromValidation(networkError, {
      hasStoredKey: licenseGateSnapshot.hasStoredKey,
      hasUsableCache: false,
    });
    return networkError;
  }
}

export function getLicenseGateSnapshot(): LicenseGateSnapshot {
  return { ...licenseGateSnapshot };
}

async function bootstrapLicenseGateInternal(): Promise<void> {
  const runtime = await getAppRuntimeInfo();
  const config = resolveLicenseRuntimeConfig(runtime.packaged);
  const identity = await readClientIdentity(runtime.userDataDir);
  const nowMs = Date.now();
  const cachedState = await loadCachedState();
  const usableCache = cachedState
    ? isCacheUsable(cachedState, {
      currentInstallId: identity.installId,
      nowMs,
    })
    : null;

  const storedKey = await readStoredLicenseKeyWithRecovery(runtime, config, identity);
  const hasStoredKey = Boolean(storedKey);

  if (usableCache?.valid) {
    const remainingGraceMs = cachedState
      ? Math.max(0, cachedState.offlineGraceUntilMs - nowMs)
      : (usableCache.offlineGraceUntilMs ? Math.max(0, usableCache.offlineGraceUntilMs - nowMs) : 0);

    markGateFromValidation(usableCache, {
      hasStoredKey,
      hasUsableCache: true,
    });

    if (storedKey && remainingGraceMs <= STARTUP_PROACTIVE_RENEW_THRESHOLD_MS) {
      void forceRevalidateStoredLicense('startup-near-expiry');
    } else if (usableCache.refreshAfterSec) {
      armRevalidateTimer(usableCache.refreshAfterSec);
    }
    return;
  }

  if (!storedKey) {
    const blocked: LicenseValidationResult = {
      valid: false,
      code: 'empty',
      mode: 'none',
      message: 'missing stored license key',
    };
    markGateFromValidation(blocked, { hasStoredKey: false, hasUsableCache: false });
    return;
  }

  setGateSnapshot({
    state: 'checking',
    reason: 'startup_revalidate',
    hasStoredKey: true,
    hasUsableCache: false,
  });
  const result = await validateLicenseKey(storedKey);
  if (shouldScheduleRenewRetry(result, false)) {
    scheduleRevalidateRetry();
  }
}

export function ensureLicenseGateBootstrapped(): void {
  if (gateBootstrapStarted) {
    return;
  }
  gateBootstrapStarted = true;
  gateBootstrapPromise = bootstrapLicenseGateInternal()
    .catch((error) => {
      const failure: LicenseValidationResult = {
        valid: false,
        code: 'network_error',
        mode: 'none',
        message: error instanceof Error ? error.message : String(error),
      };
      markGateFromValidation(failure, {
        hasStoredKey: licenseGateSnapshot.hasStoredKey,
        hasUsableCache: false,
      });
      scheduleRevalidateRetry();
    })
    .finally(() => {
      gateBootstrapPromise = null;
    });
}

export async function forceRevalidateStoredLicense(reason: 'manual' | 'timer' | 'startup' | 'startup-near-expiry' = 'manual'): Promise<LicenseValidationResult> {
  const runtime = await getAppRuntimeInfo();
  const config = resolveLicenseRuntimeConfig(runtime.packaged);
  const identity = await readClientIdentity(runtime.userDataDir);
  const nowMs = Date.now();
  const cacheBeforeRevalidate = await loadCachedState();
  const nearExpiryWindow = isNearExpiryWindow(cacheBeforeRevalidate, identity.installId, nowMs);
  const storedKey = await readStoredLicenseKeyWithRecovery(runtime, config, identity);
  if (!storedKey) {
    const result: LicenseValidationResult = {
      valid: false,
      code: 'empty',
      mode: 'none',
      message: reason === 'manual' ? 'missing stored license key' : 'no stored key for auto revalidate',
    };
    markGateFromValidation(result, { hasStoredKey: false, hasUsableCache: false });
    clearRevalidateTimer();
    return result;
  }

  setGateSnapshot({
    state: 'checking',
    reason: `revalidate_${reason}`,
    hasStoredKey: true,
  });
  const result = await validateLicenseKey(storedKey);
  setGateSnapshot({
    renewalAlert: shouldShowRenewalAlert(result, nearExpiryWindow) ? 'near_expiry_renew_failed' : null,
  });
  if (shouldScheduleRenewRetry(result, nearExpiryWindow)) {
    scheduleRevalidateRetry();
  }
  return result;
}

export async function clearStoredLicenseData(): Promise<void> {
  clearRevalidateTimer();
  resetRevalidateRetryState();
  const runtime = await getAppRuntimeInfo();
  if (runtime.userDataDir) {
    const filePath = getLicenseSecretFilePath(runtime.userDataDir);
    await removeEncryptedLicenseFile(filePath);
  }
  await clearCachedState();
  setGateSnapshot({
    state: 'blocked',
    reason: 'cleared',
    hasStoredKey: false,
    hasUsableCache: false,
    nextRevalidateAtMs: null,
    lastValidation: null,
    renewalAlert: null,
  });
}

export async function getStoredLicenseKey(): Promise<string | null> {
  const runtime = await getAppRuntimeInfo();
  const config = resolveLicenseRuntimeConfig(runtime.packaged);
  const identity = await readClientIdentity(runtime.userDataDir);
  return readStoredLicenseKeyWithRecovery(runtime, config, identity);
}

export async function waitForLicenseGateBootstrap(): Promise<void> {
  ensureLicenseGateBootstrapped();
  await gateBootstrapPromise;
}
