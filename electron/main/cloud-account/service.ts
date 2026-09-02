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

export type CloudAccountService = Readonly<{
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
}>;

export function createCloudAccountService(client: CloudAccountClient = createCloudAccountClient()): CloudAccountService {
  return {
    getPublicSettings: () => client.fetchPublicSettings(),
    getSession: () => sessionProjection(client),
    login: async (request) => {
      const result = await client.login(request);
      if (!isAuthTokenResult(result)) return result;
      const session = sessionFromAuth(result);
      await writeCloudAccountSession(session);
      return toSessionProjection(session);
    },
    login2FA: async (request) => {
      const result = await client.login2FA(request);
      const session = sessionFromAuth(result);
      await writeCloudAccountSession(session);
      return toSessionProjection(session);
    },
    register: async (request) => {
      const result = await client.register(request);
      const session = sessionFromAuth(result);
      await writeCloudAccountSession(session);
      return toSessionProjection(session);
    },
    sendVerifyCode: (request) => client.sendVerifyCode(request),
    refreshSession: () => refreshSession(client),
    logout: async () => {
      const session = await readCloudAccountSession();
      try {
        if (session?.refreshToken) await client.logout(session.refreshToken);
      } finally {
        await clearCloudAccountSession();
      }
    },
    getCheckoutInfo: () => withValidSession(client, (session) => client.fetchCheckoutInfo(session.accessToken)),
    getPlans: () => withValidSession(client, (session) => client.fetchPlans(session.accessToken)),
    createPaymentOrder: (request) => withValidSession(client, (session) => client.createPaymentOrder(session.accessToken, request)),
    verifyPaymentOrder: (outTradeNo) => withValidSession(client, (session) => client.verifyPaymentOrder(session.accessToken, outTradeNo)),
    getPaymentOrder: (orderId) => withValidSession(client, (session) => client.fetchPaymentOrder(session.accessToken, orderId)),
    getSubscriptionSummary: () => withValidSession(client, (session) => client.fetchSubscriptionSummary(session.accessToken)),
    getActiveSubscriptions: () => withValidSession(client, (session) => client.fetchActiveSubscriptions(session.accessToken)),
    getSubscriptionProgress: () => withValidSession(client, (session) => client.fetchSubscriptionProgress(session.accessToken)),
    getPlatformQuotas: () => withValidSession(client, (session) => client.fetchPlatformQuotas(session.accessToken)),
  };
}

async function sessionProjection(client: CloudAccountClient): Promise<AccountSessionProjection> {
  const session = await validSession(client);
  if (!session) return { state: 'anonymous' };
  void syncStoredProfile(client, session);
  return toSessionProjection(session);
}

async function syncStoredProfile(client: CloudAccountClient, session: CloudAccountSession): Promise<void> {
  try {
    const user = await client.fetchProfile(session.accessToken);
    if (await isCurrentStoredSession(session)) {
      await writeCloudAccountSession({ ...session, user });
    }
  } catch (error) {
    if (isUnauthorized(error)) {
      await clearCurrentStoredSession(session);
    }
  }
}

async function isCurrentStoredSession(session: CloudAccountSession): Promise<boolean> {
  const currentSession = await readCloudAccountSession();
  return currentSession?.accessToken === session.accessToken;
}

async function clearCurrentStoredSession(session: CloudAccountSession): Promise<void> {
  try {
    if (await isCurrentStoredSession(session)) {
      await clearCloudAccountSession();
    }
  } catch {
    // Ignore background profile sync cleanup failures.
  }
}

async function refreshSession(client: CloudAccountClient): Promise<AccountSessionProjection> {
  const session = await readCloudAccountSession();
  if (!session?.refreshToken) {
    await clearCloudAccountSession();
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
    return toSessionProjection(nextSession);
  } catch (error) {
    if (isUnauthorized(error)) {
      await clearCloudAccountSession();
      return { state: 'anonymous' };
    }
    throw error;
  }
}

async function withValidSession<T>(
  client: CloudAccountClient,
  run: (session: CloudAccountSession) => Promise<T>,
): Promise<T> {
  const session = await validSession(client);
  if (!session) throw new CloudAccountClientError(401, 401, 'Cloud account session is not authenticated');
  try {
    return await run(session);
  } catch (error) {
    if (isUnauthorized(error)) await clearCloudAccountSession();
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
