import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
import { Separator } from '@/components/ui/separator';
import { ProviderCredentialModelsEditor } from '@/plugins/providers/components/ProviderCredentialModelsEditor';
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
  buildProviderCredentialId,
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
  type ProviderAccountDraft,
  type ProviderEditPayload,
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
  const modelCatalogSaving = useProviderModelCatalogStore((state) => state.saving);
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

  const handleAddProvider = async (draft: ProviderAccountDraft, secret: ProviderSecretInput) => {
    const id = buildProviderCredentialId(draft.vendorId, null, vendors);
    try {
      await createAccount({
        ...draft,
        id,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, secret.apiKey, secret.token);
      setShowAddDialog(false);
      toast.success(t('aiProviders.toast.added'));
    } catch (addError) {
      toast.error(`${t('aiProviders.toast.failedAdd')}: ${addError}`);
    }
  };

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
              modelCatalogReady={modelCatalogReady}
              modelCatalogLoading={modelCatalogLoading}
              modelCatalogSaving={modelCatalogSaving}
              modelCatalogError={modelCatalogError}
              providerSnapshot={providerSnapshot}
              isMutating={Boolean(mutatingActionsByAccountId[item.account.id])}
              isDeleting={Boolean(mutatingActionsByAccountId[item.account.id]?.delete)}
              isEditing={editingProvider === item.account.id}
              onEdit={() => setEditingProvider(item.account.id)}
              onCancelEdit={() => setEditingProvider(null)}
              onDelete={async () => {
                try {
                  await removeAccount(item.account.id);
                  toast.success(t('aiProviders.toast.deleted'));
                } catch (deleteError) {
                  toast.error(`${t('aiProviders.toast.failedDelete')}: ${deleteError}`);
                }
              }}
              onSaveEdits={async (payload) => {
                await updateAccount(item.account.id, payload.updates ?? {}, payload.newApiKey, payload.token);
                setEditingProvider(null);
              }}
              onReplaceModels={(next) => replaceAccountModels(item.account.id, next)}
            />
          ))}
        </div>
      )}

      </CardContent> : null}
      {showAddDialog ? (
        <AddProviderDialog
          existingVendorIds={existingVendorIds}
          vendors={vendors}
          onClose={() => setShowAddDialog(false)}
          onAdd={handleAddProvider}
        />
      ) : null}
    </Card>
  );
}

interface ProviderCardProps {
  item: ProviderListItem;
  models: ProviderModel[];
  modelCatalogReady: boolean;
  modelCatalogLoading: boolean;
  modelCatalogSaving: boolean;
  modelCatalogError: string | null;
  providerSnapshot: ProviderSnapshot;
  isMutating: boolean;
  isDeleting: boolean;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onSaveEdits: (payload: ProviderEditPayload) => Promise<void>;
  onReplaceModels: (next: Omit<ProviderModel, 'accountId'>[]) => Promise<void>;
}

