import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deviceKeyStore = vi.hoisted(() => ({
  getCloudPackageDevicePublicKey: vi.fn(() => Promise.resolve('device-public-key')),
  unwrapCloudPackageDeviceEnvelope: vi.fn(() => Promise.resolve('authorization-key')),
}));

vi.mock('../../electron/main/cloud-account/device-key-store', () => ({
  getCloudPackageDevicePublicKey: () => deviceKeyStore.getCloudPackageDevicePublicKey(),
  unwrapCloudPackageDeviceEnvelope: (envelope: unknown) => deviceKeyStore.unwrapCloudPackageDeviceEnvelope(envelope),
}));

import { handlePackageRoutes } from '../../electron/api/routes/packages';

function incoming(body: unknown, method = 'POST') {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    headers: { 'content-type': 'application/json' },
  });
}

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const deviceEnvelope = {
  keyId: 'device-key',
  algorithm: 'rsa-oaep-sha256',
  ciphertextBase64: 'ciphertext',
} as const;

const packageSha256 = 'a'.repeat(64);

const authorizationLease = {
  packageVersionId: 'version-calendar',
  packageType: 'skill',
  deviceEnvelope,
  leaseExpiresAt: '2099-01-01T00:00:00.000Z',
} as const;

const forbiddenPublicFields = /packagePath|deviceEnvelope|authorizationKey|contentKey|rawPayload|token/;

