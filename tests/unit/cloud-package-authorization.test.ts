import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPackageAuthorizationLifecycle } from '../../electron/main/cloud-account/package-authorization';
import { CloudAccountClientError } from '../../electron/main/cloud-account/client';

vi.mock('../../electron/main/cloud-account/device-key-store', () => ({
  unwrapCloudPackageDeviceEnvelope: vi.fn().mockResolvedValue('a'.repeat(43)),
}));
const metadata = { packageVersionId: 'v1', packageType: 'skill' as const, packageSha256: 'a'.repeat(64), fileName: 'calendar.matcha-skillpkg' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const transport = {
    clearAuthorizations: vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'accepted' } }),
    listCloudPackages: vi.fn().mockResolvedValue({ status: 200, body: { packages: [metadata] } }),
    authorizePackage: vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'accepted' } }),
  };
  const authorize = vi.fn().mockImplementation(async (request) => ({ packageVersionId: request.packageVersionId, packageType: request.packageType || 'skill', deviceEnvelope: {}, leaseExpiresAt: new Date(Date.now() + 300_000).toISOString() }));
  const download = vi.fn().mockResolvedValue({ packagePath: 'C:/sealed/calendar.matcha-skillpkg', packageVersionId: 'v1', filename: metadata.fileName, bytes: 10, packageSha256: metadata.packageSha256 });
  return { transport, authorize, download, owner: createPackageAuthorizationLifecycle(transport, authorize, download) };
}

