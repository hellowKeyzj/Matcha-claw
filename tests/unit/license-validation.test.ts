import { afterEach, describe, expect, it } from 'vitest';
import { buildLicenseKey, validateLicenseKey, validateLicenseKeyLocally } from '@electron/utils/license';

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
    const result = validateLicenseKeyLocally(checksumValidKey);
    expect(result.valid).toBe(false);
    expect(result.code).toBe('not_allowed');
    expect(result.mode).toBe('allowlist');
  });

  it('配置白名单后，白名单内 key 可以通过（大小写不敏感）', () => {
    process.env.MATCHACLAW_LICENSE_KEYS = 'MATCHACLAW-AAAA-BBBB-CCCC-DDDD';
    const result = validateLicenseKeyLocally('matchaclaw-aaaa-bbbb-cccc-dddd');
    expect(result.valid).toBe(true);
    expect(result.code).toBe('valid');
    expect(result.mode).toBe('allowlist');
    expect(result.normalizedKey).toBe('MATCHACLAW-AAAA-BBBB-CCCC-DDDD');
  });
});

describe('validateLicenseKey (policy)', () => {
  it('在线必需模式下，服务不可达时返回 network_error', async () => {
    process.env.MATCHACLAW_LICENSE_ENDPOINT = 'http://127.0.0.1:9/v1/activate';
    process.env.MATCHACLAW_LICENSE_MODE = 'online-required';
    process.env.MATCHACLAW_LICENSE_TIMEOUT_MS = '100';
    const key = buildLicenseKey('ABCD1234EFGH');

    const result = await validateLicenseKey(key, { packagedOverride: true });
    expect(result.valid).toBe(false);
    expect(result.code).toBe('network_error');
  });

  it('offline-local 模式直接走本地校验', async () => {
    process.env.MATCHACLAW_LICENSE_MODE = 'offline-local';
    const key = buildLicenseKey('QWER5678TYUI');

    const result = await validateLicenseKey(key, { packagedOverride: false });
    expect(result.valid).toBe(true);
    expect(result.code).toBe('valid');
    expect(result.mode).toBe('checksum');
  });
});
