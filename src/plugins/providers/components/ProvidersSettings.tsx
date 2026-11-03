import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  ChevronDown,
  ChevronRight,
  Edit,
  ExternalLink,
  Key,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { getProviderAccountRuntimeReport, useProviderStore, type ProviderCredential, type ProviderSnapshot, type ProviderVendorInfo } from '@/plugins/providers/stores/providers';
import { providerDiagnosticError } from '@/plugins/providers/domain/provider-projection-errors';
import { useProviderModelCatalogStore } from '@/plugins/providers/stores/provider-model-catalog';
import {
  type ProviderModel,
} from '@/plugins/providers/services/provider-model-catalog';
import {
  getProviderDocsUrl,
  getProviderIconUrl,
  shouldInvertInDark,
  type ProviderType,
} from '@/plugins/providers/domain/providers';
import { getCustomMediaContract } from '@/plugins/providers/domain/custom-media-provider-contracts';
import {
  buildProviderListItems,
  type ProviderListItem,
} from '@/plugins/providers/services/provider-accounts';
import { isGatewayOperational } from '@/plugins/runtime/gateway-status';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import { useGatewayStore } from '@/plugins/runtime/store';
import { cn } from '@/lib/utils';
import { lazyWithPreload } from '@/plugin-host/core';
import { useContributions } from '@/plugin-host/react';
import {
  providerAuthMethods,
  providerForms,
  providerVendors,
  type ProviderSecretInput,
} from '../extensions';

const ProviderOAuthOwner = lazyWithPreload(async () => ({ default: (await import('../auth/ProviderOAuthInteraction')).ProviderOAuthOwner }));

function ProviderFormLoading() {
  return <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>;
}

function resolveAccountLabel(
  account: Pick<ProviderCredential, 'label' | 'vendorId'>,
  customLabel: string,
): string {
  const rawLabel = (account.label ?? '').trim();
  if (account.vendorId !== 'custom') {
    return rawLabel || account.vendorId;
  }
  if (!rawLabel) {
    return customLabel;
  }
  const lower = rawLabel.toLowerCase();
  if (lower === 'custom' || rawLabel === '自定义' || rawLabel === 'カスタム') {
    return customLabel;
  }
  return rawLabel;
}

function modelsForAccount(models: readonly ProviderModel[], accountId: string): ProviderModel[] {
  return models.filter((model) => model.accountId === accountId);
}

