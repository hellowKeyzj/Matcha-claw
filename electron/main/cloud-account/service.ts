import {
  clearCloudAccountSession,
  readCloudAccountSession,
  writeCloudAccountSession,
  type CloudAccountSession,
} from './session-store';
import {
  CloudAccountClientError,
  createCloudAccountClient,
  type CloudAccountClient,
} from './client';
import type { CloudProviderSync } from './provider-sync';
import type {
  AccountSessionProjection,
  AuthLogin2FARequest,
  AuthLoginRequest,
  AuthLoginResult,
  AuthRegisterRequest,
  AuthSendVerifyCodeRequest,
  AuthSendVerifyCodeResult,
  AuthTokenResult,
  BillingCheckoutInfo,
  BillingPlan,
  CloudPackageAuthorization,
  CloudPackageAuthorizationRequest,
  CloudPackageDownloadRecord,
  CloudPackageDownloadRecordRequest,
  CloudPackageDownloadRequest,
  CloudPackageListPage,
  CloudPackageListQuery,
  CloudPackageLocalDownload,
  CloudPackageVersion,
  CloudSealedCloudKey,
  CloudUser,
  CreatePaymentOrderRequest,
  CreatePaymentOrderResult,
  PaymentOrder,
  PlatformQuota,
  PublicCloudSettings,
  SubscriptionProgress,
  SubscriptionSummary,
  UserSubscription,
} from './types';
import { getCloudPackageDevicePublicKey } from './device-key-store';

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
  uploadPackage(packagePath: string): Promise<CloudPackageVersion>;
  authorizePackage(request: Omit<CloudPackageAuthorizationRequest, 'devicePublicKey'>): Promise<CloudPackageAuthorization>;
  recordPackageDownload(request: CloudPackageDownloadRecordRequest): Promise<CloudPackageDownloadRecord>;
  downloadPackage(request: CloudPackageDownloadRequest): Promise<CloudPackageLocalDownload>;
}>;

export function createCloudAccountService(
  client: CloudAccountClient = createCloudAccountClient(),
  providerSync?: CloudProviderSync,
): CloudAccountService {
  let publicSettingsTask: Promise<PublicCloudSettings> | undefined;
  let sessionTask: Promise<AccountSessionProjection> | undefined;

  const setSessionProjection = (projection: AccountSessionProjection) => {
    sessionTask = Promise.resolve(projection);
  };
  const getPublicSettings = () => {
    if (!publicSettingsTask) {
      let task: Promise<PublicCloudSettings>;
      task = client.fetchPublicSettings().catch((error) => {
        if (publicSettingsTask === task) publicSettingsTask = undefined;
        throw error;
      });
      publicSettingsTask = task;
    }
    return publicSettingsTask;
  };
  const getSession = () => {
    if (!sessionTask) {
      let task: Promise<AccountSessionProjection>;
      task = sessionProjection(client, providerSync, (projection) => {
        if (sessionTask === task) setSessionProjection(projection);
      }).catch((error) => {
        if (sessionTask === task) sessionTask = undefined;
        throw error;
      });
      sessionTask = task;
    }
    return sessionTask;
  };
  const storeSession = async (session: CloudAccountSession) => {
    await writeCloudAccountSession(session);
    void providerSync?.reconcile(session);
    const projection = toSessionProjection(session);
    setSessionProjection(projection);
    return projection;
  };

  return {
    prewarm: () => {
      void getPublicSettings().catch(() => undefined);
      void getSession().catch(() => undefined);
    },
    getPublicSettings,
    getSession,
    login: async (request) => {
      const result = await client.login(request);
      if (!isAuthTokenResult(result)) return result;
      return storeSession(sessionFromAuth(result));
    },
    login2FA: async (request) => storeSession(sessionFromAuth(await client.login2FA(request))),
    register: async (request) => storeSession(sessionFromAuth(await client.register(request))),
    sendVerifyCode: (request) => client.sendVerifyCode(request),
    refreshSession: async () => {
      const projection = await refreshSession(client, providerSync);
      setSessionProjection(projection);
      return projection;
    },
    logout: async () => {
      const session = await readCloudAccountSession();
      try {
        if (session?.refreshToken) await client.logout(session.refreshToken);
      } finally {
        await clearCloudAccountSession();
        await providerSync?.reconcile(null);
        setSessionProjection({ state: 'anonymous' });
      }
    },
    getCheckoutInfo: () => withValidSession(client, providerSync, (session) => client.fetchCheckoutInfo(session.accessToken)),
    getPlans: () => withValidSession(client, providerSync, (session) => client.fetchPlans(session.accessToken)),
    createPaymentOrder: (request) => withValidSession(client, providerSync, (session) => client.createPaymentOrder(session.accessToken, request)),
    verifyPaymentOrder: (outTradeNo) => withValidSession(client, providerSync, (session) => client.verifyPaymentOrder(session.accessToken, outTradeNo)),
    getPaymentOrder: (orderId) => withValidSession(client, providerSync, (session) => client.fetchPaymentOrder(session.accessToken, orderId)),
    getSubscriptionSummary: () => withValidSession(client, providerSync, (session) => client.fetchSubscriptionSummary(session.accessToken)),
    getActiveSubscriptions: () => withValidSession(client, providerSync, (session) => client.fetchActiveSubscriptions(session.accessToken)),
    getSubscriptionProgress: () => withValidSession(client, providerSync, (session) => client.fetchSubscriptionProgress(session.accessToken)),
    getPlatformQuotas: () => withValidSession(client, providerSync, (session) => client.fetchPlatformQuotas(session.accessToken)),
    listOwnedPackages: (query) => withValidSession(client, providerSync, (session) => client.listOwnedPackages(session.accessToken, query)),
    listMarketPackages: (query) => withValidSession(client, providerSync, (session) => client.listMarketPackages(session.accessToken, query)),
    fetchSealedCloudKey: () => withValidSession(client, providerSync, (session) => client.fetchSealedCloudKey(session.accessToken)),
    uploadPackage: (packagePath) => withValidSession(client, providerSync, (session) => client.uploadPackage(session.accessToken, packagePath)),
    authorizePackage: (request) => withValidSession(client, providerSync, async (session) => client.authorizePackage(session.accessToken, {
      ...request,
      devicePublicKey: await getCloudPackageDevicePublicKey(),
    })),
    recordPackageDownload: (request) => withValidSession(client, providerSync, (session) => client.recordPackageDownload(session.accessToken, request)),
    downloadPackage: (request) => withValidSession(client, providerSync, (session) => client.downloadPackage(session.accessToken, request)),
  };
}

