import { constants, publicEncrypt, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ directory: '', available: true, encrypt: vi.fn((value: string) => Buffer.from(value)), decrypt: vi.fn((value: Buffer) => value.toString()) }));
vi.mock('electron', () => ({ app: { getPath: () => state.directory }, safeStorage: { isEncryptionAvailable: () => state.available, encryptString: (value: string) => state.encrypt(value), decryptString: (value: Buffer) => state.decrypt(value) } }));
afterEach(async () => { if (state.directory) await rm(state.directory, { recursive: true, force: true }); state.available = true; });

describe('cloud package device key initialization', () => {
  it('singleflights read/create/write and unwraps every concurrent caller with the persisted key', async () => {
    vi.resetModules();
    state.directory = await mkdtemp(join(tmpdir(), 'matcha-device-key-test-'));
    state.encrypt.mockClear();
    const keys = await import('../../electron/main/cloud-account/device-key-store');
    const publicKeys = await Promise.all(Array.from({ length: 16 }, () => keys.getCloudPackageDevicePublicKey()));
    expect(new Set(publicKeys).size).toBe(1);
    expect(state.encrypt).toHaveBeenCalledTimes(1);
    const secret = randomBytes(32);
    const ciphertextBase64 = publicEncrypt({ key: publicKeys[0], padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, secret).toString('base64url');
    await expect(keys.unwrapCloudPackageDeviceEnvelope({ algorithm: 'rsa-oaep-sha256', ciphertextBase64 })).resolves.toBe(secret.toString('base64url'));
    expect(await keys.getCloudPackageDevicePublicKey()).toBe(publicKeys[0]);
    expect(state.encrypt).toHaveBeenCalledTimes(1);
  });

  it('releases failed initialization so secure storage recovery can retry', async () => {
    vi.resetModules();
    state.directory = await mkdtemp(join(tmpdir(), 'matcha-device-key-test-'));
    state.available = false;
    const keys = await import('../../electron/main/cloud-account/device-key-store');
    const failures = await Promise.allSettled([keys.getCloudPackageDevicePublicKey(), keys.getCloudPackageDevicePublicKey()]);
    expect(failures.every((result) => result.status === 'rejected')).toBe(true);
    state.available = true;
    await expect(keys.getCloudPackageDevicePublicKey()).resolves.toContain('BEGIN PUBLIC KEY');
  });
});
