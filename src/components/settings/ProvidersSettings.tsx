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
} from '@/lib/provider-runtime';
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

function getAuthModeLabel(authMode: ProviderCredential['authMode'], t: (key: string) => string): string {
  switch (authMode) {
    case 'api_key':
      return t('aiProviders.authModes.apiKey');
    case 'oauth_device':
      return t('aiProviders.authModes.oauthDevice');
    case 'oauth_browser':
      return t('aiProviders.authModes.oauthBrowser');
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

function modelsForCredential(models: readonly ProviderModel[], credentialId: string): ProviderModel[] {
  return models.filter((model) => model.credentialId === credentialId);
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
    validateAccountApiKey,
  } = useProviderStore();
  const modelCatalogModels = useProviderModelCatalogStore((state) => state.models);
  const modelCatalogReady = useProviderModelCatalogStore((state) => state.ready);
  const modelCatalogLoading = useProviderModelCatalogStore((state) => state.loading);
  const modelCatalogSaving = useProviderModelCatalogStore((state) => state.saving);
  const modelCatalogError = useProviderModelCatalogStore((state) => state.error);
  const refreshModelCatalog = useProviderModelCatalogStore((state) => state.refresh);
  const replaceCredentialModels = useProviderModelCatalogStore((state) => state.replaceCredentialModels);
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
        apiProtocol: (options?.providerKind ?? 'chat') === 'chat' && (type === 'custom' || type === 'ollama')
          ? (options?.apiProtocol || 'openai-completions')
          : undefined,
        mediaApiProtocol: options?.mediaApiProtocol,
        headers: options?.headers,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, effectiveApiKey);
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
              models={modelsForCredential(modelCatalogModels, item.account.id)}
              modelCatalogReady={modelCatalogReady}
              modelCatalogLoading={modelCatalogLoading}
              modelCatalogSaving={modelCatalogSaving}
              modelCatalogError={modelCatalogError}
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
                await updateAccount(item.account.id, payload.updates ?? {}, payload.newApiKey);
                setEditingProvider(null);
              }}
              onValidateKey={(key, options) => validateAccountApiKey(item.account.id, key, options)}
              onReplaceModels={(next) => replaceCredentialModels(item.account.id, next)}
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
          onValidateKey={(type, key, options) => validateAccountApiKey(type, key, options)}
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
  isMutating: boolean;
  isDeleting: boolean;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onSaveEdits: (payload: { newApiKey?: string; updates?: Partial<ProviderCredential> }) => Promise<void>;
  onValidateKey: (
    key: string,
    options?: {
      baseUrl?: string;
      apiProtocol?: ProviderCredential['apiProtocol'];
      headers?: Record<string, string>;
    },
  ) => Promise<{ valid: boolean; error?: string }>;
  onReplaceModels: (next: Omit<ProviderModel, 'credentialId'>[]) => Promise<void>;
}

