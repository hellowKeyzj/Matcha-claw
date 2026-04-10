import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildDeviceAuthPayloadV3,
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from '../../runtime-host/shared/device-identity';

describe('runtime-host device identity', () => {
  it('首次加载会落盘身份文件，后续复用同一 deviceId', () => {
    const root = mkdtempSync(join(tmpdir(), 'matchaclaw-device-identity-'));
    const filePath = join(root, 'identity', 'device.json');

    const first = loadOrCreateDeviceIdentity(filePath);
    const second = loadOrCreateDeviceIdentity(filePath);

    expect(first.deviceId).toBeTruthy();
    expect(second.deviceId).toBe(first.deviceId);
    expect(readFileSync(filePath, 'utf8')).toContain(first.deviceId);
  });

  it('按 v3 格式构造 challenge 绑定签名载荷', () => {
    const root = mkdtempSync(join(tmpdir(), 'matchaclaw-device-payload-'));
    const filePath = join(root, 'identity', 'device.json');
    const identity = loadOrCreateDeviceIdentity(filePath);
    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: 'gateway-client',
      clientMode: 'backend',
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      signedAtMs: 1744070400000,
      token: 'token-123',
      nonce: 'nonce-xyz',
      platform: 'WIN32',
      deviceFamily: 'Desktop',
    });
    const signature = signDevicePayload(identity.privateKeyPem, payload);
    const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);

    expect(payload).toBe(
      `v3|${identity.deviceId}|gateway-client|backend|operator|operator.read,operator.write|1744070400000|token-123|nonce-xyz|win32|desktop`,
    );
    expect(signature.length).toBeGreaterThan(20);
    expect(publicKey.length).toBeGreaterThan(20);
  });
});
