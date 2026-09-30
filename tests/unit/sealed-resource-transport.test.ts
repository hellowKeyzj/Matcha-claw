import { describe, expect, it, vi } from 'vitest';

import { createRuntimeHostDeliveryIssuer } from '../../electron/main/runtime-host-delivery/issuer';
import { createSealedResourceAuthorizationTransport } from '../../electron/main/runtime-host-delivery/transport/sealed-resource';

const packageEntry = {
  packageVersionId: 'version-1',
  packageType: 'skill',
  packageSha256: 'a'.repeat(64),
  fileName: 'cloud.matcha-skillpkg',
};

function nativeResponse(body: unknown, status = 200) {
  return { status, json: async () => body };
}

describe('sealed resource private delivery transport', () => {
  it('uses generic issuer decisions with fixed endpoints, methods, scope and subject', async () => {
    const issuer = createRuntimeHostDeliveryIssuer();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(nativeResponse({ packages: [packageEntry, { ...packageEntry, packageType: 'agent' }] }))
      .mockResolvedValueOnce(nativeResponse({ outcome: 'accepted' }))
      .mockResolvedValueOnce(nativeResponse({ outcome: 'accepted' }));
    const transport = createSealedResourceAuthorizationTransport(issuer, 3227, fetcher);
    await expect(transport.listCloudPackages()).resolves.toEqual({ status: 200, body: { packages: [packageEntry, { ...packageEntry, packageType: 'agent' }] } });
    await expect(transport.clearAuthorizations()).resolves.toEqual({ status: 200, body: { outcome: 'accepted' } });
    const authorization = { packageSha256: packageEntry.packageSha256, authorizationKey: 'b'.repeat(43), leaseExpiresAt: '2099-01-01T00:00:00Z' };
    await expect(transport.authorizePackage(authorization)).resolves.toEqual({ status: 200, body: { outcome: 'accepted' } });
    const routes = [
      ['GET', '/api/sealed-resource/cloud-packages', 'sealedResource.listCloudPackages'],
      ['POST', '/api/sealed-resource/clear-authorizations', 'sealedResource.clearAuthorizations'],
      ['POST', '/api/sealed-resource/authorize-package', 'sealedResource.authorizePackage'],
    ];
    for (const [index, [method, endpoint, capability]] of routes.entries()) {
      const [url, init] = fetcher.mock.calls[index];
      expect(url).toBe(`http://127.0.0.1:3227${endpoint}`);
      expect(init.method).toBe(method);
      const token = init.headers.Authorization.slice('Bearer '.length);
      const decision = JSON.parse(Buffer.from(token.split('.')[2], 'base64url').toString());
      expect(decision).toMatchObject({ endpoint, capability, scope: 'sealed-resource:package', subject: 'sealed-resource-keyring' });
    }
    expect(fetcher.mock.calls[0][1].body).toBeUndefined();
    expect(fetcher.mock.calls[1][1].body).toBeUndefined();
    expect(fetcher.mock.calls[1][1].headers['Content-Length']).toBe('0');
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual(authorization);
  });

  it.each([
    { packages: [{ ...packageEntry, authorizationKey: 'secret' }] },
    { packages: [{ ...packageEntry, packageType: 'other' }] },
    { packages: [{ ...packageEntry, packageSha256: 'bad' }] },
    { packages: [{ ...packageEntry, packageVersionId: '' }] },
    { packages: [{ ...packageEntry, fileName: 'bad\0name' }] },
    { packages: null },
    { packages: [], secret: 'secret' },
  ])('fails closed without projecting malformed or secret-bearing directories', async (body) => {
    const fetcher = vi.fn().mockResolvedValue(nativeResponse(body));
    await expect(createSealedResourceAuthorizationTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher).listCloudPackages())
      .resolves.toEqual({ status: 503, body: { packages: [] } });
  });

  it.each([
    nativeResponse({ outcome: 'accepted', authorizationKey: 'secret' }),
    nativeResponse({ outcome: 'unknown' }),
    nativeResponse({ outcome: 'accepted' }, 401),
    nativeResponse({ outcome: 'accepted' }, 503),
  ])('does not report clear as accepted without an exact successful receipt', async (response) => {
    const fetcher = vi.fn().mockResolvedValue(response);
    await expect(createSealedResourceAuthorizationTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher).clearAuthorizations())
      .resolves.toEqual({ status: 503, body: { outcome: 'unknown' } });
  });

  it('handles unavailable runtime without returning secrets and preserves authorize response format', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('secret transport error'));
    const transport = createSealedResourceAuthorizationTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);
    await expect(transport.listCloudPackages()).resolves.toEqual({ status: 503, body: { packages: [] } });
    await expect(transport.clearAuthorizations()).resolves.toEqual({ status: 503, body: { outcome: 'unknown' } });
    await expect(transport.authorizePackage({ packageSha256: 'bad', authorizationKey: 'bad' }))
      .resolves.toEqual({ status: 400, body: { outcome: 'rejected' } });
    await expect(transport.authorizePackage({ packageSha256: packageEntry.packageSha256, authorizationKey: 'b'.repeat(43), leaseExpiresAt: '2099-01-01T00:00:00Z' }))
      .resolves.toEqual({ status: 503, body: { outcome: 'unknown' } });
    fetcher.mockResolvedValue(nativeResponse({ outcome: 'rejected' }, 400));
    await expect(transport.authorizePackage({ packageSha256: packageEntry.packageSha256, authorizationKey: 'b'.repeat(43), leaseExpiresAt: '2000-01-01T00:00:00Z' }))
      .resolves.toEqual({ status: 400, body: { outcome: 'rejected' } });
  });
});