function ProviderCard({
  item,
  models,
  modelCatalogReady,
  modelCatalogLoading,
  modelCatalogSaving,
  modelCatalogError,
  isMutating,
  isDeleting,
  isEditing,
  onEdit,
  onCancelEdit,
  onDelete,
  onSaveEdits,
  onValidateKey,
  onReplaceModels,
}: ProviderCardProps) {
  const { t, i18n } = useTranslation('settings');
  const { account, vendor, status } = item;
  const [newKey, setNewKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(account.baseUrl || '');
  const [apiProtocol, setApiProtocol] = useState<ProviderCredential['apiProtocol']>(
    account.apiProtocol || 'openai-completions',
  );
  const [showKey, setShowKey] = useState(false);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
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
    setApiProtocol(account.apiProtocol || 'openai-completions');
    setValidationError(null);
  }, [account.apiProtocol, account.baseUrl, isEditing]);

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
  const hasConfigChanges = (typeInfo?.showBaseUrl && (baseUrl.trim() || undefined) !== (account.baseUrl || undefined))
    || (!isMediaCredential && (account.vendorId === 'custom' || account.vendorId === 'ollama')
      && (apiProtocol || 'openai-completions') !== (account.apiProtocol || 'openai-completions'))
    || hasLegacyUserAgentHeader;

  const handleSaveEdits = async () => {
    setSaving(true);
    setValidationError(null);
    try {
    const payload: { newApiKey?: string; updates?: Partial<ProviderCredential> } = {};
      if (normalizedNewKey) {
        setValidating(true);
        const result = await onValidateKey(normalizedNewKey, {
          baseUrl: baseUrl.trim() || undefined,
          apiProtocol: (!isMediaCredential && (account.vendorId === 'custom' || account.vendorId === 'ollama')) ? apiProtocol : undefined,
          headers: sanitizedHeaders,
        });
        setValidating(false);
        if (!result.valid) {
          setValidationError(result.error || t('aiProviders.toast.invalidKey'));
          return;
        }
        payload.newApiKey = normalizedNewKey;
      }

      const updates: Partial<ProviderCredential> = {};
      if (typeInfo?.showBaseUrl && (baseUrl.trim() || undefined) !== (account.baseUrl || undefined)) {
        updates.baseUrl = baseUrl.trim() || undefined;
      }
      if (
        !isMediaCredential
        && (account.vendorId === 'custom' || account.vendorId === 'ollama')
        && (apiProtocol || 'openai-completions') !== (account.apiProtocol || 'openai-completions')
      ) {
        updates.apiProtocol = apiProtocol || 'openai-completions';
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
      if (!payload.newApiKey && !payload.updates) {
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
      setValidating(false);
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
                {typeInfo?.showBaseUrl ? (
                  <div className="space-y-1">
                    <Label htmlFor={`provider-edit-base-url-${account.id}`} className="text-xs">
                      {t('aiProviders.dialog.baseUrl')}
                    </Label>
                    <Input
                      id={`provider-edit-base-url-${account.id}`}
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder={getProtocolBaseUrlPlaceholder(apiProtocol)}
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
                  <Label className="text-xs">{t('aiProviders.dialog.apiKey')}</Label>
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
              <div className="space-y-1">
                <Label className="text-xs">{t('aiProviders.dialog.replaceApiKey')}</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      data-testid={`provider-edit-key-input-${account.id}`}
                      type={showKey ? 'text' : 'password'}
                      placeholder={typeInfo?.requiresApiKey ? typeInfo?.placeholder : (typeInfo?.id === 'ollama' ? t('aiProviders.notRequired') : t('aiProviders.card.editKey'))}
                      value={newKey}
                      onChange={(event) => {
                        setNewKey(event.target.value);
                        setValidationError(null);
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
                    disabled={validating || saving || (!normalizedNewKey && !hasConfigChanges)}
                  >
                    {validating || saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                {validationError ? (
                  <p
                    data-testid={`provider-edit-validation-error-${account.id}`}
                    className="mt-1 flex items-start gap-1 text-xs text-destructive"
                  >
                    <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      <span className="font-medium">{t('aiProviders.dialog.failed')}:</span>{' '}
                      {validationError}
                    </span>
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">{t('aiProviders.dialog.replaceApiKeyHelp')}</p>
              </div>
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
      baseUrl?: string;
      apiProtocol?: ProviderCredential['apiProtocol'];
      headers?: Record<string, string>;
      authMode?: ProviderCredential['authMode'];
      providerKind?: ProviderCredential['providerKind'];
      mediaApiProtocol?: ProviderCredential['mediaApiProtocol'];
    },
  ) => Promise<void>;
  onValidateKey: (
    type: string,
    apiKey: string,
    options?: {
      baseUrl?: string;
      apiProtocol?: ProviderCredential['apiProtocol'];
      headers?: Record<string, string>;
    },
  ) => Promise<{ valid: boolean; error?: string }>;
}

function AddProviderDialog({
  existingVendorIds,
  vendors,
  onClose,
  onAdd,
  onValidateKey,
}: AddProviderDialogProps) {
  const { t, i18n } = useTranslation('settings');
  const [selectedType, setSelectedType] = useState<ProviderType | null>(null);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
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
  const [authMode, setAuthMode] = useState<'oauth' | 'apikey'>('apikey');

  const typeInfo = PROVIDER_TYPE_INFO.find((type) => type.id === selectedType);
  const providerDocsUrl = getProviderDocsUrl(typeInfo, i18n.language);
  const isOAuth = typeInfo?.isOAuth ?? false;
  const supportsApiKey = typeInfo?.supportsApiKey ?? false;
  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const selectedVendor = selectedType ? vendorMap.get(selectedType) : undefined;
  const selectedMediaContract = getCustomMediaContract(mediaApiProtocol);
  const isCustomMedia = selectedType === 'custom' && customKind === 'media';
  const preferredOAuthMode = selectedVendor?.supportedAuthModes.includes('oauth_browser')
    ? 'oauth_browser'
    : (selectedVendor?.supportedAuthModes.includes('oauth_device')
      ? 'oauth_device'
      : (selectedType === 'google' ? 'oauth_browser' : null));
  const useOAuthFlow = isOAuth && (!supportsApiKey || authMode === 'oauth');
  const normalizedApiKey = normalizeProviderApiKeyInput(apiKey);

  useEffect(() => {
    if (!selectedMediaContract) return;
    setBaseUrl(selectedMediaContract.defaultBaseUrl ?? '');
  }, [mediaApiProtocol, selectedMediaContract]);

  useEffect(() => {
    if (!selectedVendor || !isOAuth || !supportsApiKey) return;
    setAuthMode(selectedVendor.defaultAuthMode === 'api_key' ? 'apikey' : 'oauth');
  }, [selectedVendor, isOAuth, supportsApiKey]);

  const latestRef = useRef({ selectedType, typeInfo, onClose, t });
  const [pendingOAuth, setPendingOAuth] = useState<{ accountId: string; label: string } | null>(null);
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
    const hasMinimax = existingVendorIds.has('minimax-portal') || existingVendorIds.has('minimax-portal-cn');
    if ((type.id === 'minimax-portal' || type.id === 'minimax-portal-cn') && hasMinimax) {
      return false;
    }
    const vendor = vendorMap.get(type.id);
    if (!vendor) {
      return !existingVendorIds.has(type.id) || type.id === 'custom';
    }
    return vendor.supportsMultipleAccounts || !existingVendorIds.has(type.id);
  });

  const handleStartOAuth = async () => {
    if (!selectedType) return;
    const hasMinimax = existingVendorIds.has('minimax-portal') || existingVendorIds.has('minimax-portal-cn');
    if ((selectedType === 'minimax-portal' || selectedType === 'minimax-portal-cn') && hasMinimax) {
      toast.error(t('aiProviders.toast.minimaxConflict'));
      return;
    }

    setOauthFlowing(true);
    setOauthData(null);
    setManualCodeInput('');
    setOauthError(null);

    try {
      const vendor = vendorMap.get(selectedType);
      const accountId = buildProviderCredentialId(selectedType, null, vendors);
      const label = name || (typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name) || selectedType;
      if (vendor?.supportsMultipleAccounts === false && existingVendorIds.has(selectedType)) {
        toast.error(t('aiProviders.toast.duplicateSingleProvider'));
        setOauthFlowing(false);
        return;
      }
      setPendingOAuth({ accountId, label });
      await hostProviderStartOAuth({ provider: selectedType, accountId, label });
    } catch (oauthStartError) {
      setOauthError(String(oauthStartError));
      setOauthFlowing(false);
      setPendingOAuth(null);
    }
  };

  const handleCancelOAuth = async () => {
    setOauthFlowing(false);
    setOauthData(null);
    setManualCodeInput('');
    setOauthError(null);
    setPendingOAuth(null);
    await hostProviderCancelOAuth();
  };

  const handleSubmitManualOAuthCode = async () => {
    const value = manualCodeInput.trim();
    if (!value) return;
    try {
      await hostProviderSubmitOAuthCode(value);
      setOauthError(null);
    } catch (submitError) {
      setOauthError(String(submitError));
    }
  };

  const handleAdd = async () => {
    if (!selectedType) return;
    const hasMinimax = existingVendorIds.has('minimax-portal') || existingVendorIds.has('minimax-portal-cn');
    if ((selectedType === 'minimax-portal' || selectedType === 'minimax-portal-cn') && hasMinimax) {
      toast.error(t('aiProviders.toast.minimaxConflict'));
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
      const requiresKey = typeInfo?.requiresApiKey ?? false;
      if (requiresKey && !normalizedApiKey) {
        setValidationError(t('aiProviders.toast.invalidKey'));
        return;
      }
      if (requiresKey && normalizedApiKey && !isCustomMedia) {
        const result = await onValidateKey(selectedType, normalizedApiKey, {
          baseUrl: baseUrl.trim() || undefined,
          apiProtocol: (selectedType === 'custom' || selectedType === 'ollama') ? apiProtocol : undefined,
        });
        if (!result.valid) {
          setValidationError(result.error || t('aiProviders.toast.invalidKey'));
          return;
        }
      }

      await onAdd(
        selectedType,
        name || (typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name) || selectedType,
        normalizedApiKey,
        {
          baseUrl: baseUrl.trim() || undefined,
          apiProtocol: (!isCustomMedia && (selectedType === 'custom' || selectedType === 'ollama')) ? apiProtocol : undefined,
          providerKind: isCustomMedia ? 'media' : 'chat',
          mediaApiProtocol: isCustomMedia ? mediaApiProtocol : undefined,
          authMode: useOAuthFlow
            ? (preferredOAuthMode || 'oauth_device')
            : selectedType === 'ollama'
              ? 'local'
              : (isOAuth && supportsApiKey && authMode === 'apikey')
                ? 'api_key'
                : vendorMap.get(selectedType)?.defaultAuthMode || 'api_key',
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
        className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-xl border bg-background p-6 shadow-xl"
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
              {availableTypes.map((type) => (
                <button
                  key={type.id}
                  onClick={() => {
                    setSelectedType(type.id);
                    setName(type.id === 'custom' ? t('aiProviders.custom') : type.name);
                    setBaseUrl(type.defaultBaseUrl || '');
                    setApiProtocol('openai-completions');
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
                  <p className="mt-2 font-medium">{type.id === 'custom' ? t('aiProviders.custom') : type.name}</p>
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

              {isOAuth && supportsApiKey ? (
                <div className="flex overflow-hidden rounded-lg border text-sm">
                  <button
                    onClick={() => setAuthMode('oauth')}
                    className={cn(
                      'flex-1 px-3 py-2 transition-colors',
                      authMode === 'oauth' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {t('aiProviders.oauth.loginMode')}
                  </button>
                  <button
                    onClick={() => setAuthMode('apikey')}
                    className={cn(
                      'flex-1 px-3 py-2 transition-colors',
                      authMode === 'apikey' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {t('aiProviders.oauth.apikeyMode')}
                  </button>
                </div>
              ) : null}

              {(!isOAuth || (supportsApiKey && authMode === 'apikey')) ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="apiKey">{t('aiProviders.dialog.apiKey')}</Label>
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
                  <p className="text-xs text-muted-foreground">{t('aiProviders.dialog.apiKeyStored')}</p>
                </div>
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
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
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
  pendingOAuth: { accountId: string; label: string } | null;
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

      {oauthFlowing ? (
        <div className="relative mt-4 overflow-hidden rounded-xl border bg-card p-4">
          <div className="absolute inset-0 bg-primary/5 animate-pulse" />
          <div className="relative z-10 flex flex-col items-center justify-center space-y-4 text-center">
            {oauthError ? (
              <div className="space-y-2 text-red-400">
                <XCircle className="mx-auto h-8 w-8" />
                <p className="font-medium">{t('aiProviders.oauth.authFailed')}</p>
                <p className="text-sm opacity-80">{oauthError}</p>
                <Button variant="outline" size="sm" onClick={onCancel} className="mt-2 text-foreground">
                  Try Again
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
                  <h3 className="text-lg font-medium text-foreground">Complete OpenAI Login</h3>
                  <p className="text-sm text-muted-foreground">
                    {oauthData.message || 'Open the authorization page, complete login, then paste the callback URL or code below.'}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => invokeIpc('shell:openExternal', oauthData.authorizationUrl)}
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Open Authorization Page
                </Button>
                <Input
                  placeholder="Paste callback URL or code"
                  value={manualCodeInput}
                  onChange={(event) => onManualCodeChange(event.target.value)}
                />
                <Button className="w-full" onClick={onSubmitManualCode} disabled={!manualCodeInput.trim()}>
                  Submit Code
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
