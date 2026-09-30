import { logger } from '../../utils/logger';
import { CloudAccountClientError } from './client';
import { unwrapCloudPackageDeviceEnvelope } from './device-key-store';
import type { CloudPackageAuthorization, CloudPackageDownloadRequest, CloudPackageLocalDownload } from './types';
import type { SealedResourceAuthorizationTransport, SealedResourceCloudPackage } from '../runtime-host-delivery/transport/sealed-resource';

export type PreparedPackageInstall = Readonly<{
  download: CloudPackageLocalDownload;
  cloudMetadata: SealedResourceCloudPackage;
  epoch: number;
  leaseExpiresAt: string;
}>;

type TrackedPackage = { metadata: SealedResourceCloudPackage; renewAt: number; retryDelay: number };

export const MAX_PENDING_INSTALLS = 16;
const MIN_RENEW_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 300_000;
const nextRetryDelay = (previous: number) => Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RENEW_DELAY_MS, previous * 2));
const isTransient = (error: unknown) => !(error instanceof CloudAccountClientError)
  || (error.status >= 500 && error.code !== 'INVALID_PACKAGE_AUTHORIZATION' && error.code !== 'PACKAGE_AUTHORIZATION_REJECTED');

export function createPackageAuthorizationLifecycle(
  transport: SealedResourceAuthorizationTransport,
  authorize: (request: CloudPackageDownloadRequest) => Promise<CloudPackageAuthorization>,
  download: (request: CloudPackageDownloadRequest) => Promise<CloudPackageLocalDownload>,
) {
  let epoch = 0;
  let userId: number | undefined;
  let sessionInitialized = false;
  let running = true;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let runtimeTail = Promise.resolve();
  let restoreTask: Promise<void> | undefined;
  let restoreRetryAt = Infinity;
  let restoreRetryDelay = 0;
  const packages = new Map<string, TrackedPackage>();
  const renewals = new Map<string, Promise<void>>();
  const installReservations = new Set<Readonly<{ epoch: number }>>();
  const pendingInstalls = new Map<string, PreparedPackageInstall>();

  const current = (expected: number) => !closed && running && userId !== undefined && epoch === expected;
  const assertCurrent = (expected: number) => {
    if (!current(expected)) throw new CloudAccountClientError(409, 409, 'Cloud package session changed');
  };
  // Serialize registration and clearing: a late registration must finish before logout clears it.
  const runtimeOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = runtimeTail.then(operation);
    runtimeTail = task.then(() => undefined, () => undefined);
    return task;
  };
  const invalidate = () => {
    epoch += 1;
    if (timer) clearTimeout(timer);
    timer = undefined;
    packages.clear();
    renewals.clear();
    installReservations.clear();
    pendingInstalls.clear();
    restoreTask = undefined;
    restoreRetryAt = Infinity;
    restoreRetryDelay = 0;
  };
  const unwrap = async (authorization: CloudPackageAuthorization) => {
    const key = await unwrapCloudPackageDeviceEnvelope(authorization.deviceEnvelope);
    if (!key) throw new CloudAccountClientError(403, 403, 'Package authorization is unavailable');
    return key;
  };
  const register = async (metadata: SealedResourceCloudPackage, authorization: CloudPackageAuthorization, expected: number, key?: string) => {
    assertAuthorization(metadata.packageVersionId, metadata.packageType, authorization);
    const authorizationKey = key ?? await unwrap(authorization);
    assertCurrent(expected);
    await runtimeOperation(async () => {
      assertCurrent(expected);
      assertAuthorization(metadata.packageVersionId, metadata.packageType, authorization);
      const response = await transport.authorizePackage({
        packageSha256: metadata.packageSha256,
        authorizationKey,
        leaseExpiresAt: authorization.leaseExpiresAt,
      });
      if (response.status !== 200 || response.body.outcome !== 'accepted') {
        throw new CloudAccountClientError(response.status, response.body.outcome === 'rejected' ? 'PACKAGE_AUTHORIZATION_REJECTED' : response.status, response.body.error || 'Package authorization failed', response.body.reason);
      }
      assertCurrent(expected);
    });
  };
  const track = (metadata: SealedResourceCloudPackage, leaseExpiresAt: string) => {
    const remaining = Date.parse(leaseExpiresAt) - Date.now();
    packages.set(metadata.packageSha256, {
      metadata,
      renewAt: Date.now() + Math.max(MIN_RENEW_DELAY_MS, remaining - Math.min(60_000, remaining / 5)),
      retryDelay: 0,
    });
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!current(epoch)) return;
    const next = Math.min(restoreRetryAt, ...[...packages.values()].map((entry) => entry.renewAt));
    if (!Number.isFinite(next)) return;
    timer = setTimeout(() => { void renewDue(); }, Math.min(2_147_483_647, Math.max(0, next - Date.now())));
    timer.unref?.();
  };
  const renew = (metadata: SealedResourceCloudPackage, expected: number): Promise<void> => {
    const existing = renewals.get(metadata.packageSha256);
    if (existing) return existing;
    const task = (async () => {
      const authorization = await authorize({ packageVersionId: metadata.packageVersionId, packageType: metadata.packageType });
      assertCurrent(expected);
      await register(metadata, authorization, expected);
      track(metadata, authorization.leaseExpiresAt);
    })().finally(() => {
      if (renewals.get(metadata.packageSha256) === task) renewals.delete(metadata.packageSha256);
    });
    renewals.set(metadata.packageSha256, task);
    return task;
  };
  const renewBatch = async (metadata: SealedResourceCloudPackage[], expected: number) => {
    // ponytail: four workers per restore/renew batch; no persistent whole-directory polling.
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, metadata.length) }, async () => {
      while (current(expected) && index < metadata.length) {
        const entry = metadata[index++];
        try {
          await renew(entry, expected);
        } catch (error) {
          if (!current(expected)) continue;
          // Retry metadata only; the runtime's existing lease still expires unchanged.
          if (isTransient(error)) {
            const retryDelay = nextRetryDelay(packages.get(entry.packageSha256)?.retryDelay ?? 0);
            packages.set(entry.packageSha256, { metadata: entry, renewAt: Date.now() + retryDelay, retryDelay });
          } else {
            packages.delete(entry.packageSha256);
          }
        }
      }
    }));
  };
  const renewDue = async () => {
    const expected = epoch;
    if (restoreRetryAt <= Date.now()) {
      await restore().catch(() => undefined);
      return;
    }
    const due = [...packages.values()].filter((entry) => entry.renewAt <= Date.now()).map((entry) => entry.metadata);
    await renewBatch(due, expected);
    if (current(expected)) schedule();
  };
  const clear = () => runtimeOperation(async () => {
    const response = await transport.clearAuthorizations();
    if (response.status !== 200 || response.body.outcome !== 'accepted') {
      throw new CloudAccountClientError(503, 503, 'Package authorization clearing is unavailable');
    }
  });
  const restore = (): Promise<void> => {
    if (restoreTask) return restoreTask;
    const expected = epoch;
    const startedAt = performance.now();
    let stage: 'clear' | 'list' | 'renew' | undefined;
    let stageStartedAt = startedAt;
    let outcome: 'success' | 'skipped' | 'failed' = 'skipped';
    let packageCount: number | undefined;
    logger.info('[startup-trace] source=cloud-package-authorization phase=restore stage=start');
    const task = (async () => {
      stage = 'clear';
      stageStartedAt = performance.now();
      logger.info('[startup-trace] source=cloud-package-authorization phase=restore stage=clear-start');
      await clear();
      logger.info(`[startup-trace] source=cloud-package-authorization phase=restore stage=clear-end duration_ms=${(performance.now() - stageStartedAt).toFixed(1)}`);
      stage = undefined;
      if (!current(expected)) return;
      stage = 'list';
      stageStartedAt = performance.now();
      logger.info('[startup-trace] source=cloud-package-authorization phase=restore stage=list-start');
      const response = await transport.listCloudPackages();
      if (response.status !== 200) throw new CloudAccountClientError(503, 503, 'Installed cloud packages are unavailable');
      packageCount = response.body.packages.length;
      logger.info(`[startup-trace] source=cloud-package-authorization phase=restore stage=list-end duration_ms=${(performance.now() - stageStartedAt).toFixed(1)} package_count=${packageCount}`);
      stage = undefined;
      if (!current(expected)) return;
      restoreRetryAt = Infinity;
      restoreRetryDelay = 0;
      stage = 'renew';
      stageStartedAt = performance.now();
      logger.info('[startup-trace] source=cloud-package-authorization phase=restore stage=renew-start');
      await renewBatch(response.body.packages, expected);
      logger.info(`[startup-trace] source=cloud-package-authorization phase=restore stage=renew-end duration_ms=${(performance.now() - stageStartedAt).toFixed(1)}`);
      stage = undefined;
      if (current(expected)) {
        schedule();
        outcome = 'success';
      }
    })().catch((error) => {
      outcome = 'failed';
      if (stage) logger.info(`[startup-trace] source=cloud-package-authorization phase=restore stage=${stage}-end duration_ms=${(performance.now() - stageStartedAt).toFixed(1)} outcome=failed`);
      if (current(expected) && isTransient(error)) {
        restoreRetryDelay = nextRetryDelay(restoreRetryDelay);
        restoreRetryAt = Date.now() + restoreRetryDelay;
        schedule();
      }
      throw error;
    }).finally(() => {
      if (restoreTask === task) restoreTask = undefined;
      logger.info(`[startup-trace] source=cloud-package-authorization phase=restore stage=end duration_ms=${(performance.now() - startedAt).toFixed(1)} outcome=${outcome}${packageCount === undefined ? '' : ` package_count=${packageCount}`}`);
    });
    restoreTask = task;
    return task;
  };

  const packageInstalled = (prepared: PreparedPackageInstall) => {
    if (!current(prepared.epoch)) return;
    track(prepared.cloudMetadata, prepared.leaseExpiresAt);
    schedule();
  };

  return {
    setSession(nextUserId: number | undefined): Promise<void> {
      if (closed || (sessionInitialized && nextUserId === userId)) return Promise.resolve();
      sessionInitialized = true;
      invalidate();
      userId = nextUserId;
      return running ? restore() : Promise.resolve();
    },
    invalidateSession(): Promise<void> {
      sessionInitialized = true;
      invalidate();
      userId = undefined;
      return running && !closed ? clear() : Promise.resolve();
    },
    runtimeExited() {
      invalidate();
      running = false;
    },
    runtimeRestarted(): Promise<void> {
      invalidate();
      running = true;
      return closed ? Promise.resolve() : restore();
    },
    async close() {
      invalidate();
      closed = true;
      if (running) await clear();
    },
    async preparePackageInstall(request: CloudPackageDownloadRequest): Promise<PreparedPackageInstall> {
      // Wait for the session-transition clear, not unrelated background renewals.
      await runtimeTail;
      const expected = epoch;
      assertCurrent(expected);
      const reservation = { epoch: expected };
      if (installReservations.size + pendingInstalls.size >= MAX_PENDING_INSTALLS) {
        throw new CloudAccountClientError(409, 'PACKAGE_INSTALL_QUEUE_FULL', 'Confirm pending package installs before installing another package');
      }
      installReservations.add(reservation);
      try {
        const authorization = await authorize(request);
        assertCurrent(expected);
        assertAuthorization(request.packageVersionId, request.packageType, authorization);
        const key = await unwrap(authorization);
        assertCurrent(expected);
        const downloaded = await download({ ...request, packageType: authorization.packageType });
        assertCurrent(expected);
        if (downloaded.packageVersionId !== request.packageVersionId || !/^[a-f0-9]{64}$/i.test(downloaded.packageSha256)
          || !downloaded.filename || !downloaded.packagePath.toLowerCase().endsWith(`.matcha-${authorization.packageType}pkg`)) {
          throw new CloudAccountClientError(502, 502, 'Package download metadata is invalid');
        }
        const metadata: SealedResourceCloudPackage = {
          packageVersionId: downloaded.packageVersionId,
          packageType: authorization.packageType as 'skill' | 'agent',
          packageSha256: downloaded.packageSha256,
          fileName: downloaded.filename,
        };
        await register(metadata, authorization, expected, key);
        const prepared = { download: downloaded, cloudMetadata: metadata, epoch: expected, leaseExpiresAt: authorization.leaseExpiresAt };
        installReservations.add(prepared);
        return prepared;
      } finally {
        installReservations.delete(reservation);
      }
    },
    packageInstalled,
    reservePackageInstall(prepared: PreparedPackageInstall) {
      assertCurrent(prepared.epoch);
      if (!installReservations.has(prepared)) throw new CloudAccountClientError(409, 409, 'Cloud package install reservation is unavailable');
    },
    bindPackageInstall(callId: string, prepared: PreparedPackageInstall) {
      // An admitted native install keeps its receipt even if the cloud session changed.
      if (!installReservations.delete(prepared) || !current(prepared.epoch)) return;
      pendingInstalls.set(callId, prepared);
    },
    releasePackageInstall(prepared: PreparedPackageInstall) {
      installReservations.delete(prepared);
    },
    acknowledgePackageInstall(callId: string, confirmed: boolean) {
      const prepared = pendingInstalls.get(callId);
      if (!prepared) return;
      pendingInstalls.delete(callId);
      if (confirmed) packageInstalled(prepared);
    },
  };
}

function assertAuthorization(packageVersionId: string, packageType: string | undefined, authorization: CloudPackageAuthorization) {
  if (authorization.packageVersionId !== packageVersionId || !['skill', 'agent'].includes(authorization.packageType)
    || (packageType !== undefined && authorization.packageType !== packageType)) {
    throw new CloudAccountClientError(502, 'INVALID_PACKAGE_AUTHORIZATION', 'Cloud package authorization metadata is invalid');
  }
  const expiresAt = Date.parse(authorization.leaseExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new CloudAccountClientError(403, 403, 'Cloud package authorization lease has expired');
  }
}
