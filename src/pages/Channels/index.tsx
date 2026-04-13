/**
 * Channels Page
 * Manage messaging channel connections with configuration UI
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus,
  Radio,
  RefreshCw,
  Trash2,
  Power,
  PowerOff,
  QrCode,
  Loader2,
  X,
  ExternalLink,
  BookOpen,
  Eye,
  EyeOff,
  Check,
  AlertCircle,
  CheckCircle,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useChannelsStore } from '@/stores/channels';
import { useGatewayStore } from '@/stores/gateway';
import { StatusBadge, type Status } from '@/components/common/StatusBadge';
import {
  hostChannelsCancelSession,
  hostChannelsFetchConfiguredTypes,
  hostChannelsReadConfig,
  hostChannelsSaveConfig,
  hostChannelsStartSession,
  hostChannelsValidateCredentials,
} from '@/lib/channel-runtime';
import { subscribeHostEvent } from '@/lib/host-events';
import { cn } from '@/lib/utils';
import {
  CHANNEL_ICONS,
  CHANNEL_NAMES,
  CHANNEL_META,
  getPrimaryChannels,
  type ChannelType,
  type Channel,
  type ChannelMeta,
  type ChannelConfigField,
} from '@/types/channel';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

const CHANNELS_EVENT_REFRESH_COOLDOWN_MS = 400;
const QR_API_BASE_BY_TYPE: Partial<Record<ChannelType, string>> = {
  whatsapp: '/api/channels/whatsapp',
  'openclaw-weixin': '/api/channels/openclaw-weixin',
};
const QR_EVENT_PREFIX_BY_TYPE: Partial<Record<ChannelType, string>> = {
  whatsapp: 'channel:whatsapp',
  'openclaw-weixin': 'channel:weixin',
};
const WEIXIN_ADVANCED_FIELD_KEYS = new Set(['baseUrl', 'cdnBaseUrl', 'logUploadUrl', 'routeTag']);
const QR_GENERATE_TIMEOUT_MS = 12_000;

function tryDecodeUriComponent(value: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(value)) {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isLikelyBase64(value: string): boolean {
  const normalized = value.replace(/\s+/g, '');
  return normalized.length > 64 && /^[A-Za-z0-9+/=]+$/.test(normalized);
}

function normalizeQrImageSource(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = tryDecodeUriComponent(value.trim());
  if (!trimmed) {
    return null;
  }
  if (/^data:image\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const compact = trimmed.replace(/\s+/g, '');
  if (isLikelyBase64(compact)) {
    return `data:image/png;base64,${compact}`;
  }
  return null;
}

function resolveQrImageSource(payload: { qrDataUrl?: string; qr?: string; raw?: string }): string | null {
  return (
    normalizeQrImageSource(payload.qrDataUrl)
    ?? normalizeQrImageSource(payload.qr)
    ?? normalizeQrImageSource(payload.raw)
  );
}

export function Channels() {
  const { t } = useTranslation('channels');
  const channels = useChannelsStore((state) => state.channels);
  const snapshotReady = useChannelsStore((state) => state.snapshotReady);
  const initialLoading = useChannelsStore((state) => state.initialLoading);
  const refreshing = useChannelsStore((state) => state.refreshing);
  const mutating = useChannelsStore((state) => state.mutating);
  const mutatingByChannelId = useChannelsStore((state) => state.mutatingByChannelId);
  const error = useChannelsStore((state) => state.error);
  const fetchChannels = useChannelsStore((state) => state.fetchChannels);
  const deleteChannel = useChannelsStore((state) => state.deleteChannel);
  const gatewayStatus = useGatewayStore((state) => state.status);

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [selectedChannelType, setSelectedChannelType] = useState<ChannelType | null>(null);
  const [configuredTypes, setConfiguredTypes] = useState<string[]>([]);
  const [channelToDelete, setChannelToDelete] = useState<{ id: string; type: ChannelType } | null>(null);
  const statusRefreshPendingRef = useRef(false);
  const statusRefreshRafRef = useRef<number | null>(null);
  const statusRefreshLastAtRef = useRef(0);
  const lastGatewayStateRef = useRef(gatewayStatus.state);

  // Fetch channels on mount
  useEffect(() => {
    void fetchChannels();
  }, [fetchChannels]);

  // Fetch configured channel types from config file
  const fetchConfiguredTypes = useCallback(async () => {
    try {
      const result = await hostChannelsFetchConfiguredTypes();
      if (result.success && result.channels) {
        setConfiguredTypes(result.channels);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchConfiguredTypes();
  }, [fetchConfiguredTypes]);

  const scheduleStatusRefresh = useCallback(() => {
    if (statusRefreshPendingRef.current) {
      return;
    }
    statusRefreshPendingRef.current = true;
    statusRefreshRafRef.current = window.requestAnimationFrame(() => {
      statusRefreshPendingRef.current = false;
      statusRefreshRafRef.current = null;
      const now = Date.now();
      if (now - statusRefreshLastAtRef.current < CHANNELS_EVENT_REFRESH_COOLDOWN_MS) {
        return;
      }
      statusRefreshLastAtRef.current = now;
      void fetchChannels({ silent: true });
      void fetchConfiguredTypes();
    });
  }, [fetchChannels, fetchConfiguredTypes]);

  useEffect(() => {
    const unsubscribe = subscribeHostEvent('gateway:channel-status', () => {
      scheduleStatusRefresh();
    });
    return () => {
      if (statusRefreshRafRef.current != null) {
        window.cancelAnimationFrame(statusRefreshRafRef.current);
        statusRefreshRafRef.current = null;
      }
      statusRefreshPendingRef.current = false;
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [scheduleStatusRefresh]);

  useEffect(() => {
    const previousGatewayState = lastGatewayStateRef.current;
    lastGatewayStateRef.current = gatewayStatus.state;
    if (previousGatewayState !== 'running' && gatewayStatus.state === 'running') {
      scheduleStatusRefresh();
    }
  }, [gatewayStatus.state, scheduleStatusRefresh]);

  // Get channel types to display
  const displayedChannelTypes = getPrimaryChannels();
  const safeChannels = Array.isArray(channels) ? channels : [];
  const configuredPlaceholderChannels: Channel[] = displayedChannelTypes
    .filter((type) => configuredTypes.includes(type) && !safeChannels.some((channel) => channel.type === type))
    .map((type) => ({
      id: `${type}-default`,
      type,
      name: CHANNEL_NAMES[type] || CHANNEL_META[type].name,
      status: 'disconnected',
    }));
  const configuredChannels = [...safeChannels, ...configuredPlaceholderChannels];

  // Connected/disconnected channel counts
  const connectedCount = configuredChannels.filter((c) => c.status === 'connected').length;
  const showInitialLoading = !snapshotReady && initialLoading;
  const manualRefreshBusy = refreshing || mutating;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground">
            {t('subtitle')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => { void fetchChannels(); }} disabled={manualRefreshBusy}>
            <RefreshCw className={cn('h-4 w-4 mr-2', refreshing && 'animate-spin')} />
            {t('refresh')}
          </Button>
          <Button onClick={() => setShowAddDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            {t('addChannel')}
          </Button>
        </div>
      </div>

      {/* Stats */}
      {!showInitialLoading && (
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="rounded-full bg-primary/10 p-3">
                  <Radio className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{configuredChannels.length}</p>
                  <p className="text-sm text-muted-foreground">{t('stats.total')}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="rounded-full bg-green-100 p-3 dark:bg-green-900">
                  <Power className="h-6 w-6 text-green-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{connectedCount}</p>
                  <p className="text-sm text-muted-foreground">{t('stats.connected')}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="rounded-full bg-slate-100 p-3 dark:bg-slate-800">
                  <PowerOff className="h-6 w-6 text-slate-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{configuredChannels.length - connectedCount}</p>
                  <p className="text-sm text-muted-foreground">{t('stats.disconnected')}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Gateway Warning */}
      {gatewayStatus.state !== 'running' && (
        <Card className="border-yellow-500 bg-yellow-50 dark:bg-yellow-900/10">
          <CardContent className="py-4 flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-yellow-500" />
            <span className="text-yellow-700 dark:text-yellow-400">
              {t('gatewayWarning')}
            </span>
          </CardContent>
        </Card>
      )}

      {/* Error Display */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4 text-destructive">
            {error}
          </CardContent>
        </Card>
      )}

      {refreshing && snapshotReady && (
        <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          {t('common:status.loading', 'Loading...')}
        </div>
      )}

      {showInitialLoading ? (
        <Card>
          <CardContent className="py-10">
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('common:status.loading', 'Loading...')}
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Configured Channels */}
          {configuredChannels.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>{t('configured')}</CardTitle>
                <CardDescription>{t('configuredDesc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {configuredChannels.map((channel) => (
                    <ChannelCard
                      key={channel.id}
                      channel={channel}
                      isMutating={Boolean(mutatingByChannelId[channel.id])}
                      onDelete={() => setChannelToDelete({ id: channel.id, type: channel.type })}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Available Channels */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>{t('available')}</CardTitle>
                  <CardDescription>
                    {t('availableDesc')}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                {displayedChannelTypes.map((type) => {
                  const meta = CHANNEL_META[type];
                  const isConfigured = configuredChannels.some((channel) => channel.type === type);
                  return (
                    <button
                      key={type}
                      className={`p-4 rounded-lg border hover:bg-accent transition-colors text-left relative ${isConfigured ? 'border-green-500/50 bg-green-500/5' : ''}`}
                      onClick={() => {
                        setSelectedChannelType(type);
                        setShowAddDialog(true);
                      }}
                    >
                      <span className="text-3xl">{meta.icon}</span>
                      <p className="font-medium mt-2">{meta.name}</p>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {meta.description}
                      </p>
                      {isConfigured && (
                        <Badge className="absolute top-2 right-2 text-xs bg-green-600 hover:bg-green-600">
                          {t('configuredBadge')}
                        </Badge>
                      )}
                      {!isConfigured && meta.isPlugin && (
                        <Badge variant="secondary" className="absolute top-2 right-2 text-xs">
                          {t('pluginBadge')}
                        </Badge>
                      )}
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Add Channel Dialog */}
      {showAddDialog && (
        <AddChannelDialog
          selectedType={selectedChannelType}
          onSelectType={setSelectedChannelType}
          onClose={() => {
            setShowAddDialog(false);
            setSelectedChannelType(null);
          }}
          onChannelAdded={() => {
            void fetchChannels();
            void fetchConfiguredTypes();
            setShowAddDialog(false);
            setSelectedChannelType(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!channelToDelete}
        title={t('common.confirm', 'Confirm')}
        message={t('deleteConfirm')}
        confirmLabel={t('common.delete', 'Delete')}
        cancelLabel={t('common.cancel', 'Cancel')}
        variant="destructive"
        onConfirm={async () => {
          if (channelToDelete) {
            await deleteChannel(channelToDelete.id);
            await fetchChannels({ silent: true });
            await fetchConfiguredTypes();
            setChannelToDelete(null);
          }
        }}
        onCancel={() => setChannelToDelete(null)}
      />
    </div>
  );
}

// ==================== Channel Card Component ====================

interface ChannelCardProps {
  channel: Channel;
  isMutating?: boolean;
  onDelete: () => void;
}

function ChannelCard({ channel, isMutating = false, onDelete }: ChannelCardProps) {
  const { t } = useTranslation('channels');
  const status = channel.status as Status;
  const statusLabel = t(`status.${status}`, { defaultValue: status });

  return (
    <Card className="h-full">
      <CardContent className="flex h-full min-h-[136px] flex-col justify-between p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="text-2xl">
              {CHANNEL_ICONS[channel.type]}
            </span>
            <div className="min-w-0">
              <CardTitle className="truncate text-base">{channel.name}</CardTitle>
              <CardDescription className="truncate text-xs">
                {CHANNEL_NAMES[channel.type]}
              </CardDescription>
            </div>
          </div>
          <StatusBadge status={status} label={statusLabel} className="shrink-0 max-w-none" />
        </div>

        <div className="min-h-5">
          {channel.error ? (
            <p className="line-clamp-2 text-xs text-destructive">{channel.error}</p>
          ) : (
            <p className="text-xs text-muted-foreground">{CHANNEL_NAMES[channel.type]}</p>
          )}
        </div>

        <div className="flex items-center justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
            disabled={isMutating}
          >
            {isMutating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ==================== Add Channel Dialog ====================

interface AddChannelDialogProps {
  selectedType: ChannelType | null;
  onSelectType: (type: ChannelType | null) => void;
  onClose: () => void;
  onChannelAdded: () => void;
}

function AddChannelDialog({ selectedType, onSelectType, onClose, onChannelAdded }: AddChannelDialogProps) {
  const { t } = useTranslation('channels');
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [channelName, setChannelName] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrImageFailed, setQrImageFailed] = useState(false);
  const [validating, setValidating] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [isExistingConfig, setIsExistingConfig] = useState(false);
  const qrGenerateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  } | null>(null);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);

  const meta: ChannelMeta | null = selectedType ? CHANNEL_META[selectedType] : null;

  const clearQrGenerateTimeout = useCallback(() => {
    if (qrGenerateTimeoutRef.current) {
      clearTimeout(qrGenerateTimeoutRef.current);
      qrGenerateTimeoutRef.current = null;
    }
  }, []);

  // Load existing config when a channel type is selected
  useEffect(() => {
    if (!selectedType) {
      clearQrGenerateTimeout();
      setConnecting(false);
      setConfigValues({});
      setChannelName('');
      setIsExistingConfig(false);
      setQrCode(null);
      setQrImageFailed(false);
      setShowAdvancedSettings(false);
      // 清理可能存在的二维码会话
      void hostChannelsCancelSession('whatsapp').catch(() => { });
      void hostChannelsCancelSession('openclaw-weixin').catch(() => { });
      return;
    }
    setShowAdvancedSettings(false);

    let cancelled = false;
    setLoadingConfig(true);

    (async () => {
      try {
        const result = await hostChannelsReadConfig(selectedType);

        if (cancelled) return;

        if (result.success && result.values && Object.keys(result.values).length > 0) {
          setConfigValues(result.values);
          setIsExistingConfig(true);
        } else {
          setConfigValues({});
          setIsExistingConfig(false);
        }
      } catch {
        if (!cancelled) {
          setConfigValues({});
          setIsExistingConfig(false);
        }
      } finally {
        if (!cancelled) setLoadingConfig(false);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedType, clearQrGenerateTimeout]);

  // Focus first input when form is ready (avoids Windows focus loss after native dialogs)
  useEffect(() => {
    if (selectedType && !loadingConfig && firstInputRef.current) {
      firstInputRef.current.focus();
    }
  }, [selectedType, loadingConfig]);

  // 监听二维码渠道事件（WhatsApp / WeChat）
  useEffect(() => {
    if (!selectedType || CHANNEL_META[selectedType].connectionType !== 'qr') return;
    const eventPrefix = QR_EVENT_PREFIX_BY_TYPE[selectedType];
    const qrApiBase = QR_API_BASE_BY_TYPE[selectedType];
    if (!eventPrefix || !qrApiBase) return;

    const onQr = (data: { qr?: string; qrDataUrl?: string; raw?: string }) => {
      clearQrGenerateTimeout();
      const resolved = resolveQrImageSource(data ?? {});
      if (resolved) {
        setQrImageFailed(false);
        setQrCode(resolved);
        setConnecting(false);
      } else {
        setQrCode(null);
      }
    };

    const onSuccess = async (data?: { accountId?: string }) => {
      clearQrGenerateTimeout();
      if (selectedType === 'whatsapp') {
        toast.success(t('toast.whatsappConnected'));
      } else {
        toast.success(t('toast.channelSaved', { name: CHANNEL_NAMES[selectedType] }));
      }
      void data;
      onChannelAdded();
      setConnecting(false);
    };

    const onError = (raw: unknown) => {
      clearQrGenerateTimeout();
      const err = typeof raw === 'string' ? raw : String(raw ?? '');
      console.error('QR Login Error:', err);
      if (selectedType === 'whatsapp') {
        toast.error(t('toast.whatsappFailed', { error: err }));
      } else {
        toast.error(t('toast.configFailed', { error: err }));
      }
      setQrCode(null);
      setQrImageFailed(false);
      setConnecting(false);
    };

    const removeQrListener = subscribeHostEvent(`${eventPrefix}-qr`, onQr);
    const removeSuccessListener = subscribeHostEvent(`${eventPrefix}-success`, onSuccess);
    const removeErrorListener = subscribeHostEvent(`${eventPrefix}-error`, onError);

    return () => {
      if (typeof removeQrListener === 'function') removeQrListener();
      if (typeof removeSuccessListener === 'function') removeSuccessListener();
      if (typeof removeErrorListener === 'function') removeErrorListener();
      clearQrGenerateTimeout();
      // Cancel when unmounting or switching types
      const qrChannelType = selectedType as Extract<ChannelType, 'whatsapp' | 'openclaw-weixin'>;
      void hostChannelsCancelSession(qrChannelType).catch(() => { });
    };
  }, [selectedType, channelName, onChannelAdded, t, clearQrGenerateTimeout]);

  const handleValidate = async () => {
    if (!selectedType) return;

    setValidating(true);
    setValidationResult(null);

    try {
      const result = await hostChannelsValidateCredentials(selectedType, configValues);

      const warnings = result.warnings || [];
      if (result.valid && result.details) {
        const details = result.details;
        if (details.botUsername) warnings.push(`Bot: @${details.botUsername}`);
        if (details.guildName) warnings.push(`Server: ${details.guildName}`);
        if (details.channelName) warnings.push(`Channel: #${details.channelName}`);
      }

      setValidationResult({
        valid: result.valid || false,
        errors: result.errors || [],
        warnings,
      });
    } catch (error) {
      setValidationResult({
        valid: false,
        errors: [String(error)],
        warnings: [],
      });
    } finally {
      setValidating(false);
    }
  };


  const handleConnect = async () => {
    if (!selectedType || !meta) return;

    setConnecting(true);
    setValidationResult(null);

    try {
      // For QR-based channels, request QR code
      if (meta.connectionType === 'qr') {
        if (!QR_API_BASE_BY_TYPE[selectedType]) {
          throw new Error(`Unsupported QR channel type: ${selectedType}`);
        }
        clearQrGenerateTimeout();
        qrGenerateTimeoutRef.current = setTimeout(() => {
          setConnecting(false);
          toast.error(t('toast.qrGenerateTimeout'));
        }, QR_GENERATE_TIMEOUT_MS);
        const accountId = channelName.trim() || 'default';
        const qrChannelType = selectedType as Extract<ChannelType, 'whatsapp' | 'openclaw-weixin'>;
        await hostChannelsStartSession(qrChannelType, { accountId, config: configValues });
        // The QR code will be set via event listener
        return;
      }

      // Step 1: Validate credentials against the actual service API
      if (meta.connectionType === 'token') {
        const validationResponse = await hostChannelsValidateCredentials(selectedType, configValues);

        if (!validationResponse.valid) {
          setValidationResult({
            valid: false,
            errors: validationResponse.errors || ['Validation failed'],
            warnings: validationResponse.warnings || [],
          });
          setConnecting(false);
          return;
        }

        // Show success details (bot name, guild name, etc.) as warnings/info
        const warnings = validationResponse.warnings || [];
        if (validationResponse.details) {
          const details = validationResponse.details;
          if (details.botUsername) {
            warnings.push(`Bot: @${details.botUsername}`);
          }
          if (details.guildName) {
            warnings.push(`Server: ${details.guildName}`);
          }
          if (details.channelName) {
            warnings.push(`Channel: #${details.channelName}`);
          }
        }

        // Show validation success with details
        setValidationResult({
          valid: true,
          errors: [],
          warnings,
        });
      }

      // Step 2: Save channel configuration via IPC
      const config: Record<string, unknown> = { ...configValues };
      const saveResult = await hostChannelsSaveConfig({ channelType: selectedType, config });
      if (!saveResult?.success) {
        throw new Error(saveResult?.error || 'Failed to save channel config');
      }
      if (typeof saveResult.warning === 'string' && saveResult.warning) {
        toast.warning(saveResult.warning);
      }

      toast.success(t('toast.channelSaved', { name: meta.name }));

      // Brief delay so user can see the success state before dialog closes
      await new Promise((resolve) => setTimeout(resolve, 800));
      onChannelAdded();
    } catch (error) {
      clearQrGenerateTimeout();
      toast.error(t('toast.configFailed', { error }));
      setConnecting(false);
    }
  };

  const openDocs = () => {
    if (meta?.docsUrl) {
      const url = t(meta.docsUrl);
      try {
        if (window.electron?.openExternal) {
          window.electron.openExternal(url);
        } else {
          // Fallback: open in new window
          window.open(url, '_blank');
        }
      } catch (error) {
        console.error('Failed to open docs:', error);
        // Fallback: open in new window
        window.open(url, '_blank');
      }
    }
  };


  const isFormValid = () => {
    if (!meta) return false;

    // Check all required fields are filled
    return meta.configFields
      .filter((field) => field.required)
      .every((field) => configValues[field.key]?.trim());
  };

  const updateConfigValue = (key: string, value: string) => {
    setConfigValues((prev) => ({ ...prev, [key]: value }));
  };

  const toggleSecretVisibility = (key: string) => {
    setShowSecrets((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const isWeixinChannel = selectedType === 'openclaw-weixin';
  const regularFields = meta?.configFields.filter((field) => !WEIXIN_ADVANCED_FIELD_KEYS.has(field.key)) ?? [];
  const advancedFields = isWeixinChannel
    ? meta?.configFields.filter((field) => WEIXIN_ADVANCED_FIELD_KEYS.has(field.key)) ?? []
    : [];

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <Card
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle>
              {selectedType
                ? isExistingConfig
                  ? t('dialog.updateTitle', { name: CHANNEL_NAMES[selectedType] })
                  : t('dialog.configureTitle', { name: CHANNEL_NAMES[selectedType] })
                : t('dialog.addTitle')}
            </CardTitle>
            <CardDescription>
              {selectedType && isExistingConfig
                ? t('dialog.existingDesc')
                : meta ? t(meta.description) : t('dialog.selectDesc')}
            </CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {!selectedType ? (
            // Channel type selection
            <div className="grid grid-cols-2 gap-4">
              {getPrimaryChannels().map((type) => {
                const channelMeta = CHANNEL_META[type];
                return (
                  <button
                    key={type}
                    onClick={() => onSelectType(type)}
                    className="p-4 rounded-lg border hover:bg-accent transition-colors text-left"
                  >
                    <span className="text-3xl">{channelMeta.icon}</span>
                    <p className="font-medium mt-2">{channelMeta.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {channelMeta.connectionType === 'qr' ? t('dialog.qrCode') : t('dialog.token')}
                    </p>
                  </button>
                );
              })}
            </div>
          ) : qrCode ? (
            // QR Code display
            <div className="text-center space-y-4">
              <div className="bg-white p-4 rounded-lg inline-block shadow-sm border">
                {!qrImageFailed ? (
                  <img
                    src={qrCode}
                    alt={t('dialog.qrImageAlt', { name: meta?.name || 'QR Code' })}
                    className="w-64 h-64 object-contain"
                    onError={() => setQrImageFailed(true)}
                  />
                ) : (
                  <div className="w-64 h-64 bg-gray-100 flex items-center justify-center">
                    <QrCode className="h-32 w-32 text-gray-400" />
                  </div>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {t('dialog.scanQR', { name: meta?.name })}
              </p>
              <div className="flex justify-center gap-2">
                <Button variant="outline" onClick={() => {
                  setQrCode(null);
                  setQrImageFailed(false);
                  handleConnect(); // Retry
                }}>
                  {t('dialog.refreshCode')}
                </Button>
              </div>
            </div>
          ) : loadingConfig ? (
            // Loading saved config
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">{t('dialog.loadingConfig')}</span>
            </div>
          ) : (
            // Connection form
            <div className="space-y-4">
              {/* Existing config hint */}
              {isExistingConfig && (
                <div className="bg-blue-500/10 text-blue-600 dark:text-blue-400 p-3 rounded-lg text-sm flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 shrink-0" />
                  <span>{t('dialog.existingHint')}</span>
                </div>
              )}

              {/* Instructions */}
              <div className="bg-muted p-4 rounded-lg space-y-3">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-sm">{t('dialog.howToConnect')}</p>
                  <Button
                    variant="link"
                    className="p-0 h-auto text-sm"
                    onClick={openDocs}
                  >
                    <BookOpen className="h-3 w-3 mr-1" />
                    {t('dialog.viewDocs')}
                    <ExternalLink className="h-3 w-3 ml-1" />
                  </Button>
                </div>
                <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1">
                  {meta?.instructions.map((instruction, i) => (
                    <li key={i}>{t(instruction)}</li>
                  ))}
                </ol>
              </div>

              {/* Channel name */}
              <div className="space-y-2">
                <Label htmlFor="name">{t('dialog.channelName')}</Label>
                <Input
                  ref={firstInputRef}
                  id="name"
                  placeholder={t('dialog.channelNamePlaceholder', { name: meta?.name })}
                  value={channelName}
                  onChange={(e) => setChannelName(e.target.value)}
                />
              </div>

              {/* Configuration fields */}
              {regularFields.map((field) => (
                <ConfigField
                  key={field.key}
                  field={field}
                  value={configValues[field.key] || ''}
                  onChange={(value) => updateConfigValue(field.key, value)}
                  showSecret={showSecrets[field.key] || false}
                  onToggleSecret={() => toggleSecretVisibility(field.key)}
                />
              ))}

              {/* Weixin optional advanced settings */}
              {isWeixinChannel && advancedFields.length > 0 && (
                <div className="rounded-lg border border-border/80 bg-muted/20 p-3 space-y-3">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between text-sm font-medium"
                    onClick={() => setShowAdvancedSettings((prev) => !prev)}
                  >
                    <span>{t('dialog.advancedSettings')}</span>
                    {showAdvancedSettings ? (
                      <ChevronUp className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    )}
                  </button>
                  {showAdvancedSettings && (
                    <div className="space-y-4">
                      {advancedFields.map((field) => (
                        <ConfigField
                          key={field.key}
                          field={field}
                          value={configValues[field.key] || ''}
                          onChange={(value) => updateConfigValue(field.key, value)}
                          showSecret={showSecrets[field.key] || false}
                          onToggleSecret={() => toggleSecretVisibility(field.key)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Validation Results */}
              {validationResult && (
                <div className={`p-4 rounded-lg text-sm ${validationResult.valid ? 'bg-green-500/10 text-green-600 dark:text-green-400' : 'bg-destructive/10 text-destructive'
                  }`}>
                  <div className="flex items-start gap-2">
                    {validationResult.valid ? (
                      <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    ) : (
                      <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <h4 className="font-medium mb-1">
                        {validationResult.valid ? t('dialog.credentialsVerified') : t('dialog.validationFailed')}
                      </h4>
                      {validationResult.errors.length > 0 && (
                        <ul className="list-disc list-inside space-y-0.5">
                          {validationResult.errors.map((err, i) => (
                            <li key={i}>{err}</li>
                          ))}
                        </ul>
                      )}
                      {validationResult.valid && validationResult.warnings.length > 0 && (
                        <div className="mt-1 text-green-600 dark:text-green-400 space-y-0.5">
                          {validationResult.warnings.map((info, i) => (
                            <p key={i} className="text-xs">{info}</p>
                          ))}
                        </div>
                      )}
                      {!validationResult.valid && validationResult.warnings.length > 0 && (
                        <div className="mt-2 text-yellow-600 dark:text-yellow-500">
                          <p className="font-medium text-xs uppercase mb-1">{t('dialog.warnings')}</p>
                          <ul className="list-disc list-inside space-y-0.5">
                            {validationResult.warnings.map((warn, i) => (
                              <li key={i}>{warn}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <Separator />

              <div className="flex justify-between">
                <Button variant="outline" onClick={() => onSelectType(null)}>
                  {t('dialog.back')}
                </Button>
                <div className="flex gap-2">
                  {/* Validation Button - Only for token-based channels for now */}
                  {meta?.connectionType === 'token' && (
                    <Button
                      variant="secondary"
                      onClick={handleValidate}
                      disabled={validating}
                    >
                      {validating ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          {t('dialog.validating')}
                        </>
                      ) : (
                        <>
                          <ShieldCheck className="h-4 w-4 mr-2" />
                          {t('dialog.validateConfig')}
                        </>
                      )}
                    </Button>
                  )}
                  <Button
                    onClick={handleConnect}
                    disabled={connecting || !isFormValid()}
                  >
                    {connecting ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        {meta?.connectionType === 'qr' ? t('dialog.generatingQR') : t('dialog.validatingAndSaving')}
                      </>
                    ) : meta?.connectionType === 'qr' ? (
                      t('dialog.generateQRCode')
                    ) : (
                      <>
                        <Check className="h-4 w-4 mr-2" />
                        {isExistingConfig ? t('dialog.updateAndReconnect') : t('dialog.saveAndConnect')}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div >
  );
}

// ==================== Config Field Component ====================

interface ConfigFieldProps {
  field: ChannelConfigField;
  value: string;
  onChange: (value: string) => void;
  showSecret: boolean;
  onToggleSecret: () => void;
}

function ConfigField({ field, value, onChange, showSecret, onToggleSecret }: ConfigFieldProps) {
  const { t } = useTranslation('channels');
  const isPassword = field.type === 'password';

  return (
    <div className="space-y-2">
      <Label htmlFor={field.key}>
        {t(field.label)}
        {field.required && <span className="text-destructive ml-1">*</span>}
      </Label>
      <div className="flex gap-2">
        <Input
          id={field.key}
          type={isPassword && !showSecret ? 'password' : 'text'}
          placeholder={field.placeholder ? t(field.placeholder) : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-sm"
        />
        {isPassword && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onToggleSecret}
          >
            {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        )}
      </div>
      {field.description && (
        <p className="text-xs text-muted-foreground">
          {t(field.description)}
        </p>
      )}
      {field.envVar && (
        <p className="text-xs text-muted-foreground">
          {t('dialog.envVar', { var: field.envVar })}
        </p>
      )}
    </div>
  );
}

export default Channels;
