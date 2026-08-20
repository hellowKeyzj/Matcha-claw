import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeHostCronBrokerProvisioning } from '../../electron/main/runtime-host-delivery/cron-broker-provisioning';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('createRuntimeHostCronBrokerProvisioning', () => {
  it('creates an independent public key and private app-server handoff', () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'matcha-cron-provisioning-'));
    tempRoots.push(storageRoot);

    const provisioning = createRuntimeHostCronBrokerProvisioning({
      storageRoot,
      cronBrokerTransportPort: 3250,
    });
    const provisioningPath = join(storageRoot, 'cron-broker-provisioning.json');

    expect(provisioning.verificationKey).toMatch(/^[A-Za-z0-9_-]{59}$/);
    expect(provisioning.endpoint).toBe('http://127.0.0.1:3250/api/cron/broker');
    expect(provisioning.privateKeyPath).toBe(
      join(storageRoot, 'cron-broker-private-key.pem'),
    );
    expect(readFileSync(provisioning.privateKeyPath, 'utf8')).toMatch(
      /^-----BEGIN PRIVATE KEY-----/,
    );
    expect(JSON.parse(readFileSync(provisioningPath, 'utf8'))).toEqual({
      version: 1,
      endpoint: provisioning.endpoint,
      privateKeyPath: provisioning.privateKeyPath,
    });
  });

  it('does not reuse the generic delivery key or a previous Cron key', () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'matcha-cron-provisioning-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'matcha-cron-provisioning-'));
    tempRoots.push(firstRoot, secondRoot);

    const first = createRuntimeHostCronBrokerProvisioning({
      storageRoot: firstRoot,
      cronBrokerTransportPort: 3250,
    });
    const second = createRuntimeHostCronBrokerProvisioning({
      storageRoot: secondRoot,
      cronBrokerTransportPort: 3250,
    });

    expect(second.verificationKey).not.toBe(first.verificationKey);
    expect(second.verificationKey).not.toBe(
      'MCowBQYDK2VwAyEAI3qD__Jv49yWsjljbNRbVm11047IMl5xFBflSPOROKE',
    );
  });

  it('removes private key and metadata on close, including repeated close', () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'matcha-cron-provisioning-'));
    tempRoots.push(storageRoot);
    const provisioning = createRuntimeHostCronBrokerProvisioning({
      storageRoot,
      cronBrokerTransportPort: 3250,
    });
    const provisioningPath = join(storageRoot, 'cron-broker-provisioning.json');

    provisioning.close();
    provisioning.close();

    expect(existsSync(provisioning.privateKeyPath)).toBe(false);
    expect(existsSync(provisioningPath)).toBe(false);
  });

  it('rejects an invalid dedicated broker port before creating files', () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'matcha-cron-provisioning-'));
    tempRoots.push(storageRoot);

    expect(() =>
      createRuntimeHostCronBrokerProvisioning({
        storageRoot,
        cronBrokerTransportPort: 0,
      }),
    ).toThrow('cronBrokerTransportPort');
    expect(existsSync(join(storageRoot, 'cron-broker-private-key.pem'))).toBe(false);
  });
});
