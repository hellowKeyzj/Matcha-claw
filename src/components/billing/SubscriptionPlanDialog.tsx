import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Check, Copy, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  createBillingOrder,
  fetchBillingCheckoutInfo,
  fetchBillingOrder,
  verifyBillingOrder,
  type BillingCheckoutInfo,
  type BillingMethodLimit,
  type BillingPlan,
  type PaymentOrder,
  type PaymentOrderResult,
} from '@/lib/billing';
import type { PlatformQuota, SubscriptionProgress, SubscriptionQuotaProgress, SubscriptionSummary } from '@/lib/subscription';
import { cn } from '@/lib/utils';
import { useSubscriptionStore } from '@/stores/subscription';
import { useTranslation } from 'react-i18next';

export interface SubscriptionPlanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type BillingLoadStatus = 'idle' | 'loading' | 'ready' | 'error';
type SubscriptionDialogTab = 'current' | 'checkout';

type BillingMethodOption = Readonly<{
  id: string;
  limit: BillingMethodLimit;
}>;

type ActiveBillingOrder = Readonly<{
  id: number;
  status: string;
  amount: number;
  payAmount: number;
  currency?: string;
  feeRate: number;
  paymentType?: string;
  outTradeNo?: string;
  qrCode?: string;
  payUrl?: string;
  clientSecret?: string;
  expiresAt: string;
}>;

type PlanTab = Readonly<{
  key: string;
  label: string;
}>;

type QuotaPeriod = 'daily' | 'weekly' | 'monthly';

type QuotaDisplayRow = Readonly<{
  id: string;
  label: string;
  used: number;
  limit: number | null;
  remaining?: number | null;
  percentage: number;
  resetsAt?: string | null;
}>;

type SubscriptionSummaryItem = SubscriptionSummary['subscriptions'][number];

const POLL_INTERVAL_MS = 3000;
const ALL_PLANS_TAB = 'all';
const QUOTA_PERIODS: Array<Readonly<{ key: QuotaPeriod; labelKey: string }>> = [
  { key: 'daily', labelKey: 'subscriptionDialog.quota.daily' },
  { key: 'weekly', labelKey: 'subscriptionDialog.quota.weekly' },
  { key: 'monthly', labelKey: 'subscriptionDialog.quota.monthly' },
];

type Translate = (key: string, options?: Record<string, unknown>) => string;

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function methodLabel(method: BillingMethodOption): string {
  return method.limit.displayName || method.id;
}

