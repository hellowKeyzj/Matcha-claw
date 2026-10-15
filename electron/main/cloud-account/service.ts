import { randomUUID } from 'node:crypto';
import { isTraceEnabled, startupTrace } from '../../utils/trace-logger';
import { executePackageOperation, PackageOperationError, type PackageOperationTransports } from './package-operations';
import type { CloudPackageOperationKind, CloudPackageOperationRequests, CloudPackageOperationReceipt, CloudPackageOperationResult, CloudPackageOperationError } from '../../../src/types/cloud-package-operation';
import { clearCloudAccountSession, readCloudAccountSession, writeCloudAccountSession, type CloudAccountSession } from './session-store';
import { CloudAccountClientError, removePackageDownload, type CloudAccountClient, type CloudPackageUpload } from './client';
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

export type CloudAccountRuntime = Readonly<{
  providerSync: CloudProviderSync;
  packageTransport: SealedResourceAuthorizationTransport;
  operationTransports: PackageOperationTransports;
}>;

export function createCloudAccountService(
  client: CloudAccountClient,
  runtime: Promise<CloudAccountRuntime>,
): CloudAccountService {
  let publicSettingsTask: Promise<PublicCloudSettings> | undefined;
  let sessionTask: Promise<AccountSessionProjection> | undefined;
  let refreshTask: Promise<CloudAccountSession | null> | undefined;
  const traceEnabled = isTraceEnabled();
  let traceSeq = 0;
  let publicSettingsSeq = 0;
  let refreshSeq = 0;
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
  const providerTasks = new Set<Promise<void>>();
  let packageUploadTail = Promise.resolve();
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
      if (!exported.terminal && !exported.operationId) observeSkillExport(callId, true);
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
    if (closing || !exported || exported.epoch !== epoch || exported.terminal || exported.operationId) return;
    if (skillExportObservationDisconnected && !recoverExpiredLease) {
      if (exported.expiresAt === undefined) exported.expiresAt = Date.now() + 10 * 60_000;
      return;
    }
    if (exported.observing) { exported.readRequested = true; return; }
    exported.observing = true;
    exported.readRequested = false;
    const task = (async () => {
      try {
        const { operationTransports } = await runtime;
        if (closing || skillExports.get(callId) !== exported || exported.epoch !== epoch || exported.operationId) return;
        subscribeSkillExports(operationTransports);
        if (skillExportObservationDisconnected && !recoverExpiredLease) return;
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
  const subscribeSkillExports = (operationTransports: PackageOperationTransports) => {
    if (unsubscribeSkillExports) return;
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
    const task = runtime.then(({ operationTransports }) => {
      operationTransports.packageChanged(operationId);
    }).catch(() => { /* Hints must not interrupt owner completion. */ }).finally(() => { packageTasks.delete(task); });
    packageTasks.add(task);
  };
  const invalidatePackageObservation = () => {
    for (const [operationId, entry] of packageOperations) {
      if (entry.epoch !== epoch && entry.result.state === 'pending') notifyPackageChanged(operationId);
    }
    packageObservation.abort(new CloudAccountClientError(409, 409, 'Cloud account session changed'));
    packageObservation = new AbortController();
  };

  const assertCurrent = (expected: number) => {
    if (closing || closed || epoch !== expected) throw new CloudAccountClientError(409, 409, 'Cloud account session changed');
  };
  const sessionOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = sessionTail.then(operation);
    sessionTail = task.then(() => undefined, () => undefined);
    return task;
  };
  const notifySession = (session: CloudAccountSession | null, expected: number) => {
    assertCurrent(expected);
    const seq = traceEnabled ? ++traceSeq : 0;
    const startedAt = traceEnabled ? performance.now() : 0;
    startupTrace('cloud-account-service', 'session.notify.start', () => ({ seq }));
    const signals = { bootstrap: AbortSignal.any([operationShutdown.signal, packageObservation.signal]), observation: operationShutdown.signal };
    const task = runtime.then(({ providerSync }) => {
      if (!closing && !closed && epoch === expected) return providerSync.reconcile(session, () => assertCurrent(expected), signals);
    }).catch(() => undefined).finally(() => { providerTasks.delete(task); });
    providerTasks.add(task);
    void packages.setSession(session?.user.id).catch(() => undefined);
    startupTrace('cloud-account-service', 'session.notify.end', () => ({ seq, outcome: 'dispatched', elapsedMs: Math.round(performance.now() - startedAt) }));
  };
  const clearSession = async (expected: number) => {
    assertCurrent(expected);
    const { clearing, previousSession } = beginSessionChange();
    await previousSession;
    await clearing;
  };
  const refreshStoredSession = (session: CloudAccountSession, expected: number): Promise<CloudAccountSession | null> => {
    if (refreshTask) {
      startupTrace('cloud-account-service', 'refresh.cache-join', () => ({ seq: refreshSeq }));
      return refreshTask;
    }
    const seq = refreshSeq = traceEnabled ? ++traceSeq : 0;
    const startedAt = traceEnabled ? performance.now() : 0;
    let stage = 'clear';
    let stageStartedAt = startedAt;
    let outcome = 'error';
    startupTrace('cloud-account-service', 'refresh.begin', () => ({ seq }));
    const task = (async () => {
      if (!session.refreshToken) {
        startupTrace('cloud-account-service', 'refresh.clear.start', () => ({ seq }));
        await clearSession(expected);
        startupTrace('cloud-account-service', 'refresh.clear.end', () => ({ seq, outcome: 'success', elapsedMs: Math.round(performance.now() - stageStartedAt) }));
        stage = '';
        outcome = 'anonymous';
        return null;
      }
      try {
        stage = 'network';
        stageStartedAt = traceEnabled ? performance.now() : 0;
        startupTrace('cloud-account-service', 'refresh.network.start', () => ({ seq }));
        const refreshed = await client.refresh(session.refreshToken);
        startupTrace('cloud-account-service', 'refresh.network.end', () => ({ seq, outcome: 'success', elapsedMs: Math.round(performance.now() - stageStartedAt) }));
        stage = '';
        assertCurrent(expected);
        const nextSession = { ...session, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken, expiresAt: refreshed.expiresAt, tokenType: refreshed.tokenType };
        stage = 'tail.wait';
        stageStartedAt = traceEnabled ? performance.now() : 0;
        startupTrace('cloud-account-service', 'refresh.tail.wait.start', () => ({ seq }));
        await sessionOperation(async () => {
          startupTrace('cloud-account-service', 'refresh.tail.wait.end', () => ({ seq, outcome: 'success', elapsedMs: Math.round(performance.now() - stageStartedAt) }));
          stage = '';
          assertCurrent(expected);
          stage = 'write';
          stageStartedAt = traceEnabled ? performance.now() : 0;
          startupTrace('cloud-account-service', 'refresh.write.start', () => ({ seq }));
          await writeCloudAccountSession(nextSession);
          startupTrace('cloud-account-service', 'refresh.write.end', () => ({ seq, outcome: 'success', elapsedMs: Math.round(performance.now() - stageStartedAt) }));
          stage = '';
        });
        assertCurrent(expected);
        notifySession(nextSession, expected);
        outcome = 'success';
        return nextSession;
      } catch (error) {
        if (stage) startupTrace('cloud-account-service', `refresh.${stage}.end`, () => ({ seq, outcome: 'error', elapsedMs: Math.round(performance.now() - stageStartedAt) }));
        stage = '';
        startupTrace('cloud-account-service', 'refresh.error', () => ({ seq, outcome: isUnauthorized(error) ? 'unauthorized' : 'error', elapsedMs: Math.round(performance.now() - startedAt) }));
        if (isUnauthorized(error) && expected === epoch) {
          stage = 'clear';
          stageStartedAt = traceEnabled ? performance.now() : 0;
          startupTrace('cloud-account-service', 'refresh.clear.start', () => ({ seq }));
          await clearSession(expected);
          startupTrace('cloud-account-service', 'refresh.clear.end', () => ({ seq, outcome: 'success', elapsedMs: Math.round(performance.now() - stageStartedAt) }));
          stage = '';
          outcome = 'anonymous';
          return null;
        }
        throw error;
      }
    })().finally(() => {
      if (refreshTask === task) refreshTask = undefined;
      if (stage) startupTrace('cloud-account-service', `refresh.${stage}.end`, () => ({ seq, outcome: 'error', elapsedMs: Math.round(performance.now() - stageStartedAt) }));
      startupTrace('cloud-account-service', 'refresh.end', () => ({ seq, outcome, elapsedMs: Math.round(performance.now() - startedAt) }));
    });
    refreshTask = task;
    return task;
  };
  const validSession = async (expected: number) => {
    const seq = traceEnabled ? ++traceSeq : 0;
    let stage = 'change.wait';
    let startedAt = traceEnabled ? performance.now() : 0;
    startupTrace('cloud-account-service', 'session.change.wait.start', () => ({ seq }));
    try {
      await sessionChangeTask;
      startupTrace('cloud-account-service', 'session.change.wait.end', () => ({ seq, outcome: 'success', elapsedMs: Math.round(performance.now() - startedAt) }));
      stage = 'tail.wait';
      startedAt = traceEnabled ? performance.now() : 0;
      startupTrace('cloud-account-service', 'session.tail.wait.start', () => ({ seq }));
      await sessionTail;
      startupTrace('cloud-account-service', 'session.tail.wait.end', () => ({ seq, outcome: 'success', elapsedMs: Math.round(performance.now() - startedAt) }));
      stage = '';
      assertCurrent(expected);
      stage = 'read';
      startedAt = traceEnabled ? performance.now() : 0;
      startupTrace('cloud-account-service', 'session.read.start', () => ({ seq }));
      const session = await readCloudAccountSession();
      startupTrace('cloud-account-service', 'session.read.end', () => ({ seq, outcome: session ? 'stored' : 'empty', elapsedMs: Math.round(performance.now() - startedAt) }));
      stage = '';
      assertCurrent(expected);
      if (!session) return null;
      const needsRefresh = session.expiresAt !== null && session.expiresAt <= Date.now() + 120_000;
      startupTrace('cloud-account-service', 'session.local', () => ({ seq, outcome: needsRefresh ? 'near-expiry-refresh' : 'cache' }));
      return needsRefresh ? refreshStoredSession(session, expected) : session;
    } catch (error) {
      if (stage) startupTrace('cloud-account-service', `session.${stage}.end`, () => ({ seq, outcome: 'error', elapsedMs: Math.round(performance.now() - startedAt) }));
      throw error;
    }
  };
  const withSession = async <T>(run: (session: CloudAccountSession) => Promise<T>): Promise<T> => {
    const expected = epoch;
    const session = await validSession(expected);
    if (!session) {
      notifySession(null, expected);
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
  const packages = createPackageAuthorizationLifecycle(async () => (await runtime).packageTransport, authorizePackage, downloadPackage);
  const getPublicSettings = () => {
    if (!publicSettingsTask) {
      const seq = publicSettingsSeq = traceEnabled ? ++traceSeq : 0;
      const startedAt = traceEnabled ? performance.now() : 0;
      startupTrace('cloud-account-service', 'public-settings.create', () => ({ seq }));
      const task = client.fetchPublicSettings().catch((error) => {
        startupTrace('cloud-account-service', 'public-settings.settle', () => ({ seq, outcome: 'error', elapsedMs: Math.round(performance.now() - startedAt) }));
        if (publicSettingsTask === task) {
          publicSettingsTask = undefined;
          startupTrace('cloud-account-service', 'public-settings.reset', () => ({ seq }));
        }
        throw error;
      });
      publicSettingsTask = task;
      if (traceEnabled) void task.then(() => {
        startupTrace('cloud-account-service', 'public-settings.settle', () => ({ seq, outcome: 'success', elapsedMs: Math.round(performance.now() - startedAt) }));
      }, () => undefined);
    } else {
      startupTrace('cloud-account-service', 'public-settings.cache-join', () => ({ seq: publicSettingsSeq }));
    }
    return publicSettingsTask;
  };
  const getSession = () => {
    const seq = traceEnabled ? ++traceSeq : 0;
    const startedAt = traceEnabled ? performance.now() : 0;
    startupTrace('cloud-account-service', 'session.get.begin', () => ({ seq }));
    if (!sessionTask) {
      startupTrace('cloud-account-service', 'session.get.create', () => ({ seq }));
      const expected = epoch;
      const task = (async (): Promise<AccountSessionProjection> => {
        const session = await validSession(expected);
        notifySession(session, expected);
        if (!session) return { state: 'anonymous' };
        void (async () => {
          const profileSeq = traceEnabled ? ++traceSeq : 0;
          const profileStartedAt = traceEnabled ? performance.now() : 0;
          let stage = '';
          let stageStartedAt = profileStartedAt;
          let outcome = 'error';
          startupTrace('cloud-account-service', 'profile.background.start', () => ({ seq: profileSeq }));
          try {
            const user = await client.fetchProfile(session.accessToken);
            stage = 'tail.wait';
            stageStartedAt = traceEnabled ? performance.now() : 0;
            startupTrace('cloud-account-service', 'profile.tail.wait.start', () => ({ seq: profileSeq }));
            await sessionOperation(async () => {
              startupTrace('cloud-account-service', 'profile.tail.wait.end', () => ({ seq: profileSeq, outcome: 'success', elapsedMs: Math.round(performance.now() - stageStartedAt) }));
              stage = '';
              assertCurrent(expected);
              stage = 'read';
              stageStartedAt = traceEnabled ? performance.now() : 0;
              startupTrace('cloud-account-service', 'profile.read.start', () => ({ seq: profileSeq }));
              const current = await readCloudAccountSession();
              startupTrace('cloud-account-service', 'profile.read.end', () => ({ seq: profileSeq, outcome: 'success', elapsedMs: Math.round(performance.now() - stageStartedAt) }));
              stage = '';
              if (current?.accessToken !== session.accessToken) { outcome = 'skipped'; return; }
              assertCurrent(expected);
              const next = { ...session, user };
              stage = 'write';
              stageStartedAt = traceEnabled ? performance.now() : 0;
              startupTrace('cloud-account-service', 'profile.write.start', () => ({ seq: profileSeq }));
              await writeCloudAccountSession(next);
              startupTrace('cloud-account-service', 'profile.write.end', () => ({ seq: profileSeq, outcome: 'success', elapsedMs: Math.round(performance.now() - stageStartedAt) }));
              stage = '';
              assertCurrent(expected);
              notifySession(next, expected);
              if (sessionTask === task) sessionTask = Promise.resolve(toSessionProjection(next));
              outcome = 'success';
            });
          } catch (error) {
            if (stage) startupTrace('cloud-account-service', `profile.${stage}.end`, () => ({ seq: profileSeq, outcome: 'error', elapsedMs: Math.round(performance.now() - stageStartedAt) }));
            startupTrace('cloud-account-service', 'profile.background.error', () => ({ seq: profileSeq, outcome: isUnauthorized(error) ? 'unauthorized' : 'error' }));
            if (isUnauthorized(error) && expected === epoch) {
              stageStartedAt = traceEnabled ? performance.now() : 0;
              startupTrace('cloud-account-service', 'profile.clear.start', () => ({ seq: profileSeq }));
              let clearOutcome = 'success';
              await clearSession(expected).catch(() => { clearOutcome = 'error'; });
              startupTrace('cloud-account-service', 'profile.clear.end', () => ({ seq: profileSeq, outcome: clearOutcome, elapsedMs: Math.round(performance.now() - stageStartedAt) }));
            }
          } finally {
            startupTrace('cloud-account-service', 'profile.background.end', () => ({ seq: profileSeq, outcome, elapsedMs: Math.round(performance.now() - profileStartedAt) }));
          }
        })();
        return toSessionProjection(session);
      })().catch((error) => {
        if (sessionTask === task) {
          sessionTask = undefined;
          startupTrace('cloud-account-service', 'session.get.reset', () => ({ seq }));
        }
        throw error;
      });
      sessionTask = task;
    } else {
      startupTrace('cloud-account-service', 'session.get.cache-join', () => ({ seq }));
    }
    if (traceEnabled) void sessionTask.then(() => {
      startupTrace('cloud-account-service', 'session.get.end', () => ({ seq, outcome: 'success', elapsedMs: Math.round(performance.now() - startedAt) }));
    }, () => {
      startupTrace('cloud-account-service', 'session.get.end', () => ({ seq, outcome: 'error', elapsedMs: Math.round(performance.now() - startedAt) }));
    });
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
      notifySession(null, expected);
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
    notifySession(session, expected);
    const projection = toSessionProjection(session);
    sessionTask = Promise.resolve(projection);
    return projection;
  };

  const admitPackageOperation = <K extends CloudPackageOperationKind>(kind: K, request: CloudPackageOperationRequests[K]): CloudPackageOperationReceipt => {
    if (closing || closed) throw new PackageOperationError('unavailable', 503, 'Cloud package operations are unavailable');
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
    // The retained operation slots bound workflows; only multipart uploads share a serial effect.
    const task = Promise.resolve().then(async () => {
      try {
        assertCurrent(expected);
        operationShutdown.signal.throwIfAborted();
        const session = await validSession(expected);
        if (!session) throw new CloudAccountClientError(401, 401, 'Cloud account session is not authenticated');
        void packages.setSession(session.user.id).catch(() => undefined);
        const { operationTransports } = await runtime;
        assertCurrent(expected);
        operationShutdown.signal.throwIfAborted();
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
          upload: (upload) => {
            const uploading = packageUploadTail.then(async () => {
              assertCurrent(expected);
              operationShutdown.signal.throwIfAborted();
              try {
                const value = await client.uploadPackage(session.accessToken, upload);
                assertCurrent(expected);
                return value;
              } catch (error) {
                if (isUnauthorized(error) && expected === epoch) await clearSession(expected).catch(() => undefined);
                throw error;
              }
            });
            packageUploadTail = uploading.then(() => undefined, () => undefined);
            return uploading;
          },
          prepare: async (input) => { assertCurrent(expected); await getSession(); assertCurrent(expected); return packages.preparePackageInstall(input); },
          bind: (callId, prepared) => packages.bindPackageInstall(callId, prepared, Promise.resolve(operationTransports)),
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
    packageTasks.add(task);
    return { operationId, accepted: true };
  };

  return {
    prewarm: () => {
      if (!traceEnabled) {
        void getPublicSettings().catch(() => undefined);
        void getSession().catch(() => undefined);
        return;
      }
      const seq = ++traceSeq;
      const startedAt = traceEnabled ? performance.now() : 0;
      let remaining = 2;
      let outcome = 'success';
      startupTrace('cloud-account-service', 'prewarm.begin', () => ({ seq }));
      void getPublicSettings().catch(() => {
        outcome = 'error';
        startupTrace('cloud-account-service', 'prewarm.error', () => ({ seq, operation: 'public-settings', outcome: 'error' }));
      }).finally(() => {
        if (--remaining === 0) startupTrace('cloud-account-service', 'prewarm.end', () => ({ seq, outcome, elapsedMs: Math.round(performance.now() - startedAt) }));
      });
      void getSession().catch(() => {
        outcome = 'error';
        startupTrace('cloud-account-service', 'prewarm.error', () => ({ seq, operation: 'session', outcome: 'error' }));
      }).finally(() => {
        if (--remaining === 0) startupTrace('cloud-account-service', 'prewarm.end', () => ({ seq, outcome, elapsedMs: Math.round(performance.now() - startedAt) }));
      });
    },
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
      notifySession(refreshed, expected);
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
    bindPackageInstall: (callId, prepared) => packages.bindPackageInstall(callId, prepared, runtime.then(({ operationTransports }) => operationTransports)),
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
      await sessionTail;
      while (packageTasks.size || providerTasks.size) await Promise.all([...packageTasks, ...providerTasks]);
      closed = true;
      epoch += 1;
      invalidatePackageObservation();
      packageOperations.clear();
      skillExports.clear();
      skillExportReservations.clear();
      try { await packages.close(); }
      finally { while (packageTasks.size) await Promise.all(packageTasks); }
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