function ProviderCard({
  item,
  models,
  modelCatalogReady,
  modelCatalogLoading,
  modelCatalogSaving,
  modelCatalogError,
  providerSnapshot,
  isMutating,
  isDeleting,
  isEditing,
  onEdit,
  onCancelEdit,
  onDelete,
  onSaveEdits,
  onReplaceModels,
}: ProviderCardProps) {
  const { t, i18n } = useTranslation('settings');
  const { account, vendor, status } = item;
  const vendorContributions = useContributions(providerVendors);
  const authMethods = useContributions(providerAuthMethods);
  const forms = useContributions(providerForms);
  const contribution = vendorContributions.find(({ info }) => info.id === account.vendorId);
  const typeInfo = contribution?.info;
  const form = forms.find(({ id }) => id === contribution?.form);
  const authMethod = authMethods.flatMap(({ methods }) => methods).find(({ id }) => id === account.authMode);
  const authLabel = authMethod ? t(authMethod.label) : account.authMode;
  const usesStoredCredential = authMethod?.input === 'apiKey' || authMethod?.input === 'token';
  const [open, setOpen] = useState(false);
  const [editMounted, setEditMounted] = useState(false);
  if (isEditing && !editMounted) setEditMounted(true);
  const EditForm = form?.edit;
  const providerDocsUrl = getProviderDocsUrl(typeInfo, i18n.language);
  const isMediaCredential = account.vendorId === 'custom' && account.providerKind === 'media';
  const mediaContract = getCustomMediaContract(account.mediaApiProtocol);
  const displayAccountLabel = resolveAccountLabel(account, t('aiProviders.custom'));
  const effectiveVendor = vendor ?? {
    id: account.vendorId,
    name: account.vendorId,
    icon: typeInfo?.icon ?? '',
    placeholder: typeInfo?.placeholder ?? '',
    requiresApiKey: typeInfo?.requiresApiKey ?? true,
    category: 'custom',
    supportedAuthModes: [account.authMode],
    defaultAuthMode: account.authMode,
    supportsMultipleAccounts: true,
    modelCapabilities: typeInfo?.modelCapabilities,
  } satisfies ProviderVendorInfo;

  const [editConfig, setEditConfig] = useState({ isEditing, apiProtocol: account.apiProtocol, baseUrl: account.baseUrl, typeInfo });
  if (editConfig.isEditing !== isEditing || editConfig.apiProtocol !== account.apiProtocol
    || editConfig.baseUrl !== account.baseUrl || editConfig.typeInfo !== typeInfo) {
    setEditConfig({ isEditing, apiProtocol: account.apiProtocol, baseUrl: account.baseUrl, typeInfo });
    if (isEditing) setOpen(true);
  }

  return (
    <Card className="overflow-hidden rounded-[1.25rem] bg-[hsl(var(--shell-surface-muted))] [border-color:hsl(var(--shell-border))]">
      <CardContent className="p-0">
        <div className={cn('flex items-start justify-between gap-3 px-4 py-3', open && 'border-b border-border/70')}>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
          >
            {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
            {getProviderIconUrl(account.vendorId) ? (
              <img
                src={getProviderIconUrl(account.vendorId)}
                alt={typeInfo?.name || account.vendorId}
                className={cn('h-5 w-5', shouldInvertInDark(account.vendorId) && 'dark:invert')}
              />
            ) : (
              <span className="text-xl">{vendor?.icon || typeInfo?.icon || '⚙️'}</span>
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 truncate font-semibold">{displayAccountLabel}</span>
                <Badge variant="secondary" className="shrink-0">{vendor?.name || account.vendorId}</Badge>
                {isMediaCredential ? <Badge variant="outline" className="shrink-0">{t('aiProviders.dialog.mediaProvider')}</Badge> : null}
                <Badge variant="outline" className="shrink-0">{authLabel}</Badge>
              </div>
              <div className="mt-1 space-y-0.5">
                <p className="text-xs text-muted-foreground">
                  {isMediaCredential
                    ? mediaContract?.label || account.mediaApiProtocol || t('aiProviders.dialog.mediaProvider')
                    : account.vendorId}
                </p>
                {account.baseUrl ? (
                  <p className="truncate text-xs text-muted-foreground">{account.baseUrl}</p>
                ) : null}
                {providerSnapshot.reports.map(({ endpoint }) => {
                  const report = getProviderAccountRuntimeReport(providerSnapshot, account.id, endpoint);
                  if (report?.execution !== 'blocked' && report?.execution !== 'unsupported') return null;
                  const diagnostic = providerDiagnosticError(report.diagnostic);
                  return (
                    <p key={`${endpoint.runtimeAdapterId}/${endpoint.runtimeInstanceId}`} className="text-xs text-amber-700 dark:text-amber-300">
                      {endpoint.runtimeAdapterId}: {diagnostic ?? t(`aiProviders.execution.${report.execution}`)}
                    </p>
                  );
                })}
              </div>
            </div>
          </button>
          <div className="flex flex-col items-end gap-2">
            {isEditing ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onCancelEdit}
                aria-label={t('aiProviders.dialog.cancel')}
                title={t('aiProviders.dialog.cancel')}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            ) : null}
              {providerDocsUrl ? (
                <a
                  href={providerDocsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  {t('aiProviders.dialog.customDoc')}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
          </div>
        </div>

        {open || editMounted ? <div className="px-4 py-3" hidden={!open}>
          {editMounted ? (
            <Suspense fallback={isEditing ? <ProviderFormLoading /> : null}>
              {EditForm && contribution ? (
                <EditForm active={isEditing} account={account} vendor={contribution} status={status} onSubmit={onSaveEdits} onCancel={onCancelEdit} />
              ) : null}
            </Suspense>
          ) : null}
          {!isEditing && open ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg bg-muted/45 px-3 py-2">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <Key className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  {!usesStoredCredential ? (
                    <Badge variant="secondary" className="shrink-0 text-xs">{authLabel}</Badge>
                  ) : (
                    <>
                      <span className="truncate font-mono text-sm text-muted-foreground">
                        {status?.hasKey
                          ? (status.keyMasked && status.keyMasked.length > 12
                            ? `${status.keyMasked.substring(0, 4)}...${status.keyMasked.substring(status.keyMasked.length - 4)}`
                            : status.keyMasked)
                          : t(status ? 'aiProviders.card.noKey' : 'aiProviders.card.credentialUnknown')}
                      </span>
                      {status?.hasKey ? (
                        <Badge variant="secondary" className="shrink-0 text-xs">{t('aiProviders.card.configured')}</Badge>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
              <div className="ml-2 flex shrink-0 gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onEdit}
                  title={t('aiProviders.card.editKey')}
                  disabled={isMutating}
                >
                  <Edit className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onDelete}
                  title={t('aiProviders.card.delete')}
                  disabled={isMutating}
                >
                  {isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : <Trash2 className="h-3.5 w-3.5 text-destructive" />}
                </Button>
              </div>
            </div>
            <ProviderCredentialModelsEditor
              credential={account}
              vendor={effectiveVendor}
              models={models}
              ready={modelCatalogReady}
              loading={modelCatalogLoading}
              saving={modelCatalogSaving}
              error={modelCatalogError}
              onReplace={onReplaceModels}
            />
          </div>
          ) : null}
        </div> : null}
      </CardContent>
    </Card>
  );
}

interface AddProviderDialogProps {
  existingVendorIds: ReadonlySet<string>;
  vendors: ProviderVendorInfo[];
  onClose: () => void;
  onAdd: (draft: ProviderAccountDraft, secret: ProviderSecretInput) => Promise<void>;
}

function AddProviderDialog({
  existingVendorIds,
  vendors,
  onClose,
  onAdd,
}: AddProviderDialogProps) {
  const { t, i18n } = useTranslation('settings');
  const [selection, setSelection] = useState<{
    type: ProviderType;
    kind: 'brand' | 'variant';
    active: boolean;
  } | null>(null);
  const selectedType = selection?.active ? selection.type : null;
  const vendorContributions = useContributions(providerVendors);
  const forms = useContributions(providerForms);
  const contribution = vendorContributions.find(({ info }) => info.id === selection?.type);
  const typeInfo = contribution?.info;
  const form = forms.find(({ id }) => id === contribution?.form);
  const AddForm = form?.add;
  const providerDocsUrl = getProviderDocsUrl(typeInfo, i18n.language);
  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const selectedVendor = selection ? vendorMap.get(selection.type) : undefined;
  const availableTypes = vendorContributions.filter((candidate) => {
    const type = candidate.info;
    if (candidate.conflict?.vendors.some((id) => existingVendorIds.has(id))) return false;
    const vendor = vendorMap.get(type.id);
    if (!vendor) return !existingVendorIds.has(type.id) || type.id === 'custom';
    return vendor.supportsMultipleAccounts || !existingVendorIds.has(type.id);
  }).map(({ info }) => info);

  const brandGroups = new Map<ProviderType, typeof availableTypes>();
  for (const type of availableTypes) {
    const brandId = type.brandId ?? type.id;
    const group = brandGroups.get(brandId) ?? [];
    group.push(type);
    brandGroups.set(brandId, group);
  }
  const brandVariants = typeInfo ? brandGroups.get(typeInfo.brandId ?? typeInfo.id) ?? [] : [];
  const availableBrands = Array.from(brandGroups, ([brandId, variants]) => ({
    brand: vendorContributions.find(({ info }) => info.id === brandId)!.info,
    type: variants.find((type) => type.id === brandId) ?? variants[0],
  }));

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[hsl(var(--shell-scrim))] p-4">
      <section
        role="dialog"
        aria-label={t('aiProviders.dialog.title')}
        className="max-h-[92vh] w-full max-w-4xl overflow-y-auto overscroll-contain rounded-[1.25rem] border bg-[hsl(var(--shell-surface))] p-6 shadow-[var(--shell-shadow-overlay)] [border-color:hsl(var(--shell-border))] [scrollbar-gutter:stable]"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{t('aiProviders.dialog.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('aiProviders.dialog.desc')}</p>
          </div>
          <Button variant="ghost" size="icon" aria-label={t('aiProviders.dialog.cancel')} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>
        <Suspense fallback={<ProviderFormLoading />}>
          <ProviderOAuthOwner
            onCompleted={() => {
              onClose();
              toast.success(t('aiProviders.toast.added'));
            }}
          >
            {(oauth) => (
                <div className="mt-5 space-y-4">
                  {!selectedType ? (
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                      {availableBrands.map(({ brand, type }) => (
                        <button
                          key={type.id}
                          onClick={() => setSelection({ type: type.id, kind: 'brand', active: true })}
                          className="rounded-lg border p-4 text-center transition-colors hover:bg-accent"
                        >
                          {getProviderIconUrl(type.id) ? (
                            <img
                              src={getProviderIconUrl(type.id)}
                              alt={type.name}
                              className={cn('mx-auto h-7 w-7', shouldInvertInDark(type.id) && 'dark:invert')}
                            />
                          ) : (
                            <span className="text-2xl">{type.icon}</span>
                          )}
                          <p className="mt-2 font-medium">{brand.id === 'custom' ? t('aiProviders.custom') : brand.name}</p>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex min-w-0 items-center gap-3 rounded-lg bg-muted p-3">
                        {getProviderIconUrl(selectedType) ? (
                          <img
                            src={getProviderIconUrl(selectedType)}
                            alt={typeInfo?.name}
                            className={cn('h-7 w-7', shouldInvertInDark(selectedType) && 'dark:invert')}
                          />
                        ) : (
                          <span className="text-2xl">{typeInfo?.icon}</span>
                        )}
                        <div className="min-w-0">
                          <p className="truncate font-medium">{typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name}</p>
                          <button
                            onClick={() => setSelection((current) => current ? { ...current, active: false } : null)}
                            className="text-sm text-muted-foreground hover:text-foreground"
                          >
                            {t('aiProviders.dialog.change')}
                          </button>
                          {providerDocsUrl ? (
                            <>
                              <span className="mx-2 text-foreground/20">|</span>
                              <a
                                href={providerDocsUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[13px] font-medium text-blue-500 hover:text-blue-600"
                              >
                                {t('aiProviders.dialog.customDoc')}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            </>
                          ) : null}
                        </div>
                      </div>
                      {brandVariants.length > 1 ? (
                        <div className="space-y-2">
                          <Label htmlFor="provider-variant">{t('aiProviders.dialog.variant')}</Label>
                          <Select
                            id="provider-variant"
                            value={selectedType}
                            disabled={oauth.flowing}
                            onChange={(event) => {
                              const next = brandVariants.find((variant) => variant.id === event.target.value)!;
                              setSelection({ type: next.id, kind: 'variant', active: true });
                            }}
                          >
                            {brandVariants.map((variant) => <option key={variant.id} value={variant.id}>{variant.name}</option>)}
                          </Select>
                        </div>
                      ) : null}
                    </div>
                  )}
                  {AddForm && contribution && selection ? (
                    <div hidden={!selection.active} className="space-y-4">
                      <Suspense fallback={<ProviderFormLoading />}>
                        <AddForm
                          active={selection.active}
                          selection={selection.kind}
                          vendor={contribution}
                          accountVendor={selectedVendor}
                          existingVendorIds={existingVendorIds}
                          oauth={oauth}
                          onSubmit={onAdd}
                          onClose={onClose}
                        />
                      </Suspense>
                    </div>
                  ) : null}
                  {!selectedType ? (
                    <>
                      <Separator />
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" onClick={onClose}>{t('aiProviders.dialog.cancel')}</Button>
                        <Button disabled>{t('aiProviders.dialog.add')}</Button>
                      </div>
                    </>
                  ) : null}
                </div>
            )}
          </ProviderOAuthOwner>
        </Suspense>
      </section>
    </div>,
    document.body,
  );
}