export function ProvidersSettings() {
  const { t } = useTranslation('settings');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const {
    providerSnapshot,
    snapshotReady,
    initialLoading,
    refreshing,
    mutatingActionsByAccountId,
    error,
    refreshProviderSnapshot,
    createAccount,
    removeAccount,
    updateAccount,
  } = useProviderStore();
  const modelCatalogModels = useProviderModelCatalogStore((state) => state.models);
  const modelCatalogReady = useProviderModelCatalogStore((state) => state.ready);
  const modelCatalogLoading = useProviderModelCatalogStore((state) => state.loading);
  const modelCatalogError = useProviderModelCatalogStore((state) => state.error);
  const refreshModelCatalog = useProviderModelCatalogStore((state) => state.refresh);
  const replaceAccountModels = useProviderModelCatalogStore((state) => state.replaceAccountModels);
  const { credentials, statuses, vendors } = providerSnapshot;
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [manualRefreshPending, setManualRefreshPending] = useState(false);
  const [open, setOpen] = useState(true);
  const gatewayOperational = isGatewayOperational(gatewayStatus);
  const wasGatewayRunningRef = useRef(gatewayOperational);
  const displayProviders = useMemo(
    () => buildProviderListItems(credentials, statuses, vendors),
    [credentials, statuses, vendors],
  );
  const existingVendorIds = useMemo(
    () => new Set(credentials.map((credential) => credential.vendorId)),
    [credentials],
  );
  const showRefreshingHint = useDelayedFlag(refreshing && snapshotReady, 180);

  useEffect(() => {
    void refreshProviderSnapshot({
      trigger: 'background',
      reason: 'providers_settings_mount',
    });
    void refreshModelCatalog();
  }, [refreshModelCatalog, refreshProviderSnapshot]);

  useEffect(() => {
    const handleFocus = () => {
      void refreshProviderSnapshot({ trigger: 'background', reason: 'window_focus' });
    };
    const handleOnline = () => {
      void refreshProviderSnapshot({ trigger: 'background', reason: 'network_online' });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshProviderSnapshot({ trigger: 'background', reason: 'visibility_visible' });
      }
    };

    window.addEventListener('focus', handleFocus);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshProviderSnapshot]);

  useEffect(() => {
    if (!wasGatewayRunningRef.current && gatewayOperational) {
      void refreshProviderSnapshot({ trigger: 'background', reason: 'gateway_reconnected' });
    }
    wasGatewayRunningRef.current = gatewayOperational;
  }, [gatewayOperational, refreshProviderSnapshot]);

  const handleManualRefresh = useCallback(() => {
    if (manualRefreshPending) return;
    setManualRefreshPending(true);
    void Promise.all([
      refreshProviderSnapshot({
        trigger: 'manual',
        reason: 'user_manual_refresh',
      }),
      refreshModelCatalog(),
    ]).finally(() => setManualRefreshPending(false));
  }, [manualRefreshPending, refreshModelCatalog, refreshProviderSnapshot]);

  const saveAccount = async (account: ProviderCredential, secret: ProviderSecretInput, creating: boolean) => {
    return creating ? createAccount(account, secret.apiKey, secret.token)
      : updateAccount(account.id, account, secret.apiKey, secret.token);
  };
  const editingItem = displayProviders.find((item) => item.account.id === editingProvider);

  return (
    <Card className="overflow-hidden rounded-[1.25rem] bg-[hsl(var(--shell-surface-muted))] [border-color:hsl(var(--shell-border))]">
      <CardHeader className={cn('pb-4', open && 'border-b [border-color:hsl(var(--shell-border))]')}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-left"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
          >
            {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
            <Key className="h-5 w-5 shrink-0" />
            <CardTitle>{t('aiProviders.title')}</CardTitle>
          </button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleManualRefresh}
              disabled={initialLoading || refreshing || manualRefreshPending}
            >
              <RefreshCw className={cn('h-4 w-4 mr-2', manualRefreshPending && 'animate-spin')} />
              {t('aiProviders.status.refresh')}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setOpen(true);
                setShowAddDialog(true);
              }}
            >
              <Plus className="h-4 w-4 mr-2" />
              {t('aiProviders.add')}
            </Button>
          </div>
        </div>
      </CardHeader>

      {open ? <CardContent className="space-y-4 pt-4">
        {showRefreshingHint ? (
          <div className="min-h-5">
            {showRefreshingHint ? (
              <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>{t('aiProviders.status.refreshing')}</span>
              </div>
            ) : null}
          </div>
        ) : null}

      {error && snapshotReady ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {providerSnapshot.reports.map((report) => {
        const diagnostic = providerDiagnosticError(report.diagnostic);
        if (!diagnostic || (report.observed !== 'mismatch' && report.diagnostic?.reason !== 'provider-restart-required')
          || report.diagnostic?.reason === 'provider-projection-partial'
          || report.accounts.some((account) => (
            account.accountRevision !== providerSnapshot.revisions[account.accountId]
          ))) return null;
        return (
          <div key={`${report.endpoint.runtimeAdapterId}/${report.endpoint.runtimeInstanceId}`} className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {report.endpoint.runtimeAdapterId}: {diagnostic}
          </div>
        );
      })}

      {initialLoading && !snapshotReady ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : !snapshotReady && error ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refreshProviderSnapshot({ trigger: 'manual', reason: 'user_retry_refresh' });
              }}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              {t('aiProviders.status.retry')}
            </Button>
          </CardContent>
        </Card>
      ) : displayProviders.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Key className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">{t('aiProviders.empty.title')}</h3>
            <p className="text-muted-foreground text-center mb-4">
              {t('aiProviders.empty.desc')}
            </p>
            <Button onClick={() => setShowAddDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              {t('aiProviders.empty.cta')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {displayProviders.map((item) => (
            <ProviderCard
              key={item.account.id}
              item={item}
              models={modelsForAccount(modelCatalogModels, item.account.id)}
              providerSnapshot={providerSnapshot}
              isMutating={Boolean(mutatingActionsByAccountId[item.account.id])}
              isDeleting={Boolean(mutatingActionsByAccountId[item.account.id]?.delete)}
              onEdit={() => setEditingProvider(item.account.id)}
              onDelete={async () => {
                try {
                  await removeAccount(item.account.id);
                  toast.success(t('aiProviders.toast.deleted'));
                } catch (deleteError) {
                  toast.error(`${t('aiProviders.toast.failedDelete')}: ${deleteError}`);
                }
              }}
            />
          ))}
        </div>
      )}

      </CardContent> : null}
      {showAddDialog || editingItem ? (
        <ProviderConfigurationDialog
          key={editingItem?.account.id ?? 'add'} item={editingItem}
          models={editingItem ? modelsForAccount(modelCatalogModels, editingItem.account.id) : []}
          modelsReady={modelCatalogReady} modelsLoading={modelCatalogLoading} modelsError={modelCatalogError}
          existingVendorIds={existingVendorIds} vendors={vendors}
          onClose={() => { setShowAddDialog(false); setEditingProvider(null); }}
          onSubmit={saveAccount} onReplaceModels={replaceAccountModels}
        />
      ) : null}
    </Card>
  );
}

