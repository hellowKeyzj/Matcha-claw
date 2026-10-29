import { hostApiFetch } from '@/lib/host-api';

export type JsonRecord = Record<string, unknown>;

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

export type PaymentOrderResult = Readonly<{
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

export type VerifyBillingOrderRequest = Readonly<{
  outTradeNo: string;
}>;

export async function fetchBillingCheckoutInfo(): Promise<BillingCheckoutInfo> {
  return await hostApiFetch<BillingCheckoutInfo>('/api/billing/checkout-info');
}

export async function fetchBillingPlans(): Promise<BillingPlan[]> {
  return await hostApiFetch<BillingPlan[]>('/api/billing/plans');
}

export async function createBillingOrder(request: CreatePaymentOrderRequest): Promise<PaymentOrderResult> {
  return await hostApiFetch<PaymentOrderResult>('/api/billing/orders', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export async function verifyBillingOrder(request: VerifyBillingOrderRequest): Promise<PaymentOrder> {
  return await hostApiFetch<PaymentOrder>('/api/billing/orders/verify', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export async function fetchBillingOrder(orderId: number | string): Promise<PaymentOrder> {
  return await hostApiFetch<PaymentOrder>(`/api/billing/orders/${encodeURIComponent(String(orderId))}`);
}
