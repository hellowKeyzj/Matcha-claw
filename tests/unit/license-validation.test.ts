import { afterEach, describe, expect, it } from 'vitest';
import { buildLicenseKey, LicenseService, validateLicenseKeyLocally } from '../../runtime-host/application/license/service';

const originalAllowlistEnv = process.env.MATCHACLAW_LICENSE_KEYS;
const originalEndpoint = process.env.MATCHACLAW_LICENSE_ENDPOINT;
const originalMode = process.env.MATCHACLAW_LICENSE_MODE;
const originalTimeoutMs = process.env.MATCHACLAW_LICENSE_TIMEOUT_MS;

afterEach(() => {
  if (originalAllowlistEnv === undefined) {
    delete process.env.MATCHACLAW_LICENSE_KEYS;
  } else {
    process.env.MATCHACLAW_LICENSE_KEYS = originalAllowlistEnv;
  }
  if (originalEndpoint === undefined) {
    delete process.env.MATCHACLAW_LICENSE_ENDPOINT;
  } else {
    process.env.MATCHACLAW_LICENSE_ENDPOINT = originalEndpoint;
  }
  if (originalMode === undefined) {
    delete process.env.MATCHACLAW_LICENSE_MODE;
  } else {
    process.env.MATCHACLAW_LICENSE_MODE = originalMode;
  }
  if (originalTimeoutMs === undefined) {
    delete process.env.MATCHACLAW_LICENSE_TIMEOUT_MS;
  } else {
    process.env.MATCHACLAW_LICENSE_TIMEOUT_MS = originalTimeoutMs;
  }
});

describe('validateLicenseKeyLocally', () => {
  it('空字符串返回 empty', () => {
    delete process.env.MATCHACLAW_LICENSE_KEYS;
    const result = validateLicenseKeyLocally('   ');
    expect(result.valid).toBe(false);
    expect(result.code).toBe('empty');
    expect(result.mode).toBe('none');
  });

  it('格式错误返回 format_invalid', () => {
    delete process.env.MATCHACLAW_LICENSE_KEYS;
    const result = validateLicenseKeyLocally('bad-license-key');
    expect(result.valid).toBe(false);
    expect(result.code).toBe('format_invalid');
  });

  it('无白名单时，合法校验码可以通过', () => {
    delete process.env.MATCHACLAW_LICENSE_KEYS;
    const key = buildLicenseKey('ABCD1234EFGH');
    const result = validateLicenseKeyLocally(key);
    expect(result.valid).toBe(true);
    expect(result.code).toBe('valid');
    expect(result.mode).toBe('checksum');
  });

  it('无白名单时，错误校验码会被拒绝', () => {
    delete process.env.MATCHACLAW_LICENSE_KEYS;
    const result = validateLicenseKeyLocally('MATCHACLAW-ABCD-1234-EFGH-AAAA');
    expect(result.valid).toBe(false);
    expect(result.code).toBe('checksum_invalid');
    expect(result.mode).toBe('checksum');
  });

  it('配置白名单后，白名单外 key 会被拒绝（即使校验码正确）', () => {
    process.env.MATCHACLAW_LICENSE_KEYS = 'MATCHACLAW-AAAA-BBBB-CCCC-DDDD';
    const checksumValidKey = buildLicenseKey('ZXCV5678BNMQ');
    const result = validateLicenseKeyLocally(checksumValidKey, {
      allowlistEnv: process.env.MATCHACLAW_LICENSE_KEYS,
    });
    expect(result.valid).toBe(false);
    expect(result.code).toBe('not_allowed');
    expect(result.mode).toBe('allowlist');
  });

  it('配置白名单后，白名单内 key 可以通过（大小写不敏感）', () => {
    process.env.MATCHACLAW_LICENSE_KEYS = 'MATCHACLAW-AAAA-BBBB-CCCC-DDDD';
    const result = validateLicenseKeyLocally('matchaclaw-aaaa-bbbb-cccc-dddd', {
      allowlistEnv: process.env.MATCHACLAW_LICENSE_KEYS,
    });
    expect(result.valid).toBe(true);
    expect(result.code).toBe('valid');
    expect(result.mode).toBe('allowlist');
    expect(result.normalizedKey).toBe('MATCHACLAW-AAAA-BBBB-CCCC-DDDD');
  });
});

