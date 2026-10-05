import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type {
  AuthLogin2FARequest,
  AuthLoginRequest,
  AuthLoginResult,
  AuthRegisterRequest,
  AuthSendVerifyCodeRequest,
  AuthSendVerifyCodeResult,
  AuthTokenResult,
  BillingCheckoutInfo,
  BillingMethodLimit,
  BillingPlan,
  CloudClientBootstrap,
  CloudClientConfig,
  CloudSealedCloudKey,
  CloudPackageAuthorization,
  CloudPackageAuthorizationRequest,
  CloudPackageEnvelope,
  CloudPackageDownloadRequest,
  CloudPackageListPage,
  CloudPackageListQuery,
  CloudPackageLocalDownload,
  CloudPackageVersion,
  CloudUser,
  CreatePaymentOrderRequest,
  CreatePaymentOrderResult,
  PaymentOrder,
  PlatformQuota,
  PublicCloudSettings,
  SubscriptionProgress,
  SubscriptionQuotaProgress,
  SubscriptionSummary,
  UserSubscription,
} from './types';

const DEFAULT_CLOUD_BASE_URL = 'http://localhost:8999/api/v1';
const REQUEST_TIMEOUT_MS = 30_000;

type HttpMethod = 'GET' | 'POST';

type CloudEnvelope<T> = Readonly<{
  code: number | string;
  message: string;
  reason?: string;
  metadata?: Record<string, string>;
  data?: T;
}>;

type CloudRequestOptions = Readonly<{
  method?: HttpMethod;
  token?: string;
  body?: unknown;
}>;

export class CloudAccountClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | string,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'CloudAccountClientError';
  }
}

export type CloudPackageUpload = string | Readonly<{ fileName: string; packageBytes: Uint8Array<ArrayBuffer> }>;

export type CloudAccountClient = Readonly<{
  fetchPublicSettings(): Promise<PublicCloudSettings>;
  login(request: AuthLoginRequest): Promise<AuthLoginResult>;
  login2FA(request: AuthLogin2FARequest): Promise<AuthTokenResult>;
  register(request: AuthRegisterRequest): Promise<AuthTokenResult>;
  sendVerifyCode(request: AuthSendVerifyCodeRequest): Promise<AuthSendVerifyCodeResult>;
  refresh(refreshToken: string): Promise<Omit<AuthTokenResult, 'user'>>;
  logout(refreshToken: string): Promise<void>;
  fetchProfile(token: string): Promise<CloudUser>;
  fetchClientBootstrap(token: string): Promise<CloudClientBootstrap>;
  fetchCheckoutInfo(token: string): Promise<BillingCheckoutInfo>;
  fetchPlans(token: string): Promise<BillingPlan[]>;
  createPaymentOrder(token: string, request: CreatePaymentOrderRequest): Promise<CreatePaymentOrderResult>;
  verifyPaymentOrder(token: string, outTradeNo: string): Promise<PaymentOrder>;
  fetchPaymentOrder(token: string, orderId: number): Promise<PaymentOrder>;
  fetchSubscriptionSummary(token: string): Promise<SubscriptionSummary>;
  fetchActiveSubscriptions(token: string): Promise<UserSubscription[]>;
  fetchSubscriptionProgress(token: string): Promise<SubscriptionProgress[]>;
  fetchPlatformQuotas(token: string): Promise<PlatformQuota[]>;
  listOwnedPackages(token: string, query: CloudPackageListQuery): Promise<CloudPackageListPage>;
  listMarketPackages(token: string, query: CloudPackageListQuery): Promise<CloudPackageListPage>;
  fetchSealedCloudKey(token: string): Promise<CloudSealedCloudKey>;
  uploadPackage(token: string, upload: CloudPackageUpload): Promise<CloudPackageVersion>;
  publishPackage(token: string, packageVersionId: string): Promise<CloudPackageVersion>;
  authorizePackage(token: string, request: CloudPackageAuthorizationRequest): Promise<CloudPackageAuthorization>;
  downloadPackage(token: string, request: CloudPackageDownloadRequest): Promise<CloudPackageLocalDownload>;
}>;

