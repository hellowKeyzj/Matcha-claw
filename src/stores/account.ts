import { create } from 'zustand';
import {
  fetchAccountSession,
  fetchPublicCloudSettings,
  loginCloudAccount,
  loginCloudAccount2FA,
  logoutCloudAccount,
  refreshCloudAccountSession,
  registerCloudAccount,
  sendCloudAccountVerifyCode,
} from '@/lib/account';
import type {
  AccountSessionProjection,
  CloudUser,
  Login2FARequest,
  LoginRequest,
  LoginResult,
  PublicCloudSettings,
  RegisterRequest,
  SendVerifyCodeRequest,
  SendVerifyCodeResult,
} from '@/lib/account';

export type CloudAccountLoginInput = LoginRequest;
export type CloudAccountLogin2FAInput = Login2FARequest;
export type CloudAccountRegisterInput = RegisterRequest;
export type CloudAccountUser = CloudUser;
export type AccountSubscription = NonNullable<AccountSessionProjection['subscription']>;
export type AccountPlatformQuotas = NonNullable<AccountSessionProjection['platformQuotas']>;
export type AccountUsage = NonNullable<AccountSessionProjection['usage']>;
export type AccountStatus = 'checking' | 'signedOut' | 'signedIn' | 'requires2fa' | 'offline';

type AccountProjectionFields = {
  subscription: AccountSubscription | null;
  usage: AccountUsage | null;
  platformQuotas: AccountPlatformQuotas | null;
  publicSettings: PublicCloudSettings | null;
  errorMessage: string | null;
};

export type AccountStoreProjection = AccountProjectionFields & (
  | {
    status: 'checking';
    user: CloudAccountUser | null;
    twoFactorChallengeId: string | null;
    twoFactorEmail: string | null;
  }
  | {
    status: 'signedOut';
    user: null;
    twoFactorChallengeId: null;
    twoFactorEmail: null;
  }
  | {
    status: 'signedIn';
    user: CloudAccountUser;
    twoFactorChallengeId: null;
    twoFactorEmail: null;
  }
  | {
    status: 'requires2fa';
    user: null;
    twoFactorChallengeId: string;
    twoFactorEmail: string | null;
  }
  | {
    status: 'offline';
    user: CloudAccountUser | null;
    twoFactorChallengeId: null;
    twoFactorEmail: null;
  }
);

export interface AccountStoreActions {
  init: () => Promise<void>;
  refreshSession: () => Promise<void>;
  login: (...args: [request: LoginRequest] | [email: string, password: string]) => Promise<void>;
  login2FA: (...args: [code: string] | [request: Login2FARequest]) => Promise<void>;
  register: (...args: [request: RegisterRequest] | [email: string, password: string, name?: string]) => Promise<void>;
  sendVerifyCode: (request: SendVerifyCodeRequest) => Promise<SendVerifyCodeResult>;
  logout: () => Promise<void>;
  loadPublicSettings: () => Promise<void>;
  clearError: () => void;
}

export type AccountStoreState = AccountStoreProjection & AccountStoreActions;

let latestAccountRequestId = 0;
let latestPublicSettingsRequestId = 0;
let initTask: Promise<void> | null = null;

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function valueOrPrevious<T>(incoming: T | null | undefined, previous: T | null): T | null {
  return incoming === undefined ? previous : incoming;
}

function subscriptionFieldsForSession(
  session: AccountSessionProjection,
  current: AccountStoreState,
  user: CloudAccountUser,
): Pick<AccountProjectionFields, 'subscription' | 'usage' | 'platformQuotas'> {
  const sameUser = current.status === 'signedIn' && current.user.id === user.id;
  return {
    subscription: valueOrPrevious(session.subscription, sameUser ? current.subscription : null),
    usage: valueOrPrevious(session.usage, sameUser ? current.usage : null),
    platformQuotas: valueOrPrevious(session.platformQuotas, sameUser ? current.platformQuotas : null),
  };
}

function projectChecking(current: AccountStoreState, preserveTwoFactor = false): AccountStoreProjection {
  return {
    status: 'checking',
    user: current.user,
    subscription: current.subscription,
    usage: current.usage,
    platformQuotas: current.platformQuotas,
    publicSettings: current.publicSettings,
    errorMessage: null,
    twoFactorChallengeId: preserveTwoFactor ? current.twoFactorChallengeId : null,
    twoFactorEmail: preserveTwoFactor ? current.twoFactorEmail : null,
  };
}

function projectSignedOut(
  publicSettings: PublicCloudSettings | null,
  errorMessage: string | null,
): AccountStoreProjection {
  return {
    status: 'signedOut',
    user: null,
    subscription: null,
    usage: null,
    platformQuotas: null,
    publicSettings,
    errorMessage,
    twoFactorChallengeId: null,
    twoFactorEmail: null,
  };
}