describe('cloud package authorization lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-30T00:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('restores metadata only, renews before expiry, and stops retrying permanent denial', async () => {
    const { owner, transport, authorize, download } = fixture();
    await owner.setSession(1);
    expect(download).not.toHaveBeenCalled();
    expect(transport.listCloudPackages).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(authorize).toHaveBeenCalledTimes(2);
    authorize.mockRejectedValueOnce(new CloudAccountClientError(403, 403, 'denied'));
    await vi.advanceTimersByTimeAsync(240_000);
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(transport.authorizePackage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(transport.listCloudPackages).toHaveBeenCalledTimes(1);
    await owner.runtimeRestarted();
    expect(authorize).toHaveBeenCalledTimes(4);
    expect(download).not.toHaveBeenCalled();
    owner.runtimeExited();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(authorize).toHaveBeenCalledTimes(4);
    await owner.close();
  });

  it('recovers from temporary cloud and runtime outages using metadata-only backoff, without extending a failed lease', async () => {
    const { owner, transport, authorize, download } = fixture();
    await owner.setSession(1);
    const lease = transport.authorizePackage.mock.calls[0][0];
    authorize.mockRejectedValueOnce(new CloudAccountClientError(503, 503, 'temporary outage'))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    await vi.advanceTimersByTimeAsync(240_000);
    await owner.setSession(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(authorize).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(authorize).toHaveBeenCalledTimes(3);
    transport.authorizePackage.mockResolvedValueOnce({ status: 503, body: { outcome: 'unknown' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(authorize).toHaveBeenCalledTimes(4);
    expect(transport.authorizePackage.mock.calls[0][0]).toEqual(lease);
    transport.authorizePackage.mockResolvedValueOnce({ status: 503, body: { outcome: 'unknown' } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(authorize).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(39_999);
    expect(authorize).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(authorize).toHaveBeenCalledTimes(6);
    expect(transport.authorizePackage).toHaveBeenCalledTimes(4);
    expect(transport.authorizePackage.mock.calls[3][0]).toMatchObject({ leaseExpiresAt: new Date(Date.now() + 300_000).toISOString() });
    expect(download).not.toHaveBeenCalled();
    expect(transport.listCloudPackages).toHaveBeenCalledTimes(1);
    await owner.close();
  });

  it.each(['clearAuthorizations', 'listCloudPackages'] as const)('recovers initial runtime %s unavailability with a bounded restore retry', async (operation) => {
    const { owner, transport, authorize, download } = fixture();
    transport[operation].mockRejectedValueOnce(new Error('runtime unavailable'));
    await expect(owner.setSession(1)).rejects.toThrow('runtime unavailable');
    await owner.setSession(1);
    expect(authorize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
    await owner.close();
  });

  it('caps prolonged outage backoff and cancels retries on logout', async () => {
    const { owner, authorize, transport } = fixture();
    authorize.mockRejectedValue(new CloudAccountClientError(503, 503, 'offline'));
    await owner.setSession(1);
    for (const delay of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]) {
      const before = authorize.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(authorize).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(authorize).toHaveBeenCalledTimes(before + 1);
    }
    expect(transport.authorizePackage).not.toHaveBeenCalled();
    expect(transport.listCloudPackages).toHaveBeenCalledTimes(1);
    await owner.invalidateSession();
    const calls = authorize.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(authorize).toHaveBeenCalledTimes(calls);
    await owner.close();
  });

  it('does not hot-loop very short leases', async () => {
    const { owner, authorize } = fixture();
    authorize.mockImplementation(async () => ({ packageVersionId: 'v1', packageType: 'skill', deviceEnvelope: {}, leaseExpiresAt: new Date(Date.now() + 100).toISOString() }));
    await owner.setSession(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(authorize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(authorize).toHaveBeenCalledTimes(2);
    await owner.close();
  });

  it.each(['notFound', 'invalidMetadata', 'runtimeRejected'])('does not retry explicit rejection: %s', async (failure) => {
    const { owner, authorize, transport } = fixture();
    if (failure === 'notFound') authorize.mockRejectedValue(new CloudAccountClientError(404, 404, 'not found'));
    if (failure === 'invalidMetadata') authorize.mockResolvedValue({ packageVersionId: 'another-version', packageType: 'skill', leaseExpiresAt: new Date(Date.now() + 300_000).toISOString() });
    if (failure === 'runtimeRejected') transport.authorizePackage.mockResolvedValue({ status: 400, body: { outcome: 'rejected', reason: 'invalidAuthorizationKey' } });
    await owner.setSession(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(authorize).toHaveBeenCalledTimes(1);
    await owner.close();
  });

  it('does not register an old authorization after logout or session replacement', async () => {
    const { owner, transport, authorize } = fixture();
    const pending = deferred<never>();
    authorize.mockReturnValueOnce(pending.promise);
    const restoring = owner.setSession(1);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
    await owner.invalidateSession();
    transport.listCloudPackages.mockResolvedValueOnce({ status: 200, body: { packages: [] } });
    await owner.setSession(2);
    pending.resolve({ packageVersionId: 'v1', packageType: 'skill', leaseExpiresAt: new Date(Date.now() + 300_000).toISOString() } as never);
    await restoring;
    expect(transport.authorizePackage).not.toHaveBeenCalled();
    await owner.close();
  });

  it('drains in-flight runtime registration before clear, and does not clobber the next session', async () => {
    const { owner, transport } = fixture();
    const pending = deferred<never>();
    const order: string[] = [];
    transport.authorizePackage.mockImplementationOnce(() => { order.push('register'); return pending.promise; });
    transport.clearAuthorizations.mockImplementation(async () => { order.push('clear'); return { status: 200, body: { outcome: 'accepted' } }; });
    const restoring = owner.setSession(1);
    await vi.waitFor(() => expect(transport.authorizePackage).toHaveBeenCalledTimes(1));
    const logout = owner.invalidateSession();
    expect(order).toEqual(['clear', 'register']);
    pending.resolve({ status: 200, body: { outcome: 'accepted' } } as never);
    await logout;
    await restoring;
    expect(order).toEqual(['clear', 'register', 'clear']);
    await owner.close();
  });

  it('guards download completion against logout, rejects malformed/expired leases before download', async () => {
    const { owner, transport, authorize, download } = fixture();
    transport.listCloudPackages.mockResolvedValue({ status: 200, body: { packages: [] } });
    await owner.setSession(1);
    const pending = deferred<never>();
    download.mockReturnValueOnce(pending.promise);
    const install = owner.preparePackageInstall({ packageVersionId: 'v1' });
    const rejection = expect(install).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    await owner.invalidateSession();
    pending.resolve({ packagePath: 'calendar.matcha-skillpkg', packageVersionId: 'v1', packageSha256: metadata.packageSha256, filename: metadata.fileName } as never);
    await rejection;
    expect(transport.authorizePackage).not.toHaveBeenCalled();
    await owner.setSession(1);
    authorize.mockResolvedValueOnce({ packageVersionId: 'v1', packageType: 'skill', leaseExpiresAt: 'invalid' });
    await expect(owner.preparePackageInstall({ packageVersionId: 'v1' })).rejects.toMatchObject({ status: 403 });
    expect(download).toHaveBeenCalledTimes(1);
    await owner.close();
  });

  it('tracks only successful installation and keeps keys out of prepared/persisted metadata', async () => {
    const { owner, transport, authorize } = fixture();
    transport.listCloudPackages.mockResolvedValue({ status: 200, body: { packages: [] } });
    await owner.setSession(1);
    const prepared = await owner.preparePackageInstall({ packageVersionId: 'v1' });
    expect(JSON.stringify(prepared)).not.toMatch(/authorizationKey|deviceEnvelope|contentKey/);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(authorize).toHaveBeenCalledTimes(1);
    owner.packageInstalled(prepared);
    await vi.advanceTimersByTimeAsync(48_000);
    expect(authorize).toHaveBeenCalledTimes(2);
    await owner.close();
  });

  it('bounds restore concurrency and singleflights overlapping restore', async () => {
    const { owner, transport, authorize } = fixture();
    transport.listCloudPackages.mockResolvedValue({ status: 200, body: { packages: Array.from({ length: 9 }, (_, i) => ({ ...metadata, packageVersionId: `v${i}`, packageSha256: i.toString(16).repeat(64) })) } });
    const pending = deferred<void>();
    let active = 0; let maxActive = 0;
    authorize.mockImplementation(async (request) => {
      active++; maxActive = Math.max(maxActive, active);
      await pending.promise;
      active--;
      return { packageVersionId: request.packageVersionId, packageType: 'skill', leaseExpiresAt: new Date(Date.now() + 300_000).toISOString() };
    });
    const first = owner.setSession(1);
    await owner.setSession(1);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(4));
    expect(maxActive).toBe(4);
    pending.resolve();
    await first;
    expect(authorize).toHaveBeenCalledTimes(9);
    expect(transport.listCloudPackages).toHaveBeenCalledTimes(1);
    await owner.close();
  });
});
