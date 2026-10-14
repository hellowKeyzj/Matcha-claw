import { randomUUID } from 'node:crypto';
import { executePackageOperation, PackageOperationError, type PackageOperationTransports } from './package-operations';
import type { CloudPackageOperationKind, CloudPackageOperationRequests, CloudPackageOperationReceipt, CloudPackageOperationResult, CloudPackageOperationError } from '../../../src/types/cloud-package-operation';
import { clearCloudAccountSession, readCloudAccountSession, writeCloudAccountSession, type CloudAccountSession } from './session-store';
import { CloudAccountClientError, createCloudAccountClient, removePackageDownload, type CloudAccountClient, type CloudPackageUpload } from './client';
import type { CloudProviderSync } from './provider-sync';
import { getCloudPackageDevicePublicKey } from './device-key-store';
import { createPackageAuthorizationLifecycle, MAX_PENDING_INSTALLS, type PreparedPackageInstall } from './package-authorization';
import type { SealedResourceAuthorizationTransport } from '../runtime-host-delivery/transport/sealed-resource';
import type {
  AccountSessionProjection, AuthLogin2FARequest, AuthLoginRequest, AuthLoginResult, AuthRegisterRequest,
  AuthSendVerifyCodeRequest, AuthSendVerifyCodeResult, AuthTokenResult, BillingCheckoutInfo, BillingPlan,
  CloudPackageAuthorization, CloudPackageAuthorizationRequest,
  CloudPackageDownloadRequest, CloudPackageListPage, CloudPackageListQuery,
  CloudPackageLocalDownload, CloudPackageVersion, CloudSealedCloudKey, CreatePaymentOrderRequest,
  CreatePaymentOrderResult, PaymentOrder, PlatformQuota, PublicCloudSettings, SubscriptionProgress,
  SubscriptionSummary, UserSubscription,
} from './types';

export type CloudAccountService = Readonly<{
  prewarm(): void;
  getPublicSettings(): Promise<PublicCloudSettings>;
  getSession(): Promise<AccountSessionProjection>;
  login(request: AuthLoginRequest): Promise<AccountSessionProjection | Extract<AuthLoginResult, { state: 'requires2FA' }>>;
  login2FA(request: AuthLogin2FARequest): Promise<AccountSessionProjection>;
  register(request: AuthRegisterRequest): Promise<AccountSessionProjection>;
  sendVerifyCode(request: AuthSendVerifyCodeRequest): Promise<AuthSendVerifyCodeResult>;
  refreshSession(): Promise<AccountSessionProjection>;
  logout(): Promise<void>;
  getCheckoutInfo(): Promise<BillingCheckoutInfo>;
  getPlans(): Promise<BillingPlan[]>;
  createPaymentOrder(request: CreatePaymentOrderRequest): Promise<CreatePaymentOrderResult>;
  verifyPaymentOrder(outTradeNo: string): Promise<PaymentOrder>;
  getPaymentOrder(orderId: number): Promise<PaymentOrder>;
  getSubscriptionSummary(): Promise<SubscriptionSummary>;
  getActiveSubscriptions(): Promise<UserSubscription[]>;
  getSubscriptionProgress(): Promise<SubscriptionProgress[]>;
  getPlatformQuotas(): Promise<PlatformQuota[]>;
  listOwnedPackages(query: CloudPackageListQuery): Promise<CloudPackageListPage>;
  listMarketPackages(query: CloudPackageListQuery): Promise<CloudPackageListPage>;
  fetchSealedCloudKey(): Promise<CloudSealedCloudKey>;
  uploadPackage(upload: CloudPackageUpload): Promise<CloudPackageVersion>;
  publishPackage(packageVersionId: string): Promise<CloudPackageVersion>;
  authorizePackage(request: Omit<CloudPackageAuthorizationRequest, 'devicePublicKey'>): Promise<CloudPackageAuthorization>;
  downloadPackage(request: CloudPackageDownloadRequest): Promise<CloudPackageLocalDownload>;
  preparePackageInstall(request: CloudPackageDownloadRequest): Promise<PreparedPackageInstall>;
  packageInstalled(prepared: PreparedPackageInstall): void;
  reservePackageInstall(prepared: PreparedPackageInstall): void;
  bindPackageInstall(callId: string, prepared: PreparedPackageInstall): void;
  releasePackageInstall(prepared: PreparedPackageInstall): void;
  acknowledgePackageInstall(callId: string, confirmed: boolean): void;
  runtimeExited(): void;
  runtimeRestarted(): Promise<void>;
  admitPackageOperation<K extends CloudPackageOperationKind>(kind: K, request: CloudPackageOperationRequests[K]): CloudPackageOperationReceipt;
  readPackageOperation(operationId: string): CloudPackageOperationResult | undefined;
  reserveSkillExport(): Readonly<{ epoch: number }>;
  bindSkillExport(reservation: Readonly<{ epoch: number }>, callId: string): void;
  releaseSkillExport(reservation: Readonly<{ epoch: number }>): void;
  close(): Promise<void>;
}>;

