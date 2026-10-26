import { memo, startTransition, useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CreditCard, Info, LogIn, LogOut, Palette, UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SubscriptionPlanDialog } from '@/plugins/account/billing/SubscriptionPlanDialog';
import { useAccountStore } from '@/plugins/account/stores/account';
import { useLocalLicenseLocked } from '@/plugins/account/stores/license';
import { useSubscriptionStore } from '@/plugins/account/stores/subscription';
import type { AccountSubscriptionProjection, AccountUsageProjection, CloudUser } from '@/lib/account';
import type { SubscriptionProgress as SubscriptionProgressItem, SubscriptionSummary } from '@/lib/subscription';

const SIDEBAR_ACCOUNT_QUOTA_RENDER_LIMIT = 2;

type SidebarPlanBadgeVariant = 'success' | 'warning' | 'secondary' | 'outline';

type SidebarQuotaInput = {
  id?: string;
  name?: string;
  used: number;
  limit: number | null;
  unit: string;
};

type SidebarQuotaView = {
  id: string;
  name: string;
  usageLabel: string;
  percent: number;
  hasLimit: boolean;
};

function formatSidebarUsageAmount(value: number, unit: string): string {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  const formatted = Number.isInteger(safeValue)
    ? String(safeValue)
    : safeValue.toFixed(1).replace(/\.0$/, '');
  return unit ? `${formatted} ${unit}` : formatted;
}

function buildSidebarQuotaView(quota: SidebarQuotaInput, index: number, t: (key: string, options?: Record<string, unknown>) => string): SidebarQuotaView {
  const used = Number.isFinite(quota.used) ? Math.max(0, quota.used) : 0;
  const hasLimit = quota.limit !== null && Number.isFinite(quota.limit) && quota.limit > 0;
  const limit = hasLimit ? quota.limit as number : null;
  const formattedUsed = formatSidebarUsageAmount(used, quota.unit);
  return {
    id: quota.id || `${quota.name || 'quota'}-${index}`,
    name: quota.name || t('sidebar.account.quota.usage'),
    usageLabel: limit === null
      ? t('sidebar.account.quota.usedAmount', { amount: formattedUsed })
      : t('sidebar.account.quota.usedOfLimit', { used: formattedUsed, limit: formatSidebarUsageAmount(limit, quota.unit) }),
    percent: limit === null ? 0 : Math.min(100, Math.round((used / limit) * 100)),
    hasLimit,
  };
}

function buildSidebarQuotaViews(quotas: readonly SidebarQuotaInput[], t: (key: string, options?: Record<string, unknown>) => string): SidebarQuotaView[] {
  return quotas
    .slice(0, SIDEBAR_ACCOUNT_QUOTA_RENDER_LIMIT)
    .map((quota, index) => buildSidebarQuotaView(quota, index, t));
}

function buildSidebarBalanceViews(user: CloudUser | null, t: (key: string, options?: Record<string, unknown>) => string): SidebarQuotaView[] {
  if (!user) return [];
  const frozenBalance = user.frozenBalance ?? 0;
  return buildSidebarQuotaViews([
    { id: 'balance:available', name: t('sidebar.account.quota.availableBalance'), used: user.balance, limit: null, unit: 'USD' },
    { id: 'balance:frozen', name: t('sidebar.account.quota.frozenBalance'), used: frozenBalance, limit: null, unit: 'USD' },
  ], t);
}

function isUsableSubscriptionStatus(status: string | undefined): boolean {
  return status === 'active' || status === 'trialing';
}