describe('LicenseService public projection', () => {
  it('validate/revalidate/gate do not expose normalizedKey or full license key', async () => {
    const fullKey = 'MATCHACLAW-AAAA-BBBB-CCCC-DDDD';
    const service = new LicenseService({
      gate: async () => ({
        state: 'granted',
        reason: 'valid',
        checkedAtMs: 1,
        hasStoredKey: true,
        hasUsableCache: true,
        nextRevalidateAtMs: null,
        lastValidation: { valid: true, code: 'valid', normalizedKey: fullKey, mode: 'checksum', source: 'local' },
        renewalAlert: null,
      }),
      storedKey: async () => fullKey,
      validate: async () => ({ valid: true, code: 'valid', normalizedKey: fullKey, mode: 'checksum', source: 'local' }),
      revalidate: async () => ({ valid: true, code: 'valid', normalizedKey: fullKey, mode: 'checksum', source: 'local' }),
      clear: async () => {},
    });

    const validateResult = await service.validate({ key: fullKey });
    const revalidateResult = await service.revalidate();
    const gateResult = await service.gate();
    const storedKeyResult = await service.storedKey();

    expect(validateResult.data).toMatchObject({ valid: true, masked: 'MATCHACLAW-****-****-****-DDDD', last4: 'DDDD' });
    expect(revalidateResult.data).toMatchObject({ valid: true, masked: 'MATCHACLAW-****-****-****-DDDD', last4: 'DDDD' });
    expect(gateResult.data.lastValidation).toMatchObject({ valid: true, masked: 'MATCHACLAW-****-****-****-DDDD', last4: 'DDDD' });
    expect(storedKeyResult.data).toEqual({ hasStoredKey: true, masked: 'MATCHACLAW-****-****-****-DDDD', last4: 'DDDD' });
    expect(JSON.stringify([validateResult, revalidateResult, gateResult, storedKeyResult])).not.toContain(fullKey);
    expect(validateResult.data).not.toHaveProperty('normalizedKey');
    expect(revalidateResult.data).not.toHaveProperty('normalizedKey');
    expect(gateResult.data.lastValidation).not.toHaveProperty('normalizedKey');
  });
});

describe('validateLicenseKey (policy)', () => {
  it('在线必需模式下，服务不可达时返回 network_error', async () => {
    process.env.MATCHACLAW_LICENSE_ENDPOINT = 'http://127.0.0.1:9/v1/activate';
    process.env.MATCHACLAW_LICENSE_MODE = 'online-required';
    process.env.MATCHACLAW_LICENSE_TIMEOUT_MS = '100';
    const key = buildLicenseKey('ABCD1234EFGH');

    const { NodeLicenseRuntime } = await import('../../runtime-host/composition/license-node-runtime');
    const result = await new NodeLicenseRuntime().validate(key, { packagedOverride: true });
    expect(result.valid).toBe(false);
    expect(result.code).toBe('network_error');
  });

  it('offline-local 模式直接走本地校验', async () => {
    process.env.MATCHACLAW_LICENSE_MODE = 'offline-local';
    const key = buildLicenseKey('QWER5678TYUI');

    const { NodeLicenseRuntime } = await import('../../runtime-host/composition/license-node-runtime');
    const result = await new NodeLicenseRuntime().validate(key, { packagedOverride: false });
    expect(result.valid).toBe(true);
    expect(result.code).toBe('valid');
    expect(result.mode).toBe('checksum');
  });
});