export function createCloudAccountService(
  client: CloudAccountClient = createCloudAccountClient(),
  providerSync: CloudProviderSync | undefined,
  packageTransport: SealedResourceAuthorizationTransport,
  operationTransports?: PackageOperationTransports,
): CloudAccountService {
  let publicSettingsTask: Promise<PublicCloudSettings> | undefined;
  let sessionTask: Promise<AccountSessionProjection> | undefined;
  let refreshTask: Promise<CloudAccountSession | null> | undefined;
  let epoch = 0;
  let closed = false;
  let sessionTail = Promise.resolve();
  let sessionChangeTask: Promise<void> | undefined;
  let closing = false;
  const operationShutdown = new AbortController();
  let packageObservation = new AbortController();
  const packageOperations = new Map<string, { epoch: number; result: CloudPackageOperationResult; expiresAt?: number }>();
  const skillExports = new Map<string, { epoch: number; expiresAt?: number; operationId?: string; terminal?: boolean; observing?: boolean; readRequested?: boolean; revision?: number }>();
  let unsubscribeSkillExports: (() => void) | undefined;
  let skillExportObservationDisconnected = false;
  const skillExportReservations = new Set<Readonly<{ epoch: number }>>();
  const packageTasks = new Set<Promise<void>>();
  let packageTail = Promise.resolve();
  const prunePackageOperations = () => {
    const now = Date.now();
    for (const [id, entry] of packageOperations) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) packageOperations.delete(id);
    }
  };

  const pruneSkillExports = () => {
    const now = Date.now();
    for (const [callId, exported] of skillExports) {
      if (exported.expiresAt === undefined || exported.expiresAt > now || exported.observing) continue;
      // A disconnected observation lease is not the native artifact's completion TTL.
      if (operationTransports && !exported.terminal && !exported.operationId) observeSkillExport(callId, true);
      else skillExports.delete(callId);
    }
  };
  const clearSkillExports = () => {
    unsubscribeSkillExports?.();
    unsubscribeSkillExports = undefined;
    skillExportObservationDisconnected = false;
    skillExports.clear();
    skillExportReservations.clear();
  };
  const observeSkillExport = (callId: string, recoverExpiredLease = false) => {
    const exported = skillExports.get(callId);
    if (!operationTransports || closing || !exported || exported.epoch !== epoch || exported.terminal || exported.operationId) return;
    if (skillExportObservationDisconnected && !recoverExpiredLease) {
      if (exported.expiresAt === undefined) exported.expiresAt = Date.now() + 10 * 60_000;
      return;
    }
    if (exported.observing) { exported.readRequested = true; return; }
    exported.observing = true;
    exported.readRequested = false;
    const task = (async () => {
      try {
        const response = await operationTransports.callLogTransport.get({ callId });
        if (closing || skillExports.get(callId) !== exported || exported.epoch !== epoch || exported.operationId || (skillExportObservationDisconnected && !recoverExpiredLease)) return;
        if (response.status !== 200 || !('module' in response.body) || response.body.callId !== callId
          || response.body.module !== 'skills' || response.body.command !== 'sealedSkills.exportCloud') {
          throw new Error('Cloud skill export observation is unavailable');
        }
        const call = response.body;
        if (exported.revision !== undefined && call.revision < exported.revision) return;
        exported.revision = call.revision;
        exported.terminal = ['succeeded', 'failed', 'rejected', 'unknown'].includes(call.status);
        exported.expiresAt = exported.terminal || skillExportObservationDisconnected ? Date.now() + 10 * 60_000 : undefined;
      } catch {
        // An observation lease releases abandoned bindings without settling or replaying native work.
        if (skillExports.get(callId) === exported && exported.epoch === epoch && !exported.operationId && exported.expiresAt === undefined) {
          exported.expiresAt = Date.now() + 10 * 60_000;
        }
      } finally {
        exported.observing = false;
        if (skillExports.get(callId) === exported && !exported.operationId && exported.expiresAt !== undefined && exported.expiresAt <= Date.now()) {
          if (exported.readRequested && !recoverExpiredLease) observeSkillExport(callId, true);
          else skillExports.delete(callId);
        } else if (exported.readRequested) observeSkillExport(callId);
      }
    })().finally(() => { packageTasks.delete(task); });
    packageTasks.add(task);
  };
  const subscribeSkillExports = () => {
    if (unsubscribeSkillExports || !operationTransports) return;
    try {
      unsubscribeSkillExports = operationTransports.subscribeCalls((event) => {
        if (event === 'disconnected') {
          skillExportObservationDisconnected = true;
          for (const exported of skillExports.values()) {
            if (!exported.terminal && !exported.operationId && exported.expiresAt === undefined) exported.expiresAt = Date.now() + 10 * 60_000;
          }
        } else if (event === 'resync') {
          skillExportObservationDisconnected = false;
          for (const callId of skillExports.keys()) observeSkillExport(callId);
          pruneSkillExports();
        } else if (skillExports.has(event.callId)) {
          skillExportObservationDisconnected = false;
          observeSkillExport(event.callId);
          pruneSkillExports();
        }
      });
    } catch {
      skillExportObservationDisconnected = true;
      for (const exported of skillExports.values()) {
        if (!exported.terminal && !exported.operationId && exported.expiresAt === undefined) exported.expiresAt = Date.now() + 10 * 60_000;
      }
    }
  };

  const notifyPackageChanged = (operationId: string) => {
    try { operationTransports?.packageChanged(operationId); } catch { /* Hints must not interrupt owner completion. */ }
  };
  const invalidatePackageObservation = () => {
    for (const [operationId, entry] of packageOperations) {
      if (entry.epoch !== epoch && entry.result.state === 'pending') notifyPackageChanged(operationId);
    }
    packageObservation.abort(new CloudAccountClientError(409, 409, 'Cloud account session changed'));
    packageObservation = new AbortController();
  };

  const assertCurrent = (expected: number) => {
    if (closed || epoch !== expected) throw new CloudAccountClientError(409, 409, 'Cloud account session changed');
  };
  const sessionOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = sessionTail.then(operation);
    sessionTail = task.then(() => undefined, () => undefined);
    return task;
  };
  const notifySession = (session: CloudAccountSession | null) => {
    void providerSync?.reconcile(session);
    void packages.setSession(session?.user.id).catch(() => undefined);
  };
  const clearSession = async (expected: number) => {
    assertCurrent(expected);
    const { clearing, previousSession } = beginSessionChange();
    await previousSession;
    await clearing;
  };
  const refreshStoredSession = (session: CloudAccountSession, expected: number): Promise<CloudAccountSession | null> => {
    if (refreshTask) return refreshTask;
    const task = (async () => {
      if (!session.refreshToken) { await clearSession(expected); return null; }
      try {
        const refreshed = await client.refresh(session.refreshToken);
        assertCurrent(expected);
        const nextSession = { ...session, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken, expiresAt: refreshed.expiresAt, tokenType: refreshed.tokenType };
        await sessionOperation(async () => { assertCurrent(expected); await writeCloudAccountSession(nextSession); });
        assertCurrent(expected);
        notifySession(nextSession);
        return nextSession;
      } catch (error) {
        if (isUnauthorized(error) && expected === epoch) { await clearSession(expected); return null; }
        throw error;
      }
    })().finally(() => { if (refreshTask === task) refreshTask = undefined; });
    refreshTask = task;
    return task;
  };
  const validSession = async (expected: number) => {
    await sessionChangeTask;
    await sessionTail;
    assertCurrent(expected);
    const session = await readCloudAccountSession();
    assertCurrent(expected);
    if (!session) return null;
    return session.expiresAt !== null && session.expiresAt <= Date.now() + 120_000
      ? refreshStoredSession(session, expected) : session;
  };
  const withSession = async <T>(run: (session: CloudAccountSession) => Promise<T>): Promise<T> => {
    const expected = epoch;
    const session = await validSession(expected);
    if (!session) {
      notifySession(null);
      throw new CloudAccountClientError(401, 401, 'Cloud account session is not authenticated');
    }
    void packages.setSession(session.user.id).catch(() => undefined);
    try {
      const result = await run(session);
      assertCurrent(expected);
      return result;
    } catch (error) {
      if (isUnauthorized(error) && expected === epoch) await clearSession(expected);
      throw error;
    }
  };
  const authorizePackage = (request: Omit<CloudPackageAuthorizationRequest, 'devicePublicKey'>) => withSession(async (session) => client.authorizePackage(session.accessToken, {
    ...request, devicePublicKey: await getCloudPackageDevicePublicKey(),
  }));
  const downloadPackage = async (request: CloudPackageDownloadRequest) => {
    let downloaded: CloudPackageLocalDownload | undefined;
    try {
      return await withSession(async (session) => {
        downloaded = await client.downloadPackage(session.accessToken, request);
        return downloaded;
      });
    } catch (error) {
      if (downloaded) await removePackageDownload(request, downloaded);
      throw error;
    }
  };
  const packages = createPackageAuthorizationLifecycle(packageTransport, authorizePackage, downloadPackage);
  const getPublicSettings = () => {
    if (!publicSettingsTask) {
      const task = client.fetchPublicSettings().catch((error) => {
        if (publicSettingsTask === task) publicSettingsTask = undefined;
        throw error;
      });
      publicSettingsTask = task;
    }
    return publicSettingsTask;
  };
  const getSession = () => {
    if (!sessionTask) {
      const expected = epoch;
      const task = (async (): Promise<AccountSessionProjection> => {
        const session = await validSession(expected);
        notifySession(session);
        if (!session) return { state: 'anonymous' };
        void (async () => {
          try {
            const user = await client.fetchProfile(session.accessToken);
            await sessionOperation(async () => {
              assertCurrent(expected);
              const current = await readCloudAccountSession();
              if (current?.accessToken !== session.accessToken) return;
              assertCurrent(expected);
              const next = { ...session, user };
              await writeCloudAccountSession(next);
              assertCurrent(expected);
              notifySession(next);
              if (sessionTask === task) sessionTask = Promise.resolve(toSessionProjection(next));
            });
          } catch (error) {
            if (isUnauthorized(error) && expected === epoch) await clearSession(expected).catch(() => undefined);
          }
        })();
        return toSessionProjection(session);
      })().catch((error) => {
        if (sessionTask === task) sessionTask = undefined;
        throw error;
      });
      sessionTask = task;
    }
    return sessionTask;
  };
  const beginSessionChange = () => {
    const expected = ++epoch;
    invalidatePackageObservation();
    clearSkillExports();
    refreshTask = undefined;
    const clearing = packages.invalidateSession();
    void clearing.catch(() => undefined);
    const previousSession = sessionOperation(async () => {
      assertCurrent(expected);
      const previous = await readCloudAccountSession();
      assertCurrent(expected);
      await clearCloudAccountSession();
      assertCurrent(expected);
      notifySession(null);
      return previous;
    });
    sessionChangeTask = previousSession.then(() => undefined);
    sessionTask = sessionChangeTask.then(() => ({ state: 'anonymous' } as const));
    void sessionTask.catch(() => undefined);
    return { expected, clearing, previousSession };
  };
  const storeSession = async (result: AuthTokenResult, expected: number, clearing: Promise<void>) => {
    await sessionChangeTask;
    await clearing;
    const session: CloudAccountSession = { accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: result.expiresAt, tokenType: result.tokenType, user: result.user };
    await sessionOperation(async () => { assertCurrent(expected); await writeCloudAccountSession(session); });
    assertCurrent(expected);
    notifySession(session);
    const projection = toSessionProjection(session);
    sessionTask = Promise.resolve(projection);
    return projection;
  };

  const admitPackageOperation = <K extends CloudPackageOperationKind>(kind: K, request: CloudPackageOperationRequests[K]): CloudPackageOperationReceipt => {
    if (closing || closed || !operationTransports) throw new PackageOperationError('unavailable', 503, 'Cloud package operations are unavailable');
    prunePackageOperations();
    const expected = epoch;
    const observationSignal = AbortSignal.any([operationShutdown.signal, packageObservation.signal]);
    if (kind === 'confirmSealedSkillUpload') {
      pruneSkillExports();
      const callId = (request as CloudPackageOperationRequests['confirmSealedSkillUpload']).callId;
      const exported = skillExports.get(callId);
      if (!exported || exported.epoch !== expected) throw new PackageOperationError('exportUnconfirmed', 409, 'Cloud skill export is not confirmed for this account session');
      if (exported.operationId) return { operationId: exported.operationId, accepted: true };
    }
    if (packageOperations.size >= MAX_PENDING_INSTALLS) throw new PackageOperationError('queueFull', 409, 'Cloud package operation capacity is full; wait for pending operations or completed results to expire');
    const operationId = `cloud-package:${randomUUID()}`;
    if (kind === 'confirmSealedSkillUpload') {
      const exported = skillExports.get((request as CloudPackageOperationRequests['confirmSealedSkillUpload']).callId)!;
      exported.operationId = operationId;
      exported.expiresAt = undefined;
    }
    const entry = { epoch: expected, result: { operationId, kind, state: 'pending' } as CloudPackageOperationResult, expiresAt: undefined as number | undefined };
    packageOperations.set(operationId, entry);
    // Package uploads share cloud account effects; one in-flight workflow, at most 16 retained operations.
    const task = packageTail.then(async () => {
      try {
        assertCurrent(expected);
        operationShutdown.signal.throwIfAborted();
        const session = await validSession(expected);
        if (!session) throw new CloudAccountClientError(401, 401, 'Cloud account session is not authenticated');
        void packages.setSession(session.user.id).catch(() => undefined);
        const result = await executePackageOperation(kind, request, {
          assertCurrent: () => { assertCurrent(expected); operationShutdown.signal.throwIfAborted(); },
          signal: observationSignal,
          download: async (input) => {
            assertCurrent(expected);
            const value = await client.downloadPackage(session.accessToken, input);
            try { assertCurrent(expected); operationShutdown.signal.throwIfAborted(); return value; }
            catch (error) { await removePackageDownload(input, value); throw error; }
          },
          fetchKey: async () => { assertCurrent(expected); const value = await client.fetchSealedCloudKey(session.accessToken); assertCurrent(expected); return value; },
          upload: async (upload) => { assertCurrent(expected); const value = await client.uploadPackage(session.accessToken, upload); assertCurrent(expected); return value; },
          prepare: async (input) => { assertCurrent(expected); await getSession(); assertCurrent(expected); return packages.preparePackageInstall(input); },
          bind: (callId, prepared) => packages.bindPackageInstall(callId, prepared),
          release: (prepared) => packages.releasePackageInstall(prepared),
        }, operationTransports);
        entry.result = { operationId, kind, state: 'succeeded', result } as CloudPackageOperationResult;
      } catch (error) {
        if (isUnauthorized(error) && expected === epoch) await clearSession(expected).catch(() => undefined);
        entry.result = { operationId, kind, state: 'failed', error: packageOperationError(error) };
      } finally {
        entry.expiresAt = Date.now() + 10 * 60_000;
        if (kind === 'confirmSealedSkillUpload') {
          const exported = skillExports.get((request as CloudPackageOperationRequests['confirmSealedSkillUpload']).callId);
          if (exported?.epoch === expected && exported.expiresAt === undefined) exported.expiresAt = entry.expiresAt;
        }
        notifyPackageChanged(operationId);
      }
    }).finally(() => { packageTasks.delete(task); });
    packageTail = task;
    packageTasks.add(task);
    return { operationId, accepted: true };
  };

  return {
    prewarm: () => { void getPublicSettings().catch(() => undefined); void getSession().catch(() => undefined); },
    getPublicSettings,
    getSession,
    login: async (request) => {
      const { expected, clearing, previousSession } = beginSessionChange();
      await previousSession;
      assertCurrent(expected);
      const result = await client.login(request);
      assertCurrent(expected);
      if ('state' in result) return result;
      return storeSession(result, expected, clearing);
    },
    login2FA: async (request) => {
      const { expected, clearing, previousSession } = beginSessionChange();
      await previousSession;
      assertCurrent(expected);
      return storeSession(await client.login2FA(request), expected, clearing);
    },
    register: async (request) => {
      const { expected, clearing, previousSession } = beginSessionChange();
      await previousSession;
      assertCurrent(expected);
      return storeSession(await client.register(request), expected, clearing);
    },
    sendVerifyCode: (request) => client.sendVerifyCode(request),
    refreshSession: async () => {
      const expected = epoch;
      await sessionChangeTask;
      await sessionTail;
      assertCurrent(expected);
      const session = await readCloudAccountSession();
      assertCurrent(expected);
      const refreshed = session ? await refreshStoredSession(session, expected) : null;
      if (!refreshed && epoch !== expected) return getSession();
      assertCurrent(expected);
      notifySession(refreshed);
      const projection: AccountSessionProjection = refreshed ? toSessionProjection(refreshed) : { state: 'anonymous' };
      sessionTask = Promise.resolve(projection);
      return projection;
    },
    logout: async () => {
      const { clearing, previousSession } = beginSessionChange();
      const session = await previousSession;
      await clearing;
      if (session?.refreshToken) await client.logout(session.refreshToken);
    },
    getCheckoutInfo: () => withSession((session) => client.fetchCheckoutInfo(session.accessToken)),
    getPlans: () => withSession((session) => client.fetchPlans(session.accessToken)),
    createPaymentOrder: (request) => withSession((session) => client.createPaymentOrder(session.accessToken, request)),
    verifyPaymentOrder: (outTradeNo) => withSession((session) => client.verifyPaymentOrder(session.accessToken, outTradeNo)),
    getPaymentOrder: (orderId) => withSession((session) => client.fetchPaymentOrder(session.accessToken, orderId)),
    getSubscriptionSummary: () => withSession((session) => client.fetchSubscriptionSummary(session.accessToken)),
    getActiveSubscriptions: () => withSession((session) => client.fetchActiveSubscriptions(session.accessToken)),
    getSubscriptionProgress: () => withSession((session) => client.fetchSubscriptionProgress(session.accessToken)),
    getPlatformQuotas: () => withSession((session) => client.fetchPlatformQuotas(session.accessToken)),
    listOwnedPackages: (query) => withSession((session) => client.listOwnedPackages(session.accessToken, query)),
    listMarketPackages: (query) => withSession((session) => client.listMarketPackages(session.accessToken, query)),
    fetchSealedCloudKey: () => withSession((session) => client.fetchSealedCloudKey(session.accessToken)),
    uploadPackage: (upload) => withSession((session) => client.uploadPackage(session.accessToken, upload)),
    publishPackage: (packageVersionId) => withSession((session) => client.publishPackage(session.accessToken, packageVersionId)),
    authorizePackage,
    downloadPackage,
    preparePackageInstall: async (request) => {
      await getSession();
      return packages.preparePackageInstall(request);
    },
    packageInstalled: (prepared) => packages.packageInstalled(prepared),
    reservePackageInstall: (prepared) => packages.reservePackageInstall(prepared),
    bindPackageInstall: (callId, prepared) => packages.bindPackageInstall(callId, prepared),
    releasePackageInstall: (prepared) => packages.releasePackageInstall(prepared),
    acknowledgePackageInstall: (callId, confirmed) => packages.acknowledgePackageInstall(callId, confirmed),
    runtimeExited: () => packages.runtimeExited(),
    runtimeRestarted: async () => {
      const restoring = packages.runtimeRestarted();
      await getSession();
      await restoring;
    },
    admitPackageOperation,
    reserveSkillExport: () => {
      if (closing || closed) throw new PackageOperationError('unavailable', 503, 'Cloud package operations are unavailable');
      pruneSkillExports();
      if (skillExports.size + skillExportReservations.size >= MAX_PENDING_INSTALLS) throw new PackageOperationError('queueFull', 409, 'Cloud skill export capacity is full; finish pending uploads before exporting another skill');
      const reservation = { epoch };
      skillExportReservations.add(reservation);
      return reservation;
    },
    bindSkillExport: (reservation, callId) => {
      assertCurrent(reservation.epoch);
      if (!skillExportReservations.delete(reservation)) throw new PackageOperationError('sessionChanged', 409, 'Cloud account session changed; sign in and check package status');
      skillExports.set(callId, { epoch: reservation.epoch });
      subscribeSkillExports();
      observeSkillExport(callId);
    },
    releaseSkillExport: (reservation) => { skillExportReservations.delete(reservation); },
    readPackageOperation: (operationId) => {
      prunePackageOperations();
      const entry = packageOperations.get(operationId);
      return !closed && entry?.epoch === epoch ? entry.result : undefined;
    },
    close: async () => {
      closing = true;
      unsubscribeSkillExports?.();
      unsubscribeSkillExports = undefined;
      operationShutdown.abort();
      await Promise.all(packageTasks);
      closed = true;
      epoch += 1;
      invalidatePackageObservation();
      packageOperations.clear();
      skillExports.clear();
      skillExportReservations.clear();
      await packages.close();
    },
  };
}