function projectRequires2FA(
  current: AccountStoreState,
  challengeId: string,
  email: string | null,
  errorMessage: string | null,
): AccountStoreProjection {
  return {
    status: 'requires2fa',
    user: null,
    subscription: null,
    usage: null,
    platformQuotas: null,
    publicSettings: current.publicSettings,
    errorMessage,
    twoFactorChallengeId: challengeId,
    twoFactorEmail: email,
  };
}

function projectOffline(current: AccountStoreState, message: string): AccountStoreProjection {
  return {
    status: 'offline',
    user: current.user,
    subscription: current.subscription,
    usage: current.usage,
    platformQuotas: current.platformQuotas,
    publicSettings: current.publicSettings,
    errorMessage: message,
    twoFactorChallengeId: null,
    twoFactorEmail: null,
  };
}

function projectAccountSession(
  session: AccountSessionProjection,
  current: AccountStoreState,
): AccountStoreProjection {
  switch (session.state.status) {
    case 'checking':
      return projectChecking(current);
    case 'signedOut':
      return projectSignedOut(current.publicSettings, null);
    case 'signedIn':
      return {
        status: 'signedIn',
        user: session.state.user,
        ...subscriptionFieldsForSession(session, current, session.state.user),
        publicSettings: current.publicSettings,
        errorMessage: null,
        twoFactorChallengeId: null,
        twoFactorEmail: null,
      };
    case 'requires2fa':
      return projectRequires2FA(current, session.state.challengeId, session.state.email ?? null, null);
    case 'offline':
      return projectOffline(current, session.state.message ?? 'Cloud account is offline');
  }
}

function projectLoginResult(result: LoginResult, current: AccountStoreState): AccountStoreProjection {
  switch (result.status) {
    case 'signedIn':
      return projectAccountSession(result.session, current);
    case 'requires2fa':
      return projectRequires2FA(current, result.challengeId, result.email ?? null, null);
    case 'offline':
      return projectOffline(current, result.message ?? 'Cloud account is offline');
  }
}

function withPublicSettings(
  projection: AccountStoreProjection,
  publicSettings: PublicCloudSettings,
): AccountStoreProjection {
  return { ...projection, publicSettings };
}

function withErrorMessage(
  projection: AccountStoreProjection,
  errorMessage: string | null,
): AccountStoreProjection {
  return { ...projection, errorMessage };
}

function toLoginRequest(input: LoginRequest | string, password?: string): LoginRequest {
  if (typeof input !== 'string') return input;
  if (!password) throw new Error('Cloud account password is required');
  return { email: input, password };
}

function toRegisterRequest(input: RegisterRequest | string, password?: string, name?: string): RegisterRequest {
  if (typeof input !== 'string') return input;
  if (!password) throw new Error('Cloud account password is required');
  return {
    email: input,
    password,
    ...(name ? { name } : {}),
  };
}

function toLogin2FARequest(input: string | Login2FARequest, current: AccountStoreState): Login2FARequest | null {
  if (typeof input !== 'string') {
    return input.challengeId || current.twoFactorChallengeId
      ? { ...input, challengeId: input.challengeId ?? current.twoFactorChallengeId ?? undefined }
      : input;
  }
  if (!current.twoFactorChallengeId) return null;
  return { challengeId: current.twoFactorChallengeId, code: input };
}

async function refreshSubscriptionStoreAfterSignedIn(requestId: number): Promise<void> {
  try {
    if (requestId !== latestAccountRequestId) return;
    const { useSubscriptionStore } = await import('./subscription');
    if (requestId !== latestAccountRequestId) return;
    await useSubscriptionStore.getState().refreshAll();
  } catch {
    // Subscription store owns its own error projection.
  }
}

const initialAccountProjection: AccountStoreProjection = {
  status: 'checking',
  user: null,
  subscription: null,
  usage: null,
  platformQuotas: null,
  publicSettings: null,
  errorMessage: null,
  twoFactorChallengeId: null,
  twoFactorEmail: null,
};

