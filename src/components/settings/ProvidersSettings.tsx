import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Edit,
  ExternalLink,
  Eye,
  EyeOff,
  Key,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { ProviderCredentialModelsEditor } from '@/components/settings/ProviderCredentialModelsEditor';
import { useProviderStore, type ProviderCredential, type ProviderVendorInfo } from '@/stores/providers';
import { useProviderModelCatalogStore } from '@/stores/provider-model-catalog';
import {
  type ProviderModel,
} from '@/lib/provider-model-catalog';
import {
  PROVIDER_TYPE_INFO,
  getProviderDocsUrl,
  getProviderIconUrl,
  normalizeProviderApiKeyInput,
  resolveProviderApiKeyForSave,
  shouldInvertInDark,
  type ProviderType,
} from '@/lib/providers';
import { CUSTOM_MEDIA_CONTRACTS, getCustomMediaContract } from '@/lib/custom-media-provider-contracts';
import {
  buildProviderCredentialId,
  buildProviderListItems,
  type ProviderListItem,
} from '@/lib/provider-accounts';
import {
  hostProviderCancelOAuth,
  hostProviderStartOAuth,
  hostProviderSubmitOAuthCode,
} from '@/lib/provider-projection';
import { invokeIpc } from '@/lib/api-client';
import { subscribeHostEvent } from '@/lib/host-events';
import { isGatewayOperational } from '@/lib/gateway-status';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import { useGatewayStore } from '@/stores/gateway';
import { cn } from '@/lib/utils';

function getProtocolBaseUrlPlaceholder(apiProtocol: ProviderCredential['apiProtocol']): string {
  if (apiProtocol === 'anthropic-messages') {
    return 'https://api.example.com/anthropic';
  }
  return 'https://api.example.com/v1';
}

function stripUserAgentHeader(headers?: Record<string, string>): Record<string, string> | undefined {
  const next = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() !== 'user-agent'),
  );
  return Object.keys(next).length > 0 ? next : undefined;
}

function getProviderConflictToastKey(type: ProviderType, existingVendorIds: Set<string>): string | null {
  const hasMinimax = existingVendorIds.has('minimax-portal') || existingVendorIds.has('minimax-portal-cn');
  if ((type === 'minimax-portal' || type === 'minimax-portal-cn') && hasMinimax) {
    return 'aiProviders.toast.minimaxConflict';
  }
  const hasZai = existingVendorIds.has('zai') || existingVendorIds.has('zai-global');
  if ((type === 'zai' || type === 'zai-global') && hasZai) {
    return 'aiProviders.toast.zaiConflict';
  }
  return null;
}

function resolveCodePlanBaseUrl(type: ProviderType | string, enabled: boolean): string | undefined {
  if (!enabled) return undefined;
  return PROVIDER_TYPE_INFO.find((info) => info.id === type)?.codePlan?.baseUrl;
}

function isCodePlanBaseUrl(type: ProviderType | string, baseUrl: string | undefined): boolean {
  const codePlanBaseUrl = PROVIDER_TYPE_INFO.find((info) => info.id === type)?.codePlan?.baseUrl;
  return Boolean(codePlanBaseUrl && baseUrl === codePlanBaseUrl);
}

function getAuthModeLabel(authMode: ProviderCredential['authMode'], t: (key: string) => string): string {
  switch (authMode) {
    case 'api_key':
      return t('aiProviders.authModes.apiKey');
    case 'oauth_device':
      return t('aiProviders.authModes.oauthDevice');
    case 'oauth_browser':
      return t('aiProviders.authModes.oauthBrowser');
    case 'token':
      return t('aiProviders.authModes.token');
    case 'cli_reuse':
      return t('aiProviders.authModes.cliReuse');
    case 'local':
      return t('aiProviders.authModes.local');
    default:
      return authMode;
  }
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
    warning,
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
  const modelCatalogWarning = useProviderModelCatalogStore((state) => state.warning);
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

  const handleAddProvider = async (
    type: ProviderType,
    name: string,
    apiKey: string,
    options?: {
      token?: string;
      baseUrl?: string;
      apiProtocol?: ProviderCredential['apiProtocol'];
      headers?: Record<string, string>;
      authMode?: ProviderCredential['authMode'];
      providerKind?: ProviderCredential['providerKind'];
      mediaApiProtocol?: ProviderCredential['mediaApiProtocol'];
    },
  ) => {
    const vendor = vendors.find((item) => item.id === type);
    const id = buildProviderCredentialId(type, null, vendors);
    const effectiveApiKey = resolveProviderApiKeyForSave(type, apiKey);
    try {
      await createAccount({
        id,
        vendorId: type,
        providerKind: options?.providerKind ?? 'chat',
        label: name,
        authMode: options?.authMode || vendor?.defaultAuthMode || (type === 'ollama' ? 'local' : 'api_key'),
        baseUrl: options?.baseUrl,
        apiProtocol: (options?.providerKind ?? 'chat') === 'chat' ? options?.apiProtocol : undefined,
        mediaApiProtocol: options?.mediaApiProtocol,
        headers: options?.headers,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, effectiveApiKey, options?.token);
      setShowAddDialog(false);
      toast.success(t('aiProviders.toast.added'));
    } catch (addError) {
      toast.error(`${t('aiProviders.toast.failedAdd')}: ${addError}`);
    }
  };

  return (
    <Card className="overflow-hidden rounded-lg">
      <CardHeader className={cn('pb-4', open && 'border-b border-border/70')}>
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
      ) : !error && warning ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {warning}
        </div>
      ) : null}

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
              modelCatalogWarning={modelCatalogWarning}
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
  modelCatalogWarning: string | null;
  isMutating: boolean;
  isDeleting: boolean;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onSaveEdits: (payload: { newApiKey?: string; token?: string; updates?: Partial<ProviderCredential> }) => Promise<void>;
  onReplaceModels: (next: Omit<ProviderModel, 'accountId'>[]) => Promise<void>;
}