describe('packages host API route', () => {
  beforeEach(() => {
    deviceKeyStore.getCloudPackageDevicePublicKey.mockClear();
    deviceKeyStore.unwrapCloudPackageDeviceEnvelope.mockClear();
  });

  it('uploads sealed skill cloud packages through skill key and cloud envelope export', async () => {
    const cloudAccountService = {
      fetchSealedCloudKey: vi.fn().mockResolvedValue({ version: 1, publicKey: 'cloud-public-key', keyId: 'cloud-key' }),
      uploadPackage: vi.fn().mockResolvedValue({ packageId: 'pkg-calendar', packageVersionId: 'version-calendar' }),
    };
    const sealedSkillsTransport = {
      exportCloud: vi.fn().mockResolvedValue({
        status: 200,
        body: { outcome: 'accepted', skillKey: 'skill:openclaw:calendar', packagePath: 'C:/sealed/calendar.matcha-skillpkg' },
      }),
    };
    const result = response();

    await expect(handlePackageRoutes(
      incoming({ skillKey: 'skill:openclaw:calendar' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/packages/upload/sealed-skill'),
      { cloudAccountService, runtimeHostTransports: { sealedSkillsTransport } } as never,
    )).resolves.toBe(true);

    expect(sealedSkillsTransport.exportCloud).toHaveBeenCalledWith({
      skillKey: 'skill:openclaw:calendar',
      cloudPublicKey: 'cloud-public-key',
      cloudKeyId: 'cloud-key',
    });
    expect(cloudAccountService.uploadPackage).toHaveBeenCalledWith('C:/sealed/calendar.matcha-skillpkg');
    expect(JSON.stringify(sealedSkillsTransport.exportCloud.mock.calls[0]?.[0])).not.toContain('packagePath');
    expect(result.state).toEqual({
      statusCode: 200,
      body: { packageId: 'pkg-calendar', packageVersionId: 'version-calendar' },
    });
  });

  it('uploads sealed agent cloud packages through agent id and cloud envelope export', async () => {
    const cloudAccountService = {
      fetchSealedCloudKey: vi.fn().mockResolvedValue({ version: 1, publicKey: 'cloud-public-key', keyId: 'cloud-key' }),
      uploadPackage: vi.fn().mockResolvedValue({ packageId: 'pkg-writer', packageVersionId: 'version-writer' }),
    };
    const agentsTransport = {
      execute: vi.fn().mockResolvedValue({
        status: 200,
        body: { success: true, package: { agentId: 'writer', fileName: 'writer.matcha-agentpkg', packagePath: 'C:/sealed/writer.matcha-agentpkg', size: 1024, exportedAtMs: 1 } },
      }),
    };
    const result = response();

    await expect(handlePackageRoutes(
      incoming({ agentId: 'writer' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/packages/upload/sealed-agent'),
      { cloudAccountService, runtimeHostTransports: { agentsTransport } } as never,
    )).resolves.toBe(true);

    expect(agentsTransport.execute).toHaveBeenCalledWith({
      id: 'subagent.management',
      operationId: 'subagents.package.exportCloud',
      scope: { kind: 'agent', endpoint, agentId: 'main' },
      target: { kind: 'subagent', subagentId: 'writer' },
      input: { kind: 'packageExportCloud', endpoint, agentId: 'writer', cloudPublicKey: 'cloud-public-key', cloudKeyId: 'cloud-key' },
    });
    expect(JSON.stringify(agentsTransport.execute.mock.calls[0]?.[0])).not.toContain('C:/sealed');
    expect(cloudAccountService.uploadPackage).toHaveBeenCalledWith('C:/sealed/writer.matcha-agentpkg');
    expect(result.state).toEqual({
      statusCode: 200,
      body: { packageId: 'pkg-writer', packageVersionId: 'version-writer' },
    });
  });

  it('records downloads without renderer device key and no device envelope projection', async () => {
    const cloudAccountService = {
      recordPackageDownload: vi.fn().mockResolvedValue({
        packageVersionId: 'version-calendar',
        recorded: true,
      }),
    };
    const result = response();

    await expect(handlePackageRoutes(
      incoming({ packageVersionId: 'version-calendar', source: 'skills', devicePublicKey: 'renderer-key' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/packages/download-record'),
      { cloudAccountService, runtimeHostTransports: {} } as never,
    )).resolves.toBe(true);

    expect(cloudAccountService.recordPackageDownload).toHaveBeenCalledWith({
      packageVersionId: 'version-calendar',
      source: 'skills',
    });
    expect(result.state).toEqual({
      statusCode: 200,
      body: { packageVersionId: 'version-calendar', recorded: true },
    });
    expect(JSON.stringify(result.state.body)).not.toContain('deviceEnvelope');
  });

  it('authorizes, installs, and records downloaded agent packages through subagent package install', async () => {
    const cloudAccountService = {
      authorizePackage: vi.fn().mockResolvedValue({ ...authorizationLease, packageVersionId: 'version-writer', packageType: 'agent' }),
      downloadPackage: vi.fn().mockResolvedValue({
        packagePath: 'C:/sealed/writer.matcha-agentpkg',
        packageVersionId: 'version-writer',
        filename: 'writer.matcha-agentpkg',
        bytes: 1024,
        packageSha256,
      }),
      recordPackageDownload: vi.fn().mockResolvedValue({
        packageVersionId: 'version-writer',
        recorded: true,
      }),
    };
    const agentsTransport = {
      execute: vi.fn().mockResolvedValue({
        status: 200,
        body: { success: true, package: { agentId: 'writer' } },
      }),
    };
    const sealedSkillsTransport = { install: vi.fn() };
    const sealedResourceAuthorizationTransport = {
      authorizePackage: vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'accepted' } }),
    };
    const result = response();

    await expect(handlePackageRoutes(
      incoming({ packageVersionId: 'version-writer', packageType: 'agent', source: 'subagents' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/packages/install'),
      { cloudAccountService, runtimeHostTransports: { agentsTransport, sealedSkillsTransport, sealedResourceAuthorizationTransport } } as never,
    )).resolves.toBe(true);

    expect(cloudAccountService.authorizePackage).toHaveBeenCalledWith({
      packageVersionId: 'version-writer',
      packageType: 'agent',
      source: 'subagents',
    });
    expect(deviceKeyStore.unwrapCloudPackageDeviceEnvelope).toHaveBeenCalledWith(deviceEnvelope);
    expect(cloudAccountService.downloadPackage).toHaveBeenCalledWith({
      packageVersionId: 'version-writer',
      packageType: 'agent',
      source: 'subagents',
    });
    expect(sealedResourceAuthorizationTransport.authorizePackage).toHaveBeenCalledWith({
      packageSha256,
      authorizationKey: 'authorization-key',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(sealedResourceAuthorizationTransport.authorizePackage.mock.invocationCallOrder[0]).toBeLessThan(
      agentsTransport.execute.mock.invocationCallOrder[0],
    );
    expect(agentsTransport.execute).toHaveBeenCalledWith({
      id: 'subagent.management',
      operationId: 'subagents.package.install',
      scope: { kind: 'agent', endpoint, agentId: 'main' },
      target: { kind: 'subagent' },
      input: { kind: 'packageInstall', endpoint, packagePath: 'C:/sealed/writer.matcha-agentpkg', cloudMetadata: { packageVersionId: 'version-writer', packageType: 'agent', packageSha256, fileName: 'writer.matcha-agentpkg' } },
    });
    expect(JSON.stringify(agentsTransport.execute.mock.calls[0]?.[0])).not.toMatch(/authorizationKey|deviceEnvelope/);
    expect(sealedSkillsTransport.install).not.toHaveBeenCalled();
    expect(cloudAccountService.recordPackageDownload).toHaveBeenCalledWith({
      packageVersionId: 'version-writer',
      source: 'subagents',
    });
    expect(cloudAccountService.recordPackageDownload.mock.invocationCallOrder[0]).toBeGreaterThan(
      agentsTransport.execute.mock.invocationCallOrder[0],
    );
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        packageVersionId: 'version-writer',
        filename: 'writer.matcha-agentpkg',
        bytes: 1024,
        packageSha256,
        install: { outcome: 'accepted', agentId: 'writer' },
      },
    });
    expect(JSON.stringify(result.state.body)).not.toMatch(forbiddenPublicFields);
  });

  it('rejects install when runtime keyring authorization rejects the lease', async () => {
    const cloudAccountService = {
      authorizePackage: vi.fn().mockResolvedValue(authorizationLease),
      downloadPackage: vi.fn().mockResolvedValue({
        packagePath: 'C:/sealed/calendar.matcha-skillpkg',
        packageVersionId: 'version-calendar',
        filename: 'calendar.matcha-skillpkg',
        bytes: 1024,
        packageSha256,
      }),
      recordPackageDownload: vi.fn(),
    };
    const agentsTransport = { execute: vi.fn() };
    const sealedSkillsTransport = { install: vi.fn() };
    const sealedResourceAuthorizationTransport = {
      authorizePackage: vi.fn().mockResolvedValue({ status: 403, body: { outcome: 'rejected' } }),
    };
    const result = response();

    await expect(handlePackageRoutes(
      incoming({ packageVersionId: 'version-calendar', packageType: 'skill', source: 'skills' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/packages/install'),
      { cloudAccountService, runtimeHostTransports: { agentsTransport, sealedSkillsTransport, sealedResourceAuthorizationTransport } } as never,
    )).resolves.toBe(true);

    expect(sealedResourceAuthorizationTransport.authorizePackage).toHaveBeenCalledWith({
      packageSha256,
      authorizationKey: 'authorization-key',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(result.state).toEqual({
      statusCode: 403,
      body: { success: false, error: 'Package authorization failed' },
    });
    expect(agentsTransport.execute).not.toHaveBeenCalled();
    expect(sealedSkillsTransport.install).not.toHaveBeenCalled();
    expect(cloudAccountService.recordPackageDownload).not.toHaveBeenCalled();
  });

  it('authorizes, installs, and records downloaded skill packages through sealed install and skills config', async () => {
    const cloudAccountService = {
      authorizePackage: vi.fn().mockResolvedValue(authorizationLease),
      downloadPackage: vi.fn().mockResolvedValue({
        packagePath: 'C:/sealed/calendar.matcha-skillpkg',
        packageVersionId: 'version-calendar',
        filename: 'calendar.matcha-skillpkg',
        bytes: 1024,
        packageSha256,
      }),
      recordPackageDownload: vi.fn().mockResolvedValue({
        packageVersionId: 'version-calendar',
        recorded: true,
      }),
    };
    const agentsTransport = { execute: vi.fn() };
    const sealedSkillsTransport = {
      install: vi.fn().mockResolvedValue({
        status: 200,
        body: { outcome: 'accepted', skillKey: 'vendor/calendar' },
      }),
    };
    const skillsManagementTransport = {
      mutateConfig: vi.fn().mockResolvedValue({
        status: 200,
        body: { outcome: 'accepted' },
      }),
    };
    const sealedResourceAuthorizationTransport = {
      authorizePackage: vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'accepted' } }),
    };
    const result = response();

    await expect(handlePackageRoutes(
      incoming({ packageVersionId: 'version-calendar', packageType: 'skill', source: 'skills' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/packages/install'),
      { cloudAccountService, runtimeHostTransports: { agentsTransport, sealedSkillsTransport, skillsManagementTransport, sealedResourceAuthorizationTransport } } as never,
    )).resolves.toBe(true);

    expect(cloudAccountService.authorizePackage).toHaveBeenCalledWith({
      packageVersionId: 'version-calendar',
      packageType: 'skill',
      source: 'skills',
    });
    expect(deviceKeyStore.unwrapCloudPackageDeviceEnvelope).toHaveBeenCalledWith(deviceEnvelope);
    expect(cloudAccountService.downloadPackage).toHaveBeenCalledWith({
      packageVersionId: 'version-calendar',
      packageType: 'skill',
      source: 'skills',
    });
    expect(sealedResourceAuthorizationTransport.authorizePackage).toHaveBeenCalledWith({
      packageSha256,
      authorizationKey: 'authorization-key',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(sealedResourceAuthorizationTransport.authorizePackage.mock.invocationCallOrder[0]).toBeLessThan(
      sealedSkillsTransport.install.mock.invocationCallOrder[0],
    );
    expect(sealedSkillsTransport.install).toHaveBeenCalledWith({
      packagePath: 'C:/sealed/calendar.matcha-skillpkg',
      cloudMetadata: { packageVersionId: 'version-calendar', packageType: 'skill', packageSha256, fileName: 'calendar.matcha-skillpkg' },
    });
    expect(JSON.stringify(sealedSkillsTransport.install.mock.calls[0]?.[0])).not.toMatch(/authorizationKey|deviceEnvelope/);
    expect(skillsManagementTransport.mutateConfig).not.toHaveBeenCalled();
    expect(agentsTransport.execute).not.toHaveBeenCalled();
    expect(cloudAccountService.recordPackageDownload).toHaveBeenCalledWith({
      packageVersionId: 'version-calendar',
      source: 'skills',
    });
    expect(cloudAccountService.recordPackageDownload.mock.invocationCallOrder[0]).toBeGreaterThan(
      sealedSkillsTransport.install.mock.invocationCallOrder[0],
    );
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        packageVersionId: 'version-calendar',
        filename: 'calendar.matcha-skillpkg',
        bytes: 1024,
        packageSha256,
        install: { outcome: 'accepted', skillKey: 'vendor/calendar' },
      },
    });
    expect(JSON.stringify(result.state.body)).not.toMatch(forbiddenPublicFields);
  });
});
