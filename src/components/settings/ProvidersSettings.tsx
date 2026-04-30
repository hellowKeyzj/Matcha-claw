/**
 * Providers Settings Component
 * Manage AI provider configurations and API keys
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus,
  RefreshCw,
  Trash2,
  Edit,
  Eye,
  EyeOff,
  Check,
  X,
  Loader2,
  Star,
  Key,
  ExternalLink,
  Copy,
  XCircle,
  ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import {
  useProviderStore,
  type ProviderAccount,
  type ProviderVendorInfo,
} from '@/stores/providers';
import {
  PROVIDER_TYPE_INFO,
  getProviderDocsUrl,
  type ProviderConfig,
  type ProviderType,
  getProviderIconUrl,
  resolveProviderApiKeyForSave,
  resolveProviderModelForSave,
  shouldShowProviderModelId,
  shouldInvertInDark,
} from '@/lib/providers';
import {
  buildProviderAccountId,
  buildProviderListItems,
  type ProviderListItem,
} from '@/lib/provider-accounts';
import {
  hostProviderCancelOAuth,
  hostProviderStartOAuth,
  hostProviderSubmitOAuthCode,
} from '@/lib/provider-runtime';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { invokeIpc } from '@/lib/api-client';
import { useSettingsStore } from '@/stores/settings';
import { useGatewayStore } from '@/stores/gateway';
import { subscribeHostEvent } from '@/lib/host-events';

type ArkMode = 'apikey' | 'codeplan';

function normalizeFallbackProviderIds(ids?: string[]): string[] {
  return Array.from(new Set((ids ?? []).filter(Boolean)));
}

function getProtocolBaseUrlPlaceholder(
  apiProtocol: ProviderAccount['apiProtocol'],
): string {
  if (apiProtocol === 'anthropic-messages') {
    return 'https://api.example.com/anthropic';
  }
  return 'https://api.example.com/v1';
}

function fallbackProviderIdsEqual(a?: string[], b?: string[]): boolean {
  const left = normalizeFallbackProviderIds(a).sort();
  const right = normalizeFallbackProviderIds(b).sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function normalizeFallbackModels(models?: string[]): string[] {
  return Array.from(new Set((models ?? []).map((model) => model.trim()).filter(Boolean)));
}

function formatOptionalPositiveInteger(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? String(Math.floor(value))
    : '';
}

function parseOptionalPositiveInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const normalized = Number.parseInt(trimmed, 10);
  return normalized > 0 ? normalized : undefined;
}

function fallbackModelsEqual(a?: string[], b?: string[]): boolean {
  const left = normalizeFallbackModels(a);
  const right = normalizeFallbackModels(b);
  return left.length === right.length && left.every((model, index) => model === right[index]);
}

function stripUserAgentHeader(headers?: Record<string, string>): Record<string, string> | undefined {
  const next = Object.fromEntries(
    Object.entries(headers ?? {})
      .filter(([key]) => key.toLowerCase() !== 'user-agent'),
  );
  return Object.keys(next).length > 0 ? next : undefined;
}

function isArkCodePlanMode(
  vendorId: string,
  baseUrl: string | undefined,
  modelId: string | undefined,
  codePlanPresetBaseUrl?: string,
  codePlanPresetModelId?: string,
): boolean {
  if (vendorId !== 'ark' || !codePlanPresetBaseUrl || !codePlanPresetModelId) {
    return false;
  }
  return (baseUrl || '').trim() === codePlanPresetBaseUrl
    && (modelId || '').trim() === codePlanPresetModelId;
}

function getAuthModeLabel(
  authMode: ProviderAccount['authMode'],
  t: (key: string) => string
): string {
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

export function ProvidersSettings() {
  const { t } = useTranslation('settings');
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const gatewayState = useGatewayStore((state) => state.status.state);
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
    setDefaultAccount,
    validateAccountApiKey,
  } = useProviderStore();
  const {
    statuses,
    accounts,
    vendors,
    defaultAccountId,
  } = providerSnapshot;

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [manualRefreshPending, setManualRefreshPending] = useState(false);
  const wasGatewayRunningRef = React.useRef(gatewayState === 'running');
  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const existingVendorIds = new Set(accounts.map((account) => account.vendorId));
  const displayProviders = useMemo(
    () => buildProviderListItems(accounts, statuses, vendors, defaultAccountId),
    [accounts, statuses, vendors, defaultAccountId],
  );
  const showRefreshingHint = useDelayedFlag(refreshing && snapshotReady, 180);

  // Fetch providers on mount
  useEffect(() => {
    void refreshProviderSnapshot({
      trigger: 'background',
      reason: 'providers_settings_mount',
    });
  }, [refreshProviderSnapshot]);

  useEffect(() => {
    const handleFocus = () => {
      void refreshProviderSnapshot({
        trigger: 'background',
        reason: 'window_focus',
      });
    };
    const handleOnline = () => {
      void refreshProviderSnapshot({
        trigger: 'background',
        reason: 'network_online',
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshProviderSnapshot({
          trigger: 'background',
          reason: 'visibility_visible',
        });
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
    if (!wasGatewayRunningRef.current && gatewayState === 'running') {
      void refreshProviderSnapshot({
        trigger: 'background',
        reason: 'gateway_reconnected',
      });
    }
    wasGatewayRunningRef.current = gatewayState === 'running';
  }, [gatewayState, refreshProviderSnapshot]);

  const handleManualRefresh = () => {
    if (manualRefreshPending) {
      return;
    }
    setManualRefreshPending(true);
    void refreshProviderSnapshot({
      trigger: 'manual',
      reason: 'user_manual_refresh',
    }).finally(() => {
      setManualRefreshPending(false);
    });
  };

  const handleAddProvider = async (
    type: ProviderType,
    name: string,
    apiKey: string,
    options?: {
      baseUrl?: string;
      apiProtocol?: ProviderAccount['apiProtocol'];
      headers?: Record<string, string>;
      model?: string;
      contextWindow?: number;
      maxTokens?: number;
      authMode?: ProviderAccount['authMode'];
    }
  ) => {
    const vendor = vendorMap.get(type);
    const id = buildProviderAccountId(type, null, vendors);
    const effectiveApiKey = resolveProviderApiKeyForSave(type, apiKey);
    try {
      await createAccount({
        id,
        vendorId: type,
        label: name,
        authMode: options?.authMode || vendor?.defaultAuthMode || (type === 'ollama' ? 'local' : 'api_key'),
        baseUrl: options?.baseUrl,
        apiProtocol: type === 'custom' || type === 'ollama'
          ? (options?.apiProtocol || 'openai-completions')
          : undefined,
        headers: options?.headers,
        model: options?.model,
        contextWindow: options?.contextWindow,
        maxTokens: options?.maxTokens,
        enabled: true,
        isDefault: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, effectiveApiKey);

      // Auto-set as default if no default is currently configured
      if (!defaultAccountId) {
        await setDefaultAccount(id);
      }

      setShowAddDialog(false);
      toast.success(t('aiProviders.toast.added'));
    } catch (error) {
      toast.error(`${t('aiProviders.toast.failedAdd')}: ${error}`);
    }
  };

  const handleDeleteProvider = async (providerId: string) => {
    try {
      await removeAccount(providerId);
      toast.success(t('aiProviders.toast.deleted'));
    } catch (error) {
      toast.error(`${t('aiProviders.toast.failedDelete')}: ${error}`);
    }
  };

  const handleSetDefault = async (providerId: string) => {
    try {
      await setDefaultAccount(providerId);
      toast.success(t('aiProviders.toast.defaultUpdated'));
    } catch (error) {
      toast.error(`${t('aiProviders.toast.failedDefault')}: ${error}`);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-h-5">
          {showRefreshingHint ? (
            <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{t('aiProviders.status.refreshing')}</span>
            </div>
          ) : null}
        </div>

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
          <Button size="sm" onClick={() => setShowAddDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            {t('aiProviders.add')}
          </Button>
        </div>
      </div>

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
                void refreshProviderSnapshot({
                  trigger: 'manual',
                  reason: 'user_retry_refresh',
                });
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
        <div className="space-y-4">
          {displayProviders.map((item) => (
            <ProviderCard
              key={item.account.id}
              item={item}
              allProviders={displayProviders}
              isMutating={Boolean(mutatingActionsByAccountId[item.account.id])}
              isDeleting={Boolean(mutatingActionsByAccountId[item.account.id]?.delete)}
              isSettingDefault={Boolean(mutatingActionsByAccountId[item.account.id]?.setDefault)}
              isDefault={item.account.id === defaultAccountId}
              isEditing={editingProvider === item.account.id}
              onEdit={() => setEditingProvider(item.account.id)}
              onCancelEdit={() => setEditingProvider(null)}
              onDelete={() => handleDeleteProvider(item.account.id)}
              onSetDefault={() => handleSetDefault(item.account.id)}
              onSaveEdits={async (payload) => {
                const updates: Partial<ProviderAccount> = {};
                if (payload.updates) {
                  if (payload.updates.baseUrl !== undefined) updates.baseUrl = payload.updates.baseUrl;
                  if (payload.updates.apiProtocol !== undefined) updates.apiProtocol = payload.updates.apiProtocol;
                  if (payload.updates.headers !== undefined) updates.headers = payload.updates.headers;
                  if (payload.updates.model !== undefined) updates.model = payload.updates.model;
                  if (Object.prototype.hasOwnProperty.call(payload.updates, 'contextWindow')) {
                    updates.contextWindow = payload.updates.contextWindow;
                  }
                  if (Object.prototype.hasOwnProperty.call(payload.updates, 'maxTokens')) {
                    updates.maxTokens = payload.updates.maxTokens;
                  }
                  if (payload.updates.fallbackModels !== undefined) updates.fallbackModels = payload.updates.fallbackModels;
                  if (payload.updates.fallbackProviderIds !== undefined) {
                    updates.fallbackAccountIds = payload.updates.fallbackProviderIds;
                  }
                }
                await updateAccount(
                  item.account.id,
                  updates,
                  payload.newApiKey
                );
                setEditingProvider(null);
              }}
              onValidateKey={(key, options) => validateAccountApiKey(item.account.id, key, options)}
              devModeUnlocked={devModeUnlocked}
            />
          ))}
        </div>
      )}

      {/* Add Provider Dialog */}
      {showAddDialog && (
        <AddProviderDialog
          existingVendorIds={existingVendorIds}
          vendors={vendors}
          onClose={() => setShowAddDialog(false)}
          onAdd={handleAddProvider}
          onValidateKey={(type, key, options) => validateAccountApiKey(type, key, options)}
          devModeUnlocked={devModeUnlocked}
        />
      )}
    </div>
  );
}