function ProviderCard({
  item,
  models,
  modelCatalogReady,
  modelCatalogLoading,
  modelCatalogSaving,
  modelCatalogError,
  modelCatalogWarning,
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
  const [newKey, setNewKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(account.baseUrl || '');
  const [codePlanEnabled, setCodePlanEnabled] = useState(() => isCodePlanBaseUrl(account.vendorId, account.baseUrl));
  const [apiProtocol, setApiProtocol] = useState<ProviderCredential['apiProtocol']>(
    account.apiProtocol || 'openai-completions',
  );
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const typeInfo = PROVIDER_TYPE_INFO.find((type) => type.id === account.vendorId);
  const providerDocsUrl = getProviderDocsUrl(typeInfo, i18n.language);
  const sanitizedHeaders = stripUserAgentHeader(account.headers);
  const hasLegacyUserAgentHeader = Object.keys(account.headers ?? {}).length
    !== Object.keys(sanitizedHeaders ?? {}).length;
  const normalizedNewKey = normalizeProviderApiKeyInput(newKey);
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

  useEffect(() => {
    if (!isEditing) return;
    setOpen(true);
    setNewKey('');
    setShowKey(false);
    setBaseUrl(account.baseUrl || '');
    setCodePlanEnabled(isCodePlanBaseUrl(account.vendorId, account.baseUrl));
    setApiProtocol(account.apiProtocol || 'openai-completions');
  }, [account.apiProtocol, account.baseUrl, account.vendorId, isEditing]);

  useEffect(() => {
    if (!isEditing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancelEdit();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isEditing, onCancelEdit]);

  const canEditRuntimeConfig = Boolean(!isMediaCredential && (typeInfo?.showBaseUrl || account.vendorId === 'custom' || account.vendorId === 'ollama'));
  const effectiveBaseUrl = resolveCodePlanBaseUrl(account.vendorId, codePlanEnabled) ?? (baseUrl.trim() || undefined);
  const hasConfigChanges = (typeInfo?.showBaseUrl && effectiveBaseUrl !== (account.baseUrl || undefined))
    || (!isMediaCredential && (account.vendorId === 'custom' || account.vendorId === 'ollama')
      && (apiProtocol || 'openai-completions') !== (account.apiProtocol || 'openai-completions'))
    || (!isMediaCredential && Boolean(typeInfo?.apiProtocol && typeInfo.apiProtocol !== account.apiProtocol))
    || hasLegacyUserAgentHeader;

  const handleSaveEdits = async () => {
    setSaving(true);
    try {
      const payload: { newApiKey?: string; token?: string; updates?: Partial<ProviderCredential> } = {};
      if (normalizedNewKey) {
        if (account.authMode === 'token') payload.token = normalizedNewKey;
        else payload.newApiKey = normalizedNewKey;
      }

      const updates: Partial<ProviderCredential> = {};
      if (typeInfo?.showBaseUrl && effectiveBaseUrl !== (account.baseUrl || undefined)) {
        updates.baseUrl = effectiveBaseUrl;
      }
      if (
        !isMediaCredential
        && (account.vendorId === 'custom' || account.vendorId === 'ollama')
        && (apiProtocol || 'openai-completions') !== (account.apiProtocol || 'openai-completions')
      ) {
        updates.apiProtocol = apiProtocol || 'openai-completions';
      }
      if (!isMediaCredential && typeInfo?.apiProtocol && typeInfo.apiProtocol !== account.apiProtocol) {
        updates.apiProtocol = typeInfo.apiProtocol;
      }
      if (hasLegacyUserAgentHeader) {
        updates.headers = sanitizedHeaders;
      }
      if (Object.keys(updates).length > 0) {
        payload.updates = updates;
      }
      if (account.vendorId === 'ollama' && !status?.hasKey && !payload.newApiKey) {
        payload.newApiKey = resolveProviderApiKeyForSave(account.vendorId, '') as string;
      }
      if (!payload.newApiKey && !payload.token && !payload.updates && account.authMode !== 'cli_reuse') {
        onCancelEdit();
        return;
      }
      await onSaveEdits(payload);
      setNewKey('');
      toast.success(t('aiProviders.toast.updated'));
    } catch (saveError) {
      toast.error(`${t('aiProviders.toast.failedUpdate')}: ${saveError}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="overflow-hidden rounded-lg">
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
                <Badge variant="outline" className="shrink-0">{getAuthModeLabel(account.authMode, t)}</Badge>
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

        {open ? <div className="px-4 py-3">
          {isEditing ? (
          <div className="space-y-3">
            {canEditRuntimeConfig ? (
              <div className="space-y-3 rounded-lg border border-border/80 bg-muted/20 p-3">
                <p className="text-sm font-medium">{t('aiProviders.sections.credentials')}</p>
                {typeInfo?.codePlan?.baseUrl ? (
                  <label className="flex items-center justify-between gap-3 rounded-md bg-background px-3 py-2 text-sm">
                    <span>{t('aiProviders.dialog.codePlanMode')}</span>
                    <input
                      type="checkbox"
                      checked={codePlanEnabled}
                      onChange={(event) => {
                        setCodePlanEnabled(event.target.checked);
                      }}
                    />
                  </label>
                ) : null}
                {typeInfo?.endpointPresets?.length ? (
                  <div className="space-y-1">
                    <Label htmlFor={`provider-edit-endpoint-${account.id}`} className="text-xs">{t('aiProviders.dialog.endpointPreset')}</Label>
                    <Select id={`provider-edit-endpoint-${account.id}`} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)}>
                      {!typeInfo.endpointPresets.some((preset) => preset.baseUrl === baseUrl) ? <option value={baseUrl}>{t('aiProviders.custom')}</option> : null}
                      {typeInfo.endpointPresets.map((preset) => <option key={preset.id} value={preset.baseUrl}>{preset.label}</option>)}
                    </Select>
                  </div>
                ) : null}
                {typeInfo?.showBaseUrl ? (
                  <div className="space-y-1">
                    <Label htmlFor={`provider-edit-base-url-${account.id}`} className="text-xs">
                      {t('aiProviders.dialog.baseUrl')}
                    </Label>
                    <Input
                      id={`provider-edit-base-url-${account.id}`}
                      value={codePlanEnabled ? typeInfo?.codePlan?.baseUrl ?? '' : baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder={getProtocolBaseUrlPlaceholder(apiProtocol)}
                      disabled={codePlanEnabled}
                      className="h-9 text-sm"
                    />
                  </div>
                ) : null}
                {account.vendorId === 'custom' && !isMediaCredential ? (
                  <div className="space-y-1">
                    <Label htmlFor={`provider-edit-protocol-${account.id}`} className="text-xs">
                      {t('aiProviders.dialog.protocol')}
                    </Label>
                    <Select
                      id={`provider-edit-protocol-${account.id}`}
                      value={apiProtocol}
                      onChange={(event) => setApiProtocol(event.target.value as ProviderCredential['apiProtocol'])}
                      className="h-9 text-sm"
                    >
                      <option value="openai-completions">{t('aiProviders.protocols.openaiCompletions')}</option>
                      <option value="openai-responses">{t('aiProviders.protocols.openaiResponses')}</option>
                      <option value="anthropic-messages">{t('aiProviders.protocols.anthropic')}</option>
                    </Select>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="space-y-3 rounded-lg border border-border/80 bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">{getAuthModeLabel(account.authMode, t)}</Label>
                  <p className="text-xs text-muted-foreground">
                    {status?.hasKey ? t('aiProviders.dialog.apiKeyConfigured') : t('aiProviders.dialog.apiKeyMissing')}
                  </p>
                </div>
                {status?.hasKey ? <Badge variant="secondary">{t('aiProviders.card.configured')}</Badge> : null}
              </div>
              {typeInfo?.apiKeyUrl ? (
                <a
                  href={typeInfo.apiKeyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                  tabIndex={-1}
                >
                  {t('aiProviders.oauth.getApiKey')} <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
              {account.authMode === 'cli_reuse' ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">{t('aiProviders.dialog.cliReuseHelp')}</p>
                  <Button size="sm" onClick={handleSaveEdits} disabled={saving}>
                    {saving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                    {t('aiProviders.dialog.save')}
                  </Button>
                </div>
              ) : <div className="space-y-1">
                <Label className="text-xs">{account.authMode === 'token' ? t('aiProviders.dialog.replaceToken') : t('aiProviders.dialog.replaceApiKey')}</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      data-testid={`provider-edit-key-input-${account.id}`}
                      type={showKey ? 'text' : 'password'}
                      placeholder={typeInfo?.requiresApiKey ? typeInfo?.placeholder : (typeInfo?.id === 'ollama' ? t('aiProviders.notRequired') : t('aiProviders.card.editKey'))}
                      disabled={account.authMode === 'oauth_browser' || account.authMode === 'oauth_device'}
                      value={newKey}
                      onChange={(event) => {
                        setNewKey(event.target.value);
                      }}
                      className="h-9 pr-10 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                  <Button
                    data-testid={`provider-edit-save-${account.id}`}
                    variant="outline"
                    size="sm"
                    onClick={handleSaveEdits}
                    disabled={saving || (!normalizedNewKey && !hasConfigChanges)}
                  >
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t('aiProviders.dialog.replaceApiKeyHelp')}</p>
              </div>}
            </div>
          </div>
          ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg bg-muted/45 px-3 py-2">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <Key className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  {account.authMode === 'oauth_device' || account.authMode === 'oauth_browser' ? (
                    <Badge variant="secondary" className="shrink-0 text-xs">{t('aiProviders.card.configured')}</Badge>
                  ) : (
                    <>
                      <span className="truncate font-mono text-sm text-muted-foreground">
                        {status?.hasKey
                          ? (status.keyMasked && status.keyMasked.length > 12
                            ? `${status.keyMasked.substring(0, 4)}...${status.keyMasked.substring(status.keyMasked.length - 4)}`
                            : status.keyMasked)
                          : t('aiProviders.card.noKey')}
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
              warning={modelCatalogWarning}
              onReplace={onReplaceModels}
            />
          </div>
          )}
        </div> : null}
      </CardContent>
    </Card>
  );
}

interface AddProviderDialogProps {
  existingVendorIds: Set<string>;
  vendors: ProviderVendorInfo[];
  onClose: () => void;
  onAdd: (
    type: ProviderType,
    name: string,
    apiKey: string,
    options?: {
      token?: string;
      baseUrl?: string;
      apiProtocol?: ProviderCredential['apiProtocol'];
      headers?: Record<string, string>;
      authMode?: ProviderCredential['authMode'];
      providerKind?: ProviderCredential['providerKind'];
      mediaApiProtocol?: ProviderCredential['mediaApiProtocol'];
    },
  ) => Promise<void>;
}

function AddProviderDialog({
  existingVendorIds,
  vendors,
  onClose,
  onAdd,
}: AddProviderDialogProps) {
  const { t, i18n } = useTranslation('settings');
  const [selectedType, setSelectedType] = useState<ProviderType | null>(null);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [codePlanEnabled, setCodePlanEnabled] = useState(false);
  const [apiProtocol, setApiProtocol] = useState<ProviderCredential['apiProtocol']>('openai-completions');
  const [customKind, setCustomKind] = useState<ProviderCredential['providerKind']>('chat');
  const [mediaApiProtocol, setMediaApiProtocol] = useState<ProviderCredential['mediaApiProtocol']>('openai');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [oauthFlowing, setOauthFlowing] = useState(false);
  const [oauthData, setOauthData] = useState<{
    mode: 'device';
    verificationUri: string;
    userCode: string;
    expiresIn: number;
  } | {
    mode: 'manual';
    authorizationUrl: string;
    message?: string;
  } | null>(null);
  const [manualCodeInput, setManualCodeInput] = useState('');
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<ProviderCredential['authMode']>('api_key');

  const typeInfo = PROVIDER_TYPE_INFO.find((type) => type.id === selectedType);
  const providerDocsUrl = getProviderDocsUrl(typeInfo, i18n.language);
  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const selectedVendor = selectedType ? vendorMap.get(selectedType) : undefined;
  const selectedMediaContract = getCustomMediaContract(mediaApiProtocol);
  const isCustomMedia = selectedType === 'custom' && customKind === 'media';
  const useOAuthFlow = authMode === 'oauth_browser' || authMode === 'oauth_device';
  const effectiveBaseUrl = selectedType
    ? resolveCodePlanBaseUrl(selectedType, codePlanEnabled) ?? (baseUrl.trim() || undefined)
    : undefined;
  const normalizedApiKey = normalizeProviderApiKeyInput(apiKey);

  useEffect(() => {
    if (!selectedMediaContract) return;
    setBaseUrl(selectedMediaContract.defaultBaseUrl ?? '');
  }, [mediaApiProtocol, selectedMediaContract]);

  const latestRef = useRef({ selectedType, typeInfo, onClose, t });
  const [pendingOAuth, setPendingOAuth] = useState<{ flowId: string; accountId: string; vendorId: string; label: string } | null>(null);
  useEffect(() => {
    latestRef.current = { selectedType, typeInfo, onClose, t };
  });

  useEffect(() => {
    const handleCode = (data: unknown) => {
      const payload = data as Record<string, unknown>;
      if (payload?.mode === 'manual') {
        setOauthData({
          mode: 'manual',
          authorizationUrl: String(payload.authorizationUrl || ''),
          message: typeof payload.message === 'string' ? payload.message : undefined,
        });
      } else {
        setOauthData({
          mode: 'device',
          verificationUri: String(payload.verificationUri || ''),
          userCode: String(payload.userCode || ''),
          expiresIn: Number(payload.expiresIn || 300),
        });
      }
      setOauthError(null);
    };

    const handleSuccess = async () => {
      setOauthFlowing(false);
      setOauthData(null);
      setManualCodeInput('');
      setValidationError(null);
      try {
        await useProviderStore.getState().refreshProviderSnapshot({
          trigger: 'reconcile',
          reason: 'oauth_success_reconcile',
        });
      } catch (refreshError) {
        console.error('Failed to refresh providers after OAuth:', refreshError);
      }
      setPendingOAuth(null);
      latestRef.current.onClose();
      toast.success(latestRef.current.t('aiProviders.toast.added'));
    };

    const handleError = (data: unknown) => {
      setOauthError((data as { message: string }).message);
      setOauthData(null);
      setPendingOAuth(null);
    };

    const offCode = subscribeHostEvent('oauth:code', handleCode);
    const offSuccess = subscribeHostEvent('oauth:success', handleSuccess);
    const offError = subscribeHostEvent('oauth:error', handleError);
    return () => {
      offCode();
      offSuccess();
      offError();
    };
  }, [latestRef]);

  const availableTypes = PROVIDER_TYPE_INFO.filter((type) => {
    if (getProviderConflictToastKey(type.id, existingVendorIds)) {
      return false;
    }
    const vendor = vendorMap.get(type.id);
    if (!vendor) {
      return !existingVendorIds.has(type.id) || type.id === 'custom';
    }
    return vendor.supportsMultipleAccounts || !existingVendorIds.has(type.id);
  });

  const brandGroups = new Map<ProviderType, typeof availableTypes>();
  for (const type of availableTypes) {
    const brandId = type.brandId ?? type.id;
    const group = brandGroups.get(brandId) ?? [];
    group.push(type);
    brandGroups.set(brandId, group);
  }
  const brandVariants = typeInfo ? brandGroups.get(typeInfo.brandId ?? typeInfo.id) ?? [] : [];
  const availableBrands = Array.from(brandGroups, ([brandId, variants]) => ({
    brand: PROVIDER_TYPE_INFO.find((type) => type.id === brandId)!,
    type: variants.find((type) => type.id === brandId) ?? variants[0],
  }));

  const handleStartOAuth = async () => {
    if (!selectedType) return;
    const conflictToastKey = getProviderConflictToastKey(selectedType, existingVendorIds);
    if (conflictToastKey) {
      toast.error(t(conflictToastKey));
      return;
    }

    setOauthFlowing(true);
    setOauthData(null);
    setManualCodeInput('');
    setOauthError(null);

    try {
      const vendor = vendorMap.get(selectedType);
      const accountId = buildProviderCredentialId(selectedType, null, vendors);
      const flowId = `${accountId}:${Date.now().toString(36)}`;
      const label = name || (typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name) || selectedType;
      if (vendor?.supportsMultipleAccounts === false && existingVendorIds.has(selectedType)) {
        toast.error(t('aiProviders.toast.duplicateSingleProvider'));
        setOauthFlowing(false);
        return;
      }
      setPendingOAuth({ flowId, accountId, vendorId: selectedType, label });
      if (authMode !== 'oauth_browser' && authMode !== 'oauth_device') return;
      await hostProviderStartOAuth({ provider: selectedType, flowId, accountId, label, mode: authMode });
    } catch (oauthStartError) {
      setOauthError(String(oauthStartError));
      setOauthFlowing(false);
      setPendingOAuth(null);
    }
  };

  const handleCancelOAuth = async () => {
    const binding = pendingOAuth;
    setOauthFlowing(false);
    setOauthData(null);
    setManualCodeInput('');
    setOauthError(null);
    setPendingOAuth(null);
    if (binding) {
      await hostProviderCancelOAuth({
        flowId: binding.flowId,
        accountId: binding.accountId,
        vendorId: binding.vendorId,
      });
    }
  };

  const handleSubmitManualOAuthCode = async () => {
    const value = manualCodeInput.trim();
    if (!value || !pendingOAuth) return;
    try {
      await hostProviderSubmitOAuthCode({
        flowId: pendingOAuth.flowId,
        accountId: pendingOAuth.accountId,
        vendorId: pendingOAuth.vendorId,
        code: value,
      });
      setOauthError(null);
    } catch (submitError) {
      setOauthError(String(submitError));
    }
  };

  const handleAdd = async () => {
    if (!selectedType) return;
    const conflictToastKey = getProviderConflictToastKey(selectedType, existingVendorIds);
    if (conflictToastKey) {
      toast.error(t(conflictToastKey));
      return;
    }
    const vendor = vendorMap.get(selectedType);
    if (vendor?.supportsMultipleAccounts === false && existingVendorIds.has(selectedType)) {
      toast.error(t('aiProviders.toast.duplicateSingleProvider'));
      return;
    }

    setSaving(true);
    setValidationError(null);
    try {
      const requiresKey = authMode === 'api_key' || authMode === 'token';
      if (requiresKey && !normalizedApiKey) {
        setValidationError(t('aiProviders.toast.invalidKey'));
        return;
      }
      await onAdd(
        selectedType,
        name || (typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name) || selectedType,
        authMode === 'token' || authMode === 'cli_reuse' ? '' : normalizedApiKey,
        {
          baseUrl: effectiveBaseUrl,
          apiProtocol: isCustomMedia ? undefined : typeInfo?.apiProtocol ?? (selectedType === 'custom' || selectedType === 'ollama' ? apiProtocol : undefined),
          token: authMode === 'token' ? normalizedApiKey : undefined,
          providerKind: isCustomMedia ? 'media' : 'chat',
          mediaApiProtocol: isCustomMedia ? mediaApiProtocol : undefined,
          authMode,
        },
      );
    } finally {
      setSaving(false);
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4">
      <section
        role="dialog"
        aria-label={t('aiProviders.dialog.title')}
        className="max-h-[92vh] w-full max-w-4xl overflow-y-auto overscroll-contain rounded-xl border bg-background p-6 shadow-none [scrollbar-gutter:stable]"
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

        <div className="mt-5 space-y-4">
          {!selectedType ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {availableBrands.map(({ brand, type }) => (
                <button
                  key={type.id}
                  onClick={() => {
                    setSelectedType(type.id);
                    setName(type.id === 'custom' ? t('aiProviders.custom') : type.name);
                    setBaseUrl(type.defaultBaseUrl || '');
                    setCodePlanEnabled(false);
                    setApiProtocol(type.apiProtocol ?? 'openai-completions');
                    setAuthMode(vendorMap.get(type.id)?.defaultAuthMode ?? 'api_key');
                    setApiKey('');
                    setCustomKind('chat');
                    setMediaApiProtocol('openai');
                  }}
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
                    onClick={() => {
                      setSelectedType(null);
                      setValidationError(null);
                      setBaseUrl('');
                      setCodePlanEnabled(false);
                      setApiProtocol('openai-completions');
                      setCustomKind('chat');
                    }}
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
                  <Select id="provider-variant" value={selectedType} disabled={oauthFlowing} onChange={(event) => {
                    const next = brandVariants.find((variant) => variant.id === event.target.value)!;
                    setSelectedType(next.id);
                    setName(next.name);
                    setBaseUrl(next.defaultBaseUrl ?? '');
                    setApiProtocol(next.apiProtocol ?? 'openai-completions');
                    setAuthMode(vendorMap.get(next.id)?.defaultAuthMode ?? 'api_key');
                    setCodePlanEnabled(false);
                    setApiKey('');
                    setValidationError(null);
                  }}>
                    {brandVariants.map((variant) => <option key={variant.id} value={variant.id}>{variant.name}</option>)}
                  </Select>
                </div>
              ) : null}
              {typeInfo?.endpointPresets?.length ? (
                <div className="space-y-2">
                  <Label htmlFor="provider-endpoint-preset">{t('aiProviders.dialog.endpointPreset')}</Label>
                  <Select id="provider-endpoint-preset" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)}>
                    {!typeInfo.endpointPresets.some((preset) => preset.baseUrl === baseUrl) ? <option value={baseUrl}>{t('aiProviders.custom')}</option> : null}
                    {typeInfo.endpointPresets.map((preset) => <option key={preset.id} value={preset.baseUrl}>{preset.label}</option>)}
                  </Select>
                </div>
              ) : null}

              <div className="space-y-2">
                <Label htmlFor="name">{t('aiProviders.dialog.displayName')}</Label>
                <Input
                  id="name"
                  placeholder={typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>

              {selectedType === 'custom' ? (
                <div className="grid grid-cols-2 overflow-hidden rounded-lg border text-sm">
                  <button
                    type="button"
                    onClick={() => {
                      setCustomKind('chat');
                      setBaseUrl('');
                      setCodePlanEnabled(false);
                      setApiProtocol('openai-completions');
                    }}
                    className={cn(
                      'px-3 py-2 transition-colors',
                      customKind === 'chat' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {t('aiProviders.dialog.chatProvider')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCustomKind('media');
                      const contract = getCustomMediaContract(mediaApiProtocol);
                      setBaseUrl(contract?.defaultBaseUrl ?? '');
                      setCodePlanEnabled(false);
                    }}
                    className={cn(
                      'px-3 py-2 transition-colors',
                      customKind === 'media' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {t('aiProviders.dialog.mediaProvider')}
                  </button>
                </div>
              ) : null}

              {selectedVendor && selectedVendor.supportedAuthModes.length > 1 ? (
                <div className="space-y-2">
                  <Label htmlFor="provider-auth-mode">{t('aiProviders.dialog.authMode')}</Label>
                  <Select id="provider-auth-mode" value={authMode} disabled={oauthFlowing} onChange={(event) => {
                    setAuthMode(event.target.value as ProviderCredential['authMode']);
                    setApiKey('');
                    setValidationError(null);
                  }}>
                    {selectedVendor.supportedAuthModes.map((mode) => (
                      <option key={mode} value={mode}>{getAuthModeLabel(mode, t)}</option>
                    ))}
                  </Select>
                </div>
              ) : null}
              {authMode === 'cli_reuse' ? <p className="text-sm text-muted-foreground">{t('aiProviders.dialog.cliReuseHelp')}</p> : null}

              {(authMode === 'api_key' || authMode === 'token' || authMode === 'local') ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="apiKey">{authMode === 'token' ? t('aiProviders.authModes.token') : t('aiProviders.dialog.apiKey')}</Label>
                    {typeInfo?.apiKeyUrl ? (
                      <a
                        href={typeInfo.apiKeyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-primary hover:underline"
                        tabIndex={-1}
                      >
                        {t('aiProviders.oauth.getApiKey')} <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : null}
                  </div>
                  <div className="relative">
                    <Input
                      id="apiKey"
                      type={showKey ? 'text' : 'password'}
                      placeholder={typeInfo?.id === 'ollama' ? t('aiProviders.notRequired') : typeInfo?.placeholder}
                      value={apiKey}
                      onChange={(event) => {
                        setApiKey(event.target.value);
                        setValidationError(null);
                      }}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {validationError ? <p className="text-xs text-destructive">{validationError}</p> : null}
                  <p className="text-xs text-muted-foreground">{t(authMode === 'token' ? 'aiProviders.dialog.tokenHelp' : 'aiProviders.dialog.apiKeyStored')}</p>
                </div>
              ) : null}

              {typeInfo?.codePlan?.baseUrl ? (
                <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
                  <span>{t('aiProviders.dialog.codePlanMode')}</span>
                  <input
                    type="checkbox"
                    checked={codePlanEnabled}
                    onChange={(event) => {
                      setCodePlanEnabled(event.target.checked);
                      setValidationError(null);
                    }}
                  />
                </label>
              ) : null}

              {isCustomMedia ? (
                <div className="grid gap-3 sm:grid-cols-1">
                  <div className="space-y-2">
                    <Label htmlFor="provider-add-media-provider">{t('aiProviders.dialog.mediaContract')}</Label>
                    <Select
                      id="provider-add-media-provider"
                      value={mediaApiProtocol}
                      onChange={(event) => setMediaApiProtocol(event.target.value as ProviderCredential['mediaApiProtocol'])}
                    >
                      {CUSTOM_MEDIA_CONTRACTS.map((contract) => (
                        <option key={contract.id} value={contract.id}>{contract.label}</option>
                      ))}
                    </Select>
                  </div>
                </div>
              ) : null}

              {(typeInfo?.showBaseUrl || isCustomMedia) ? (
                <div className="space-y-2">
                  <Label htmlFor="baseUrl">{t('aiProviders.dialog.baseUrl')}</Label>
                  <Input
                    id="baseUrl"
                    placeholder={isCustomMedia ? selectedMediaContract?.defaultBaseUrl || 'https://api.example.com/v1' : getProtocolBaseUrlPlaceholder(apiProtocol)}
                    value={codePlanEnabled ? typeInfo?.codePlan?.baseUrl ?? '' : baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    disabled={codePlanEnabled}
                  />
                </div>
              ) : null}

              {selectedType === 'custom' && !isCustomMedia ? (
                <div className="space-y-2">
                  <Label htmlFor="provider-add-protocol">{t('aiProviders.dialog.protocol')}</Label>
                  <Select
                    id="provider-add-protocol"
                    value={apiProtocol}
                    onChange={(event) => setApiProtocol(event.target.value as ProviderCredential['apiProtocol'])}
                  >
                    <option value="openai-completions">{t('aiProviders.protocols.openaiCompletions')}</option>
                    <option value="openai-responses">{t('aiProviders.protocols.openaiResponses')}</option>
                    <option value="anthropic-messages">{t('aiProviders.protocols.anthropic')}</option>
                  </Select>
                </div>
              ) : null}

              {useOAuthFlow ? (
                <OAuthPanel
                  oauthFlowing={oauthFlowing}
                  oauthData={oauthData}
                  oauthError={oauthError}
                  manualCodeInput={manualCodeInput}
                  pendingOAuth={pendingOAuth}
                  onStart={handleStartOAuth}
                  onCancel={handleCancelOAuth}
                  onManualCodeChange={setManualCodeInput}
                  onSubmitManualCode={handleSubmitManualOAuthCode}
                />
              ) : null}
            </div>
          )}

          <Separator />

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t('aiProviders.dialog.cancel')}</Button>
            <Button onClick={handleAdd} className={cn(useOAuthFlow && 'hidden')} disabled={!selectedType || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {t('aiProviders.dialog.add')}
            </Button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function OAuthPanel(props: {
  oauthFlowing: boolean;
  oauthData: {
    mode: 'device';
    verificationUri: string;
    userCode: string;
    expiresIn: number;
  } | {
    mode: 'manual';
    authorizationUrl: string;
    message?: string;
  } | null;
  oauthError: string | null;
  manualCodeInput: string;
  pendingOAuth: { flowId: string; accountId: string; vendorId: string; label: string } | null;
  onStart: () => void;
  onCancel: () => void;
  onManualCodeChange: (value: string) => void;
  onSubmitManualCode: () => void;
}) {
  const { t } = useTranslation('settings');
  const {
    oauthFlowing,
    oauthData,
    oauthError,
    manualCodeInput,
    pendingOAuth,
    onStart,
    onCancel,
    onManualCodeChange,
    onSubmitManualCode,
  } = props;

  return (
    <div className="space-y-4 pt-2">
      <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-4 text-center">
        <p className="mb-3 block text-sm text-blue-200">
          {pendingOAuth ? pendingOAuth.label : t('aiProviders.oauth.loginPrompt')}
        </p>
        <Button onClick={onStart} disabled={oauthFlowing} className="w-full bg-blue-600 text-white hover:bg-blue-700">
          {oauthFlowing ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              {t('aiProviders.oauth.waiting')}
            </>
          ) : (
            t('aiProviders.oauth.loginButton')
          )}
        </Button>
      </div>

      {oauthFlowing || oauthError ? (
        <div className="relative mt-4 overflow-hidden rounded-xl border bg-card p-4">
          <div className="absolute inset-0 bg-primary/5 animate-pulse" />
          <div className="relative z-10 flex flex-col items-center justify-center space-y-4 text-center">
            {oauthError ? (
              <div className="space-y-2 text-red-400">
                <XCircle className="mx-auto h-8 w-8" />
                <p className="font-medium">{t('aiProviders.oauth.authFailed')}</p>
                <p className="text-sm opacity-80">{oauthError}</p>
                <Button variant="outline" size="sm" onClick={onCancel} className="mt-2 text-foreground">
                  {t('aiProviders.oauth.tryAgain')}
                </Button>
              </div>
            ) : !oauthData ? (
              <div className="space-y-3 py-4">
                <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
                <p className="animate-pulse text-sm text-muted-foreground">{t('aiProviders.oauth.requestingCode')}</p>
              </div>
            ) : oauthData.mode === 'manual' ? (
              <div className="w-full space-y-4">
                <div className="space-y-2 text-left">
                  <h3 className="text-lg font-medium text-foreground">{t('aiProviders.oauth.completeLogin')}</h3>
                  <p className="text-sm text-muted-foreground">
                    {oauthData.message || t('aiProviders.oauth.manualHelp')}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => invokeIpc('shell:openExternal', oauthData.authorizationUrl)}
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  {t('aiProviders.oauth.openLoginPage')}
                </Button>
                <Input
                  placeholder={t('aiProviders.oauth.callbackPlaceholder')}
                  value={manualCodeInput}
                  onChange={(event) => onManualCodeChange(event.target.value)}
                />
                <Button className="w-full" onClick={onSubmitManualCode} disabled={!manualCodeInput.trim()}>
                  {t('aiProviders.oauth.submitCode')}
                </Button>
                <Button variant="ghost" size="sm" className="w-full mt-2" onClick={onCancel}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="w-full space-y-4">
                <div className="space-y-1">
                  <h3 className="text-lg font-medium text-foreground">{t('aiProviders.oauth.approveLogin')}</h3>
                  <div className="mt-2 space-y-1 text-left text-sm text-muted-foreground">
                    <p>1. {t('aiProviders.oauth.step1')}</p>
                    <p>2. {t('aiProviders.oauth.step2')}</p>
                    <p>3. {t('aiProviders.oauth.step3')}</p>
                  </div>
                </div>
                <div className="flex items-center justify-center gap-2 rounded-lg border bg-background p-3">
                  <code className="font-mono text-2xl font-bold tracking-widest text-primary">{oauthData.userCode}</code>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      navigator.clipboard.writeText(oauthData.userCode);
                      toast.success(t('aiProviders.oauth.codeCopied'));
                    }}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => invokeIpc('shell:openExternal', oauthData.verificationUri)}
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  {t('aiProviders.oauth.openLoginPage')}
                </Button>
                <div className="flex items-center justify-center gap-2 pt-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>{t('aiProviders.oauth.waitingApproval')}</span>
                </div>
                <Button variant="ghost" size="sm" className="w-full mt-2" onClick={onCancel}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
