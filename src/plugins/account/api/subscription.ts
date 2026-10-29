import { hostApiFetch } from '@/lib/host-api';

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

export type ActiveSubscription = Readonly<{
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

export async function fetchSubscriptionSummary(): Promise<SubscriptionSummary> {
  return await hostApiFetch<SubscriptionSummary>('/api/subscription/summary');
}

export async function fetchActiveSubscriptions(): Promise<ActiveSubscription[]> {
  return await hostApiFetch<ActiveSubscription[]>('/api/subscription/active');
}

export async function fetchSubscriptionProgress(): Promise<SubscriptionProgress[]> {
  return await hostApiFetch<SubscriptionProgress[]>('/api/subscription/progress');
}

export async function fetchPlatformQuotas(): Promise<PlatformQuota[]> {
  return await hostApiFetch<PlatformQuota[]>('/api/subscription/platform-quotas');
}