function buildSidebarSubscriptionQuotaViews(input: {
  summary: SubscriptionSummary | null;
  progress: readonly SubscriptionProgressItem[] | null;
  t: (key: string, options?: Record<string, unknown>) => string;
}): SidebarQuotaView[] {
  const summarySubscription = input.summary?.subscriptions.find((subscription) => isUsableSubscriptionStatus(subscription.status))
    ?? null;
  const progress = summarySubscription
    ? input.progress?.find((item) => item.subscriptionId === summarySubscription.id) ?? null
    : null;

  const quotas: SidebarQuotaInput[] = [];
  if (progress?.daily) {
    quotas.push({ id: `${progress.subscriptionId}:daily`, name: input.t('sidebar.account.quota.subscriptionDaily'), used: progress.daily.used, limit: progress.daily.limit, unit: 'USD' });
  } else if (summarySubscription?.dailyUsedUsd !== undefined || summarySubscription?.dailyLimitUsd !== undefined) {
    quotas.push({ id: `${summarySubscription.id}:daily`, name: input.t('sidebar.account.quota.subscriptionDaily'), used: summarySubscription.dailyUsedUsd ?? 0, limit: summarySubscription.dailyLimitUsd ?? null, unit: 'USD' });
  }

  if (progress?.weekly) {
    quotas.push({ id: `${progress.subscriptionId}:weekly`, name: input.t('sidebar.account.quota.subscriptionWeekly'), used: progress.weekly.used, limit: progress.weekly.limit, unit: 'USD' });
  } else if (summarySubscription?.weeklyUsedUsd !== undefined || summarySubscription?.weeklyLimitUsd !== undefined) {
    quotas.push({ id: `${summarySubscription.id}:weekly`, name: input.t('sidebar.account.quota.subscriptionWeekly'), used: summarySubscription.weeklyUsedUsd ?? 0, limit: summarySubscription.weeklyLimitUsd ?? null, unit: 'USD' });
  }

  if (progress?.monthly) {
    quotas.push({ id: `${progress.subscriptionId}:monthly`, name: input.t('sidebar.account.quota.subscriptionMonthly'), used: progress.monthly.used, limit: progress.monthly.limit, unit: 'USD' });
  } else if (summarySubscription?.monthlyUsedUsd !== undefined || summarySubscription?.monthlyLimitUsd !== undefined) {
    quotas.push({ id: `${summarySubscription.id}:monthly`, name: input.t('sidebar.account.quota.subscriptionMonthly'), used: summarySubscription.monthlyUsedUsd ?? 0, limit: summarySubscription.monthlyLimitUsd ?? null, unit: 'USD' });
  }

  return buildSidebarQuotaViews(quotas, input.t);
}

function sidebarPlanBadgeVariant(status: string | undefined): SidebarPlanBadgeVariant {
  if (status === 'active' || status === 'trialing') {
    return 'success';
  }
  if (status === 'past_due') {
    return 'warning';
  }
  if (status === 'cancelled' || status === 'expired') {
    return 'outline';
  }
  return 'secondary';
}

function sidebarPlanLabel(input: {
  subscription: AccountSubscriptionProjection | null;
  summary: SubscriptionSummary | null;
  t: (key: string) => string;
}): string {
  const summarySubscription = input.summary?.subscriptions[0];
  if (summarySubscription?.groupName) {
    return summarySubscription.groupName;
  }
  if (input.subscription?.planName) {
    return input.subscription.planName;
  }
  const status = summarySubscription?.status ?? input.subscription?.status;
  switch (status) {
    case 'trialing':
      return input.t('sidebar.account.plan.trialing');
    case 'active':
      return input.t('sidebar.account.plan.active');
    case 'past_due':
      return input.t('sidebar.account.plan.pastDue');
    case 'cancelled':
      return input.t('sidebar.account.plan.cancelled');
    case 'expired':
      return input.t('sidebar.account.plan.expired');
    case 'none':
    default:
      return input.t('sidebar.account.plan.free');
  }
}

function accountDisplayName(user: CloudUser | null, signedOutLabel: string): string {
  const name = user?.name?.trim();
  if (name) {
    return name;
  }
  const email = user?.email?.trim();
  if (email) {
    return email.split('@')[0] || email;
  }
  return signedOutLabel;
}

function accountInitial(displayName: string, email: string | undefined, signedOutLabel: string): string {
  const source = displayName !== signedOutLabel ? displayName : email;
  return Array.from(source?.trim() || 'M')[0]?.toUpperCase() || 'M';
}

function accountStatusLabel(status: string, hasUser: boolean, t: (key: string) => string): string {
  if (hasUser) {
    if (status === 'checking') return t('sidebar.account.syncing');
    if (status === 'offline') return t('sidebar.account.offline');
    return t('sidebar.account.signedIn');
  }
  if (status === 'checking') return t('sidebar.account.checking');
  if (status === 'offline') return t('sidebar.account.offline');
  return t('sidebar.account.signedOut');
}