interface ProviderCardProps {
  item: ProviderListItem;
  models: ProviderModel[];
  providerSnapshot: ProviderSnapshot;
  isMutating: boolean;
  isDeleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

function ProviderCard({ item, models, providerSnapshot, isMutating, isDeleting, onEdit, onDelete }: ProviderCardProps) {
  const { t } = useTranslation('settings');
  const { account, vendor, status } = item;
  const authMethods = useContributions(providerAuthMethods).flatMap(({ methods }) => methods);
  const authMethod = authMethods.find(({ id }) => id === account.authMode);
  return (
    <div className="flex items-start justify-between gap-4 rounded-[1rem] border bg-[hsl(var(--shell-surface))] px-4 py-4 [border-color:hsl(var(--shell-border))]">
      <div className="flex min-w-0 items-start gap-3">
        {getProviderIconUrl(account.vendorId) ? <img src={getProviderIconUrl(account.vendorId)} alt="" className={cn('mt-0.5 h-6 w-6 shrink-0', shouldInvertInDark(account.vendorId) && 'dark:invert')} /> : <Key className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{resolveAccountLabel(account, t('aiProviders.custom'))}</h3>
            <Badge variant="secondary">{account.providerKind === 'media' ? getCustomMediaContract(account.mediaApiProtocol)?.label : vendor?.name ?? account.vendorId}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">{authMethod ? t(authMethod.label) : account.authMode} · {t('providerModels.group.subtitle', { count: models.length })}</p>
          {account.id !== 'matcha-cloud' && account.baseUrl ? <p className="truncate text-xs text-muted-foreground">{account.baseUrl}</p> : null}
          {authMethod?.input ? <p className="text-xs text-muted-foreground">{t(status ? status.hasKey ? 'aiProviders.card.configured' : 'aiProviders.card.noKey' : 'aiProviders.card.credentialUnknown')}</p> : null}
          {models.length ? <p className="truncate font-mono text-xs text-muted-foreground">{models.map((model) => model.modelId).join(', ')}</p> : null}
          {providerSnapshot.reports.map(({ endpoint }) => {
            const report = getProviderAccountRuntimeReport(providerSnapshot, account.id, endpoint);
            if (report?.execution !== 'blocked' && report?.execution !== 'unsupported') return null;
            return <p key={`${endpoint.runtimeAdapterId}/${endpoint.runtimeInstanceId}`} className="text-xs text-amber-700 dark:text-amber-300">{endpoint.runtimeAdapterId}: {providerDiagnosticError(report.diagnostic) ?? t(`aiProviders.execution.${report.execution}`)}</p>;
          })}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" variant="outline" size="sm" disabled={isMutating} onClick={onEdit}><Edit className="mr-2 h-3.5 w-3.5" />{t('aiProviders.card.edit')}</Button>
        <Button type="button" variant="ghost" size="icon" disabled={isMutating} onClick={onDelete} aria-label={t('aiProviders.card.delete')} title={t('aiProviders.card.delete')}>
          {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4 text-muted-foreground" />}
        </Button>
      </div>
    </div>
  );
}

interface ProviderConfigurationDialogProps {
  item?: ProviderListItem;
  models: ProviderModel[];
  modelsReady: boolean;
  modelsLoading: boolean;
  modelsError: string | null;
  existingVendorIds: ReadonlySet<string>;
  vendors: ProviderVendorInfo[];
  onClose: () => void;
  onSubmit: (account: ProviderCredential, secret: ProviderSecretInput, creating: boolean) => Promise<ProviderCredential>;
  onReplaceModels: (accountId: string, models: Omit<ProviderModel, 'accountId'>[]) => Promise<void>;
}

function ProviderConfigurationDialog({ item, models, modelsReady, modelsLoading, modelsError, existingVendorIds, vendors, onClose, onSubmit, onReplaceModels }: ProviderConfigurationDialogProps) {
  const { t, i18n } = useTranslation('settings');
  const [selection, setSelection] = useState<{ type: ProviderType; kind: 'brand' | 'variant'; active: boolean } | null>(() => item ? { type: item.account.vendorId, kind: 'brand', active: true } : null);
  const [completedAccount, setCompletedAccount] = useState<ProviderCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [accountLocked, setAccountLocked] = useState(Boolean(item));
  const vendorContributions = useContributions(providerVendors);
  const forms = useContributions(providerForms);
  const selectedType = selection?.active ? selection.type : null;
  const contribution = vendorContributions.find(({ info }) => info.id === selection?.type);
  const typeInfo = contribution?.info;
  const form = forms.find(({ id }) => id === contribution?.form);
  const AddForm = form?.add;
  const EditForm = form?.edit;
  const providerDocsUrl = getProviderDocsUrl(typeInfo, i18n.language);
  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const availableTypes = vendorContributions.filter((candidate) => {
    const info = candidate.info;
    if (candidate.conflict?.vendors.some((id) => existingVendorIds.has(id))) return false;
    const vendor = vendorMap.get(info.id);
    return vendor ? vendor.supportsMultipleAccounts || !existingVendorIds.has(info.id) : !existingVendorIds.has(info.id) || info.id === 'custom';
  }).map(({ info }) => info);
  const brandGroups = new Map<ProviderType, typeof availableTypes>();
  for (const type of availableTypes) {
    const brandId = type.brandId ?? type.id;
    const group = brandGroups.get(brandId) ?? [];
    group.push(type);
    brandGroups.set(brandId, group);
  }
  const brandVariants = typeInfo ? brandGroups.get(typeInfo.brandId ?? typeInfo.id) ?? [] : [];
  const common = {
    models, modelsReady, modelsLoading, modelsError, onSubmit, onReplaceModels, onBusyChange: setBusy, onAccountLocked: () => setAccountLocked(true),
    onSaved: () => { toast.success(t(item ? 'aiProviders.toast.updated' : 'aiProviders.toast.added')); onClose(); },
  };

  const content = (oauth: Parameters<import('../extensions').ProviderOAuthOwnerProps['children']>[0]): ReactNode => (
    <div className="space-y-5">
      {!selectedType ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {Array.from(brandGroups, ([brandId, variants]) => {
            const brand = vendorContributions.find(({ info }) => info.id === brandId)!.info;
            const type = variants.find((variant) => variant.id === brandId) ?? variants[0];
            return <button type="button" key={brandId} disabled={busy || oauth.flowing || oauth.outcome !== 'unconfirmed'} onClick={() => setSelection({ type: type.id, kind: 'brand', active: true })} className="flex items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {getProviderIconUrl(type.id) ? <img src={getProviderIconUrl(type.id)} alt="" className={cn('h-6 w-6 shrink-0', shouldInvertInDark(type.id) && 'dark:invert')} /> : <Key className="h-5 w-5" />}
              <span>{brand.id === 'custom' ? t('aiProviders.custom') : brand.name}</span>
            </button>;
          })}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 border-b pb-4">
          <div className="flex min-w-0 items-center gap-3">
            {getProviderIconUrl(selectedType) ? <img src={getProviderIconUrl(selectedType)} alt="" className={cn('h-6 w-6', shouldInvertInDark(selectedType) && 'dark:invert')} /> : <Key className="h-5 w-5" />}
            <p className="text-sm font-medium">{typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {providerDocsUrl ? <a href={providerDocsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">{t('aiProviders.dialog.customDoc')}<ExternalLink className="h-3 w-3" /></a> : null}
            {!accountLocked && !completedAccount && oauth.outcome === 'unconfirmed' ? <Button type="button" variant="ghost" size="sm" disabled={busy || oauth.flowing} onClick={() => setSelection((current) => current ? { ...current, active: false } : null)}>{t('aiProviders.dialog.change')}</Button> : null}
          </div>
        </div>
      )}
      {!accountLocked && !completedAccount && oauth.outcome === 'unconfirmed' && selectedType && brandVariants.length > 1 ? <div className="space-y-2">
        <Label htmlFor="provider-variant">{t('aiProviders.dialog.variant')}</Label>
        <Select id="provider-variant" value={selectedType} disabled={busy || oauth.flowing} onChange={(event) => setSelection({ type: event.target.value as ProviderType, kind: 'variant', active: true })}>
          {brandVariants.map((variant) => <option key={variant.id} value={variant.id}>{variant.name}</option>)}
        </Select>
      </div> : null}
      {contribution && selection ? <div hidden={!selection.active}>
        <Suspense fallback={<ProviderFormLoading />}>
          {item && EditForm ? <EditForm {...common} active={selection.active} account={item.account} vendor={contribution} accountVendor={item.vendor} status={item.status} onCancel={onClose} />
            : AddForm ? <AddForm {...common} active={selection.active} selection={selection.kind} vendor={contribution} accountVendor={vendorMap.get(selection.type)} existingVendorIds={existingVendorIds} oauth={oauth} completedAccount={completedAccount} onClose={onClose} /> : null}
        </Suspense>
      </div> : null}
      {!selectedType ? <div className="flex justify-end border-t pt-4"><Button variant="outline" onClick={onClose}>{t('aiProviders.dialog.cancel')}</Button></div> : null}
    </div>
  );

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[120] bg-[hsl(var(--shell-scrim))]" />
        <DialogPrimitive.Content onInteractOutside={(event) => event.preventDefault()} onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} className="fixed left-1/2 top-1/2 z-[121] flex max-h-[92vh] w-[min(calc(100vw-2rem),56rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[1.25rem] border bg-[hsl(var(--shell-surface))] shadow-[var(--shell-shadow-overlay)] [border-color:hsl(var(--shell-border))] focus:outline-none">
          <header className="flex shrink-0 items-start justify-between gap-4 border-b px-6 py-5">
            <div><DialogPrimitive.Title className="text-lg font-semibold">{t(item ? 'aiProviders.dialog.editTitle' : 'aiProviders.dialog.title')}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">{t('aiProviders.dialog.configureDescription')}</DialogPrimitive.Description></div>
            <Button type="button" variant="ghost" size="icon" disabled={busy} aria-label={t('aiProviders.dialog.cancel')} onClick={onClose}><X className="h-4 w-4" /></Button>
          </header>
          <div className="overflow-y-auto overscroll-contain px-6 pt-5 [scrollbar-gutter:stable]">
            <Suspense fallback={<ProviderFormLoading />}>
              <ProviderOAuthOwner onCompleted={(account) => { setCompletedAccount(account); setAccountLocked(true); }}>{content}</ProviderOAuthOwner>
            </Suspense>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