export function createCloudAccountClient(): CloudAccountClient {
  return {
    fetchPublicSettings: () => requestCloud<unknown>('/settings/public').then(toPublicCloudSettings),
    login: (request) => requestCloud<unknown>('/auth/login', {
      method: 'POST',
      body: toLoginPayload(request),
    }).then(toAuthLoginResult),
    login2FA: (request) => requestCloud<unknown>('/auth/login/2fa', {
      method: 'POST',
      body: toLogin2FAPayload(request),
    }).then(toAuthTokenResult),
    register: (request) => requestCloud<unknown>('/auth/register', {
      method: 'POST',
      body: toRegisterPayload(request),
    }).then(toAuthTokenResult),
    sendVerifyCode: (request) => requestCloud<unknown>('/auth/send-verify-code', {
      method: 'POST',
      body: toSendVerifyCodePayload(request),
    }).then(toSendVerifyCodeResult),
    refresh: (refreshToken) => requestCloud<unknown>('/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    }).then(toRefreshTokenResult),
    logout: async (refreshToken) => {
      await requestCloud<unknown>('/auth/logout', {
        method: 'POST',
        body: { refresh_token: refreshToken },
      });
    },
    fetchProfile: (token) => requestCloud<unknown>('/auth/me', { token }).then(toCloudUser),
    fetchClientBootstrap: (token) => requestCloud<unknown>('/client/bootstrap', { token }).then(toCloudClientBootstrap),
    fetchCheckoutInfo: (token) => requestCloud<unknown>('/payment/checkout-info', { token }).then(toBillingCheckoutInfo),
    fetchPlans: (token) => requestCloud<unknown[]>('/payment/plans', { token }).then((items) => items.map(toBillingPlan)),
    createPaymentOrder: (token, request) => requestCloud<unknown>('/payment/orders', {
      method: 'POST',
      token,
      body: toCreatePaymentOrderPayload(request),
    }).then(toCreatePaymentOrderResult),
    verifyPaymentOrder: (token, outTradeNo) => requestCloud<unknown>('/payment/orders/verify', {
      method: 'POST',
      token,
      body: { out_trade_no: outTradeNo },
    }).then(toPaymentOrder),
    fetchPaymentOrder: (token, orderId) => requestCloud<unknown>(`/payment/orders/${orderId}`, { token }).then(toPaymentOrder),
    fetchSubscriptionSummary: (token) => requestCloud<unknown>('/subscriptions/summary', { token }).then(toSubscriptionSummary),
    fetchActiveSubscriptions: (token) => requestCloud<unknown[]>('/subscriptions/active', { token }).then((items) => items.map(toUserSubscription)),
    fetchSubscriptionProgress: (token) => requestCloud<unknown[]>('/subscriptions/progress', { token }).then((items) => items.map(toSubscriptionProgressInfo)),
    fetchPlatformQuotas: (token) => requestCloud<unknown>('/user/platform-quotas', { token }).then(toPlatformQuotas),
    listOwnedPackages: (token, query) => requestCloud<unknown>(`/packages/mine${packageListSearch(query)}`, { token }).then(toCloudPackageListPage),
    listMarketPackages: (token, query) => requestCloud<unknown>(`/packages/market${packageListSearch(query)}`, { token }).then(toCloudPackageListPage),
    fetchSealedCloudKey: (token) => requestCloud<unknown>('/packages/sealed-cloud-key', { token }).then(toCloudSealedCloudKey),
    uploadPackage: (token, upload) => uploadCloudPackage(token, upload).then(toCloudPackageVersion),
    publishPackage: (token, packageVersionId) => requestCloud<unknown>(`/packages/${encodeURIComponent(packageVersionId)}/publish`, {
      method: 'POST', token,
    }).then(toCloudPackageVersion),
    authorizePackage: (token, request) => requestCloud<unknown>(`/packages/${encodeURIComponent(request.packageVersionId)}/authorization`, {
      method: 'POST',
      token,
      body: toPackageAuthorizationPayload(request),
    }).then(toCloudPackageAuthorization),
    downloadPackage: (token, request) => downloadCloudPackage(token, request),
  };
}

async function uploadCloudPackage(token: string, upload: CloudPackageUpload): Promise<unknown> {
  const filename = typeof upload === 'string' ? basename(upload) : upload.fileName;
  const bytes = typeof upload === 'string' ? await readFile(upload) : upload.packageBytes;
  const form = new FormData();
  form.set('package', new Blob([bytes]), filename);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${cloudBaseUrl()}/packages/upload`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: form,
    });
    const payload = await readEnvelope<unknown>(response);
    if (!response.ok || payload.code !== 0) {
      throw new CloudAccountClientError(
        response.status,
        payload.code ?? response.status,
        payload.message || `Cloud package upload failed with HTTP ${response.status}`,
        payload.reason,
      );
    }
    return payload.data;
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadCloudPackage(token: string, request: CloudPackageDownloadRequest): Promise<CloudPackageLocalDownload> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${cloudBaseUrl()}/packages/${encodeURIComponent(request.packageVersionId)}/download`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/octet-stream',
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      const payload = await readEnvelope<unknown>(response);
      throw new CloudAccountClientError(
        response.status,
        payload.code ?? response.status,
        payload.message || `Cloud package download failed with HTTP ${response.status}`,
        payload.reason,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const filename = downloadFilename(response, request);
    const packagePath = await packageDownloadPath(request.destinationPath, filename);
    await mkdir(dirname(packagePath), { recursive: true });
    await writeFile(packagePath, bytes);
    return {
      packagePath,
      packageVersionId: request.packageVersionId,
      filename,
      ...(response.headers.get('content-type') ? { contentType: response.headers.get('content-type') ?? undefined } : {}),
      bytes: bytes.length,
      packageSha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function packageDownloadPath(destinationPath: string | undefined, filename: string): Promise<string> {
  if (destinationPath?.trim()) return destinationPath.trim();
  const directory = await mkdtemp(join(tmpdir(), 'matcha-package-'));
  return join(directory, filename);
}

function downloadFilename(response: Response, request: CloudPackageDownloadRequest): string {
  const headerFilename = filenameFromContentDisposition(response.headers.get('content-disposition'));
  const filename = headerFilename || request.filename?.trim() || `${request.packageVersionId}${packageExtension(request.packageType)}`;
  return basename(filename);
}

function filenameFromContentDisposition(value: string | null): string | undefined {
  const encoded = value?.match(/(?:^|;)\s*filename\*=utf-8'[^']*'([^;]+)/i)?.[1];
  if (encoded) return basename(decodeURIComponent(encoded.trim()));
  const match = value?.match(/filename=(?:"([^"]+)"|([^;]+))/i);
  const filename = (match?.[1] || match?.[2])?.trim();
  return filename ? basename(filename) : undefined;
}

function packageExtension(packageType: string | undefined): string {
  const normalized = packageType?.trim().toLowerCase();
  if (normalized === 'agent') return '.matcha-agentpkg';
  return '.matcha-skillpkg';
}

async function requestCloud<T>(path: string, options: CloudRequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${cloudBaseUrl()}${path}`, {
      method: options.method ?? 'GET',
      signal: controller.signal,
      headers: requestHeaders(options),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const payload = await readEnvelope<T>(response);
    if (!response.ok || payload.code !== 0) {
      throw new CloudAccountClientError(
        response.status,
        payload.code ?? response.status,
        payload.message || `Cloud account request failed with HTTP ${response.status}`,
        payload.reason,
      );
    }
    return payload.data as T;
  } finally {
    clearTimeout(timeout);
  }
}

function requestHeaders(options: CloudRequestOptions): Record<string, string> {
  return {
    Accept: 'application/json',
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
  };
}

async function readEnvelope<T>(response: Response): Promise<CloudEnvelope<T>> {
  try {
    const value: unknown = await response.json();
    if (isRecord(value) && (typeof value.code === 'number' || typeof value.code === 'string')) return value as CloudEnvelope<T>;
    return { code: response.ok ? 0 : response.status, message: response.statusText, data: value as T };
  } catch {
    return { code: response.ok ? 0 : response.status, message: response.statusText };
  }
}

function cloudBaseUrl(): string {
  return (process.env.MATCHA_CLOUD_BASE_URL?.trim() || DEFAULT_CLOUD_BASE_URL).replace(/\/+$/, '');
}

function toLoginPayload(request: AuthLoginRequest): Record<string, unknown> {
  return compactObject({
    email: request.email,
    password: request.password,
    turnstile_token: request.turnstileToken,
    tencent_captcha_ticket: request.tencentCaptchaTicket,
    tencent_captcha_randstr: request.tencentCaptchaRandstr,
  });
}

function toRegisterPayload(request: AuthRegisterRequest): Record<string, unknown> {
  return compactObject({
    email: request.email,
    password: request.password,
    verify_code: request.verifyCode,
    turnstile_token: request.turnstileToken,
    tencent_captcha_ticket: request.tencentCaptchaTicket,
    tencent_captcha_randstr: request.tencentCaptchaRandstr,
    promo_code: request.promoCode,
    invitation_code: request.invitationCode,
    aff_code: request.affCode,
  });
}

function toSendVerifyCodePayload(request: AuthSendVerifyCodeRequest): Record<string, unknown> {
  return compactObject({
    email: request.email,
    turnstile_token: request.turnstileToken,
    tencent_captcha_ticket: request.tencentCaptchaTicket,
    tencent_captcha_randstr: request.tencentCaptchaRandstr,
  });
}

function toLogin2FAPayload(request: AuthLogin2FARequest): Record<string, unknown> {
  return {
    temp_token: request.tempToken,
    totp_code: request.totpCode,
  };
}

function toCreatePaymentOrderPayload(request: CreatePaymentOrderRequest): Record<string, unknown> {
  return compactObject({
    amount: request.amount,
    payment_type: request.paymentType,
    order_type: request.orderType,
    plan_id: request.planId,
    return_url: request.returnUrl,
    payment_source: request.paymentSource,
    openid: request.openid,
    wechat_resume_token: request.wechatResumeToken,
    is_mobile: request.isMobile,
  });
}

function toAuthLoginResult(value: unknown): AuthLoginResult {
  const record = requireRecord(value, 'Cloud account login response is invalid');
  if (record.requires_2fa === true) {
    return {
      state: 'requires2FA',
      tempToken: requireString(record.temp_token, 'Cloud account 2FA token is invalid'),
      ...(typeof record.user_email_masked === 'string' ? { userEmailMasked: record.user_email_masked } : {}),
    };
  }
  return toAuthTokenResult(value);
}

function toSendVerifyCodeResult(value: unknown): AuthSendVerifyCodeResult {
  const record = requireRecord(value, 'Cloud account verify code response is invalid');
  return {
    message: typeof record.message === 'string' ? record.message : '',
    countdown: requireNumber(record.countdown, 'Cloud account verify code countdown is invalid'),
  };
}

function toAuthTokenResult(value: unknown): AuthTokenResult {
  const record = requireRecord(value, 'Cloud account auth response is invalid');
  const expiresIn = optionalNumber(record.expires_in);
  return {
    accessToken: requireString(record.access_token, 'Cloud account access token is invalid'),
    ...(typeof record.refresh_token === 'string' ? { refreshToken: record.refresh_token } : {}),
    ...(expiresIn === undefined ? {} : { expiresIn }),
    expiresAt: expiresIn === undefined ? null : Date.now() + expiresIn * 1000,
    tokenType: typeof record.token_type === 'string' ? record.token_type : 'Bearer',
    user: toCloudUser(record.user),
  };
}

function toRefreshTokenResult(value: unknown): Omit<AuthTokenResult, 'user'> {
  const record = requireRecord(value, 'Cloud account refresh response is invalid');
  const expiresIn = requireNumber(record.expires_in, 'Cloud account token expiry is invalid');
  return {
    accessToken: requireString(record.access_token, 'Cloud account access token is invalid'),
    refreshToken: requireString(record.refresh_token, 'Cloud account refresh token is invalid'),
    expiresIn,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: typeof record.token_type === 'string' ? record.token_type : 'Bearer',
  };
}

function toCloudUser(value: unknown): CloudUser {
  const record = requireRecord(value, 'Cloud user response is invalid');
  return {
    id: requireNumber(record.id, 'Cloud user id is invalid'),
    username: requireString(record.username, 'Cloud username is invalid'),
    email: requireString(record.email, 'Cloud email is invalid'),
    ...(typeof record.avatar_url === 'string' || record.avatar_url === null ? { avatarUrl: record.avatar_url } : {}),
    role: record.role === 'admin' ? 'admin' : 'user',
    balance: requireNumber(record.balance, 'Cloud user balance is invalid'),
    ...(typeof record.frozen_balance === 'number' ? { frozenBalance: record.frozen_balance } : {}),
    concurrency: requireNumber(record.concurrency, 'Cloud user concurrency is invalid'),
    ...(typeof record.rpm_limit === 'number' ? { rpmLimit: record.rpm_limit } : {}),
    status: record.status === 'disabled' ? 'disabled' : 'active',
    allowedGroups: Array.isArray(record.allowed_groups) ? record.allowed_groups.filter(isNumber) : null,
    balanceNotifyEnabled: record.balance_notify_enabled === true,
    balanceNotifyThreshold: typeof record.balance_notify_threshold === 'number' ? record.balance_notify_threshold : null,
    ...(typeof record.last_active_at === 'string' || record.last_active_at === null ? { lastActiveAt: record.last_active_at } : {}),
    createdAt: requireString(record.created_at, 'Cloud user created time is invalid'),
    updatedAt: requireString(record.updated_at, 'Cloud user updated time is invalid'),
    ...(record.run_mode === 'standard' || record.run_mode === 'simple' ? { runMode: record.run_mode } : {}),
  };
}

function toCloudClientBootstrap(value: unknown): CloudClientBootstrap {
  const record = requireRecord(value, 'Cloud client bootstrap response is invalid');
  const apiKey = record.api_key === null || record.api_key === undefined
    ? null
    : toCloudClientBootstrapApiKey(record.api_key);
  return {
    schemaVersion: requireNumber(record.schema_version, 'Cloud client bootstrap schema version is invalid'),
    ready: record.ready === true,
    needsSetup: record.needs_setup === true,
    ...(typeof record.setup_reason === 'string' ? { setupReason: record.setup_reason } : {}),
    baseUrl: requireString(record.base_url, 'Cloud client bootstrap base URL is invalid'),
    rootUrl: requireString(record.root_url, 'Cloud client bootstrap root URL is invalid'),
    apiKey,
    clients: toCloudClientConfigs(record.clients),
  };
}

function toCloudClientBootstrapApiKey(value: unknown): NonNullable<CloudClientBootstrap['apiKey']> {
  const record = requireRecord(value, 'Cloud client bootstrap API key is invalid');
  return {
    key: requireString(record.key, 'Cloud client bootstrap API key is invalid'),
    status: requireString(record.status, 'Cloud client bootstrap API key status is invalid'),
  };
}

function toCloudClientConfigs(value: unknown): Record<string, CloudClientConfig> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toCloudClientConfig(item)]));
}

function toCloudClientConfig(value: unknown): CloudClientConfig {
  const record = requireRecord(value, 'Cloud client config is invalid');
  return {
    baseUrl: requireString(record.base_url, 'Cloud client config base URL is invalid'),
    ...(typeof record.api_key === 'string' ? { apiKey: record.api_key } : {}),
    ...(typeof record.models_url === 'string' ? { modelsUrl: record.models_url } : {}),
    ...(typeof record.messages_url === 'string' ? { messagesUrl: record.messages_url } : {}),
  };
}

function toPublicCloudSettings(value: unknown): PublicCloudSettings {
  const record = requireRecord(value, 'Cloud settings response is invalid');
  return {
    registrationEnabled: record.registration_enabled === true,
    emailVerifyEnabled: record.email_verify_enabled === true,
    forceEmailOnThirdPartySignup: record.force_email_on_third_party_signup === true,
    registrationEmailSuffixWhitelist: stringArray(record.registration_email_suffix_whitelist),
    ...(typeof record.registration_email_domain_quota_enabled === 'boolean' ? { registrationEmailDomainQuotaEnabled: record.registration_email_domain_quota_enabled } : {}),
    promoCodeEnabled: record.promo_code_enabled === true,
    passwordResetEnabled: record.password_reset_enabled === true,
    invitationCodeEnabled: record.invitation_code_enabled === true,
    ...(typeof record.login_agreement_enabled === 'boolean' ? { loginAgreementEnabled: record.login_agreement_enabled } : {}),
    ...(typeof record.login_agreement_mode === 'string' ? { loginAgreementMode: record.login_agreement_mode } : {}),
    ...(typeof record.login_agreement_updated_at === 'string' ? { loginAgreementUpdatedAt: record.login_agreement_updated_at } : {}),
    ...(typeof record.login_agreement_revision === 'string' ? { loginAgreementRevision: record.login_agreement_revision } : {}),
    turnstileEnabled: record.turnstile_enabled === true,
    turnstileSiteKey: typeof record.turnstile_site_key === 'string' ? record.turnstile_site_key : '',
    ...(typeof record.tencent_captcha_enabled === 'boolean' ? { tencentCaptchaEnabled: record.tencent_captcha_enabled } : {}),
    ...(typeof record.tencent_captcha_app_id === 'string' ? { tencentCaptchaAppId: record.tencent_captcha_app_id } : {}),
    ...(typeof record.tencent_captcha_region === 'string' ? { tencentCaptchaRegion: record.tencent_captcha_region } : {}),
    ...(typeof record.aliyun_captcha_enabled === 'boolean' ? { aliyunCaptchaEnabled: record.aliyun_captcha_enabled } : {}),
    ...(typeof record.aliyun_captcha_scene_id === 'string' ? { aliyunCaptchaSceneId: record.aliyun_captcha_scene_id } : {}),
    ...(typeof record.aliyun_captcha_prefix === 'string' ? { aliyunCaptchaPrefix: record.aliyun_captcha_prefix } : {}),
    ...(typeof record.aliyun_captcha_region === 'string' ? { aliyunCaptchaRegion: record.aliyun_captcha_region } : {}),
    ...(typeof record.passkey_enabled === 'boolean' ? { passkeyEnabled: record.passkey_enabled } : {}),
    siteName: typeof record.site_name === 'string' ? record.site_name : '',
    siteLogo: typeof record.site_logo === 'string' ? record.site_logo : '',
    siteSubtitle: typeof record.site_subtitle === 'string' ? record.site_subtitle : '',
    contactInfo: typeof record.contact_info === 'string' ? record.contact_info : '',
    docUrl: typeof record.doc_url === 'string' ? record.doc_url : '',
    homeContent: typeof record.home_content === 'string' ? record.home_content : '',
    compactHomeEnabled: record.compact_home_enabled === true,
    paymentEnabled: record.payment_enabled === true,
    linuxdoOauthEnabled: record.linuxdo_oauth_enabled === true,
    ...(typeof record.dingtalk_oauth_enabled === 'boolean' ? { dingtalkOauthEnabled: record.dingtalk_oauth_enabled } : {}),
    wechatOauthEnabled: record.wechat_oauth_enabled === true,
    ...(typeof record.wechat_oauth_open_enabled === 'boolean' ? { wechatOauthOpenEnabled: record.wechat_oauth_open_enabled } : {}),
    ...(typeof record.wechat_oauth_mp_enabled === 'boolean' ? { wechatOauthMpEnabled: record.wechat_oauth_mp_enabled } : {}),
    ...(typeof record.wechat_oauth_mobile_enabled === 'boolean' ? { wechatOauthMobileEnabled: record.wechat_oauth_mobile_enabled } : {}),
    oidcOauthEnabled: record.oidc_oauth_enabled === true,
    oidcOauthProviderName: typeof record.oidc_oauth_provider_name === 'string' ? record.oidc_oauth_provider_name : '',
    githubOauthEnabled: record.github_oauth_enabled === true,
    googleOauthEnabled: record.google_oauth_enabled === true,
    serviceQuotaEnabled: record.service_quota_enabled === true,
    affiliateEnabled: record.affiliate_enabled === true,
    ...(typeof record.channel_monitor_show_quota === 'boolean' ? { channelMonitorShowQuota: record.channel_monitor_show_quota } : {}),
    version: typeof record.version === 'string' ? record.version : '',
  };
}

function toBillingCheckoutInfo(value: unknown): BillingCheckoutInfo {
  const record = requireRecord(value, 'Cloud billing checkout response is invalid');
  return {
    methods: toBillingMethodLimits(record.methods),
    globalMin: requireNumber(record.global_min, 'Cloud billing global minimum is invalid'),
    globalMax: requireNumber(record.global_max, 'Cloud billing global maximum is invalid'),
    plans: Array.isArray(record.plans) ? record.plans.map(toBillingPlan) : [],
    balanceDisabled: record.balance_disabled === true,
    balanceRechargeMultiplier: requireNumber(record.balance_recharge_multiplier, 'Cloud billing balance multiplier is invalid'),
    subscriptionUsdToCnyRate: requireNumber(record.subscription_usd_to_cny_rate, 'Cloud billing exchange rate is invalid'),
    rechargeFeeRate: requireNumber(record.recharge_fee_rate, 'Cloud billing recharge fee is invalid'),
    helpText: typeof record.help_text === 'string' ? record.help_text : '',
    helpImageUrl: typeof record.help_image_url === 'string' ? record.help_image_url : '',
    stripePublishableKey: typeof record.stripe_publishable_key === 'string' ? record.stripe_publishable_key : '',
    ...(typeof record.alipay_force_qrcode === 'boolean' ? { alipayForceQrcode: record.alipay_force_qrcode } : {}),
    ...(typeof record.alipay_mobile_precreate_deep_link === 'boolean' ? { alipayMobilePrecreateDeepLink: record.alipay_mobile_precreate_deep_link } : {}),
  };
}

function toBillingMethodLimits(value: unknown): Record<string, BillingMethodLimit> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toBillingMethodLimit(item)]));
}

function toBillingMethodLimit(value: unknown): BillingMethodLimit {
  const record = requireRecord(value, 'Cloud billing method limit is invalid');
  const dailyLimit = requireNumber(record.daily_limit, 'Cloud billing daily limit is invalid');
  const dailyUsed = optionalNumber(record.daily_used) ?? 0;
  return {
    ...(typeof record.currency === 'string' ? { currency: record.currency } : {}),
    ...(typeof record.display_name === 'string' ? { displayName: record.display_name } : {}),
    dailyLimit,
    dailyUsed,
    dailyRemaining: optionalNumber(record.daily_remaining) ?? (dailyLimit > 0 ? Math.max(0, dailyLimit - dailyUsed) : dailyLimit),
    singleMin: requireNumber(record.single_min, 'Cloud billing minimum is invalid'),
    singleMax: requireNumber(record.single_max, 'Cloud billing maximum is invalid'),
    feeRate: requireNumber(record.fee_rate, 'Cloud billing fee rate is invalid'),
    available: record.available !== false,
  };
}

function toBillingPlan(value: unknown): BillingPlan {
  const record = requireRecord(value, 'Cloud billing plan is invalid');
  return {
    id: requireNumber(record.id, 'Cloud billing plan id is invalid'),
    groupId: requireNumber(record.group_id, 'Cloud billing group id is invalid'),
    ...(typeof record.group_platform === 'string' ? { groupPlatform: record.group_platform } : {}),
    ...(typeof record.group_name === 'string' ? { groupName: record.group_name } : {}),
    ...(typeof record.rate_multiplier === 'number' ? { rateMultiplier: record.rate_multiplier } : {}),
    ...(typeof record.peak_rate_enabled === 'boolean' ? { peakRateEnabled: record.peak_rate_enabled } : {}),
    ...(typeof record.peak_start === 'string' ? { peakStart: record.peak_start } : {}),
    ...(typeof record.peak_end === 'string' ? { peakEnd: record.peak_end } : {}),
    ...(typeof record.peak_rate_multiplier === 'number' ? { peakRateMultiplier: record.peak_rate_multiplier } : {}),
    ...(typeof record.daily_limit_usd === 'number' || record.daily_limit_usd === null ? { dailyLimitUsd: record.daily_limit_usd } : {}),
    ...(typeof record.weekly_limit_usd === 'number' || record.weekly_limit_usd === null ? { weeklyLimitUsd: record.weekly_limit_usd } : {}),
    ...(typeof record.monthly_limit_usd === 'number' || record.monthly_limit_usd === null ? { monthlyLimitUsd: record.monthly_limit_usd } : {}),
    ...(Array.isArray(record.supported_model_scopes) ? { supportedModelScopes: stringArray(record.supported_model_scopes) } : {}),
    name: requireString(record.name, 'Cloud billing plan name is invalid'),
    description: typeof record.description === 'string' ? record.description : '',
    price: requireNumber(record.price, 'Cloud billing plan price is invalid'),
    ...(typeof record.original_price === 'number' ? { originalPrice: record.original_price } : {}),
    ...(typeof record.currency === 'string' ? { currency: record.currency } : {}),
    validityDays: requireNumber(record.validity_days, 'Cloud billing plan validity is invalid'),
    validityUnit: typeof record.validity_unit === 'string' ? record.validity_unit : '',
    features: Array.isArray(record.features) ? stringArray(record.features) : parseFeatureLines(record.features),
    ...(typeof record.product_name === 'string' ? { productName: record.product_name } : {}),
    ...(typeof record.for_sale === 'boolean' ? { forSale: record.for_sale } : {}),
    ...(typeof record.sort_order === 'number' ? { sortOrder: record.sort_order } : {}),
  };
}

function toCreatePaymentOrderResult(value: unknown): CreatePaymentOrderResult {
  const record = requireRecord(value, 'Cloud payment order result is invalid');
  return {
    orderId: requireNumber(record.order_id, 'Cloud payment order id is invalid'),
    amount: requireNumber(record.amount, 'Cloud payment amount is invalid'),
    ...(typeof record.pay_url === 'string' ? { payUrl: record.pay_url } : {}),
    ...(typeof record.qr_code === 'string' ? { qrCode: record.qr_code } : {}),
    ...(typeof record.client_secret === 'string' ? { clientSecret: record.client_secret } : {}),
    ...(typeof record.intent_id === 'string' ? { intentId: record.intent_id } : {}),
    ...(typeof record.currency === 'string' ? { currency: record.currency } : {}),
    ...(typeof record.country_code === 'string' ? { countryCode: record.country_code } : {}),
    ...(typeof record.payment_env === 'string' ? { paymentEnv: record.payment_env } : {}),
    payAmount: requireNumber(record.pay_amount, 'Cloud payment payable amount is invalid'),
    feeRate: requireNumber(record.fee_rate, 'Cloud payment fee rate is invalid'),
    expiresAt: requireString(record.expires_at, 'Cloud payment expiry is invalid'),
    ...(typeof record.result_type === 'string' ? { resultType: record.result_type } : {}),
    ...(typeof record.payment_type === 'string' ? { paymentType: record.payment_type } : {}),
    ...(typeof record.out_trade_no === 'string' ? { outTradeNo: record.out_trade_no } : {}),
    ...(typeof record.payment_mode === 'string' ? { paymentMode: record.payment_mode } : {}),
    ...(typeof record.resume_token === 'string' ? { resumeToken: record.resume_token } : {}),
    ...(typeof record.alipay_mobile_precreate_deep_link === 'boolean' ? { alipayMobilePrecreateDeepLink: record.alipay_mobile_precreate_deep_link } : {}),
    ...(isRecord(record.oauth) ? { oauth: record.oauth } : {}),
    ...(isRecord(record.jsapi) ? { jsapi: record.jsapi } : {}),
    ...(isRecord(record.jsapi_payload) ? { jsapiPayload: record.jsapi_payload } : {}),
  };
}

function toPaymentOrder(value: unknown): PaymentOrder {
  const record = requireRecord(value, 'Cloud payment order is invalid');
  return {
    id: requireNumber(record.id, 'Cloud payment order id is invalid'),
    userId: requireNumber(record.user_id, 'Cloud payment user id is invalid'),
    amount: requireNumber(record.amount, 'Cloud payment amount is invalid'),
    payAmount: requireNumber(record.pay_amount, 'Cloud payment payable amount is invalid'),
    ...(typeof record.currency === 'string' ? { currency: record.currency } : {}),
    feeRate: requireNumber(record.fee_rate, 'Cloud payment fee rate is invalid'),
    paymentType: requireString(record.payment_type, 'Cloud payment type is invalid'),
    outTradeNo: requireString(record.out_trade_no, 'Cloud payment trade number is invalid'),
    status: requireString(record.status, 'Cloud payment status is invalid'),
    orderType: requireString(record.order_type, 'Cloud payment order type is invalid'),
    createdAt: requireString(record.created_at, 'Cloud payment creation time is invalid'),
    expiresAt: requireString(record.expires_at, 'Cloud payment expiry is invalid'),
    ...(typeof record.paid_at === 'string' || record.paid_at === null ? { paidAt: record.paid_at } : {}),
    ...(typeof record.completed_at === 'string' || record.completed_at === null ? { completedAt: record.completed_at } : {}),
    refundAmount: requireNumber(record.refund_amount, 'Cloud payment refund amount is invalid'),
    ...(typeof record.refund_reason === 'string' || record.refund_reason === null ? { refundReason: record.refund_reason } : {}),
    ...(typeof record.refund_requested_at === 'string' || record.refund_requested_at === null ? { refundRequestedAt: record.refund_requested_at } : {}),
    ...(typeof record.refund_requested_by === 'string' || record.refund_requested_by === null ? { refundRequestedBy: record.refund_requested_by } : {}),
    ...(typeof record.refund_request_reason === 'string' || record.refund_request_reason === null ? { refundRequestReason: record.refund_request_reason } : {}),
    ...(typeof record.plan_id === 'number' || record.plan_id === null ? { planId: record.plan_id } : {}),
    ...(typeof record.provider_instance_id === 'string' || record.provider_instance_id === null ? { providerInstanceId: record.provider_instance_id } : {}),
  };
}

function toSubscriptionSummary(value: unknown): SubscriptionSummary {
  const record = requireRecord(value, 'Cloud subscription summary is invalid');
  return {
    activeCount: requireNumber(record.active_count, 'Cloud subscription active count is invalid'),
    ...(typeof record.total_used_usd === 'number' ? { totalUsedUsd: record.total_used_usd } : {}),
    subscriptions: Array.isArray(record.subscriptions) ? record.subscriptions.map(toSubscriptionSummaryItem) : [],
  };
}

function toSubscriptionSummaryItem(value: unknown): SubscriptionSummary['subscriptions'][number] {
  const record = requireRecord(value, 'Cloud subscription summary item is invalid');
  return {
    id: requireNumber(record.id, 'Cloud subscription id is invalid'),
    ...(typeof record.group_id === 'number' ? { groupId: record.group_id } : {}),
    groupName: typeof record.group_name === 'string' ? record.group_name : '',
    status: requireString(record.status, 'Cloud subscription status is invalid'),
    ...(typeof record.daily_progress === 'number' || record.daily_progress === null ? { dailyProgress: record.daily_progress } : {}),
    ...(typeof record.weekly_progress === 'number' || record.weekly_progress === null ? { weeklyProgress: record.weekly_progress } : {}),
    ...(typeof record.monthly_progress === 'number' || record.monthly_progress === null ? { monthlyProgress: record.monthly_progress } : {}),
    ...(typeof record.daily_used_usd === 'number' ? { dailyUsedUsd: record.daily_used_usd } : {}),
    ...(typeof record.daily_limit_usd === 'number' ? { dailyLimitUsd: record.daily_limit_usd } : {}),
    ...(typeof record.weekly_used_usd === 'number' ? { weeklyUsedUsd: record.weekly_used_usd } : {}),
    ...(typeof record.weekly_limit_usd === 'number' ? { weeklyLimitUsd: record.weekly_limit_usd } : {}),
    ...(typeof record.monthly_used_usd === 'number' ? { monthlyUsedUsd: record.monthly_used_usd } : {}),
    ...(typeof record.monthly_limit_usd === 'number' ? { monthlyLimitUsd: record.monthly_limit_usd } : {}),
    ...(typeof record.expires_at === 'string' || record.expires_at === null ? { expiresAt: record.expires_at } : {}),
    ...(typeof record.days_remaining === 'number' || record.days_remaining === null ? { daysRemaining: record.days_remaining } : {}),
  };
}

function toUserSubscription(value: unknown): UserSubscription {
  const record = requireRecord(value, 'Cloud subscription is invalid');
  return {
    id: requireNumber(record.id, 'Cloud subscription id is invalid'),
    userId: requireNumber(record.user_id, 'Cloud subscription user id is invalid'),
    groupId: requireNumber(record.group_id, 'Cloud subscription group id is invalid'),
    status: requireString(record.status, 'Cloud subscription status is invalid'),
    startsAt: requireString(record.starts_at, 'Cloud subscription start time is invalid'),
    expiresAt: typeof record.expires_at === 'string' ? record.expires_at : null,
    dailyUsageUsd: requireNumber(record.daily_usage_usd, 'Cloud subscription daily usage is invalid'),
    weeklyUsageUsd: requireNumber(record.weekly_usage_usd, 'Cloud subscription weekly usage is invalid'),
    monthlyUsageUsd: requireNumber(record.monthly_usage_usd, 'Cloud subscription monthly usage is invalid'),
    dailyWindowStart: typeof record.daily_window_start === 'string' ? record.daily_window_start : null,
    weeklyWindowStart: typeof record.weekly_window_start === 'string' ? record.weekly_window_start : null,
    monthlyWindowStart: typeof record.monthly_window_start === 'string' ? record.monthly_window_start : null,
    createdAt: requireString(record.created_at, 'Cloud subscription creation time is invalid'),
    updatedAt: requireString(record.updated_at, 'Cloud subscription update time is invalid'),
  };
}

function toSubscriptionProgressInfo(value: unknown): SubscriptionProgress {
  const record = requireRecord(value, 'Cloud subscription progress is invalid');
  if (isRecord(record.progress)) return toSubscriptionProgress(record.progress);
  return toSubscriptionProgress(record);
}

function toSubscriptionProgress(value: unknown): SubscriptionProgress {
  const record = requireRecord(value, 'Cloud subscription progress is invalid');
  return {
    subscriptionId: requireNumber(record.subscription_id ?? record.id, 'Cloud subscription progress id is invalid'),
    ...(typeof record.group_name === 'string' ? { groupName: record.group_name } : {}),
    ...(typeof record.expires_at === 'string' || record.expires_at === null ? { expiresAt: record.expires_at } : {}),
    ...(typeof record.expires_in_days === 'number' || record.expires_in_days === null ? { expiresInDays: record.expires_in_days } : {}),
    daily: toSubscriptionQuotaProgress(record.daily),
    weekly: toSubscriptionQuotaProgress(record.weekly),
    monthly: toSubscriptionQuotaProgress(record.monthly),
  };
}

function toSubscriptionQuotaProgress(value: unknown): SubscriptionQuotaProgress | null {
  if (value === null || value === undefined) return null;
  const record = requireRecord(value, 'Cloud subscription quota progress is invalid');
  return {
    used: requireNumber(record.used ?? record.used_usd, 'Cloud subscription quota usage is invalid'),
    limit: numberOrNull(record.limit ?? record.limit_usd),
    remaining: numberOrNull(record.remaining ?? record.remaining_usd),
    percentage: requireNumber(record.percentage, 'Cloud subscription quota percentage is invalid'),
    windowStart: stringOrNull(record.window_start),
    resetsAt: stringOrNull(record.resets_at),
    resetInSeconds: numberOrNull(record.reset_in_seconds ?? record.resets_in_seconds),
  };
}

function toPlatformQuotas(value: unknown): PlatformQuota[] {
  const record = requireRecord(value, 'Cloud platform quotas response is invalid');
  return Array.isArray(record.platform_quotas) ? record.platform_quotas.map(toPlatformQuota) : [];
}

function toPlatformQuota(value: unknown): PlatformQuota {
  const record = requireRecord(value, 'Cloud platform quota is invalid');
  return {
    platform: requireString(record.platform, 'Cloud platform quota name is invalid'),
    daily: {
      usedUsd: requireNumber(record.daily_usage_usd, 'Cloud platform daily usage is invalid'),
      limitUsd: numberOrNull(record.daily_limit_usd),
      resetsAt: stringOrNull(record.daily_window_resets_at),
    },
    weekly: {
      usedUsd: requireNumber(record.weekly_usage_usd, 'Cloud platform weekly usage is invalid'),
      limitUsd: numberOrNull(record.weekly_limit_usd),
      resetsAt: stringOrNull(record.weekly_window_resets_at),
    },
    monthly: {
      usedUsd: requireNumber(record.monthly_usage_usd, 'Cloud platform monthly usage is invalid'),
      limitUsd: numberOrNull(record.monthly_limit_usd),
      resetsAt: stringOrNull(record.monthly_window_resets_at),
    },
    ...(typeof record.updated_at === 'string' ? { updatedAt: record.updated_at } : {}),
  };
}

function packageListSearch(query: CloudPackageListQuery): string {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.pageSize !== undefined) params.set('page_size', String(query.pageSize));
  if (query.search) params.set('search', query.search);
  if (query.packageType) params.set('packageType', query.packageType);
  const search = params.toString();
  return search ? `?${search}` : '';
}

function toPackageAuthorizationPayload(request: CloudPackageAuthorizationRequest): Record<string, unknown> {
  return compactObject({
    packageVersionId: request.packageVersionId,
    packageType: request.packageType,
    clientVersion: request.clientVersion,
    installId: request.installId,
    source: request.source,
    devicePublicKey: request.devicePublicKey,
  });
}

function toCloudPackageListPage(value: unknown): CloudPackageListPage {
  const record = requireRecord(value, 'Cloud package list response is invalid');
  return {
    items: Array.isArray(record.items) ? record.items.map(toCloudPackageVersion) : [],
    total: requireNumber(record.total, 'Cloud package list total is invalid'),
    page: requireNumber(record.page, 'Cloud package list page is invalid'),
    pageSize: requireNumber(record.page_size, 'Cloud package list page size is invalid'),
    pages: requireNumber(record.pages, 'Cloud package list pages is invalid'),
  };
}

function toCloudSealedCloudKey(value: unknown): CloudSealedCloudKey {
  const record = requireRecord(value, 'Cloud sealed cloud key is invalid');
  const version = requireNumber(record.version, 'Cloud sealed cloud key version is invalid');
  if (version !== 1) throw new Error('Cloud sealed cloud key version is invalid');
  return {
    version: 1,
    publicKey: requireString(record.publicKey ?? record.public_key, 'Cloud sealed public key is invalid'),
    keyId: requireString(record.keyId ?? record.key_id, 'Cloud sealed key id is invalid'),
    algorithm: requireString(record.algorithm, 'Cloud sealed cloud key algorithm is invalid'),
  };
}

function toCloudPackageVersion(value: unknown): CloudPackageVersion {
  const record = requireRecord(value, 'Cloud package version is invalid');
  return {
    packageId: requireString(record.packageId, 'Cloud package id is invalid'),
    packageVersionId: requireString(record.packageVersionId, 'Cloud package version id is invalid'),
    name: requireString(record.name, 'Cloud package name is invalid'),
    ...(typeof record.displayName === 'string' ? { displayName: record.displayName } : {}),
    packageType: requireString(record.packageType, 'Cloud package type is invalid'),
    version: requireString(record.version, 'Cloud package version is invalid'),
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    status: requireString(record.status, 'Cloud package status is invalid'),
    ...(typeof record.entitlementStatus === 'string' ? { entitlementStatus: record.entitlementStatus } : {}),
    downloadable: record.downloadable === true,
    ...(isRecord(record.meteringBinding) ? { meteringBinding: toCloudPackageMeteringBinding(record.meteringBinding) } : {}),
    ...(typeof record.downloadCount === 'number' ? { downloadCount: record.downloadCount } : {}),
    ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
    ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}),
  };
}

function toCloudPackageAuthorization(value: unknown): CloudPackageAuthorization {
  const record = requireRecord(value, 'Cloud package authorization is invalid');
  const deviceEnvelope = optionalPackageEnvelope(record.deviceEnvelope ?? record.device_envelope);
  return {
    packageVersionId: requireString(record.packageVersionId ?? record.package_version_id, 'Cloud package version id is invalid'),
    packageType: requireString(record.packageType ?? record.package_type, 'Cloud package type is invalid'),
    ...(isRecord(record.meteringBinding ?? record.metering_binding) ? { meteringBinding: toCloudPackageMeteringBinding(record.meteringBinding ?? record.metering_binding) } : {}),
    ...(typeof (record.entitlementStatus ?? record.entitlement_status) === 'string' ? { entitlementStatus: (record.entitlementStatus ?? record.entitlement_status) as string } : {}),
    ...(deviceEnvelope ? { deviceEnvelope } : {}),
    leaseExpiresAt: requireString(record.leaseExpiresAt ?? record.lease_expires_at, 'Cloud package authorization lease expiry is invalid'),
  };
}

function optionalPackageEnvelope(value: unknown): CloudPackageEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...(typeof value.keyId === 'string' ? { keyId: value.keyId } : {}),
    algorithm: requireString(value.algorithm, 'Cloud package envelope algorithm is invalid'),
    ciphertextBase64: requireString(value.ciphertextBase64, 'Cloud package envelope ciphertext is invalid'),
  };
}

function toCloudPackageMeteringBinding(value: unknown): NonNullable<CloudPackageVersion['meteringBinding']> {
  const record = requireRecord(value, 'Cloud package metering binding is invalid');
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.type === 'string' ? { type: record.type } : {}),
    ...(typeof record.unit === 'string' ? { unit: record.unit } : {}),
    ...(typeof record.amount === 'number' ? { amount: record.amount } : {}),
    ...(typeof record.currency === 'string' ? { currency: record.currency } : {}),
  };
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error(message);
}

function requireString(value: unknown, message: string): string {
  if (typeof value === 'string') return value;
  throw new Error(message);
}

function requireNumber(value: unknown, message: string): number {
  if (typeof value === 'number') return value;
  throw new Error(message);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseFeatureLines(value: unknown): string[] {
  return typeof value === 'string'
    ? value.split('\n').map((item) => item.trim()).filter(Boolean)
    : [];
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}