async function sessionProjection(
  client: CloudAccountClient,
  providerSync: CloudProviderSync | undefined,
  onFreshProfile: (projection: AccountSessionProjection) => void,
): Promise<AccountSessionProjection> {
  const session = await validSession(client);
  if (!session) {
    void providerSync?.reconcile(null);
    return { state: 'anonymous' };
  }
  void providerSync?.reconcile(session);
  void syncStoredProfile(client, providerSync, session, onFreshProfile);
  return toSessionProjection(session);
}

async function syncStoredProfile(
  client: CloudAccountClient,
  providerSync: CloudProviderSync | undefined,
  session: CloudAccountSession,
  onFreshProfile: (projection: AccountSessionProjection) => void,
): Promise<void> {
  try {
    const user = await client.fetchProfile(session.accessToken);
    if (await isCurrentStoredSession(session)) {
      const nextSession = { ...session, user };
      await writeCloudAccountSession(nextSession);
      void providerSync?.reconcile(nextSession);
      onFreshProfile(toSessionProjection(nextSession));
    }
  } catch (error) {
    if (isUnauthorized(error) && await clearCurrentStoredSession(session)) {
      await providerSync?.reconcile(null);
      onFreshProfile({ state: 'anonymous' });
    }
  }
}

async function isCurrentStoredSession(session: CloudAccountSession): Promise<boolean> {
  const currentSession = await readCloudAccountSession();
  return currentSession?.accessToken === session.accessToken;
}

async function clearCurrentStoredSession(session: CloudAccountSession): Promise<boolean> {
  try {
    if (await isCurrentStoredSession(session)) {
      await clearCloudAccountSession();
      return true;
    }
  } catch {
    // Ignore background profile sync cleanup failures.
  }
  return false;
}

async function refreshSession(
  client: CloudAccountClient,
  providerSync: CloudProviderSync | undefined,
): Promise<AccountSessionProjection> {
  const session = await readCloudAccountSession();
  if (!session?.refreshToken) {
    await clearCloudAccountSession();
    void providerSync?.reconcile(null);
    return { state: 'anonymous' };
  }
  try {
    const refreshed = await client.refresh(session.refreshToken);
    const nextSession: CloudAccountSession = {
      ...session,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      tokenType: refreshed.tokenType,
    };
    await writeCloudAccountSession(nextSession);
    void providerSync?.reconcile(nextSession);
    return toSessionProjection(nextSession);
  } catch (error) {
    if (isUnauthorized(error)) {
      await clearCloudAccountSession();
      await providerSync?.reconcile(null);
      return { state: 'anonymous' };
    }
    throw error;
  }
}

async function withValidSession<T>(
  client: CloudAccountClient,
  providerSync: CloudProviderSync | undefined,
  run: (session: CloudAccountSession) => Promise<T>,
): Promise<T> {
  const session = await validSession(client);
  if (!session) {
    void providerSync?.reconcile(null);
    throw new CloudAccountClientError(401, 401, 'Cloud account session is not authenticated');
  }
  try {
    return await run(session);
  } catch (error) {
    if (isUnauthorized(error)) {
      await clearCloudAccountSession();
      await providerSync?.reconcile(null);
    }
    throw error;
  }
}

async function validSession(client: CloudAccountClient): Promise<CloudAccountSession | null> {
  const session = await readCloudAccountSession();
  if (!session) return null;
  if (!isExpired(session)) return session;
  if (!session.refreshToken) {
    await clearCloudAccountSession();
    return null;
  }
  try {
    const refreshed = await client.refresh(session.refreshToken);
    const nextSession: CloudAccountSession = {
      ...session,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      tokenType: refreshed.tokenType,
    };
    await writeCloudAccountSession(nextSession);
    return nextSession;
  } catch (error) {
    if (isUnauthorized(error)) {
      await clearCloudAccountSession();
      return null;
    }
    throw error;
  }
}

function isExpired(session: CloudAccountSession): boolean {
  return session.expiresAt !== null && session.expiresAt <= Date.now() + 120_000;
}

function sessionFromAuth(result: { accessToken: string; refreshToken?: string; expiresAt: number | null; tokenType: string; user: CloudUser }): CloudAccountSession {
  return {
    accessToken: result.accessToken,
    ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
    expiresAt: result.expiresAt,
    tokenType: result.tokenType,
    user: result.user,
  };
}

function toSessionProjection(session: CloudAccountSession): AccountSessionProjection {
  return {
    state: 'authenticated',
    user: session.user,
    expiresAt: session.expiresAt,
    tokenType: session.tokenType,
  };
}

function isAuthTokenResult(result: AuthLoginResult): result is AuthTokenResult {
  return !('state' in result);
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof CloudAccountClientError && error.status === 401;
}