function toSessionProjection(session: CloudAccountSession): AccountSessionProjection {
  return { state: 'authenticated', user: session.user, expiresAt: session.expiresAt, tokenType: session.tokenType };
}

function packageOperationError(error: unknown): CloudPackageOperationError {
  if (error instanceof PackageOperationError) return { code: error.code, message: error.message, status: error.status };
  if (error instanceof CloudAccountClientError) {
    if (error.status === 401) return { code: 'unauthenticated', message: 'Sign in to use cloud packages', status: 401 };
    if (error.code === 'PACKAGE_INSTALL_QUEUE_FULL') return { code: 'queueFull', message: 'Confirm pending package installs before installing another package', status: 409 };
    if (error.status === 409 && error.code === 409) return { code: 'sessionChanged', message: 'Cloud account session changed; sign in and check package status', status: 409 };
    return { code: error.status >= 400 && error.status < 500 ? 'cloudRejected' : 'outcomeUnknown',
      message: error.status >= 400 && error.status < 500 ? 'Cloud package request was rejected; check access and package availability' : 'Cloud package outcome is unknown; check its status before retrying',
      status: error.status >= 400 && error.status <= 599 ? error.status : 502 };
  }
  return { code: 'outcomeUnknown', message: 'Cloud package outcome is unknown; check its status before retrying', status: 502 };
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof CloudAccountClientError && error.status === 401;
}
