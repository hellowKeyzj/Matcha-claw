import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeLicenseKey,
  validateLicenseKeyLocally,
  type LicenseGateSnapshot,
  type LicenseRuntimePort,
  type LicenseValidationCode,
  type LicenseValidationResult,
} from '../application/license/service';

const BUILTIN_LICENSE_ENDPOINT = 'https://www.supercnm.top/claw-license/activate';
const BUILTIN_LICENSE_MODE = 'online-required' as const;
const BUILTIN_LICENSE_PRODUCT = 'matchaclaw-desktop';

const LICENSE_PATTERN = /^MATCHACLAW-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/;
const CHECKSUM_CONTEXT = 'matchaclaw-license-v1';
const LICENSE_CACHE_VERSION = 1;
const LICENSE_SECRET_FILE_NAME = 'license-secret.enc.json';
const LICENSE_CACHE_FILE_NAME = 'matchaclaw-license-cache.json';
const REVALIDATE_RETRY_BASE_SEC = 30 * 60;
const REVALIDATE_RETRY_MAX_SEC = 6 * 60 * 60;
const REVALIDATE_RETRY_JITTER_RATIO = 0.2;
const STARTUP_PROACTIVE_RENEW_THRESHOLD_MS = 24 * 60 * 60 * 1000;

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

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

interface LicenseSecretFileV1 {
  version: 1;
  alg: 'aes-256-gcm';
  kdf: 'hkdf-sha256';
  salt: string;
  iv: string;
  ciphertext: string;
  tag: string;
  updatedAt: string;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const HARDWARE_ID_CONTEXT = 'matchaclaw-hardware-id-v1';
const SECRET_CONTEXT = 'matchaclaw-license-secret-v1';

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

function toBase64(raw: Buffer): string {
  return raw.toString('base64');
}

function fromBase64(raw: string): Buffer {
  return Buffer.from(raw, 'base64');
}

function deriveAesKey(material: string, salt: Buffer): Buffer {
  const derived = crypto.hkdfSync(
    'sha256',
    Buffer.from(material, 'utf8'),
    salt,
    Buffer.from(SECRET_CONTEXT, 'utf8'),
    32,
  );
  return Buffer.isBuffer(derived) ? derived : Buffer.from(derived);
}

function assertValidSecretFile(input: unknown): asserts input is LicenseSecretFileV1 {
  if (!input || typeof input !== 'object') {
    throw new Error('invalid_license_secret_file');
  }
  const candidate = input as Partial<LicenseSecretFileV1>;
  if (
    candidate.version !== 1
    || candidate.alg !== 'aes-256-gcm'
    || candidate.kdf !== 'hkdf-sha256'
    || typeof candidate.salt !== 'string'
    || typeof candidate.iv !== 'string'
    || typeof candidate.ciphertext !== 'string'
    || typeof candidate.tag !== 'string'
  ) {
    throw new Error('invalid_license_secret_file');
  }
}

function encryptLicenseKeyForFile(
  plainLicenseKey: string,
  material: string,
): LicenseSecretFileV1 {
  const normalizedKey = plainLicenseKey.trim();
  if (!normalizedKey) {
    throw new Error('empty_license_key');
  }
  if (!material.trim()) {
    throw new Error('empty_secret_material');
  }

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveAesKey(material, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(normalizedKey, 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    alg: 'aes-256-gcm',
    kdf: 'hkdf-sha256',
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
    tag: toBase64(tag),
    updatedAt: new Date().toISOString(),
  };
}

function decryptLicenseKeyFromFile(
  file: LicenseSecretFileV1,
  material: string,
): string {
  assertValidSecretFile(file);
  if (!material.trim()) {
    throw new Error('empty_secret_material');
  }

  const salt = fromBase64(file.salt);
  const iv = fromBase64(file.iv);
  const ciphertext = fromBase64(file.ciphertext);
  const tag = fromBase64(file.tag);
  const key = deriveAesKey(material, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8').trim();

  if (!plain) {
    throw new Error('empty_decrypted_license_key');
  }

  return plain;
}

async function readEncryptedLicenseKey(
  filePath: string,
  material: string,
): Promise<string | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return decryptLicenseKeyFromFile(parsed as LicenseSecretFileV1, material);
  } catch {
    return null;
  }
}

async function writeEncryptedLicenseKey(
  filePath: string,
  plainLicenseKey: string,
  material: string,
): Promise<void> {
  const payload = encryptLicenseKeyForFile(plainLicenseKey, material);
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const backupFilePath = `${filePath}.bak`;
  await writeFile(tmpFilePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

  try {
    await copyFile(filePath, backupFilePath);
  } catch {
    // ignore backup failures
  }

  await rm(filePath, { force: true });
  await rename(tmpFilePath, filePath);
}

async function removeEncryptedLicenseFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
  await rm(`${filePath}.bak`, { force: true });
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32
    && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return crypto.createHash('sha256').update(derivePublicKeyRaw(publicKeyPem)).digest('hex');
}

async function loadOrCreateDeviceIdentity(filePath: string): Promise<DeviceIdentity> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      version?: unknown;
      deviceId?: unknown;
      publicKeyPem?: unknown;
      privateKeyPem?: unknown;
    };
    if (
      parsed.version === 1
      && typeof parsed.deviceId === 'string'
      && typeof parsed.publicKeyPem === 'string'
      && typeof parsed.privateKeyPem === 'string'
    ) {
      const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
      if (derivedId && derivedId !== parsed.deviceId) {
        await writeDeviceIdentityFile(filePath, {
          ...parsed,
          deviceId: derivedId,
        });
        return {
          deviceId: derivedId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
      return {
        deviceId: parsed.deviceId,
        publicKeyPem: parsed.publicKeyPem,
        privateKeyPem: parsed.privateKeyPem,
      };
    }
  } catch {
    // regenerate when missing or corrupt
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const identity = {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
  };
  await writeDeviceIdentityFile(filePath, {
    version: 1,
    ...identity,
    createdAtMs: Date.now(),
  });
  return identity;
}

async function writeDeviceIdentityFile(filePath: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function execFileText(command: string, args: string[], timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: 1024 * 256,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve((stdout || '').toString());
      },
    );
  });
}

