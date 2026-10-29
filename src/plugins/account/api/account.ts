import { hostApiFetch } from '@/lib/host-api';

export type CloudUserRole = 'admin' | 'user';
export type CloudUserStatus = 'active' | 'disabled';
export type CloudRunMode = 'standard' | 'simple';

export type CloudUser = Readonly<{
  id: number;
  username: string;
  name?: string | null;
  email: string;
  avatarUrl?: string | null;
  role: CloudUserRole;
  balance: number;
  frozenBalance?: number;
  concurrency: number;
  rpmLimit?: number;
  status: CloudUserStatus;
  allowedGroups: number[] | null;
  balanceNotifyEnabled: boolean;
  balanceNotifyThreshold: number | null;
  lastActiveAt?: string | null;
  createdAt: string;
  updatedAt: string;
  runMode?: CloudRunMode;
}>;

export type AccountSubscriptionProjection = Readonly<{
  planId: number | null;
  planName?: string | null;
  status: 'none' | 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired' | 'revoked' | 'suspended' | string;
  currentPeriodEnd?: string | null;
}>;

export type AccountUsageProjection = Readonly<{
  used: number;
  limit: number | null;
  unit: string;
  resetAt?: string | null;
}>;

export type PlatformQuotaProjection = Readonly<{
  id: string;
  name: string;
  used: number;
  limit: number | null;
  unit: string;
  resetAt?: string | null;
}>;

export type AccountSessionState =
  | { status: 'checking' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; user: CloudUser; expiresAt: number | null }
  | { status: 'requires2fa'; challengeId: string; email?: string }
  | { status: 'offline'; message?: string };

export type AccountSessionProjection = Readonly<{
  state: AccountSessionState;
  user: CloudUser | null;
  expiresAt: number | null;
  subscription?: AccountSubscriptionProjection | null;
  usage?: AccountUsageProjection | null;
  platformQuotas?: PlatformQuotaProjection[] | null;
}>;

export type PublicCloudSettings = Readonly<{
  registrationEnabled: boolean;
  emailVerifyEnabled: boolean;
  forceEmailOnThirdPartySignup: boolean;
  registrationEmailSuffixWhitelist: string[];
  registrationEmailDomainQuotaEnabled?: boolean;
  promoCodeEnabled: boolean;
  passwordResetEnabled: boolean;
  invitationCodeEnabled: boolean;
  loginAgreementEnabled?: boolean;
  loginAgreementMode?: string;
  loginAgreementUpdatedAt?: string;
  loginAgreementRevision?: string;
  turnstileEnabled: boolean;
  turnstileSiteKey: string;
  tencentCaptchaEnabled?: boolean;
  tencentCaptchaAppId?: string;
  tencentCaptchaRegion?: string;
  aliyunCaptchaEnabled?: boolean;
  aliyunCaptchaSceneId?: string;
  aliyunCaptchaPrefix?: string;
  aliyunCaptchaRegion?: string;
  passkeyEnabled?: boolean;
  siteName: string;
  siteLogo: string;
  siteSubtitle: string;
  contactInfo: string;
  docUrl: string;
  homeContent: string;
  compactHomeEnabled: boolean;
  paymentEnabled: boolean;
  linuxdoOauthEnabled: boolean;
  dingtalkOauthEnabled?: boolean;
  wechatOauthEnabled: boolean;
  wechatOauthOpenEnabled?: boolean;
  wechatOauthMpEnabled?: boolean;
  wechatOauthMobileEnabled?: boolean;
  oidcOauthEnabled: boolean;
  oidcOauthProviderName: string;
  githubOauthEnabled: boolean;
  googleOauthEnabled: boolean;
  serviceQuotaEnabled: boolean;
  affiliateEnabled: boolean;
  channelMonitorShowQuota?: boolean;
  version: string;
}>;

export type LoginRequest = Readonly<{
  email: string;
  password: string;
  turnstileToken?: string;
  tencentCaptchaTicket?: string;
  tencentCaptchaRandstr?: string;
}>;

export type RegisterRequest = LoginRequest & Readonly<{
  name?: string;
  verifyCode?: string;
  promoCode?: string;
  invitationCode?: string;
  affCode?: string;
}>;

export type LoginResult =
  | { status: 'signedIn'; session: AccountSessionProjection }
  | { status: 'requires2fa'; challengeId: string; email?: string }
  | { status: 'offline'; message?: string };

