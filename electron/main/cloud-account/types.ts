export type JsonRecord = Record<string, unknown>;

export type CloudUserRole = 'admin' | 'user';
export type CloudUserStatus = 'active' | 'disabled';
export type CloudRunMode = 'standard' | 'simple';

export type CloudUser = Readonly<{
  id: number;
  username: string;
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

export type AccountSessionProjection = Readonly<
  | { state: 'anonymous' }
  | {
    state: 'authenticated';
    user: CloudUser;
    expiresAt: number | null;
    tokenType: string;
  }
>;

export type AuthLoginRequest = Readonly<{
  email: string;
  password: string;
  turnstileToken?: string;
  tencentCaptchaTicket?: string;
  tencentCaptchaRandstr?: string;
}>;

export type AuthRegisterRequest = Readonly<{
  email: string;
  password: string;
  verifyCode?: string;
  turnstileToken?: string;
  tencentCaptchaTicket?: string;
  tencentCaptchaRandstr?: string;
  promoCode?: string;
  invitationCode?: string;
  affCode?: string;
}>;

export type AuthLogin2FARequest = Readonly<{
  tempToken: string;
  totpCode: string;
}>;

export type AuthSendVerifyCodeRequest = Readonly<{
  email: string;
  turnstileToken?: string;
  tencentCaptchaTicket?: string;
  tencentCaptchaRandstr?: string;
}>;

export type AuthSendVerifyCodeResult = Readonly<{
  message: string;
  countdown: number;
}>;

export type AuthTokenResult = Readonly<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  expiresAt: number | null;
  tokenType: string;
  user: CloudUser;
}>;

export type AuthLoginResult = AuthTokenResult | Readonly<{
  state: 'requires2FA';
  tempToken: string;
  userEmailMasked?: string;
}>;

export type CloudClientConfig = Readonly<{
  baseUrl: string;
  apiKey?: string;
  modelsUrl?: string;
  messagesUrl?: string;
}>;