async function resolveHardwareIdRaw(platformName: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platformName === 'win32') {
    try {
      const output = await execFileText('reg', [
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
        '/v',
        'MachineGuid',
      ]);
      const matched = output.match(/MachineGuid\s+REG_\w+\s+([^\r\n]+)/i);
      return matched ? matched[1].trim() : null;
    } catch {
      return null;
    }
  }

  if (platformName === 'darwin') {
    try {
      const output = await execFileText('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
      const matched = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/i);
      return matched ? matched[1].trim() : null;
    } catch {
      return null;
    }
  }

  if (platformName === 'linux') {
    for (const candidate of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const raw = await readFile(candidate, 'utf8');
        const normalized = raw.trim();
        if (normalized) {
          return normalized;
        }
      } catch {
        // continue
      }
    }
  }

  return null;
}

function normalizeAndHashHardwareId(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  return crypto
    .createHash('sha256')
    .update(`${HARDWARE_ID_CONTEXT}:${normalized}`)
    .digest('hex');
}

async function resolveHardwareId(platformName: NodeJS.Platform = process.platform): Promise<string | null> {
  const override = process.env.MATCHACLAW_LICENSE_HARDWARE_ID_OVERRIDE?.trim();
  if (override) {
    return normalizeAndHashHardwareId(override) || null;
  }

  const raw = await resolveHardwareIdRaw(platformName);
  return raw ? normalizeAndHashHardwareId(raw) || null : null;
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
  return {
    packaged: process.env.MATCHACLAW_APP_PACKAGED === '1',
    version: process.env.MATCHACLAW_APP_VERSION || process.env.npm_package_version || '0.0.0',
    machineName: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown-host',
    userDataDir: process.env.MATCHACLAW_APP_USER_DATA_DIR || null,
  };
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

async function getLicenseCacheFilePath(): Promise<string | null> {
  const runtime = await getAppRuntimeInfo();
  return runtime.userDataDir ? path.join(runtime.userDataDir, LICENSE_CACHE_FILE_NAME) : null;
}

async function loadCachedState(): Promise<CachedLicenseState | null> {
  const cacheFilePath = await getLicenseCacheFilePath();
  if (!cacheFilePath) {
    return null;
  }
  try {
    const state = JSON.parse(await readFile(cacheFilePath, 'utf8')) as unknown;
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
  const cacheFilePath = await getLicenseCacheFilePath();
  if (!cacheFilePath) {
    return;
  }
  await mkdir(path.dirname(cacheFilePath), { recursive: true });
  await writeFile(cacheFilePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function clearCachedState(): Promise<void> {
  const cacheFilePath = await getLicenseCacheFilePath();
  if (!cacheFilePath) {
    return;
  }
  await rm(cacheFilePath, { force: true });
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
    const response = await fetch(endpoint, {
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

  // 本地密文损坏/不可读时，用最近一次成功授权的 key 自愈重建密文文件
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

function normalizeServerCode(rawCode?: string): LicenseValidationCode {
  switch (rawCode) {
    case 'valid':
    case 'empty':
    case 'format_invalid':
    case 'service_unconfigured':
    case 'network_error':
    case 'server_rejected':
    case 'cache_grace_valid':
    case 'expired':
    case 'device_mismatch':
    case 'not_allowed':
    case 'checksum_invalid':
      return rawCode;
    default:
      return 'server_rejected';
  }
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
      const rejectedCode = normalizeServerCode(serverResult.code);
      const rejected: LicenseValidationResult = {
        valid: false,
        code: rejectedCode,
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
      if (cachedDecision?.valid) {
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

export class NodeLicenseRuntime implements LicenseRuntimePort {
  async gate() {
    await waitForLicenseGateBootstrap();
    return getLicenseGateSnapshot();
  }

  async storedKey() {
    await waitForLicenseGateBootstrap();
    return await getStoredLicenseKey();
  }

  async validate(key: string, options?: { packagedOverride?: boolean }) {
    return await validateLicenseKey(key, options);
  }

  async revalidate() {
    return await forceRevalidateStoredLicense('manual');
  }

  async clear() {
    await clearStoredLicenseData();
  }
}