export type Login2FARequest = Readonly<{
  challengeId: string;
  code: string;
}>;

export type SendVerifyCodeRequest = Readonly<{
  email: string;
  turnstileToken?: string;
  tencentCaptchaTicket?: string;
  tencentCaptchaRandstr?: string;
}>;

export type SendVerifyCodeResult = Readonly<{
  message: string;
  countdown: number;
}>;

type AccountRouteSessionProjection = Readonly<
  | { state: 'anonymous' }
  | {
    state: 'authenticated';
    user: CloudUser;
    expiresAt: number | null;
  }
>;

type AccountLoginAuthenticatedResponse = Readonly<{
  user: CloudUser;
  expiresAt: number | null;
}>;

type AccountLoginRequires2FAResponse = Readonly<{
  state: 'requires2FA';
  tempToken: string;
  userEmailMasked?: string;
}>;

type AccountLoginResponse = AccountLoginAuthenticatedResponse | AccountLoginRequires2FAResponse;

function isAccountLoginRequires2FA(result: AccountLoginResponse): result is AccountLoginRequires2FAResponse {
  return 'state' in result && result.state === 'requires2FA';
}

function projectRouteSession(session: AccountRouteSessionProjection): AccountSessionProjection {
  if (session.state === 'authenticated') {
    return projectSignedInSession(session.user, session.expiresAt);
  }
  return { state: { status: 'signedOut' }, user: null, expiresAt: null };
}

function projectSignedInSession(user: CloudUser, expiresAt: number | null): AccountSessionProjection {
  return {
    state: { status: 'signedIn', user, expiresAt },
    user,
    expiresAt,
  };
}

function projectRouteLoginResult(session: AccountRouteSessionProjection): LoginResult {
  if (session.state === 'authenticated') {
    return { status: 'signedIn', session: projectSignedInSession(session.user, session.expiresAt) };
  }
  return { status: 'offline', message: 'Cloud account session is not authenticated' };
}

function projectLoginResponse(result: AccountLoginResponse): LoginResult {
  if (isAccountLoginRequires2FA(result)) {
    return {
      status: 'requires2fa',
      challengeId: result.tempToken,
      ...(result.userEmailMasked ? { email: result.userEmailMasked } : {}),
    };
  }
  return { status: 'signedIn', session: projectSignedInSession(result.user, result.expiresAt) };
}

export async function fetchPublicCloudSettings(): Promise<PublicCloudSettings> {
  return await hostApiFetch<PublicCloudSettings>('/api/account/public-settings');
}

export async function fetchAccountSession(): Promise<AccountSessionProjection> {
  return projectRouteSession(await hostApiFetch<AccountRouteSessionProjection>('/api/account/session'));
}

export async function loginCloudAccount(request: LoginRequest): Promise<LoginResult> {
  return projectLoginResponse(await hostApiFetch<AccountLoginResponse>('/api/account/login', {
    method: 'POST',
    body: JSON.stringify(request),
  }));
}

export async function loginCloudAccount2FA(request: Login2FARequest): Promise<LoginResult> {
  return projectRouteLoginResult(await hostApiFetch<AccountRouteSessionProjection>('/api/account/login/2fa', {
    method: 'POST',
    body: JSON.stringify({ tempToken: request.challengeId, code: request.code }),
  }));
}

export async function registerCloudAccount(request: RegisterRequest): Promise<LoginResult> {
  return projectRouteLoginResult(await hostApiFetch<AccountRouteSessionProjection>('/api/account/register', {
    method: 'POST',
    body: JSON.stringify(request),
  }));
}

export async function sendCloudAccountVerifyCode(request: SendVerifyCodeRequest): Promise<SendVerifyCodeResult> {
  return await hostApiFetch<SendVerifyCodeResult>('/api/account/send-verify-code', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export async function refreshCloudAccountSession(): Promise<AccountSessionProjection> {
  return projectRouteSession(await hostApiFetch<AccountRouteSessionProjection>('/api/account/refresh', {
    method: 'POST',
  }));
}

export async function logoutCloudAccount(): Promise<AccountSessionProjection> {
  await hostApiFetch<{ success: true }>('/api/account/logout', {
    method: 'POST',
  });
  return { state: { status: 'signedOut' }, user: null, expiresAt: null };
}