interface ProviderCardProps {
  item: ProviderListItem;
  allProviders: ProviderListItem[];
  isMutating: boolean;
  isDeleting: boolean;
  isSettingDefault: boolean;
  isDefault: boolean;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
  onSaveEdits: (payload: { newApiKey?: string; updates?: Partial<ProviderConfig> }) => Promise<void>;
  onValidateKey: (
    key: string,
    options?: {
      baseUrl?: string;
      apiProtocol?: ProviderAccount['apiProtocol'];
      headers?: Record<string, string>;
    }
  ) => Promise<{ valid: boolean; error?: string }>;
  devModeUnlocked: boolean;
}



function ProviderCard({
  item,
  allProviders,
  isMutating,
  isDeleting,
  isSettingDefault,
  isDefault,
  isEditing,
  onEdit,
  onCancelEdit,
  onDelete,
  onSetDefault,
  onSaveEdits,
  onValidateKey,
  devModeUnlocked,
}: ProviderCardProps) {
  const { t, i18n } = useTranslation('settings');
  const { account, vendor, status } = item;
  const [newKey, setNewKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(account.baseUrl || '');
  const [apiProtocol, setApiProtocol] = useState<ProviderAccount['apiProtocol']>(
    account.apiProtocol || 'openai-completions',
  );
  const [modelId, setModelId] = useState(account.model || '');
  const [contextWindow, setContextWindow] = useState(formatOptionalPositiveInteger(account.contextWindow));
  const [maxTokens, setMaxTokens] = useState(formatOptionalPositiveInteger(account.maxTokens));
  const [fallbackModelsText, setFallbackModelsText] = useState(
    normalizeFallbackModels(account.fallbackModels).join('\n')
  );
  const [fallbackProviderIds, setFallbackProviderIds] = useState<string[]>(
    normalizeFallbackProviderIds(account.fallbackAccountIds)
  );
  const [fallbackExpanded, setFallbackExpanded] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [arkMode, setArkMode] = useState<ArkMode>('apikey');

  const typeInfo = PROVIDER_TYPE_INFO.find((t) => t.id === account.vendorId);
  const providerDocsUrl = getProviderDocsUrl(typeInfo, i18n.language);
  const showModelIdField = shouldShowProviderModelId(typeInfo, devModeUnlocked);
  const codePlanPreset = typeInfo?.codePlanPresetBaseUrl && typeInfo?.codePlanPresetModelId
    ? {
      baseUrl: typeInfo.codePlanPresetBaseUrl,
      modelId: typeInfo.codePlanPresetModelId,
    }
    : null;
  const effectiveDocsUrl = account.vendorId === 'ark' && arkMode === 'codeplan'
    ? (typeInfo?.codePlanDocsUrl || providerDocsUrl)
    : providerDocsUrl;
  const canEditModelConfig = Boolean(typeInfo?.showBaseUrl || showModelIdField);
  const sanitizedHeaders = stripUserAgentHeader(account.headers);
  const hasLegacyUserAgentHeader = Object.keys(account.headers ?? {}).length
    !== Object.keys(sanitizedHeaders ?? {}).length;

  const resolveAccountLabel = (candidate: ProviderAccount): string => {
    const rawLabel = (candidate.label ?? '').trim();
    if (candidate.vendorId !== 'custom') {
      return rawLabel || candidate.vendorId;
    }
    if (!rawLabel) {
      return t('aiProviders.custom');
    }
    const lower = rawLabel.toLowerCase();
    if (lower === 'custom' || rawLabel === '自定义' || rawLabel === 'カスタム') {
      return t('aiProviders.custom');
    }
    return rawLabel;
  };
  const displayAccountLabel = resolveAccountLabel(account);

  useEffect(() => {
    if (isEditing) {
      setNewKey('');
      setShowKey(false);
      setBaseUrl(account.baseUrl || '');
      setApiProtocol(account.apiProtocol || 'openai-completions');
      setModelId(account.model || '');
      setContextWindow(formatOptionalPositiveInteger(account.contextWindow));
      setMaxTokens(formatOptionalPositiveInteger(account.maxTokens));
      setFallbackModelsText(normalizeFallbackModels(account.fallbackModels).join('\n'));
      setFallbackProviderIds(normalizeFallbackProviderIds(account.fallbackAccountIds));
      setFallbackExpanded(false);
      setArkMode(
        isArkCodePlanMode(
          account.vendorId,
          account.baseUrl,
          account.model,
          typeInfo?.codePlanPresetBaseUrl,
          typeInfo?.codePlanPresetModelId,
        ) ? 'codeplan' : 'apikey'
      );
    }
  }, [
    isEditing,
    account.apiProtocol,
    account.baseUrl,
    account.contextWindow,
    account.headers,
    account.fallbackModels,
    account.fallbackAccountIds,
    account.maxTokens,
    account.model,
    account.vendorId,
    typeInfo?.codePlanPresetBaseUrl,
    typeInfo?.codePlanPresetModelId,
  ]);

  useEffect(() => {
    if (!isEditing) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      onCancelEdit();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isEditing, onCancelEdit]);

  const fallbackOptions = allProviders.filter((candidate) => candidate.account.id !== account.id);
  const fallbackSelectionCount = normalizeFallbackModels(fallbackModelsText.split('\n')).length
    + normalizeFallbackProviderIds(fallbackProviderIds).length;

  const toggleFallbackProvider = (providerId: string) => {
    setFallbackProviderIds((current) => (
      current.includes(providerId)
        ? current.filter((id) => id !== providerId)
        : [...current, providerId]
    ));
  };

  const handleSaveEdits = async () => {
    setSaving(true);
    try {
      const payload: { newApiKey?: string; updates?: Partial<ProviderConfig> } = {};
      const normalizedFallbackModels = normalizeFallbackModels(fallbackModelsText.split('\n'));
      const nextContextWindow = parseOptionalPositiveInteger(contextWindow);
      const nextMaxTokens = parseOptionalPositiveInteger(maxTokens);

      if (newKey.trim()) {
        setValidating(true);
        const result = await onValidateKey(newKey, {
          baseUrl: baseUrl.trim() || undefined,
          apiProtocol: (account.vendorId === 'custom' || account.vendorId === 'ollama')
            ? apiProtocol
            : undefined,
          headers: sanitizedHeaders,
        });
        setValidating(false);
        if (!result.valid) {
          toast.error(result.error || t('aiProviders.toast.invalidKey'));
          setSaving(false);
          return;
        }
        payload.newApiKey = newKey.trim();
      }

      {
        if (showModelIdField && !modelId.trim()) {
          toast.error(t('aiProviders.toast.modelRequired'));
          setSaving(false);
          return;
        }

        const updates: Partial<ProviderConfig> = {};
        if (typeInfo?.showBaseUrl && (baseUrl.trim() || undefined) !== (account.baseUrl || undefined)) {
          updates.baseUrl = baseUrl.trim() || undefined;
        }
        if (
          (account.vendorId === 'custom' || account.vendorId === 'ollama')
          && (apiProtocol || 'openai-completions') !== (account.apiProtocol || 'openai-completions')
        ) {
          updates.apiProtocol = apiProtocol || 'openai-completions';
        }
        if (showModelIdField && (modelId.trim() || undefined) !== (account.model || undefined)) {
          updates.model = modelId.trim() || undefined;
        }
        if (account.vendorId === 'custom' && nextContextWindow !== account.contextWindow) {
          updates.contextWindow = nextContextWindow;
        }
        if (account.vendorId === 'custom' && nextMaxTokens !== account.maxTokens) {
          updates.maxTokens = nextMaxTokens;
        }
        if (hasLegacyUserAgentHeader) {
          updates.headers = sanitizedHeaders;
        }
        if (!fallbackModelsEqual(normalizedFallbackModels, account.fallbackModels)) {
          updates.fallbackModels = normalizedFallbackModels;
        }
        if (!fallbackProviderIdsEqual(fallbackProviderIds, account.fallbackAccountIds)) {
          updates.fallbackProviderIds = normalizeFallbackProviderIds(fallbackProviderIds);
        }
        if (Object.keys(updates).length > 0) {
          payload.updates = updates;
        }
      }

      // Keep Ollama key optional in UI, but persist a placeholder when
      // editing legacy configs that have no stored key.
      if (account.vendorId === 'ollama' && !status?.hasKey && !payload.newApiKey) {
        payload.newApiKey = resolveProviderApiKeyForSave(account.vendorId, '') as string;
      }

      if (!payload.newApiKey && !payload.updates) {
        onCancelEdit();
        setSaving(false);
        return;
      }

      await onSaveEdits(payload);
      setNewKey('');
      toast.success(t('aiProviders.toast.updated'));
    } catch (error) {
      toast.error(`${t('aiProviders.toast.failedUpdate')}: ${error}`);
    } finally {
      setSaving(false);
      setValidating(false);
    }
  };

  return (
    <Card className={cn(isDefault && 'ring-2 ring-primary')}>
      <CardContent className="p-4">
        {/* Top row: icon + name */}
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {getProviderIconUrl(account.vendorId) ? (
              <img src={getProviderIconUrl(account.vendorId)} alt={typeInfo?.name || account.vendorId} className={cn('h-5 w-5', shouldInvertInDark(account.vendorId) && 'dark:invert')} />
            ) : (
              <span className="text-xl">{vendor?.icon || typeInfo?.icon || '⚙️'}</span>
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 truncate font-semibold">{displayAccountLabel}</span>
                <Badge variant="secondary" className="shrink-0">{vendor?.name || account.vendorId}</Badge>
                <Badge variant="outline" className="shrink-0">{getAuthModeLabel(account.authMode, t)}</Badge>
              </div>
              <div className="mt-1 space-y-0.5">
                <p className="text-xs text-muted-foreground capitalize">{account.vendorId}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {t('aiProviders.dialog.modelId')}: {account.model || t('aiProviders.card.none')}
                </p>
              </div>
            </div>
          </div>
          {isEditing && (
            <div className="flex flex-col items-end gap-2">
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
              {effectiveDocsUrl && (
                <a
                  href={effectiveDocsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                >
                  {t('aiProviders.dialog.customDoc')}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}
        </div>

        {/* Key row */}
        {isEditing ? (
          <div className="space-y-4">
            {canEditModelConfig && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">{t('aiProviders.sections.model')}</p>
                {typeInfo?.showBaseUrl && (
                  <div className="space-y-1">
                    <Label className="text-xs">{t('aiProviders.dialog.baseUrl')}</Label>
                    <Input
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder={getProtocolBaseUrlPlaceholder(apiProtocol)}
                      className="h-9 text-sm"
                    />
                  </div>
                )}
                {account.vendorId === 'ark' && codePlanPreset && (
                  <div className="space-y-1.5 pt-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-xs">{t('aiProviders.dialog.codePlanPreset')}</Label>
                      {typeInfo?.codePlanDocsUrl && (
                        <a
                          href={typeInfo.codePlanDocsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                        >
                          {t('aiProviders.dialog.codePlanDoc')}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <div className="flex gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => {
                          setArkMode('apikey');
                          setBaseUrl(typeInfo?.defaultBaseUrl || '');
                          if (modelId.trim() === codePlanPreset.modelId) {
                            setModelId(typeInfo?.defaultModelId || '');
                          }
                        }}
                        className={cn(
                          'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                          arkMode === 'apikey'
                            ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                            : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10',
                        )}
                      >
                        {t('aiProviders.authModes.apiKey')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setArkMode('codeplan');
                          setBaseUrl(codePlanPreset.baseUrl);
                          setModelId(codePlanPreset.modelId);
                        }}
                        className={cn(
                          'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                          arkMode === 'codeplan'
                            ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                            : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10',
                        )}
                      >
                        {t('aiProviders.dialog.codePlanMode')}
                      </button>
                    </div>
                    {arkMode === 'codeplan' && (
                      <p className="text-xs text-muted-foreground">
                        {t('aiProviders.dialog.codePlanPresetDesc')}
                      </p>
                    )}
                  </div>
                )}
                {account.vendorId === 'custom' && (
                  <div className="space-y-1">
                    <Label className="text-xs">{t('aiProviders.dialog.protocol', 'Protocol')}</Label>
                    <div className="flex gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => setApiProtocol('openai-completions')}
                        className={cn(
                          'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                          apiProtocol === 'openai-completions'
                            ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                            : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10',
                        )}
                      >
                        {t('aiProviders.protocols.openaiCompletions', 'OpenAI Completions')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setApiProtocol('openai-responses')}
                        className={cn(
                          'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                          apiProtocol === 'openai-responses'
                            ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                            : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10',
                        )}
                      >
                        {t('aiProviders.protocols.openaiResponses', 'OpenAI Responses')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setApiProtocol('anthropic-messages')}
                        className={cn(
                          'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                          apiProtocol === 'anthropic-messages'
                            ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                            : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10',
                        )}
                      >
                        {t('aiProviders.protocols.anthropic', 'Anthropic')}
                      </button>
                    </div>
                  </div>
                )}
                {showModelIdField && (
                  <div className="space-y-1">
                    <Label htmlFor={`provider-model-id-${account.id}`} className="text-xs">
                      {t('aiProviders.dialog.modelId')}
                    </Label>
                    <Input
                      id={`provider-model-id-${account.id}`}
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                      placeholder={typeInfo?.modelIdPlaceholder || 'provider/model-id'}
                      className="h-9 text-sm"
                    />
                  </div>
                )}
                {account.vendorId === 'custom' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor={`provider-context-window-${account.id}`} className="text-xs">
                        {t('aiProviders.dialog.contextWindow')}
                      </Label>
                      <Input
                        id={`provider-context-window-${account.id}`}
                        type="number"
                        min="1"
                        step="1"
                        value={contextWindow}
                        onChange={(e) => setContextWindow(e.target.value)}
                        placeholder="200000"
                        className="h-9 text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`provider-max-tokens-${account.id}`} className="text-xs">
                        {t('aiProviders.dialog.maxTokens')}
                      </Label>
                      <Input
                        id={`provider-max-tokens-${account.id}`}
                        type="number"
                        min="1"
                        step="1"
                        value={maxTokens}
                        onChange={(e) => setMaxTokens(e.target.value)}
                        placeholder="64000"
                        className="h-9 text-sm"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="space-y-3 rounded-md border p-3">
              <button
                type="button"
                onClick={() => setFallbackExpanded((current) => !current)}
                className="group flex w-full items-center justify-between gap-3 text-left"
                aria-expanded={fallbackExpanded}
                aria-label={fallbackExpanded
                  ? t('aiProviders.dialog.collapseFallback')
                  : t('aiProviders.dialog.expandFallback')}
              >
                <div className="space-y-1">
                  <p className="text-sm font-medium">{t('aiProviders.sections.fallback')}</p>
                  <p className="text-xs text-muted-foreground">
                    {fallbackSelectionCount > 0
                      ? t('aiProviders.dialog.fallbackSummaryCount', { count: fallbackSelectionCount })
                      : t('aiProviders.dialog.fallbackSummaryEmpty')}
                  </p>
                </div>
                <ChevronRight
                  className={cn(
                    'h-4 w-4 shrink-0 text-muted-foreground transition-all group-hover:text-foreground',
                    fallbackExpanded && 'rotate-90 text-foreground',
                  )}
                />
              </button>
              {fallbackExpanded && (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor={`fallback-model-ids-${account.id}`} className="text-xs">
                      {t('aiProviders.dialog.fallbackModelIds')}
                    </Label>
                    <textarea
                      id={`fallback-model-ids-${account.id}`}
                      value={fallbackModelsText}
                      onChange={(e) => setFallbackModelsText(e.target.value)}
                      placeholder={t('aiProviders.dialog.fallbackModelIdsPlaceholder')}
                      className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('aiProviders.dialog.fallbackModelIdsHelp')}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">{t('aiProviders.dialog.fallbackProviders')}</Label>
                    {fallbackOptions.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t('aiProviders.dialog.noFallbackOptions')}</p>
                    ) : (
                      <div className="space-y-2 rounded-md border p-2">
                        {fallbackOptions.map((candidate) => (
                          <label key={candidate.account.id} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={fallbackProviderIds.includes(candidate.account.id)}
                              onChange={() => toggleFallbackProvider(candidate.account.id)}
                            />
                            <span className="font-medium">{candidate.account.label}</span>
                            <span className="text-xs text-muted-foreground">
                              {candidate.account.model || candidate.vendor?.name || candidate.account.vendorId}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">{t('aiProviders.dialog.apiKey')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {status?.hasKey
                      ? t('aiProviders.dialog.apiKeyConfigured')
                      : t('aiProviders.dialog.apiKeyMissing')}
                  </p>
                </div>
                {status?.hasKey ? (
                  <Badge variant="secondary">{t('aiProviders.card.configured')}</Badge>
                ) : null}
              </div>
              {typeInfo?.apiKeyUrl && (
                <div className="flex justify-start">
                  <a
                    href={typeInfo.apiKeyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                    tabIndex={-1}
                  >
                    {t('aiProviders.oauth.getApiKey')} <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-xs">{t('aiProviders.dialog.replaceApiKey')}</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      type={showKey ? 'text' : 'password'}
                      placeholder={typeInfo?.requiresApiKey ? typeInfo?.placeholder : (typeInfo?.id === 'ollama' ? t('aiProviders.notRequired') : t('aiProviders.card.editKey'))}
                      value={newKey}
                      onChange={(e) => setNewKey(e.target.value)}
                      className="pr-10 h-9 text-sm"
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
                    variant="outline"
                    size="sm"
                    onClick={handleSaveEdits}
                    disabled={
                      validating
                      || saving
                      || (
                        !newKey.trim()
                        && (baseUrl.trim() || undefined) === (account.baseUrl || undefined)
                        && (apiProtocol || 'openai-completions') === (account.apiProtocol || 'openai-completions')
                        && !hasLegacyUserAgentHeader
                        && (modelId.trim() || undefined) === (account.model || undefined)
                        && parseOptionalPositiveInteger(contextWindow) === account.contextWindow
                        && parseOptionalPositiveInteger(maxTokens) === account.maxTokens
                        && fallbackModelsEqual(normalizeFallbackModels(fallbackModelsText.split('\n')), account.fallbackModels)
                        && fallbackProviderIdsEqual(fallbackProviderIds, account.fallbackAccountIds)
                      )
                      || Boolean(showModelIdField && !modelId.trim())
                    }
                  >
                    {validating || saving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('aiProviders.dialog.replaceApiKeyHelp')}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2 min-w-0">
                {account.authMode === 'oauth_device' || account.authMode === 'oauth_browser' ? (
                  <>
                    <Key className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <Badge variant="secondary" className="text-xs shrink-0">{t('aiProviders.card.configured')}</Badge>
                  </>
                ) : (
                  <>
                    <Key className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-sm font-mono text-muted-foreground truncate">
                      {status?.hasKey
                        ? (status.keyMasked && status.keyMasked.length > 12
                          ? `${status.keyMasked.substring(0, 4)}...${status.keyMasked.substring(status.keyMasked.length - 4)}`
                          : status.keyMasked)
                        : t('aiProviders.card.noKey')}
                    </span>
                    {status?.hasKey && (
                      <Badge variant="secondary" className="text-xs shrink-0">{t('aiProviders.card.configured')}</Badge>
                    )}
                  </>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate">
                {t('aiProviders.card.fallbacks', {
                  count: (account.fallbackModels?.length ?? 0) + (account.fallbackAccountIds?.length ?? 0),
                  names: [
                    ...normalizeFallbackModels(account.fallbackModels),
                    ...normalizeFallbackProviderIds(account.fallbackAccountIds)
                      .map((fallbackId) => {
                        const candidate = allProviders.find((provider) => provider.account.id === fallbackId);
                        return candidate ? resolveAccountLabel(candidate.account) : null;
                      })
                      .filter(Boolean),
                  ].join(', ') || t('aiProviders.card.none'),
                })}
              </p>
            </div>
            <div className="ml-2 flex shrink-0 gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={isDefault ? undefined : onSetDefault}
                title={isDefault ? t('aiProviders.card.default') : t('aiProviders.card.setDefault')}
                disabled={isDefault || isMutating}
              >
                {isSettingDefault ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <Star
                    className={cn(
                      'h-3.5 w-3.5 transition-colors',
                      isDefault
                        ? 'fill-yellow-400 text-yellow-400'
                        : 'text-muted-foreground'
                    )}
                  />
                )}
              </Button>
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
                {isDeleting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                )}
              </Button>
            </div>
          </div>
        )}
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
      apiProtocol?: ProviderAccount['apiProtocol'];
      headers?: Record<string, string>;
      model?: string;
      contextWindow?: number;
      maxTokens?: number;
      authMode?: ProviderAccount['authMode'];
    }
  ) => Promise<void>;
  onValidateKey: (
    type: string,
    apiKey: string,
    options?: {
      baseUrl?: string;
      apiProtocol?: ProviderAccount['apiProtocol'];
      headers?: Record<string, string>;
    }
  ) => Promise<{ valid: boolean; error?: string }>;
  devModeUnlocked: boolean;
}

function AddProviderDialog({
  existingVendorIds,
  vendors,
  onClose,
  onAdd,
  onValidateKey,
  devModeUnlocked,
}: AddProviderDialogProps) {
  const { t, i18n } = useTranslation('settings');
  const [selectedType, setSelectedType] = useState<ProviderType | null>(null);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiProtocol, setApiProtocol] = useState<ProviderAccount['apiProtocol']>('openai-completions');
  const [modelId, setModelId] = useState('');
  const [contextWindow, setContextWindow] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [arkMode, setArkMode] = useState<ArkMode>('apikey');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // OAuth Flow State
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
  // For providers that support both OAuth and API key, let the user choose.
  // Default to the vendor's declared auth mode instead of hard-coding OAuth.
  const [authMode, setAuthMode] = useState<'oauth' | 'apikey'>('apikey');

  const typeInfo = PROVIDER_TYPE_INFO.find((t) => t.id === selectedType);
  const providerDocsUrl = getProviderDocsUrl(typeInfo, i18n.language);
  const showModelIdField = shouldShowProviderModelId(typeInfo, devModeUnlocked);
  const codePlanPreset = typeInfo?.codePlanPresetBaseUrl && typeInfo?.codePlanPresetModelId
    ? {
      baseUrl: typeInfo.codePlanPresetBaseUrl,
      modelId: typeInfo.codePlanPresetModelId,
    }
    : null;
  const effectiveDocsUrl = selectedType === 'ark' && arkMode === 'codeplan'
    ? (typeInfo?.codePlanDocsUrl || providerDocsUrl)
    : providerDocsUrl;
  const isOAuth = typeInfo?.isOAuth ?? false;
  const supportsApiKey = typeInfo?.supportsApiKey ?? false;
  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const selectedVendor = selectedType ? vendorMap.get(selectedType) : undefined;
  const preferredOAuthMode = selectedVendor?.supportedAuthModes.includes('oauth_browser')
    ? 'oauth_browser'
    : (selectedVendor?.supportedAuthModes.includes('oauth_device')
      ? 'oauth_device'
      : (selectedType === 'google' ? 'oauth_browser' : null));
  // Effective OAuth mode: pure OAuth providers, or dual-mode with oauth selected
  const useOAuthFlow = isOAuth && (!supportsApiKey || authMode === 'oauth');

  useEffect(() => {
    if (!selectedVendor || !isOAuth || !supportsApiKey) {
      return;
    }
    setAuthMode(selectedVendor.defaultAuthMode === 'api_key' ? 'apikey' : 'oauth');
  }, [selectedVendor, isOAuth, supportsApiKey]);

  useEffect(() => {
    if (selectedType !== 'ark') {
      setArkMode('apikey');
      return;
    }
    setArkMode(
      isArkCodePlanMode(
        'ark',
        baseUrl,
        modelId,
        typeInfo?.codePlanPresetBaseUrl,
        typeInfo?.codePlanPresetModelId,
      ) ? 'codeplan' : 'apikey'
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedType]);

  // Keep refs to the latest values so event handlers see the current dialog state.
  const latestRef = React.useRef({ selectedType, typeInfo, onAdd, onClose, t });
  const pendingOAuthRef = React.useRef<{ accountId: string; label: string } | null>(null);
  useEffect(() => {
    latestRef.current = { selectedType, typeInfo, onAdd, onClose, t };
  });

  // Manage OAuth events
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

    const handleSuccess = async (data: unknown) => {
      setOauthFlowing(false);
      setOauthData(null);
      setManualCodeInput('');
      setValidationError(null);

      const { onClose: close, t: translate } = latestRef.current;
      const payload = (data as { accountId?: string } | undefined) || undefined;
      const accountId = payload?.accountId || pendingOAuthRef.current?.accountId;

      // device-oauth-manager already saved the provider config to the backend,
      // including the dynamically resolved baseUrl for the region (e.g. CN vs Global).
      // If we call add() here with undefined baseUrl, it will overwrite and erase it!
      // So we just fetch the latest list from the backend to update the UI.
      try {
        const store = useProviderStore.getState();
        await store.refreshProviderSnapshot({
          trigger: 'reconcile',
          reason: 'oauth_success_reconcile',
        });

        // OAuth sign-in should immediately become active default to avoid
        // leaving runtime on an API-key-only provider/model.
        if (accountId) {
          await store.setDefaultAccount(accountId);
        }
      } catch (err) {
        console.error('Failed to refresh providers after OAuth:', err);
      }

      pendingOAuthRef.current = null;
      close();
      toast.success(translate('aiProviders.toast.added'));
    };

    const handleError = (data: unknown) => {
      setOauthError((data as { message: string }).message);
      setOauthData(null);
      pendingOAuthRef.current = null;
    };

    const offCode = subscribeHostEvent('oauth:code', handleCode);
    const offSuccess = subscribeHostEvent('oauth:success', handleSuccess);
    const offError = subscribeHostEvent('oauth:error', handleError);

    return () => {
      offCode();
      offSuccess();
      offError();
    };
  }, []);

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
      const supportsMultipleAccounts = vendor?.supportsMultipleAccounts ?? selectedType === 'custom';
      const accountId = supportsMultipleAccounts ? `${selectedType}-${crypto.randomUUID()}` : selectedType;
      const label = name || (typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name) || selectedType;
      pendingOAuthRef.current = { accountId, label };
      await hostProviderStartOAuth({ provider: selectedType, accountId, label });
    } catch (e) {
      setOauthError(String(e));
      setOauthFlowing(false);
      pendingOAuthRef.current = null;
    }
  };

  const handleCancelOAuth = async () => {
    setOauthFlowing(false);
    setOauthData(null);
    setManualCodeInput('');
    setOauthError(null);
    pendingOAuthRef.current = null;
    await hostProviderCancelOAuth();
  };

  const handleSubmitManualOAuthCode = async () => {
    const value = manualCodeInput.trim();
    if (!value) return;
    try {
      await hostProviderSubmitOAuthCode(value);
      setOauthError(null);
    } catch (error) {
      setOauthError(String(error));
    }
  };

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

  const handleAdd = async () => {
    if (!selectedType) return;

    const hasMinimax = existingVendorIds.has('minimax-portal') || existingVendorIds.has('minimax-portal-cn');
    if ((selectedType === 'minimax-portal' || selectedType === 'minimax-portal-cn') && hasMinimax) {
      toast.error(t('aiProviders.toast.minimaxConflict'));
      return;
    }

    setSaving(true);
    setValidationError(null);

    try {
      // Validate key first if the provider requires one and a key was entered
      const requiresKey = typeInfo?.requiresApiKey ?? false;
      if (requiresKey && !apiKey.trim()) {
        setValidationError(t('aiProviders.toast.invalidKey')); // reusing invalid key msg or should add 'required' msg? null checks
        setSaving(false);
        return;
      }
      if (requiresKey && apiKey) {
        const result = await onValidateKey(selectedType, apiKey, {
          baseUrl: baseUrl.trim() || undefined,
          apiProtocol: (selectedType === 'custom' || selectedType === 'ollama')
            ? apiProtocol
            : undefined,
        });
        if (!result.valid) {
          setValidationError(result.error || t('aiProviders.toast.invalidKey'));
          setSaving(false);
          return;
        }
      }

      const requiresModel = showModelIdField;
      if (requiresModel && !modelId.trim()) {
        setValidationError(t('aiProviders.toast.modelRequired'));
        setSaving(false);
        return;
      }

      const nextContextWindow = parseOptionalPositiveInteger(contextWindow);
      const nextMaxTokens = parseOptionalPositiveInteger(maxTokens);

      await onAdd(
        selectedType,
        name || (typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name) || selectedType,
        apiKey.trim(),
        {
          baseUrl: baseUrl.trim() || undefined,
          apiProtocol: (selectedType === 'custom' || selectedType === 'ollama')
            ? apiProtocol
            : undefined,
          model: resolveProviderModelForSave(typeInfo, modelId, devModeUnlocked),
          contextWindow: selectedType === 'custom' ? nextContextWindow : undefined,
          maxTokens: selectedType === 'custom' ? nextMaxTokens : undefined,
          authMode: useOAuthFlow ? (preferredOAuthMode || 'oauth_device') : selectedType === 'ollama'
            ? 'local'
            : (isOAuth && supportsApiKey && authMode === 'apikey')
              ? 'api_key'
              : vendorMap.get(selectedType)?.defaultAuthMode || 'api_key',
        }
      );
    } catch {
      // error already handled via toast in parent
    } finally {
      setSaving(false);
    }
  };

  if (typeof document === 'undefined') {
    return null;
  }

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
                    setModelId(type.defaultModelId || '');
                    setContextWindow('');
                    setMaxTokens('');
                    setArkMode('apikey');
                  }}
                  className="p-4 rounded-lg border hover:bg-accent transition-colors text-center"
                >
                  {getProviderIconUrl(type.id) ? (
                    <img src={getProviderIconUrl(type.id)} alt={type.name} className={cn('h-7 w-7 mx-auto', shouldInvertInDark(type.id) && 'dark:invert')} />
                  ) : (
                    <span className="text-2xl">{type.icon}</span>
                  )}
                  <p className="font-medium mt-2">{type.id === 'custom' ? t('aiProviders.custom') : type.name}</p>
                </button>
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex min-w-0 items-center gap-3 rounded-lg bg-muted p-3">
                {getProviderIconUrl(selectedType!) ? (
                  <img src={getProviderIconUrl(selectedType!)} alt={typeInfo?.name} className={cn('h-7 w-7', shouldInvertInDark(selectedType!) && 'dark:invert')} />
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
                      setModelId('');
                      setContextWindow('');
                      setMaxTokens('');
                      setArkMode('apikey');
                    }}
                    className="text-sm text-muted-foreground hover:text-foreground"
                  >
                    {t('aiProviders.dialog.change')}
                  </button>
                  {effectiveDocsUrl && (
                    <>
                      <span className="mx-2 text-foreground/20">|</span>
                      <a
                        href={effectiveDocsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[13px] text-blue-500 hover:text-blue-600 font-medium inline-flex items-center gap-1"
                      >
                        {t('aiProviders.dialog.customDoc')}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="name">{t('aiProviders.dialog.displayName')}</Label>
                <Input
                  id="name"
                  placeholder={typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              {/* Auth mode toggle for providers supporting both */}
              {isOAuth && supportsApiKey && (
                <div className="flex rounded-lg border overflow-hidden text-sm">
                  <button
                    onClick={() => setAuthMode('oauth')}
                    className={cn(
                      'flex-1 py-2 px-3 transition-colors',
                      authMode === 'oauth' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'
                    )}
                  >
                    {t('aiProviders.oauth.loginMode')}
                  </button>
                  <button
                    onClick={() => setAuthMode('apikey')}
                    className={cn(
                      'flex-1 py-2 px-3 transition-colors',
                      authMode === 'apikey' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'
                    )}
                  >
                    {t('aiProviders.oauth.apikeyMode')}
                  </button>
                </div>
              )}

              {/* API Key input — shown for non-OAuth providers or when apikey mode is selected */}
              {(!isOAuth || (supportsApiKey && authMode === 'apikey')) && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="apiKey">{t('aiProviders.dialog.apiKey')}</Label>
                    {typeInfo?.apiKeyUrl && (
                      <a
                        href={typeInfo.apiKeyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline flex items-center gap-1"
                        tabIndex={-1}
                      >
                        {t('aiProviders.oauth.getApiKey')} <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <div className="relative">
                    <Input
                      id="apiKey"
                      type={showKey ? 'text' : 'password'}
                      placeholder={typeInfo?.id === 'ollama' ? t('aiProviders.notRequired') : typeInfo?.placeholder}
                      value={apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
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
                  {validationError && (
                    <p className="text-xs text-destructive">{validationError}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t('aiProviders.dialog.apiKeyStored')}
                  </p>
                </div>
              )}

              {typeInfo?.showBaseUrl && (
                <div className="space-y-2">
                  <Label htmlFor="baseUrl">{t('aiProviders.dialog.baseUrl')}</Label>
                  <Input
                    id="baseUrl"
                    placeholder={getProtocolBaseUrlPlaceholder(apiProtocol)}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </div>
              )}

              {selectedType === 'ark' && codePlanPreset && (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label>{t('aiProviders.dialog.codePlanPreset')}</Label>
                    {typeInfo?.codePlanDocsUrl && (
                      <a
                        href={typeInfo.codePlanDocsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                        tabIndex={-1}
                      >
                        {t('aiProviders.dialog.codePlanDoc')}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <div className="flex gap-2 text-[13px]">
                    <button
                      type="button"
                      onClick={() => {
                        setArkMode('apikey');
                        setBaseUrl(typeInfo?.defaultBaseUrl || '');
                        if (modelId.trim() === codePlanPreset.modelId) {
                          setModelId(typeInfo?.defaultModelId || '');
                        }
                        setValidationError(null);
                      }}
                      className={cn(
                        'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                        arkMode === 'apikey'
                          ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                          : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10',
                      )}
                    >
                      {t('aiProviders.authModes.apiKey')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setArkMode('codeplan');
                        setBaseUrl(codePlanPreset.baseUrl);
                        setModelId(codePlanPreset.modelId);
                        setValidationError(null);
                      }}
                      className={cn(
                        'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                        arkMode === 'codeplan'
                          ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                          : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10',
                      )}
                    >
                      {t('aiProviders.dialog.codePlanMode')}
                    </button>
                  </div>
                  {arkMode === 'codeplan' && (
                    <p className="text-xs text-muted-foreground">
                      {t('aiProviders.dialog.codePlanPresetDesc')}
                    </p>
                  )}
                </div>
              )}

              {selectedType === 'custom' && (
                <div className="space-y-2">
                  <Label>{t('aiProviders.dialog.protocol', 'Protocol')}</Label>
                  <div className="flex gap-2 text-[13px]">
                    <button
                      type="button"
                      onClick={() => setApiProtocol('openai-completions')}
                      className={cn(
                        'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                        apiProtocol === 'openai-completions'
                          ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                          : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10',
                      )}
                    >
                      {t('aiProviders.protocols.openaiCompletions', 'OpenAI Completions')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setApiProtocol('openai-responses')}
                      className={cn(
                        'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                        apiProtocol === 'openai-responses'
                          ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                          : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10',
                      )}
                    >
                      {t('aiProviders.protocols.openaiResponses', 'OpenAI Responses')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setApiProtocol('anthropic-messages')}
                      className={cn(
                        'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                        apiProtocol === 'anthropic-messages'
                          ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                          : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10',
                      )}
                    >
                      {t('aiProviders.protocols.anthropic', 'Anthropic')}
                    </button>
                  </div>
                </div>
              )}

              {showModelIdField && (
                <div className="space-y-2">
                  <Label htmlFor="modelId">{t('aiProviders.dialog.modelId')}</Label>
                  <Input
                    id="modelId"
                    placeholder={typeInfo?.modelIdPlaceholder || 'provider/model-id'}
                    value={modelId}
                    onChange={(e) => {
                      setModelId(e.target.value);
                      setValidationError(null);
                    }}
                  />
                </div>
              )}
              {selectedType === 'custom' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="contextWindow">{t('aiProviders.dialog.contextWindow')}</Label>
                    <Input
                      id="contextWindow"
                      type="number"
                      min="1"
                      step="1"
                      placeholder="200000"
                      value={contextWindow}
                      onChange={(e) => setContextWindow(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="maxTokens">{t('aiProviders.dialog.maxTokens')}</Label>
                    <Input
                      id="maxTokens"
                      type="number"
                      min="1"
                      step="1"
                      placeholder="64000"
                      value={maxTokens}
                      onChange={(e) => setMaxTokens(e.target.value)}
                    />
                  </div>
                </div>
              )}
              {/* Device OAuth Trigger — only shown when in OAuth mode */}
              {useOAuthFlow && (
                <div className="space-y-4 pt-2">
                  <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 p-4 text-center">
                    <p className="text-sm text-blue-200 mb-3 block">
                      {t('aiProviders.oauth.loginPrompt')}
                    </p>
                    <Button
                      onClick={handleStartOAuth}
                      disabled={oauthFlowing}
                      className="w-full bg-blue-600 hover:bg-blue-700 text-white"
                    >
                      {oauthFlowing ? (
                        <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{t('aiProviders.oauth.waiting')}</>
                      ) : (
                        t('aiProviders.oauth.loginButton')
                      )}
                    </Button>
                  </div>

                  {/* OAuth Active State Modal / Inline View */}
                  {oauthFlowing && (
                    <div className="mt-4 p-4 border rounded-xl bg-card relative overflow-hidden">
                      {/* Background pulse effect */}
                      <div className="absolute inset-0 bg-primary/5 animate-pulse" />

                      <div className="relative z-10 flex flex-col items-center justify-center text-center space-y-4">
                        {oauthError ? (
                          <div className="text-red-400 space-y-2">
                            <XCircle className="h-8 w-8 mx-auto" />
                            <p className="font-medium">{t('aiProviders.oauth.authFailed')}</p>
                            <p className="text-sm opacity-80">{oauthError}</p>
                            <Button variant="outline" size="sm" onClick={handleCancelOAuth} className="mt-2 text-foreground">
                              Try Again
                            </Button>
                          </div>
                        ) : !oauthData ? (
                          <div className="space-y-3 py-4">
                            <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
                            <p className="text-sm text-muted-foreground animate-pulse">{t('aiProviders.oauth.requestingCode')}</p>
                          </div>
                        ) : oauthData.mode === 'manual' ? (
                          <div className="space-y-4 w-full">
                            <div className="space-y-2 text-left">
                              <h3 className="font-medium text-lg text-foreground">Complete OpenAI Login</h3>
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
                              onChange={(e) => setManualCodeInput(e.target.value)}
                            />

                            <Button
                              className="w-full"
                              onClick={handleSubmitManualOAuthCode}
                              disabled={!manualCodeInput.trim()}
                            >
                              Submit Code
                            </Button>

                            <Button variant="ghost" size="sm" className="w-full mt-2" onClick={handleCancelOAuth}>
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <div className="space-y-4 w-full">
                            <div className="space-y-1">
                              <h3 className="font-medium text-lg text-foreground">{t('aiProviders.oauth.approveLogin')}</h3>
                              <div className="text-sm text-muted-foreground text-left mt-2 space-y-1">
                                <p>1. {t('aiProviders.oauth.step1')}</p>
                                <p>2. {t('aiProviders.oauth.step2')}</p>
                                <p>3. {t('aiProviders.oauth.step3')}</p>
                              </div>
                            </div>

                            <div className="flex items-center justify-center gap-2 p-3 bg-background border rounded-lg">
                              <code className="text-2xl font-mono tracking-widest font-bold text-primary">
                                {oauthData.userCode}
                              </code>
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

                            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground pt-2">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              <span>{t('aiProviders.oauth.waitingApproval')}</span>
                            </div>

                            <Button variant="ghost" size="sm" className="w-full mt-2" onClick={handleCancelOAuth}>
                              Cancel
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <Separator />

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t('aiProviders.dialog.cancel')}
            </Button>
            <Button
              onClick={handleAdd}
              className={cn(useOAuthFlow && "hidden")}
              disabled={!selectedType || saving || (showModelIdField && modelId.trim().length === 0)}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              {t('aiProviders.dialog.add')}
            </Button>
          </div>
        </div>
      </section>
    </div>
    ,
    document.body
  );
}