interface SidebarAccountCardProps {
  licenseLocked: boolean;
  status: string;
  user: CloudUser | null;
  subscription: AccountSubscriptionProjection | null;
  usage: AccountUsageProjection | null;
  subscriptionSummary: SubscriptionSummary | null;
  subscriptionProgress: readonly SubscriptionProgressItem[] | null;
  onLogin: () => void;
  onRegister: () => void;
  onOpenSubscription: () => void;
  onOpenAppearance: () => void;
  onOpenAbout: () => void;
  onLogout: () => void;
}

function SidebarAccountAvatar({ user, initial }: { user: CloudUser | null; initial: string }) {
  if (user?.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt=""
        className="h-8 w-8 rounded-full object-cover"
      />
    );
  }

  return (
    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[hsl(var(--shell-surface-muted))] text-xs font-semibold text-[hsl(var(--shell-icon-active))]">
      {initial}
    </span>
  );
}

const SidebarAccountCard = memo(function SidebarAccountCard({
  licenseLocked,
  status,
  user,
  subscription,
  usage,
  subscriptionSummary,
  subscriptionProgress,
  onLogin,
  onRegister,
  onOpenSubscription,
  onOpenAppearance,
  onOpenAbout,
  onLogout,
}: SidebarAccountCardProps) {
  const { t } = useTranslation();
  const signedOutLabel = t('sidebar.account.signedOut');
  const displayName = useMemo(() => accountDisplayName(user, signedOutLabel), [signedOutLabel, user]);
  const email = user?.email?.trim() || undefined;
  const initial = useMemo(() => accountInitial(displayName, email, signedOutLabel), [displayName, email, signedOutLabel]);
  const planLabel = useMemo(() => sidebarPlanLabel({ subscription, summary: subscriptionSummary, t }), [subscription, subscriptionSummary, t]);
  const planVariant = sidebarPlanBadgeVariant(subscriptionSummary?.subscriptions[0]?.status ?? subscription?.status);
  const signedIn = status === 'signedIn' && user !== null;
  const statusLabel = accountStatusLabel(status, signedIn, t);
  const quotaViews = useMemo(() => {
    const subscriptionQuotaViews = buildSidebarSubscriptionQuotaViews({ summary: subscriptionSummary, progress: subscriptionProgress, t });
    if (subscriptionQuotaViews.length > 0) {
      return subscriptionQuotaViews;
    }
    const balanceViews = buildSidebarBalanceViews(user, t);
    if (balanceViews.length > 0) {
      return balanceViews;
    }
    if (usage) {
      return buildSidebarQuotaViews([{ ...usage, id: 'account-usage', name: t('sidebar.account.quota.totalUsage') }], t);
    }
    return [];
  }, [subscriptionProgress, subscriptionSummary, t, usage, user]);

  const triggerClassName = 'w-full rounded-[12px] border border-transparent bg-transparent px-2.5 py-2 text-left transition-[background-color,border-color] hover:bg-[hsl(var(--shell-surface-hover))] data-[state=open]:[border-color:hsl(var(--shell-border))] data-[state=open]:bg-[hsl(var(--shell-surface-active))]';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={triggerClassName} aria-label={signedIn ? t('sidebar.account.openMenu') : t('sidebar.account.loginAria')}>
          <div className="flex min-w-0 items-center gap-2.5">
            <SidebarAccountAvatar user={user} initial={initial} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[hsl(var(--shell-icon-active))]">{displayName}</span>
                {signedIn ? (
                  <Badge variant={planVariant} className="max-w-[92px] shrink-0 px-2 py-0.5">
                    {planLabel}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-0.5 truncate text-xs text-[hsl(var(--shell-text-muted))]">
                {email ?? statusLabel}
              </div>
            </div>
          </div>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="right" className="w-72">
        <DropdownMenuLabel className="space-y-1.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <SidebarAccountAvatar user={user} initial={initial} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">{displayName}</div>
              <div className="truncate text-xs font-normal text-[hsl(var(--shell-text-muted))]">{email ?? statusLabel}</div>
            </div>
            <Badge variant={planVariant} className="max-w-[96px] shrink-0 px-2 py-0.5">
              {planLabel}
            </Badge>
          </div>
        </DropdownMenuLabel>

        <div className="space-y-2 px-2.5 py-2">
          {quotaViews.length > 0 ? (
            quotaViews.map((quota) => (
              <div key={quota.id} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-[11px] text-[hsl(var(--shell-text-muted))]">
                  <span className="truncate">{quota.name}</span>
                  <span className="shrink-0">{quota.usageLabel}</span>
                </div>
                {quota.hasLimit ? (
                  <div className="h-1.5 overflow-hidden rounded-full bg-[hsl(var(--shell-surface-muted))]">
                    <div
                      className="h-full rounded-full bg-[hsl(var(--shell-icon-active))]"
                      style={{ width: `${quota.percent}%` }}
                    />
                  </div>
                ) : null}
              </div>
            ))
          ) : (
            <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-[hsl(var(--shell-text-muted))]">
              {t('sidebar.account.quotaEmpty')}
            </div>
          )}
        </div>

        <DropdownMenuSeparator />
        {signedIn ? (
          <>
            <DropdownMenuItem onSelect={onOpenSubscription} disabled={licenseLocked}>
              <CreditCard className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">{t('sidebar.account.subscription')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenAppearance}>
              <Palette className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">{t('sidebar.account.appearanceSettings')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenAbout}>
              <Info className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">{t('sidebar.account.about')}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onLogout} className="text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive">
              <LogOut className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">{t('sidebar.account.logout')}</span>
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem onSelect={onLogin}>
              <LogIn className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">{t('sidebar.account.login')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRegister}>
              <UserPlus className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">{t('sidebar.account.register')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenSubscription} disabled={licenseLocked}>
              <CreditCard className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">{t('sidebar.account.upgradeSubscription')}</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

export default function AccountFooter() {
  const navigate = useNavigate();
  const accountStatus = useAccountStore((state) => state.status);
  const licenseLocked = useLocalLicenseLocked();
  const accountUser = useAccountStore((state) => state.user);
  const accountSubscription = useAccountStore((state) => state.subscription);
  const accountUsage = useAccountStore((state) => state.usage);
  const logoutAccount = useAccountStore((state) => state.logout);
  const subscriptionSummary = useSubscriptionStore((state) => state.summary);
  const subscriptionProgress = useSubscriptionStore((state) => state.progress);
  const [subscriptionDialogOpen, setSubscriptionDialogOpen] = useState(false);

  const openSubscriptionDialog = useCallback(() => {
    setSubscriptionDialogOpen(true);
  }, []);

  const navigateToLogin = useCallback(() => {
    startTransition(() => {
      navigate('/login');
    });
  }, [navigate]);

  const navigateToRegister = useCallback(() => {
    startTransition(() => {
      navigate('/register');
    });
  }, [navigate]);

  const navigateToAppearanceSettings = useCallback(() => {
    startTransition(() => {
      navigate('/settings?section=appearance');
    });
  }, [navigate]);

  const navigateToAbout = useCallback(() => {
    startTransition(() => {
      navigate('/settings?section=updates');
    });
  }, [navigate]);

  const handleLogout = useCallback(() => {
    void logoutAccount();
  }, [logoutAccount]);

  return (
    <>
      <SidebarAccountCard
        licenseLocked={licenseLocked}
        status={accountStatus}
        user={accountUser}
        subscription={accountSubscription}
        usage={accountUsage}
        subscriptionSummary={subscriptionSummary}
        subscriptionProgress={subscriptionProgress}
        onLogin={navigateToLogin}
        onRegister={navigateToRegister}
        onOpenSubscription={openSubscriptionDialog}
        onOpenAppearance={navigateToAppearanceSettings}
        onOpenAbout={navigateToAbout}
        onLogout={handleLogout}
      />
      {!licenseLocked && <SubscriptionPlanDialog open={subscriptionDialogOpen} onOpenChange={setSubscriptionDialogOpen} />}
    </>
  );
}