export const useAccountStore = create<AccountStoreState>((set, get) => ({
  ...initialAccountProjection,

  init: async () => {
    if (initTask) {
      await initTask;
      return;
    }

    const requestId = ++latestAccountRequestId;
    const publicSettingsRequestId = ++latestPublicSettingsRequestId;
    set(projectChecking(get()));

    initTask = (async () => {
      const [publicSettingsResult, sessionResult] = await Promise.allSettled([
        fetchPublicCloudSettings(),
        fetchAccountSession(),
      ]);
      if (requestId !== latestAccountRequestId) return;

      let projection = sessionResult.status === 'fulfilled'
        ? projectAccountSession(sessionResult.value, get())
        : projectOffline(get(), messageFromError(sessionResult.reason));

      if (publicSettingsResult.status === 'fulfilled' && publicSettingsRequestId === latestPublicSettingsRequestId) {
        projection = withPublicSettings(projection, publicSettingsResult.value);
      } else if (publicSettingsResult.status === 'rejected' && !projection.errorMessage) {
        projection = withErrorMessage(projection, messageFromError(publicSettingsResult.reason));
      }

      set(projection);

      if (projection.status === 'signedIn') {
        void refreshSubscriptionStoreAfterSignedIn(requestId);
      }
    })();

    try {
      await initTask;
    } finally {
      initTask = null;
    }
  },

  refreshSession: async () => {
    const requestId = ++latestAccountRequestId;
    set(projectChecking(get()));

    try {
      const session = await refreshCloudAccountSession();
      if (requestId !== latestAccountRequestId) return;

      const projection = projectAccountSession(session, get());
      set(projection);
      if (projection.status === 'signedIn') {
        void refreshSubscriptionStoreAfterSignedIn(requestId);
      }
    } catch (error) {
      if (requestId !== latestAccountRequestId) return;
      set(projectOffline(get(), messageFromError(error)));
    }
  },

  login: async (...args) => {
    const requestId = ++latestAccountRequestId;
    set(projectChecking(get()));

    try {
      const result = await loginCloudAccount(toLoginRequest(args[0], args[1]));
      if (requestId !== latestAccountRequestId) return;

      const projection = projectLoginResult(result, get());
      set(projection);
      if (projection.status === 'signedIn') {
        void refreshSubscriptionStoreAfterSignedIn(requestId);
      }
    } catch (error) {
      if (requestId !== latestAccountRequestId) return;
      set(projectSignedOut(get().publicSettings, messageFromError(error)));
    }
  },

  login2FA: async (...args) => {
    const requestId = ++latestAccountRequestId;
    const current = get();
    const request = toLogin2FARequest(args[0], current);
    if (!request) {
      set({ errorMessage: 'Two-factor challenge is unavailable' });
      return;
    }

    set(projectChecking(current, true));

    try {
      const result = await loginCloudAccount2FA(request);
      if (requestId !== latestAccountRequestId) return;

      const projection = projectLoginResult(result, get());
      set(projection);
      if (projection.status === 'signedIn') {
        void refreshSubscriptionStoreAfterSignedIn(requestId);
      }
    } catch (error) {
      if (requestId !== latestAccountRequestId) return;
      const challengeId = request.challengeId ?? current.twoFactorChallengeId;
      if (challengeId) {
        set(projectRequires2FA(current, challengeId, current.twoFactorEmail, messageFromError(error)));
        return;
      }
      set(projectSignedOut(get().publicSettings, messageFromError(error)));
    }
  },

  register: async (...args) => {
    const requestId = ++latestAccountRequestId;
    set(projectChecking(get()));

    try {
      const result = await registerCloudAccount(toRegisterRequest(args[0], args[1], args[2]));
      if (requestId !== latestAccountRequestId) return;

      const projection = projectLoginResult(result, get());
      set(projection);
      if (projection.status === 'signedIn') {
        void refreshSubscriptionStoreAfterSignedIn(requestId);
      }
    } catch (error) {
      if (requestId !== latestAccountRequestId) return;
      set(projectSignedOut(get().publicSettings, messageFromError(error)));
    }
  },

  sendVerifyCode: async (request) => {
    set({ errorMessage: null });
    try {
      return await sendCloudAccountVerifyCode(request);
    } catch (error) {
      set({ errorMessage: messageFromError(error) });
      throw error;
    }
  },

  logout: async () => {
    const requestId = ++latestAccountRequestId;
    set({ errorMessage: null });

    try {
      const session = await logoutCloudAccount();
      if (requestId !== latestAccountRequestId) return;

      const projection = projectAccountSession(session, get());
      set(projection);
      if (projection.status === 'signedOut') {
        const { useSubscriptionStore } = await import('./subscription');
        useSubscriptionStore.getState().clear();
      }
    } catch (error) {
      if (requestId !== latestAccountRequestId) return;
      set({ errorMessage: messageFromError(error) });
    }
  },

  loadPublicSettings: async () => {
    const requestId = ++latestPublicSettingsRequestId;

    try {
      const publicSettings = await fetchPublicCloudSettings();
      if (requestId !== latestPublicSettingsRequestId) return;

      set({ publicSettings, errorMessage: null });
    } catch (error) {
      if (requestId !== latestPublicSettingsRequestId) return;
      set({ errorMessage: messageFromError(error) });
    }
  },

  clearError: () => {
    if (!get().errorMessage) return;
    set({ errorMessage: null });
  },
}));