function formatBillingAmount(amount: number, currency?: string, locale = 'en'): string {
  const normalizedCurrency = currency?.trim().toUpperCase();
  if (normalizedCurrency) {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: normalizedCurrency,
      }).format(amount);
    } catch {
      return `${amount.toFixed(2)} ${normalizedCurrency}`;
    }
  }

  return amount.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDate(value?: string | null, locale = 'en', emptyLabel = ''): string {
  if (!value) return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function validityUnitLabel(unit: string, t: Translate): string {
  switch (unit) {
    case 'day':
    case 'days':
      return t('subscriptionDialog.units.day');
    case 'week':
    case 'weeks':
      return t('subscriptionDialog.units.week');
    case 'month':
    case 'months':
      return t('subscriptionDialog.units.month');
    case 'year':
    case 'years':
      return t('subscriptionDialog.units.year');
    default:
      return unit || t('subscriptionDialog.units.cycle');
  }
}

function planDurationLabel(plan: BillingPlan, t: Translate): string {
  const unit = validityUnitLabel(plan.validityUnit, t);
  if (plan.validityDays > 0) return t('subscriptionDialog.plan.duration', { count: plan.validityDays, unit });
  return unit;
}

function planTabKey(plan: BillingPlan): string {
  return `unit:${plan.validityUnit || 'other'}`;
}

function planTabLabel(plan: BillingPlan, t: Translate): string {
  if (!plan.validityUnit) return t('subscriptionDialog.plan.otherPlans');
  return t('subscriptionDialog.plan.unitPlans', { unit: validityUnitLabel(plan.validityUnit, t) });
}

function normalizedOrderStatus(status: string | null | undefined): string {
  return String(status ?? '').trim().toLowerCase();
}

function shouldPollOrderStatus(status: string | null | undefined): boolean {
  const normalized = normalizedOrderStatus(status);
  return normalized === 'pending' || normalized === 'recharging';
}

function isPaidOrderStatus(status: string | null | undefined): boolean {
  const normalized = normalizedOrderStatus(status);
  return normalized === 'paid' || normalized === 'completed';
}

function orderStatusLabel(status: string, t: Translate): string {
  switch (normalizedOrderStatus(status)) {
    case 'pending':
      return t('subscriptionDialog.order.status.pending');
    case 'recharging':
      return t('subscriptionDialog.order.status.recharging');
    case 'paid':
    case 'completed':
      return t('subscriptionDialog.order.status.paid');
    case 'expired':
      return t('subscriptionDialog.order.status.expired');
    case 'failed':
      return t('subscriptionDialog.order.status.failed');
    case 'cancelled':
      return t('subscriptionDialog.order.status.cancelled');
    default:
      return status || t('subscriptionDialog.order.status.unknown');
  }
}

function orderStatusVariant(status: string): BadgeProps['variant'] {
  if (isPaidOrderStatus(status)) return 'success';
  if (shouldPollOrderStatus(status)) return 'warning';
  if (normalizedOrderStatus(status) === 'expired' || normalizedOrderStatus(status) === 'failed') return 'destructive';
  return 'secondary';
}

function subscriptionStatusLabel(status: string, t: Translate): string {
  switch (status) {
    case 'active':
      return t('subscriptionDialog.subscriptionStatus.active');
    case 'trialing':
      return t('subscriptionDialog.subscriptionStatus.trialing');
    case 'past_due':
      return t('subscriptionDialog.subscriptionStatus.pastDue');
    case 'cancelled':
      return t('subscriptionDialog.subscriptionStatus.cancelled');
    case 'expired':
      return t('subscriptionDialog.subscriptionStatus.expired');
    case 'none':
      return t('subscriptionDialog.subscriptionStatus.none');
    default:
      return status;
  }
}

function subscriptionStatusVariant(status: string): BadgeProps['variant'] {
  if (status === 'active' || status === 'trialing') return 'success';
  if (status === 'past_due') return 'warning';
  return 'secondary';
}

function quotaPercent(used: number, limit: number | null): number {
  if (limit === null) return 100;
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

function formatQuotaValue(value: number | null, t: Translate, locale: string): string {
  if (value === null) return t('subscriptionDialog.quota.unlimited');
  return formatBillingAmount(value, 'USD', locale);
}

function formatPaymentLimit(value: number, currency: string | undefined, t: Translate, locale: string): string {
  return value > 0 ? formatBillingAmount(value, currency, locale) : t('subscriptionDialog.payment.unlimited');
}

function isQrCodeImageSource(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('data:image/') || normalized.startsWith('http://') || normalized.startsWith('https://');
}

function salePlans(plans: readonly BillingPlan[]): BillingPlan[] {
  return [...plans]
    .filter((plan) => plan.forSale !== false)
    .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.id - right.id);
}

function planTabs(plans: readonly BillingPlan[], t: Translate): PlanTab[] {
  const tabs: PlanTab[] = [{ key: ALL_PLANS_TAB, label: t('subscriptionDialog.plan.allPlans') }];
  const seen = new Set<string>();
  for (const plan of plans) {
    const key = planTabKey(plan);
    if (seen.has(key)) continue;
    seen.add(key);
    tabs.push({ key, label: planTabLabel(plan, t) });
  }
  return tabs;
}

function quotaRowFromProgress(id: string, label: string, quota: SubscriptionQuotaProgress): QuotaDisplayRow {
  return {
    id,
    label,
    used: quota.used,
    limit: quota.limit,
    remaining: quota.remaining,
    percentage: quota.percentage,
    resetsAt: quota.resetsAt,
  };
}

function quotaRowsFromProgress(progress: SubscriptionProgress | null, t: Translate): QuotaDisplayRow[] {
  if (!progress) return [];
  return QUOTA_PERIODS.flatMap(({ key, labelKey }) => {
    const quota = progress[key];
    return quota ? [quotaRowFromProgress(`${progress.subscriptionId}:${key}`, t(labelKey), quota)] : [];
  });
}

function quotaRowsFromSummary(subscription: SubscriptionSummaryItem | null, t: Translate): QuotaDisplayRow[] {
  if (!subscription) return [];
  const rows: QuotaDisplayRow[] = [];
  if (subscription.dailyUsedUsd !== undefined || subscription.dailyLimitUsd !== undefined) {
    const used = subscription.dailyUsedUsd ?? 0;
    const limit = subscription.dailyLimitUsd ?? null;
    rows.push({ id: `${subscription.id}:daily`, label: t('subscriptionDialog.quota.daily'), used, limit, percentage: quotaPercent(used, limit) });
  }
  if (subscription.weeklyUsedUsd !== undefined || subscription.weeklyLimitUsd !== undefined) {
    const used = subscription.weeklyUsedUsd ?? 0;
    const limit = subscription.weeklyLimitUsd ?? null;
    rows.push({ id: `${subscription.id}:weekly`, label: t('subscriptionDialog.quota.weekly'), used, limit, percentage: quotaPercent(used, limit) });
  }
  if (subscription.monthlyUsedUsd !== undefined || subscription.monthlyLimitUsd !== undefined) {
    const used = subscription.monthlyUsedUsd ?? 0;
    const limit = subscription.monthlyLimitUsd ?? null;
    rows.push({ id: `${subscription.id}:monthly`, label: t('subscriptionDialog.quota.monthly'), used, limit, percentage: quotaPercent(used, limit) });
  }
  return rows;
}

function platformQuotaRows(quotas: readonly PlatformQuota[] | null, t: Translate): QuotaDisplayRow[] {
  if (!quotas) return [];
  return quotas.slice(0, 3).map((quota) => ({
    id: `platform:${quota.platform}:monthly`,
    label: t('subscriptionDialog.quota.platformMonthly', { platform: quota.platform }),
    used: quota.monthly.usedUsd,
    limit: quota.monthly.limitUsd,
    percentage: quotaPercent(quota.monthly.usedUsd, quota.monthly.limitUsd),
    resetsAt: quota.monthly.resetsAt,
  }));
}

function planQuotaRows(plan: BillingPlan | null, t: Translate): Array<Readonly<{ label: string; limit: number | null }>> {
  if (!plan) return [];
  return [
    ...(plan.dailyLimitUsd !== undefined ? [{ label: t('subscriptionDialog.quota.daily'), limit: plan.dailyLimitUsd }] : []),
    ...(plan.weeklyLimitUsd !== undefined ? [{ label: t('subscriptionDialog.quota.weekly'), limit: plan.weeklyLimitUsd }] : []),
    ...(plan.monthlyLimitUsd !== undefined ? [{ label: t('subscriptionDialog.quota.monthly'), limit: plan.monthlyLimitUsd }] : []),
  ];
}

function activeOrderFromResult(result: PaymentOrderResult, fallbackPaymentType: string): ActiveBillingOrder {
  return {
    id: result.orderId,
    status: 'pending',
    amount: result.amount,
    payAmount: result.payAmount,
    currency: result.currency,
    feeRate: result.feeRate,
    paymentType: result.paymentType || fallbackPaymentType,
    outTradeNo: result.outTradeNo,
    qrCode: result.qrCode,
    payUrl: result.payUrl,
    clientSecret: result.clientSecret,
    expiresAt: result.expiresAt,
  };
}

function mergePaymentOrder(order: PaymentOrder, previous?: ActiveBillingOrder | null): ActiveBillingOrder {
  return {
    id: order.id,
    status: order.status,
    amount: order.amount,
    payAmount: order.payAmount,
    currency: order.currency ?? previous?.currency,
    feeRate: order.feeRate,
    paymentType: order.paymentType || previous?.paymentType,
    outTradeNo: order.outTradeNo || previous?.outTradeNo,
    qrCode: previous?.qrCode,
    payUrl: previous?.payUrl ?? undefined,
    clientSecret: previous?.clientSecret,
    expiresAt: order.expiresAt || previous?.expiresAt || '',
  };
}

export function SubscriptionPlanDialog({ open, onOpenChange }: SubscriptionPlanDialogProps) {
  const subscriptionSummary = useSubscriptionStore((state) => state.summary);
  const subscriptionProgress = useSubscriptionStore((state) => state.progress);
  const platformQuotas = useSubscriptionStore((state) => state.platformQuotas);
  const subscriptionStatus = useSubscriptionStore((state) => state.status);
  const subscriptionErrorMessage = useSubscriptionStore((state) => state.errorMessage);
  const refreshSubscriptions = useSubscriptionStore((state) => state.refreshAll);
  const { t, i18n } = useTranslation();

  const [activeDialogTab, setActiveDialogTab] = useState<SubscriptionDialogTab>('current');
  const [loadStatus, setLoadStatus] = useState<BillingLoadStatus>('idle');
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  const [checkoutInfo, setCheckoutInfo] = useState<BillingCheckoutInfo | null>(null);
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [activePlanTab, setActivePlanTab] = useState(ALL_PLANS_TAB);
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const [selectedMethodId, setSelectedMethodId] = useState('');
  const [acceptedAgreement, setAcceptedAgreement] = useState(false);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [currentOrder, setCurrentOrder] = useState<ActiveBillingOrder | null>(null);
  const [orderErrorMessage, setOrderErrorMessage] = useState<string | null>(null);
  const [verifyingOrder, setVerifyingOrder] = useState(false);
  const [checkingOrder, setCheckingOrder] = useState(false);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  const openRef = useRef(open);
  const loadRequestIdRef = useRef(0);
  const pollTimerRef = useRef<number | null>(null);
  const pollInFlightRef = useRef(false);
  const refreshedOrderIdRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const availableMethods = useMemo<BillingMethodOption[]>(() => (
    Object.entries(checkoutInfo?.methods ?? {})
      .filter(([, limit]) => limit.available)
      .map(([id, limit]) => ({ id, limit }))
  ), [checkoutInfo]);

  const visibleSalePlans = useMemo(() => salePlans(plans), [plans]);
  const tabs = useMemo(() => planTabs(visibleSalePlans, t), [t, visibleSalePlans]);
  const activePlanTabPlans = useMemo(() => (
    activePlanTab === ALL_PLANS_TAB
      ? visibleSalePlans
      : visibleSalePlans.filter((plan) => planTabKey(plan) === activePlanTab)
  ), [activePlanTab, visibleSalePlans]);
  const choosePlan = useCallback((planId: number) => setSelectedPlanId(planId), []);
  const openCheckoutTab = useCallback(() => setActiveDialogTab('checkout'), []);
  const selectedMethod = useMemo(() => (
    availableMethods.find((method) => method.id === selectedMethodId) ?? null
  ), [availableMethods, selectedMethodId]);
  const selectedPlan = useMemo(() => (
    visibleSalePlans.find((plan) => plan.id === selectedPlanId) ?? null
  ), [selectedPlanId, visibleSalePlans]);
  const selectedPlanQuotaRows = useMemo(() => planQuotaRows(selectedPlan, t), [selectedPlan, t]);
  const currentSubscription = subscriptionSummary?.subscriptions.find((subscription) => subscription.status === 'active')
    ?? subscriptionSummary?.subscriptions[0]
    ?? null;
  const currentProgress = useMemo(() => (
    subscriptionProgress?.find((progress) => progress.subscriptionId === currentSubscription?.id)
    ?? subscriptionProgress?.[0]
    ?? null
  ), [currentSubscription?.id, subscriptionProgress]);
  const currentQuotaRows = useMemo(() => {
    const progressRows = quotaRowsFromProgress(currentProgress, t);
    return progressRows.length > 0 ? progressRows : quotaRowsFromSummary(currentSubscription, t);
  }, [currentProgress, currentSubscription, t]);
  const secondaryQuotaRows = useMemo(() => platformQuotaRows(platformQuotas, t), [platformQuotas, t]);
  const subscriptionDisplayStatus = currentSubscription?.status ?? (subscriptionSummary?.activeCount ? 'active' : 'none');
  const subscriptionPlanName = currentProgress?.groupName
    ?? currentSubscription?.groupName
    ?? (subscriptionSummary?.activeCount
      ? t('subscriptionDialog.current.subscriptionCount', { count: subscriptionSummary.activeCount })
      : t('subscriptionDialog.current.noSubscription'));

  const hasPendingOrder = currentOrder ? shouldPollOrderStatus(currentOrder.status) : false;
  const canCreateOrder = !!selectedPlan
    && !!selectedMethodId
    && acceptedAgreement
    && availableMethods.length > 0
    && !creatingOrder
    && !hasPendingOrder;

  const loadBillingData = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    setLoadStatus('loading');
    setLoadErrorMessage(null);
    setCurrentOrder(null);
    setOrderErrorMessage(null);
    setAcceptedAgreement(false);
    stopPolling();

    try {
      const nextCheckoutInfo = await fetchBillingCheckoutInfo();
      if (!openRef.current || requestId !== loadRequestIdRef.current) return;

      const nextSalePlans = salePlans(nextCheckoutInfo.plans);
      const nextMethods = Object.entries(nextCheckoutInfo.methods)
        .filter(([, limit]) => limit.available)
        .map(([id, limit]) => ({ id, limit }));
      setCheckoutInfo(nextCheckoutInfo);
      setPlans(nextSalePlans);
      setSelectedMethodId(nextMethods[0]?.id ?? '');
      setSelectedPlanId(nextSalePlans[0]?.id ?? null);
      setActivePlanTab(ALL_PLANS_TAB);
      setLoadStatus('ready');
    } catch (error) {
      if (!openRef.current || requestId !== loadRequestIdRef.current) return;
      setLoadStatus('error');
      setLoadErrorMessage(messageFromError(error));
    }
  }, [stopPolling]);

  const verifyCurrentOrder = useCallback(async (outTradeNo: string, manual: boolean) => {
    if (pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    if (manual) {
      setCheckingOrder(true);
    } else {
      setVerifyingOrder(true);
    }

    try {
      const nextOrder = await verifyBillingOrder({ outTradeNo });
      if (!openRef.current) return;
      setCurrentOrder((previous) => mergePaymentOrder(nextOrder, previous));
      setOrderErrorMessage(null);
    } catch (error) {
      if (!openRef.current) return;
      setOrderErrorMessage(t('subscriptionDialog.errors.verifyOrderFailed', { message: messageFromError(error) }));
    } finally {
      pollInFlightRef.current = false;
      if (openRef.current) {
        setCheckingOrder(false);
        setVerifyingOrder(false);
      }
    }
  }, [t]);

  useEffect(() => {
    openRef.current = open;
    if (!open) {
      stopPolling();
      loadRequestIdRef.current += 1;
      setActiveDialogTab('current');
      setLoadStatus('idle');
      setLoadErrorMessage(null);
      setCheckoutInfo(null);
      setPlans([]);
      setSelectedMethodId('');
      setSelectedPlanId(null);
      setCurrentOrder(null);
      setOrderErrorMessage(null);
      setAcceptedAgreement(false);
      setCreatingOrder(false);
      setVerifyingOrder(false);
      setCheckingOrder(false);
      setCopiedText(null);
      return;
    }

    setActiveDialogTab('current');
    void refreshSubscriptions();
  }, [open, refreshSubscriptions, stopPolling]);

  useEffect(() => {
    if (!open || activeDialogTab !== 'checkout' || loadStatus !== 'idle') return;
    void loadBillingData();
  }, [activeDialogTab, loadBillingData, loadStatus, open]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  useEffect(() => {
    if (!open || !currentOrder || !shouldPollOrderStatus(currentOrder.status) || !currentOrder.outTradeNo) {
      stopPolling();
      return;
    }

    const outTradeNo = currentOrder.outTradeNo;
    const timer = window.setInterval(() => {
      void verifyCurrentOrder(outTradeNo, false);
    }, POLL_INTERVAL_MS);
    pollTimerRef.current = timer;

    return () => {
      if (pollTimerRef.current === timer) {
        window.clearInterval(timer);
        pollTimerRef.current = null;
      }
    };
  }, [currentOrder, open, stopPolling, verifyCurrentOrder]);

  useEffect(() => {
    if (!open || !currentOrder || !isPaidOrderStatus(currentOrder.status)) return;
    stopPolling();
    if (refreshedOrderIdRef.current === currentOrder.id) return;
    refreshedOrderIdRef.current = currentOrder.id;
    void refreshSubscriptions();
  }, [currentOrder, open, refreshSubscriptions, stopPolling]);

  function updateDialogTab(value: string): void {
    setActiveDialogTab(value === 'checkout' ? 'checkout' : 'current');
  }

  function updatePlanTab(tab: string): void {
    setActivePlanTab(tab);
    if (tab === ALL_PLANS_TAB) return;
    const nextPlan = visibleSalePlans.find((plan) => planTabKey(plan) === tab);
    if (nextPlan) setSelectedPlanId(nextPlan.id);
  }

  async function createOrder(): Promise<void> {
    if (!selectedPlan || !selectedMethodId || creatingOrder || hasPendingOrder) return;
    setCreatingOrder(true);
    setOrderErrorMessage(null);
    stopPolling();

    try {
      const result = await createBillingOrder({
        amount: selectedPlan.price,
        paymentType: selectedMethodId,
        orderType: 'subscription',
        planId: selectedPlan.id,
        returnUrl: window.location.href,
        paymentSource: 'matcha',
        isMobile: false,
      });
      if (!openRef.current) return;
      setCurrentOrder(activeOrderFromResult(result, selectedMethodId));
      refreshedOrderIdRef.current = null;
    } catch (error) {
      if (!openRef.current) return;
      setOrderErrorMessage(t('subscriptionDialog.errors.createOrderFailed', { message: messageFromError(error) }));
    } finally {
      if (openRef.current) setCreatingOrder(false);
    }
  }

  async function reloadOrder(): Promise<void> {
    if (!currentOrder || checkingOrder) return;
    setCheckingOrder(true);
    setOrderErrorMessage(null);

    try {
      const nextOrder = await fetchBillingOrder(currentOrder.id);
      if (!openRef.current) return;
      setCurrentOrder((previous) => mergePaymentOrder(nextOrder, previous));
    } catch (error) {
      if (!openRef.current) return;
      setOrderErrorMessage(t('subscriptionDialog.errors.reloadOrderFailed', { message: messageFromError(error) }));
    } finally {
      if (openRef.current) setCheckingOrder(false);
    }
  }

  async function openPayUrl(payUrl: string): Promise<void> {
    try {
      await window.electron.openExternal(payUrl);
    } catch (error) {
      setOrderErrorMessage(t('subscriptionDialog.errors.openPayUrlFailed', { message: messageFromError(error) }));
    }
  }

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedText(text);
    } catch (error) {
      setOrderErrorMessage(t('subscriptionDialog.errors.copyFailed', { message: messageFromError(error) }));
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 flex h-[min(calc(100vh-2rem),760px)] w-[min(calc(100vw-2rem),960px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[1.5rem] border border-border bg-background shadow-2xl data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <div className="flex items-start justify-between gap-4 border-b border-border/70 px-6 py-5">
            <DialogPrimitive.Title className="text-lg font-semibold tracking-[-0.02em]">
              {t('subscriptionDialog.title')}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring/15">
              <X className="h-4 w-4" />
              <span className="sr-only">{t('actions.close')}</span>
            </DialogPrimitive.Close>
          </div>

          <Tabs value={activeDialogTab} onValueChange={updateDialogTab} className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-border/70 px-6 py-3">
              <TabsList>
                <TabsTrigger value="current">{t('subscriptionDialog.tabs.current')}</TabsTrigger>
                <TabsTrigger value="checkout">{t('subscriptionDialog.tabs.checkout')}</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="current" className="mt-0 min-h-0 flex-1 overflow-y-auto p-6">
              <CurrentSubscriptionPanel
                currentQuotaRows={currentQuotaRows}
                currentSubscription={currentSubscription}
                currentProgress={currentProgress}
                secondaryQuotaRows={secondaryQuotaRows}
                subscriptionDisplayStatus={subscriptionDisplayStatus}
                subscriptionErrorMessage={subscriptionErrorMessage}
                subscriptionPlanName={subscriptionPlanName}
                subscriptionStatus={subscriptionStatus}
                locale={i18n.language}
                t={t}
                onRefresh={refreshSubscriptions}
                onChoosePlan={openCheckoutTab}
              />
            </TabsContent>

            <TabsContent value="checkout" className="mt-0 min-h-0 flex-1 overflow-y-auto p-6">
              {loadStatus === 'idle' || loadStatus === 'loading' ? (
                <div className="flex min-h-80 items-center justify-center gap-2 rounded-[1.35rem] border border-border/70 bg-card text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('subscriptionDialog.loading')}
                </div>
              ) : null}

              {loadStatus === 'error' ? (
                <div className="rounded-[1.35rem] border border-destructive/40 bg-card p-5">
                  <p className="font-medium text-foreground">{t('subscriptionDialog.errors.loadPlansFailed')}</p>
                  <p className="mt-2 text-sm text-muted-foreground">{loadErrorMessage}</p>
                  <Button className="mt-4" onClick={() => { void loadBillingData(); }}>
                    <RefreshCw className="h-4 w-4" />
                    {t('actions.refresh')}
                  </Button>
                </div>
              ) : null}

              {loadStatus === 'ready' ? (
                <div className="grid min-h-0 gap-5 lg:grid-cols-[minmax(0,1.25fr)_390px] lg:items-start">
                  <section className="min-h-0">
                    {visibleSalePlans.length === 0 ? (
                      <div className="rounded-[1.35rem] border border-border/70 bg-card py-14 text-center text-sm text-muted-foreground">
                        {t('subscriptionDialog.plan.empty')}
                      </div>
                    ) : (
                      <Tabs value={activePlanTab} onValueChange={updatePlanTab}>
                        <TabsList className="mb-4">
                          {tabs.map((tab) => (
                            <TabsTrigger key={tab.key} value={tab.key}>{tab.label}</TabsTrigger>
                          ))}
                        </TabsList>
                        <TabsContent value={activePlanTab} className="mt-0">
                          <div className="grid gap-3">
                            {activePlanTabPlans.map((plan) => (
                              <PlanOption
                                key={plan.id}
                                plan={plan}
                                selected={plan.id === selectedPlanId}
                                locale={i18n.language}
                                t={t}
                                onSelect={choosePlan}
                              />
                            ))}
                          </div>
                        </TabsContent>
                      </Tabs>
                    )}
                  </section>

                  <PaymentSummaryPanel
                    acceptedAgreement={acceptedAgreement}
                    availableMethods={availableMethods}
                    canCreateOrder={canCreateOrder}
                    checkingOrder={checkingOrder}
                    copiedText={copiedText}
                    creatingOrder={creatingOrder}
                    currentOrder={currentOrder}
                    hasPendingOrder={hasPendingOrder}
                    orderErrorMessage={orderErrorMessage}
                    selectedMethod={selectedMethod}
                    selectedMethodId={selectedMethodId}
                    selectedPlan={selectedPlan}
                    selectedPlanQuotaRows={selectedPlanQuotaRows}
                    verifyingOrder={verifyingOrder}
                    locale={i18n.language}
                    t={t}
                    onAcceptAgreementChange={setAcceptedAgreement}
                    onCopy={copyText}
                    onCreateOrder={createOrder}
                    onMethodChange={setSelectedMethodId}
                    onOpenPayUrl={openPayUrl}
                    onReloadOrder={reloadOrder}
                    onVerifyOrder={verifyCurrentOrder}
                  />
                </div>
              ) : null}
            </TabsContent>
          </Tabs>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function CurrentSubscriptionPanel({
  currentQuotaRows,
  currentSubscription,
  currentProgress,
  secondaryQuotaRows,
  subscriptionDisplayStatus,
  subscriptionErrorMessage,
  subscriptionPlanName,
  subscriptionStatus,
  locale,
  t,
  onRefresh,
  onChoosePlan,
}: {
  currentQuotaRows: QuotaDisplayRow[];
  currentSubscription: SubscriptionSummaryItem | null;
  currentProgress: SubscriptionProgress | null;
  secondaryQuotaRows: QuotaDisplayRow[];
  subscriptionDisplayStatus: string;
  subscriptionErrorMessage: string | null;
  subscriptionPlanName: string;
  subscriptionStatus: string;
  locale: string;
  t: Translate;
  onRefresh: () => Promise<void>;
  onChoosePlan: () => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <section className="flex min-h-52 flex-col rounded-[1.35rem] border border-border/70 bg-card p-5">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{t('subscriptionDialog.tabs.current')}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge variant={subscriptionStatusVariant(subscriptionDisplayStatus)}>
              {subscriptionStatusLabel(subscriptionDisplayStatus, t)}
            </Badge>
            <span className="text-lg font-semibold tracking-[-0.02em] text-foreground">{subscriptionPlanName}</span>
          </div>
          {currentSubscription?.expiresAt || currentProgress?.expiresAt ? (
            <p className="mt-3 text-sm text-muted-foreground">
              {t('subscriptionDialog.current.expiresAt', { date: formatDate(currentProgress?.expiresAt ?? currentSubscription?.expiresAt, locale) })}
            </p>
          ) : null}
        </div>

        {subscriptionErrorMessage ? (
          <p className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {subscriptionErrorMessage}
          </p>
        ) : null}

        <div className="mt-auto flex flex-wrap gap-2 pt-5">
          <Button variant="outline" size="sm" onClick={() => { void onRefresh(); }} disabled={subscriptionStatus === 'loading'}>
            {subscriptionStatus === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t('actions.refresh')}
          </Button>
          <Button size="sm" onClick={onChoosePlan}>{t('subscriptionDialog.tabs.checkout')}</Button>
        </div>
      </section>

      <section className="rounded-[1.35rem] border border-border/70 bg-card p-5">
        <h3 className="mb-4 text-base font-semibold tracking-[-0.02em]">{t('subscriptionDialog.current.quotaTitle')}</h3>

        {currentQuotaRows.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
            {currentQuotaRows.map((quota) => (
              <QuotaCard key={quota.id} quota={quota} locale={locale} t={t} />
            ))}
          </div>
        ) : (
          <div className="flex min-h-36 items-center justify-center rounded-xl border border-dashed border-border/80 bg-background/70 px-4 text-center text-sm text-muted-foreground">
            {t('subscriptionDialog.current.emptyQuota')}
          </div>
        )}
      </section>

      {secondaryQuotaRows.length > 0 ? (
        <section className="rounded-[1.35rem] border border-border/70 bg-card p-5 lg:col-span-2">
          <h3 className="mb-4 text-base font-semibold tracking-[-0.02em]">{t('subscriptionDialog.current.platformQuotaTitle')}</h3>
          <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
            {secondaryQuotaRows.map((quota) => (
              <QuotaCard key={quota.id} quota={quota} locale={locale} t={t} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

const QuotaCard = memo(function QuotaCard({ quota, locale, t }: { quota: QuotaDisplayRow; locale: string; t: Translate }) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/70 p-4">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium text-foreground">{quota.label}</span>
        <span className="text-muted-foreground">{quota.percentage}%</span>
      </div>
      <Progress className="mt-3 h-1.5" value={quota.percentage} />
      <p className="mt-3 text-sm text-muted-foreground">
        {t('subscriptionDialog.quota.usedOfLimit', {
          used: formatQuotaValue(quota.used, t, locale),
          limit: formatQuotaValue(quota.limit, t, locale),
        })}
      </p>
      {quota.remaining !== undefined ? (
        <p className="mt-1 text-sm text-muted-foreground">
          {t('subscriptionDialog.quota.remaining', { amount: formatQuotaValue(quota.remaining, t, locale) })}
        </p>
      ) : null}
      {quota.resetsAt ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('subscriptionDialog.quota.resetsAt', { date: formatDate(quota.resetsAt, locale) })}
        </p>
      ) : null}
    </div>
  );
});

function PaymentSummaryPanel({
  acceptedAgreement,
  availableMethods,
  canCreateOrder,
  checkingOrder,
  copiedText,
  creatingOrder,
  currentOrder,
  hasPendingOrder,
  orderErrorMessage,
  selectedMethod,
  selectedMethodId,
  selectedPlan,
  selectedPlanQuotaRows,
  verifyingOrder,
  locale,
  t,
  onAcceptAgreementChange,
  onCopy,
  onCreateOrder,
  onMethodChange,
  onOpenPayUrl,
  onReloadOrder,
  onVerifyOrder,
}: {
  acceptedAgreement: boolean;
  availableMethods: BillingMethodOption[];
  canCreateOrder: boolean;
  checkingOrder: boolean;
  copiedText: string | null;
  creatingOrder: boolean;
  currentOrder: ActiveBillingOrder | null;
  hasPendingOrder: boolean;
  orderErrorMessage: string | null;
  selectedMethod: BillingMethodOption | null;
  selectedMethodId: string;
  selectedPlan: BillingPlan | null;
  selectedPlanQuotaRows: Array<Readonly<{ label: string; limit: number | null }>>;
  verifyingOrder: boolean;
  locale: string;
  t: Translate;
  onAcceptAgreementChange: (accepted: boolean) => void;
  onCopy: (value: string) => Promise<void>;
  onCreateOrder: () => Promise<void>;
  onMethodChange: (methodId: string) => void;
  onOpenPayUrl: (value: string) => Promise<void>;
  onReloadOrder: () => Promise<void>;
  onVerifyOrder: (outTradeNo: string, manual: boolean) => Promise<void>;
}) {
  return (
    <aside className="rounded-[1.35rem] border border-border/70 bg-card p-4 lg:sticky lg:top-0">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold text-foreground">{t('subscriptionDialog.payment.title')}</p>
        {selectedPlan?.groupPlatform ? <Badge variant="outline">{selectedPlan.groupPlatform}</Badge> : null}
      </div>

      <div className="mt-5">
        <p className="text-3xl font-bold tracking-[-0.05em]">
          {selectedPlan ? formatBillingAmount(selectedPlan.price, selectedPlan.currency, locale) : '-'}
        </p>
        {selectedPlan?.originalPrice && selectedPlan.originalPrice > selectedPlan.price ? (
          <p className="mt-1 text-sm text-muted-foreground line-through">
            {formatBillingAmount(selectedPlan.originalPrice, selectedPlan.currency, locale)}
          </p>
        ) : null}
      </div>

      {selectedPlanQuotaRows.length > 0 ? (
        <div className="mt-5 grid gap-2 text-sm">
          {selectedPlanQuotaRows.map((quota) => (
            <div key={quota.label} className="flex items-center justify-between rounded-xl border border-border/70 px-3 py-2">
              <span className="text-muted-foreground">{quota.label}</span>
              <span className="font-medium text-foreground">{formatQuotaValue(quota.limit, t, locale)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {selectedPlan?.supportedModelScopes?.length ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {selectedPlan.supportedModelScopes.map((scope) => (
            <Badge key={scope} variant="secondary">{scope}</Badge>
          ))}
        </div>
      ) : null}

      <div className="mt-5 space-y-2">
        <p className="text-sm font-medium text-foreground">{t('subscriptionDialog.payment.method')}</p>
        {availableMethods.length === 0 ? (
          <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            {t('subscriptionDialog.payment.noMethod')}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {availableMethods.map((method) => {
              const selected = method.id === selectedMethodId;
              return (
                <button
                  key={method.id}
                  type="button"
                  className={cn(
                    'rounded-xl border px-3 py-2 text-left text-sm transition-colors',
                    selected ? 'border-primary bg-primary/5 text-foreground' : 'border-border/70 text-muted-foreground hover:border-primary/50 hover:text-foreground',
                  )}
                  disabled={hasPendingOrder}
                  onClick={() => onMethodChange(method.id)}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span>{methodLabel(method)}</span>
                    {selected ? <Check className="h-4 w-4 text-primary" /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {selectedMethod ? (
          <p className="text-xs leading-5 text-muted-foreground">
            {t('subscriptionDialog.payment.singleRange', {
              min: formatPaymentLimit(selectedMethod.limit.singleMin, selectedMethod.limit.currency, t, locale),
              max: formatPaymentLimit(selectedMethod.limit.singleMax, selectedMethod.limit.currency, t, locale),
            })}
            {selectedMethod.limit.feeRate > 0 ? t('subscriptionDialog.payment.feeRate', { rate: selectedMethod.limit.feeRate }) : ''}
          </p>
        ) : null}
      </div>

      <OrderPaymentPanel
        currentOrder={currentOrder}
        copiedText={copiedText}
        verifyingOrder={verifyingOrder}
        checkingOrder={checkingOrder}
        hasPendingOrder={hasPendingOrder}
        locale={locale}
        t={t}
        onCopy={onCopy}
        onOpenPayUrl={onOpenPayUrl}
        onReloadOrder={onReloadOrder}
        onVerifyOrder={onVerifyOrder}
      />

      <label className="mt-4 flex gap-3 rounded-xl border border-border/70 p-3 text-xs leading-5 text-muted-foreground">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          checked={acceptedAgreement}
          disabled={hasPendingOrder}
          onChange={(event) => onAcceptAgreementChange(event.target.checked)}
        />
        <span>{t('subscriptionDialog.payment.agreement')}</span>
      </label>

      {orderErrorMessage ? (
        <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {orderErrorMessage}
        </p>
      ) : null}

      <Button className="mt-4 w-full" disabled={!canCreateOrder} onClick={() => { void onCreateOrder(); }}>
        {creatingOrder ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {hasPendingOrder
          ? t('subscriptionDialog.order.pending')
          : selectedPlan
            ? t('subscriptionDialog.payment.confirmWithAmount', { amount: formatBillingAmount(selectedPlan.price, selectedPlan.currency, locale) })
            : t('subscriptionDialog.payment.confirm')}
      </Button>
    </aside>
  );
}

const PlanOption = memo(function PlanOption({
  plan,
  selected,
  locale,
  t,
  onSelect,
}: {
  plan: BillingPlan;
  selected: boolean;
  locale: string;
  t: Translate;
  onSelect: (planId: number) => void;
}) {
  const quotas = planQuotaRows(plan, t);

  return (
    <button
      type="button"
      className={cn(
        'rounded-[1.35rem] border bg-card p-4 text-left transition-[background-color,border-color,box-shadow] hover:border-foreground/30',
        selected ? 'border-foreground shadow-whisper' : 'border-border/70',
      )}
      onClick={() => onSelect(plan.id)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-foreground">{plan.productName || plan.name}</p>
            {plan.groupPlatform ? <Badge variant="outline">{plan.groupPlatform}</Badge> : null}
          </div>
          {plan.description ? (
            <p className="mt-1 text-sm leading-5 text-muted-foreground">{plan.description}</p>
          ) : null}
        </div>
        {selected ? <Check className="h-5 w-5 shrink-0 text-primary" /> : null}
      </div>

      <div className="mt-4 flex flex-wrap items-baseline gap-2">
        <span className="text-2xl font-bold tracking-tight text-foreground">
          {formatBillingAmount(plan.price, plan.currency, locale)}
        </span>
        <span className="text-sm text-muted-foreground">/ {planDurationLabel(plan, t)}</span>
        {plan.originalPrice && plan.originalPrice > plan.price ? (
          <span className="text-sm text-muted-foreground line-through">
            {formatBillingAmount(plan.originalPrice, plan.currency, locale)}
          </span>
        ) : null}
      </div>

      <div className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <span>{t('subscriptionDialog.plan.rateMultiplier', { value: plan.rateMultiplier ?? 1 })}</span>
        <span>{t('subscriptionDialog.plan.validity', { duration: planDurationLabel(plan, t) })}</span>
        {quotas.map((quota) => (
          <span key={quota.label}>{t('subscriptionDialog.plan.quotaLimit', { label: quota.label, amount: formatQuotaValue(quota.limit, t, locale) })}</span>
        ))}
      </div>

      <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
        {plan.features.length > 0 ? plan.features.map((feature) => (
          <li key={feature} className="flex gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            <span>{feature}</span>
          </li>
        )) : (
          <li className="flex gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            <span>{t('subscriptionDialog.plan.defaultFeature')}</span>
          </li>
        )}
      </ul>
    </button>
  );
});

function OrderPaymentPanel({
  currentOrder,
  copiedText,
  verifyingOrder,
  checkingOrder,
  hasPendingOrder,
  locale,
  t,
  onCopy,
  onOpenPayUrl,
  onReloadOrder,
  onVerifyOrder,
}: {
  currentOrder: ActiveBillingOrder | null;
  copiedText: string | null;
  verifyingOrder: boolean;
  checkingOrder: boolean;
  hasPendingOrder: boolean;
  locale: string;
  t: Translate;
  onCopy: (value: string) => Promise<void>;
  onOpenPayUrl: (value: string) => Promise<void>;
  onReloadOrder: () => Promise<void>;
  onVerifyOrder: (outTradeNo: string, manual: boolean) => Promise<void>;
}) {
  if (!currentOrder) {
    return null;
  }

  return (
    <div className="mt-5 rounded-2xl border border-border/80 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">{t('subscriptionDialog.order.statusLabel')}</p>
        <Badge variant={orderStatusVariant(currentOrder.status)}>{orderStatusLabel(currentOrder.status, t)}</Badge>
      </div>

      <div className="mt-4 grid gap-2 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">{t('subscriptionDialog.order.payAmount')}</span>
          <span className="font-semibold text-foreground">{formatBillingAmount(currentOrder.payAmount, currentOrder.currency, locale)}</span>
        </div>
        {currentOrder.expiresAt ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{t('subscriptionDialog.order.expiresAt')}</span>
            <span className="text-xs text-foreground">{formatDate(currentOrder.expiresAt, locale)}</span>
          </div>
        ) : null}
      </div>

      {currentOrder.payUrl ? (
        <Button className="mt-4 w-full" variant="outline" size="sm" onClick={() => { void onOpenPayUrl(currentOrder.payUrl!); }}>
          <ExternalLink className="h-4 w-4" />
          {t('subscriptionDialog.order.openPayUrl')}
        </Button>
      ) : null}

      {currentOrder.qrCode ? (
        <div className="mt-4 rounded-xl border border-border/70 p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-medium">{t('subscriptionDialog.order.qrCode')}</p>
            <Button variant="outline" size="sm" onClick={() => { void onCopy(currentOrder.qrCode!); }}>
              <Copy className="h-4 w-4" />
              {copiedText === currentOrder.qrCode ? t('subscriptionDialog.order.copied') : t('actions.copy')}
            </Button>
          </div>
          {isQrCodeImageSource(currentOrder.qrCode) ? (
            <img
              src={currentOrder.qrCode}
              alt={t('subscriptionDialog.order.qrCodeAlt')}
              className="mx-auto h-48 w-48 rounded-xl border border-border bg-white object-contain p-3"
            />
          ) : (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-secondary p-3 text-xs text-secondary-foreground">
              {currentOrder.qrCode}
            </pre>
          )}
        </div>
      ) : null}

      {currentOrder.clientSecret ? (
        <CopyableField label="Client Secret" value={currentOrder.clientSecret} copied={copiedText === currentOrder.clientSecret} t={t} onCopy={onCopy} />
      ) : null}

      {currentOrder.outTradeNo ? (
        <CopyableField label={t('subscriptionDialog.order.tradeNo')} value={currentOrder.outTradeNo} copied={copiedText === currentOrder.outTradeNo} t={t} onCopy={onCopy} />
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={checkingOrder} onClick={() => { void onReloadOrder(); }}>
          {checkingOrder ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t('subscriptionDialog.order.reload')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={checkingOrder || verifyingOrder || !currentOrder.outTradeNo}
          onClick={() => { if (currentOrder.outTradeNo) void onVerifyOrder(currentOrder.outTradeNo, true); }}
        >
          {verifyingOrder ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {t('subscriptionDialog.order.verify')}
        </Button>
        {hasPendingOrder && currentOrder.outTradeNo ? (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {verifyingOrder ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {t('subscriptionDialog.order.polling')}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function CopyableField({
  label,
  value,
  copied,
  t,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  t: Translate;
  onCopy: (value: string) => Promise<void>;
}) {
  return (
    <div className="mt-3 flex items-start justify-between gap-3 rounded-xl border border-border/70 p-3 text-sm">
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground">{label}</p>
        <p className="mt-1 break-all font-mono text-xs text-foreground">{value}</p>
      </div>
      <Button variant="outline" size="sm" onClick={() => { void onCopy(value); }}>
        <Copy className="h-4 w-4" />
        {copied ? t('subscriptionDialog.order.copied') : t('actions.copy')}
      </Button>
    </div>
  );
}

export default SubscriptionPlanDialog;