export type CloudClientBootstrap = Readonly<{
  schemaVersion: number;
  ready: boolean;
  needsSetup: boolean;
  setupReason?: string;
  baseUrl: string;
  rootUrl: string;
  apiKey: Readonly<{ key: string; status: string }> | null;
  clients: Record<string, CloudClientConfig>;
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

export type BillingMethodLimit = Readonly<{
  currency?: string;
  displayName?: string;
  dailyLimit: number;
  dailyUsed: number;
  dailyRemaining: number;
  singleMin: number;
  singleMax: number;
  feeRate: number;
  available: boolean;
}>;

export type BillingPlan = Readonly<{
  id: number;
  groupId: number;
  groupPlatform?: string;
  groupName?: string;
  rateMultiplier?: number;
  peakRateEnabled?: boolean;
  peakStart?: string;
  peakEnd?: string;
  peakRateMultiplier?: number;
  dailyLimitUsd?: number | null;
  weeklyLimitUsd?: number | null;
  monthlyLimitUsd?: number | null;
  supportedModelScopes?: string[];
  name: string;
  description: string;
  price: number;
  originalPrice?: number;
  currency?: string;
  validityDays: number;
  validityUnit: string;
  features: string[];
  productName?: string;
  forSale?: boolean;
  sortOrder?: number;
}>;

export type BillingCheckoutInfo = Readonly<{
  methods: Record<string, BillingMethodLimit>;
  globalMin: number;
  globalMax: number;
  plans: BillingPlan[];
  balanceDisabled: boolean;
  balanceRechargeMultiplier: number;
  subscriptionUsdToCnyRate: number;
  rechargeFeeRate: number;
  helpText: string;
  helpImageUrl: string;
  stripePublishableKey: string;
  alipayForceQrcode?: boolean;
  alipayMobilePrecreateDeepLink?: boolean;
}>;

export type CreatePaymentOrderRequest = Readonly<{
  amount: number;
  paymentType: string;
  orderType: 'balance' | 'subscription' | string;
  planId?: number;
  returnUrl?: string;
  paymentSource?: string;
  openid?: string;
  wechatResumeToken?: string;
  isMobile?: boolean;
}>;

export type CreatePaymentOrderResult = Readonly<{
  orderId: number;
  amount: number;
  payUrl?: string;
  qrCode?: string;
  clientSecret?: string;
  intentId?: string;
  currency?: string;
  countryCode?: string;
  paymentEnv?: string;
  payAmount: number;
  feeRate: number;
  expiresAt: string;
  resultType?: 'order_created' | 'oauth_required' | 'jsapi_ready' | string;
  paymentType?: string;
  outTradeNo?: string;
  paymentMode?: string;
  resumeToken?: string;
  alipayMobilePrecreateDeepLink?: boolean;
  oauth?: JsonRecord;
  jsapi?: JsonRecord;
  jsapiPayload?: JsonRecord;
}>;

export type PaymentOrder = Readonly<{
  id: number;
  userId: number;
  amount: number;
  payAmount: number;
  currency?: string;
  feeRate: number;
  paymentType: string;
  outTradeNo: string;
  status: string;
  orderType: string;
  createdAt: string;
  expiresAt: string;
  paidAt?: string | null;
  completedAt?: string | null;
  refundAmount: number;
  refundReason?: string | null;
  refundRequestedAt?: string | null;
  refundRequestedBy?: string | null;
  refundRequestReason?: string | null;
  planId?: number | null;
  providerInstanceId?: string | null;
}>;

export type SubscriptionQuotaProgress = Readonly<{
  used: number;
  limit: number | null;
  remaining: number | null;
  percentage: number;
  windowStart: string | null;
  resetsAt: string | null;
  resetInSeconds: number | null;
}>;

export type SubscriptionProgress = Readonly<{
  subscriptionId: number;
  groupName?: string;
  expiresAt?: string | null;
  expiresInDays?: number | null;
  daily: SubscriptionQuotaProgress | null;
  weekly: SubscriptionQuotaProgress | null;
  monthly: SubscriptionQuotaProgress | null;
}>;

export type UserSubscription = Readonly<{
  id: number;
  userId: number;
  groupId: number;
  status: 'active' | 'expired' | 'revoked' | 'suspended' | string;
  startsAt: string;
  expiresAt: string | null;
  dailyUsageUsd: number;
  weeklyUsageUsd: number;
  monthlyUsageUsd: number;
  dailyWindowStart: string | null;
  weeklyWindowStart: string | null;
  monthlyWindowStart: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type SubscriptionSummary = Readonly<{
  activeCount: number;
  totalUsedUsd?: number;
  subscriptions: Array<Readonly<{
    id: number;
    groupId?: number;
    groupName: string;
    status: string;
    dailyProgress?: number | null;
    weeklyProgress?: number | null;
    monthlyProgress?: number | null;
    dailyUsedUsd?: number;
    dailyLimitUsd?: number;
    weeklyUsedUsd?: number;
    weeklyLimitUsd?: number;
    monthlyUsedUsd?: number;
    monthlyLimitUsd?: number;
    expiresAt?: string | null;
    daysRemaining?: number | null;
  }>>;
}>;

export type PlatformQuotaWindow = Readonly<{
  usedUsd: number;
  limitUsd: number | null;
  resetsAt: string | null;
}>;

export type PlatformQuota = Readonly<{
  platform: string;
  daily: PlatformQuotaWindow;
  weekly: PlatformQuotaWindow;
  monthly: PlatformQuotaWindow;
  updatedAt?: string;
}>;

export type CloudPackageListQuery = Readonly<{
  page?: number;
  pageSize?: number;
  search?: string;
  packageType?: string;
}>;

export type CloudPackageMeteringBinding = Readonly<{
  id?: string;
  type?: string;
  unit?: string;
  amount?: number;
  currency?: string;
}>;

export type CloudPackageVersion = Readonly<{
  packageId: string;
  packageVersionId: string;
  name: string;
  displayName?: string;
  packageType: string;
  version: string;
  description?: string;
  status: string;
  entitlementStatus?: string;
  downloadable: boolean;
  meteringBinding?: CloudPackageMeteringBinding;
  downloadCount?: number;
  createdAt?: string;
  updatedAt?: string;
}>;

export type CloudPackageListPage = Readonly<{
  items: CloudPackageVersion[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}>;

export type CloudPackageDownloadRequest = Readonly<{
  packageVersionId: string;
  destinationPath?: string;
  packageType?: string;
  filename?: string;
  clientVersion?: string;
  installId?: string;
  source?: string;
}>;

export type CloudPackageDownloadRecordRequest = Readonly<{
  packageVersionId: string;
  clientVersion?: string;
  installId?: string;
  source?: string;
}>;

export type CloudPackageDownloadRecord = Readonly<{
  packageVersionId: string;
  meteringBinding?: CloudPackageMeteringBinding;
  entitlementStatus?: string;
  recorded: boolean;
  recordedAt?: string;
}>;

export type CloudPackageLocalDownload = Readonly<{
  packagePath: string;
  packageVersionId: string;
  filename: string;
  contentType?: string;
  bytes: number;
  meteringBinding?: CloudPackageMeteringBinding;
  entitlementStatus?: string;
  recorded?: boolean;
  recordedAt?: string;
}>;
