/**
 * Channels Page
 * Manage messaging channel connections with configuration UI
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Plus,
  Radio,
  RefreshCw,
  Trash2,
  QrCode,
  Loader2,
  X,
  BookOpen,
  Eye,
  EyeOff,
  Check,
  AlertCircle,
  CheckCircle,
  ShieldCheck,
  UserCheck,
  Settings,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { ChannelIcon } from '@/components/channels/ChannelIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useChannelsStore } from '@/stores/channels';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { StatusBadge, type Status } from '@/components/common/StatusBadge';
import {
  channelErrorCode,
  logChannelTrace,
  hostChannelsActivate,
  hostChannelsConfigure,
  hostChannelsApprovePairingRequest,
  hostChannelsCancelAuthorization,
  hostChannelsCancelSession,
  hostChannelsLoginWait,
  hostChannelsListPairingRequests,
  hostChannelsReadConfig,
  hostChannelsStartAuthorization,
  hostChannelsValidateCredentials,
  hostChannelsWaitAuthorization,
  type ChannelPairingRequest,
} from '@/lib/channel-runtime';
import { subscribeHostEvent } from '@/lib/host-events';
import { isGatewayOperational, isGatewayPreparing } from '@/lib/gateway-status';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import { invokeIpc } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import {
  CHANNEL_NAMES,
  CHANNEL_META,
  getPrimaryChannels,
  type ChannelType,
  type Channel,
  type ChannelMeta,
  type ChannelConfigField,
  type ChannelSetupMode,
} from '@/types/channel';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

const CHANNELS_EVENT_REFRESH_COOLDOWN_MS = 400;
const CHANNELS_STATUS_POLL_MS = 10_000;
const WEIXIN_ADVANCED_FIELD_KEYS = new Set(['baseUrl', 'cdnBaseUrl', 'logUploadUrl', 'routeTag']);
const QR_GENERATE_TIMEOUT_MS = 12_000;
const CHANNEL_CONFIG_LOADING_DELAY_MS = 180;

type ChannelDialogTarget =
  | { kind: 'catalog' }
  | { kind: 'new'; type: ChannelType }
  | { kind: 'configured'; channel: Channel };

type ChannelAuthPrompt = Readonly<{
  qrDataUrl?: string;
  authorizationUrl?: string;
  sessionKey?: string;
}>;

type DialogSetupMode = ChannelSetupMode;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function channelConnectionLabelKey(connectionType: ChannelMeta['connectionType']): string {
  switch (connectionType) {
    case 'qr':
      return 'dialog.qrCode';
    case 'oauth':
      return 'dialog.authorization';
    case 'webhook':
      return 'dialog.webhook';
    case 'token':
      return 'dialog.token';
  }
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
  const probeChannels = useChannelsStore((state) => state.probeChannels);
  const deleteChannel = useChannelsStore((state) => state.deleteChannel);
  const gatewayStatus = useGatewayStore((state) => state.status);
  const gatewayInitialized = useGatewayStore((state) => state.isInitialized);

  const [dialogTarget, setDialogTarget] = useState<ChannelDialogTarget | null>(null);
  const [channelToDelete, setChannelToDelete] = useState<{ id: string; type: ChannelType; traceId: string; startedAt: number } | null>(null);
  const [pairingChannel, setPairingChannel] = useState<Channel | null>(null);
  const statusRefreshPendingRef = useRef(false);
  const statusRefreshRafRef = useRef<number | null>(null);
  const statusRefreshLastAtRef = useRef(0);
  const lastGatewayOperationalRef = useRef(isGatewayOperational(gatewayStatus));

  // Fetch channels on mount
  useEffect(() => {
    void fetchChannels({ silent: true });
  }, [fetchChannels]);

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
    });
  }, [fetchChannels]);

  useEffect(() => {
    const unsubscribe = subscribeHostEvent('gateway:channel-status', (payload: unknown) => {
      if (isRecord(payload) && typeof payload.eventName === 'string' && payload.eventName.startsWith('channel:')) {
        return;
      }
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
    const gatewayOperational = isGatewayOperational(gatewayStatus);
    const previousGatewayOperational = lastGatewayOperationalRef.current;
    lastGatewayOperationalRef.current = gatewayOperational;
    if (!previousGatewayOperational && gatewayOperational) {
      scheduleStatusRefresh();
    }
  }, [gatewayStatus, scheduleStatusRefresh]);

  // Get channel types to display
  const displayedChannelTypes = getPrimaryChannels();
  const safeChannels = Array.isArray(channels) ? channels : [];
  const configuredChannels: Channel[] = safeChannels;

  // Connected/disconnected channel counts
  const connectedCount = configuredChannels.filter((c) => c.status === 'connected').length;
  const gatewayOperational = isGatewayOperational(gatewayStatus);
  const gatewayPreparing = isGatewayPreparing(gatewayStatus, gatewayInitialized);
  const showInitialLoading = !snapshotReady && initialLoading;
  const manualRefreshBusy = refreshing || mutating;
  const showRefreshingHint = useDelayedFlag(refreshing && snapshotReady, 180);

  useEffect(() => {
    if (!gatewayOperational || configuredChannels.length === 0) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void fetchChannels({ silent: true });
    }, CHANNELS_STATUS_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [configuredChannels.length, fetchChannels, gatewayOperational]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-[-0.03em]">{t('title')}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {t('subtitle')}
            </p>
          </div>
          {!showInitialLoading && (
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex h-8 items-center gap-2 rounded-full border border-border/80 bg-card px-3 text-xs text-muted-foreground">
                <Radio className="h-3.5 w-3.5" />
                <strong className="text-foreground">{configuredChannels.length}</strong>
                {t('stats.total')}
              </span>
              <span className="inline-flex h-8 items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 text-xs text-emerald-700 dark:text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <strong>{connectedCount}</strong>
                {t('stats.connected')}
              </span>
              <span className="inline-flex h-8 items-center gap-2 rounded-full border border-border/80 bg-secondary/70 px-3 text-xs text-muted-foreground">
                <strong className="text-foreground">{configuredChannels.length - connectedCount}</strong>
                {t('stats.disconnected')}
              </span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            onClick={() => {
              void probeChannels();
            }}
            disabled={manualRefreshBusy || !gatewayOperational}
          >
            <RefreshCw className={cn('h-4 w-4 mr-2', refreshing && 'animate-spin')} />
            {t('refresh')}
          </Button>
          <Button onClick={() => setDialogTarget({ kind: 'catalog' })}>
            <Plus className="h-4 w-4 mr-2" />
            {t('addChannel')}
          </Button>
        </div>
      </div>

      {/* Gateway Warning */}
      {!gatewayOperational && (
        <Card className={gatewayPreparing ? 'border-border bg-muted/30' : 'border-yellow-500 bg-yellow-50 dark:bg-yellow-900/10'}>
          <CardContent className="py-4 flex items-center gap-3">
            {gatewayPreparing ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : (
              <AlertCircle className="h-5 w-5 text-yellow-500" />
            )}
            <span className={gatewayPreparing ? 'text-muted-foreground' : 'text-yellow-700 dark:text-yellow-400'}>
              {gatewayPreparing ? t('gatewayPreparing') : t('gatewayWarning')}
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

      {showRefreshingHint && (
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
            <section className="space-y-3">
              <div>
                <h2 className="text-base font-semibold tracking-[-0.02em]">{t('configured')}</h2>
                <p className="text-sm text-muted-foreground">{t('configuredDesc')}</p>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {configuredChannels.map((channel) => (
                  <ChannelCard
                    key={channel.id}
                    channel={channel}
                    isMutating={Boolean(mutatingByChannelId[channel.id])}
                    onConfigure={() => setDialogTarget({ kind: 'configured', channel })}
                    onManagePairing={channel.type === 'feishu' ? () => setPairingChannel(channel) : undefined}
                    onDelete={() => {
                      const traceId = crypto.randomUUID();
                      logChannelTrace('delete.click', traceId);
                      setChannelToDelete({ id: channel.id, type: channel.type, traceId, startedAt: Date.now() });
                    }}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Available Channels */}
          <section className="space-y-3 rounded-[1.5rem] border border-border/90 bg-card p-5">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-base font-semibold tracking-[-0.02em]">{t('available')}</h2>
                <p className="text-sm text-muted-foreground">{t('availableDesc')}</p>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
              {displayedChannelTypes.map((type) => {
                const meta = CHANNEL_META[type];
                const isConfigured = configuredChannels.some((channel) => channel.type === type);
                const connectionLabel = t(channelConnectionLabelKey(meta.connectionType));
                return (
                  <button
                    key={type}
                    className={cn(
                      'group relative flex min-h-[148px] flex-col rounded-[1.1rem] border p-4 text-left transition-[background-color,border-color,box-shadow] duration-150 hover:border-foreground/20 hover:shadow-whisper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20',
                      isConfigured
                        ? 'border-emerald-500/45 bg-emerald-500/10'
                        : 'border-border/90 bg-background/35 hover:bg-secondary/60'
                    )}
                    onClick={() => setDialogTarget({ kind: 'new', type })}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="grid h-11 w-11 place-items-center rounded-[0.9rem] bg-secondary shadow-sm">
                        <ChannelIcon id={meta.iconId} className="h-7 w-7" />
                      </span>
                      {isConfigured ? (
                        <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">
                          {t('configuredBadge')}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">
                          {connectionLabel}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-4 min-w-0 flex-1 space-y-1">
                      <p className="truncate text-base font-semibold tracking-[-0.02em]">{meta.name}</p>
                      <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {t(meta.description)}
                      </p>
                    </div>
                    <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{meta.isPlugin ? t('pluginBadge') : connectionLabel}</span>
                      <span>→</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        </>
      )}

      {/* Add Channel Dialog */}
      {dialogTarget && (
        <AddChannelDialog
          target={dialogTarget}
          onTargetChange={setDialogTarget}
          onClose={() => setDialogTarget(null)}
          onChannelAdded={() => {
            void fetchChannels();
            setDialogTarget(null);
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
            logChannelTrace('delete.submit', channelToDelete.traceId);
            const deleted = await deleteChannel(channelToDelete.id, { traceId: channelToDelete.traceId });
            if (deleted) {
              await fetchChannels({ silent: true });
            }
            logChannelTrace('delete.final', channelToDelete.traceId, { outcome: deleted ? 'confirmed' : 'unconfirmed', durationMs: Date.now() - channelToDelete.startedAt });
            setChannelToDelete(null);
          }
        }}
        onCancel={() => {
          if (channelToDelete) logChannelTrace('delete.final', channelToDelete.traceId, { outcome: 'cancelled', durationMs: Date.now() - channelToDelete.startedAt });
          setChannelToDelete(null);
        }}
      />

      {pairingChannel && (
        <ChannelPairingDialog
          channel={pairingChannel}
          onClose={() => setPairingChannel(null)}
        />
      )}
    </div>
  );
}

// ==================== Channel Card Component ====================

interface ChannelCardProps {
  channel: Channel;
  isMutating?: boolean;
  onConfigure: () => void;
  onManagePairing?: () => void;
  onDelete: () => void;
}

function ChannelCard({ channel, isMutating = false, onConfigure, onManagePairing, onDelete }: ChannelCardProps) {
  const { t } = useTranslation('channels');
  const status = channel.status as Status;
  const statusLabel = t(`status.${status}`, { defaultValue: status });

  return (
    <Card className="h-full bg-card/80">
      <CardContent className="flex h-full min-h-[118px] flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-[0.85rem] bg-secondary shadow-sm">
              <ChannelIcon id={CHANNEL_META[channel.type].iconId} className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <CardTitle className="truncate text-base tracking-[-0.02em]">{channel.name}</CardTitle>
              <CardDescription className="truncate text-xs leading-5">
                {CHANNEL_NAMES[channel.type]}
              </CardDescription>
            </div>
          </div>
          <StatusBadge status={status} label={statusLabel} className="shrink-0 max-w-none" />
        </div>

        {channel.error && (
          <p className="line-clamp-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{channel.error}</p>
        )}

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/70 pt-3">
          <p className="truncate text-xs text-muted-foreground">
            {CHANNEL_NAMES[channel.type]}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={onConfigure}
              disabled={isMutating}
              aria-label={t('dialog.configureTitle', { name: channel.name })}
            >
              <Settings className="h-4 w-4" />
            </Button>
            {onManagePairing && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onManagePairing}
                disabled={isMutating}
                aria-label={t('pairing.manage')}
              >
                <UserCheck className="h-4 w-4" />
              </Button>
            )}
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
        </div>
      </CardContent>
    </Card>
  );
}

// ==================== Channel Pairing Dialog ====================

interface ChannelPairingDialogProps {
  channel: Channel;
  onClose: () => void;
}

function ChannelPairingDialog({ channel, onClose }: ChannelPairingDialogProps) {
  const { t } = useTranslation('channels');
  const [requests, setRequests] = useState<ChannelPairingRequest[]>([]);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshRequests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await hostChannelsListPairingRequests(channel.type, channel.accountId);
      setRequests(result.requests || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [channel.accountId, channel.type]);

  useEffect(() => {
    void refreshRequests();
  }, [refreshRequests]);

  const approveCode = async (rawCode: string) => {
    const pairingCode = rawCode.trim().toUpperCase();
    if (!pairingCode) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await hostChannelsApprovePairingRequest(channel.type, {
        code: pairingCode,
        accountId: channel.accountId,
      });
      toast.success(t('pairing.approvedToast'));
      setCode('');
      await refreshRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <Card
        className="w-full max-w-lg"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle>{t('pairing.title', { name: channel.name })}</CardTitle>
            <CardDescription>{t('pairing.description')}</CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="channel-pairing-code">{t('pairing.codeLabel')}</Label>
            <div className="flex gap-2">
              <Input
                id="channel-pairing-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder={t('pairing.codePlaceholder')}
                className="font-mono uppercase"
              />
              <Button
                onClick={() => { void approveCode(code); }}
                disabled={submitting || !code.trim()}
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {t('pairing.approve')}
              </Button>
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <Separator />

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{t('pairing.pendingTitle')}</p>
              <Button variant="ghost" size="sm" onClick={() => { void refreshRequests(); }} disabled={loading}>
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </Button>
            </div>
            {loading ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('common:status.loading', 'Loading...')}
              </div>
            ) : requests.length > 0 ? (
              <div className="space-y-2">
                {requests.map((request) => (
                  <div key={request.id} className="flex items-center justify-between rounded-lg border p-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm">{request.id}</p>
                      <p className="truncate text-xs text-muted-foreground">{request.status}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
                {t('pairing.empty')}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ==================== Add Channel Dialog ====================

interface AddChannelDialogProps {
  target: ChannelDialogTarget;
  onTargetChange: (target: ChannelDialogTarget | null) => void;
  onClose: () => void;
  onChannelAdded: () => void;
}

function AddChannelDialog({ target, onTargetChange, onClose, onChannelAdded }: AddChannelDialogProps) {
  const { t } = useTranslation('channels');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const agents = useSubagentsStore((state) => state.agentsResource.data);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [channelName, setChannelName] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [loadedAgentId, setLoadedAgentId] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [authPrompt, setAuthPrompt] = useState<ChannelAuthPrompt | null>(null);
  const [qrImageFailed, setQrImageFailed] = useState(false);
  const [setupMode, setSetupMode] = useState<DialogSetupMode>('guided');
  const [validating, setValidating] = useState(false);
  const [loadedConfigKey, setLoadedConfigKey] = useState<string | null>(null);
  const [isExistingConfig, setIsExistingConfig] = useState(false);
  const qrGenerateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qrAccountIdRef = useRef<string | null>(null);
  const authSessionKeyRef = useRef<string | null>(null);
  const qrTraceIdRef = useRef<string | undefined>(undefined);
  const qrWaitAbortControllerRef = useRef<AbortController | null>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const onChannelAddedRef = useRef(onChannelAdded);
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  } | null>(null);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);

  const selectedType = target.kind === 'new'
    ? target.type
    : target.kind === 'configured'
      ? target.channel.type
      : null;
  const configuredChannel = target.kind === 'configured' ? target.channel : null;
  const meta: ChannelMeta | null = selectedType ? CHANNEL_META[selectedType] : null;
  const isConfiguredChannelEdit = target.kind === 'configured';
  const configuredAccountId = configuredChannel?.accountId?.trim() || undefined;
  const requiredFieldsFilled = meta?.configFields
    .filter((field) => field.required)
    .every((field) => configValues[field.key]?.trim()) ?? false;
  const configKey = selectedType ? `${selectedType}:${configuredAccountId ?? ''}` : null;
  const configReady = target.kind === 'catalog' || (configKey !== null && loadedConfigKey === configKey);
  const showConfigLoading = useDelayedFlag(!configReady, CHANNEL_CONFIG_LOADING_DELAY_MS);
  const isExistingTarget = target.kind === 'configured' || isExistingConfig;
  const guidedSetupFlow = meta?.setupFlows.find((flow) => flow.mode === 'guided')?.flow;
  const supportsGuidedSetup = Boolean(guidedSetupFlow);
  const supportsCredentialSetup = Boolean(meta?.setupFlows.some((flow) => flow.mode === 'credential'));
  const showSetupModeSwitch = !isConfiguredChannelEdit && supportsGuidedSetup && supportsCredentialSetup;
  const effectiveSetupMode: DialogSetupMode = showSetupModeSwitch ? setupMode : supportsGuidedSetup && !isConfiguredChannelEdit ? 'guided' : 'credential';
  const shouldStartAuthorization = guidedSetupFlow?.kind === 'authorization' && target.kind !== 'configured' && effectiveSetupMode === 'guided';
  const shouldStartQrLogin = guidedSetupFlow?.kind === 'qr-login' && target.kind !== 'configured' && effectiveSetupMode === 'guided';
  const shouldValidateToken = effectiveSetupMode === 'credential' && meta?.connectionType === 'token' && requiredFieldsFilled;
  const agentIdToSave = selectedAgentId && (!isConfiguredChannelEdit || selectedAgentId !== loadedAgentId)
    ? selectedAgentId
    : undefined;
  const agentOptions = useMemo(() => {
    const options = agents.some((agent) => agent.id === 'main')
      ? [...agents]
      : [{ id: 'main', name: t('dialog.mainAgent') }, ...agents];
    for (const id of [loadedAgentId, selectedAgentId]) {
      if (id && !options.some((agent) => agent.id === id)) options.push({ id, name: id });
    }
    return options;
  }, [agents, loadedAgentId, selectedAgentId, t]);

  useEffect(() => {
    onChannelAddedRef.current = onChannelAdded;
  }, [onChannelAdded]);

  useEffect(() => {
    void loadAgents({ silent: true }).catch(() => undefined);
  }, [loadAgents]);

  const clearQrGenerateTimeout = useCallback(() => {
    if (qrGenerateTimeoutRef.current) {
      clearTimeout(qrGenerateTimeoutRef.current);
      qrGenerateTimeoutRef.current = null;
    }
  }, []);

  const stopActiveLoginSession = useCallback(async () => {
    clearQrGenerateTimeout();
    qrWaitAbortControllerRef.current?.abort();
    qrWaitAbortControllerRef.current = null;

    const activeAccountId = qrAccountIdRef.current;
    const activeSessionKey = authSessionKeyRef.current;
    const traceId = qrTraceIdRef.current;
    qrAccountIdRef.current = null;
    authSessionKeyRef.current = null;

    if (!selectedType || (!activeAccountId && !activeSessionKey)) return;

    const startedAt = Date.now();
    logChannelTrace('login.cancel.start', traceId);
    if (shouldStartAuthorization && activeSessionKey) {
      try {
        const authChannelType = selectedType as Extract<ChannelType, 'qqbot' | 'dingtalk' | 'feishu'>;
        await hostChannelsCancelAuthorization(authChannelType, activeSessionKey, { traceId });
        logChannelTrace('login.cancel.end', traceId, { outcome: 'cancelled', durationMs: Date.now() - startedAt });
      } catch (error) {
        logChannelTrace('login.cancel.end', traceId, { outcome: 'error', errorCode: channelErrorCode(error), durationMs: Date.now() - startedAt });
      }
      return;
    }

    if (shouldStartQrLogin && activeAccountId) {
      try {
        const qrChannelType = selectedType as Extract<ChannelType, 'whatsapp' | 'openclaw-weixin'>;
        await hostChannelsCancelSession(qrChannelType, activeAccountId, { traceId });
        logChannelTrace('login.cancel.end', traceId, { outcome: 'cancelled', durationMs: Date.now() - startedAt });
      } catch (error) {
        logChannelTrace('login.cancel.end', traceId, { outcome: 'error', errorCode: channelErrorCode(error), durationMs: Date.now() - startedAt });
      }
    }
  }, [clearQrGenerateTimeout, selectedType, shouldStartAuthorization, shouldStartQrLogin]);

  // Load existing config when a channel type is selected
  useEffect(() => {
    setSelectedAgentId('');
    setLoadedAgentId('');
    if (!selectedType) {
      clearQrGenerateTimeout();
      qrWaitAbortControllerRef.current?.abort();
      qrWaitAbortControllerRef.current = null;
      qrAccountIdRef.current = null;
      authSessionKeyRef.current = null;
      setConnecting(false);
      setConfigValues({});
      setChannelName('');
      setIsExistingConfig(false);
      setAuthPrompt(null);
      setQrImageFailed(false);
      setSetupMode('guided');
      setShowAdvancedSettings(false);
      setLoadedConfigKey(null);
      return;
    }
    setShowAdvancedSettings(false);
    setSetupMode('guided');
    setChannelName(configuredAccountId ?? '');
    setConfigValues({});
    setIsExistingConfig(isConfiguredChannelEdit);
    setAuthPrompt(null);
    setQrImageFailed(false);
    setValidationResult(null);
    setLoadedConfigKey(null);

    let cancelled = false;
    const nextConfigKey = `${selectedType}:${configuredAccountId ?? ''}`;
    const traceId = crypto.randomUUID();
    const startedAt = Date.now();
    logChannelTrace('config.read.start', traceId);

    (async () => {
      try {
        const result = await hostChannelsReadConfig(selectedType, configuredAccountId, { traceId });

        if (cancelled) return;

        const hasValues = Object.keys(result.values).length > 0;
        logChannelTrace('config.read.end', traceId, { outcome: hasValues ? 'loaded' : 'empty', durationMs: Date.now() - startedAt });
        setConfigValues(result.values);
        setSelectedAgentId(result.agentId ?? '');
        setLoadedAgentId(result.agentId ?? '');
        if (hasValues) setIsExistingConfig(true);
      } catch (error) {
        if (!cancelled) {
          logChannelTrace('config.read.end', traceId, { outcome: 'error', errorCode: channelErrorCode(error), durationMs: Date.now() - startedAt });
        }
      } finally {
        if (!cancelled) setLoadedConfigKey(nextConfigKey);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedType, configuredAccountId, isConfiguredChannelEdit, clearQrGenerateTimeout]);

  // Focus first input when form is ready (avoids Windows focus loss after native dialogs)
  useEffect(() => {
    if (selectedType && configReady && firstInputRef.current) {
      firstInputRef.current.focus();
    }
  }, [selectedType, configReady]);

  useEffect(() => {
    if (!selectedType || (!shouldStartQrLogin && !shouldStartAuthorization)) return undefined;
    return () => { void stopActiveLoginSession(); };
  }, [selectedType, shouldStartQrLogin, shouldStartAuthorization, stopActiveLoginSession]);

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

    const traceId = crypto.randomUUID();
    const startedAt = Date.now();
    let outcome = 'unconfirmed';
    let activePhase: 'login.start' | 'validation' | 'config' | null = null;
    let phaseStartedAt = startedAt;
    logChannelTrace('create.click', traceId);
    const accountId = (configuredAccountId ?? channelName.trim()) || 'default';
    logChannelTrace('create.submit.start', traceId, { accountPresent: Boolean(accountId), gatewayOperational: isGatewayOperational(gatewayStatus) });
    setConnecting(true);
    setValidationResult(null);
    if (shouldStartQrLogin || shouldStartAuthorization) {
      await stopActiveLoginSession();
    }
    const explicitAgentId = agentIdToSave;

    try {
      // For QR-based channels, request QR code
      if (shouldStartQrLogin) {
        clearQrGenerateTimeout();
        qrGenerateTimeoutRef.current = setTimeout(() => {
          logChannelTrace('login.qr.timeout', traceId, { errorCode: 'TIMEOUT', durationMs: Date.now() - startedAt });
          setConnecting(false);
          toast.error(t('toast.qrGenerateTimeout'));
        }, QR_GENERATE_TIMEOUT_MS);
        const qrChannelType = selectedType as Extract<ChannelType, 'whatsapp' | 'openclaw-weixin'>;
        qrAccountIdRef.current = accountId;
        qrTraceIdRef.current = traceId;
        const loginStartedAt = Date.now();
        activePhase = 'login.start';
        phaseStartedAt = loginStartedAt;
        logChannelTrace('login.start.start', traceId);
        const startResult = await hostChannelsActivate({ channelType: qrChannelType, accountId, agentId: explicitAgentId, config: configValues }, { traceId });
        logChannelTrace('login.start.end', traceId, { outcome: startResult.success ? 'accepted' : 'unconfirmed', durationMs: Date.now() - loginStartedAt });
        activePhase = null;
        const progress = startResult.progress;
        if (!progress || (progress.outcome !== 'progress' && progress.outcome !== 'connected')) {
          throw new Error(startResult.error || 'Channel activation outcome is unknown');
        }
        if (progress.qrDataUrl) {
          setQrImageFailed(false);
          setAuthPrompt((current) => ({ ...current, qrDataUrl: progress.qrDataUrl, sessionKey: progress.sessionKey }));
          clearQrGenerateTimeout();
        }
        if (progress.outcome === 'connected') {
          clearQrGenerateTimeout();
          qrAccountIdRef.current = null;
          setConnecting(false);
          outcome = 'confirmed';
          logChannelTrace('login.confirmed', traceId);
          onChannelAddedRef.current();
          return;
        }
        const waitController = new AbortController();
        qrWaitAbortControllerRef.current = waitController;
        let currentQrDataUrl = progress.qrDataUrl;
        let sessionKey = progress.sessionKey;
        while (!waitController.signal.aborted) {
          let waitResult;
          const waitStartedAt = Date.now();
          logChannelTrace('login.wait.start', traceId);
          try {
            waitResult = await hostChannelsLoginWait(qrChannelType, accountId, {
              traceId,
              timeoutMs: 300_000,
              sessionKey,
              currentQrDataUrl,
              signal: waitController.signal,
            });
            logChannelTrace('login.wait.end', traceId, { outcome: ['progress', 'connected', 'target_rejected'].includes(waitResult.outcome) ? waitResult.outcome : 'unknown', durationMs: Date.now() - waitStartedAt });
          } catch (error) {
            logChannelTrace('login.wait.end', traceId, { outcome: 'error', errorCode: channelErrorCode(error), durationMs: Date.now() - waitStartedAt });
            if (waitController.signal.aborted) { outcome = 'cancelled'; return; }
            throw error;
          }
          if (waitController.signal.aborted) { outcome = 'cancelled'; return; }
          if (waitResult.sessionKey) {
            sessionKey = waitResult.sessionKey;
          }
          if (waitResult.qrDataUrl) {
            clearQrGenerateTimeout();
            currentQrDataUrl = waitResult.qrDataUrl;
            setQrImageFailed(false);
            setAuthPrompt((current) => ({ ...current, qrDataUrl: waitResult.qrDataUrl, sessionKey }));
          }
          if (waitResult.outcome === 'connected') {
            clearQrGenerateTimeout();
            qrAccountIdRef.current = null;
            qrWaitAbortControllerRef.current = null;
            setConnecting(false);
            outcome = 'confirmed';
            logChannelTrace('login.confirmed', traceId);
            onChannelAddedRef.current();
            return;
          }
          if (waitResult.outcome !== 'progress') {
            throw new Error(waitResult.outcome === 'target_rejected'
              ? 'Channel activation was rejected'
              : 'Channel activation outcome is unknown');
          }
        }
        return;
      }

      if (shouldStartAuthorization) {
        clearQrGenerateTimeout();
        const authorizationChannelType = selectedType as Extract<ChannelType, 'qqbot' | 'dingtalk' | 'feishu'>;
        const waitController = new AbortController();
        qrWaitAbortControllerRef.current = waitController;
        qrAccountIdRef.current = accountId;
        qrTraceIdRef.current = traceId;
        const loginStartedAt = Date.now();
        activePhase = 'login.start';
        phaseStartedAt = loginStartedAt;
        logChannelTrace('login.start.start', traceId);
        const startResult = await hostChannelsStartAuthorization({
          channelType: authorizationChannelType,
          accountId,
          ...(explicitAgentId ? { agentId: explicitAgentId } : {}),
          config: configValues,
        }, { traceId });
        logChannelTrace('login.start.end', traceId, { outcome: startResult.outcome, durationMs: Date.now() - loginStartedAt });
        activePhase = null;
        if (startResult.sessionKey) authSessionKeyRef.current = startResult.sessionKey;
        if (startResult.qrDataUrl || startResult.authorizationUrl || startResult.sessionKey) {
          setQrImageFailed(false);
          setAuthPrompt({
            qrDataUrl: startResult.qrDataUrl,
            authorizationUrl: startResult.authorizationUrl,
            sessionKey: startResult.sessionKey,
          });
        }
        if (startResult.outcome === 'connected') {
          qrAccountIdRef.current = null;
          authSessionKeyRef.current = null;
          qrWaitAbortControllerRef.current = null;
          setConnecting(false);
          outcome = 'confirmed';
          logChannelTrace('login.confirmed', traceId);
          onChannelAddedRef.current();
          return;
        }
        if (startResult.outcome !== 'progress' || !startResult.sessionKey) {
          throw new Error(startResult.outcome === 'target_rejected'
            ? 'Channel authorization was rejected'
            : 'Channel authorization outcome is unknown');
        }
        let sessionKey = startResult.sessionKey;
        while (!waitController.signal.aborted) {
          let waitResult;
          const waitStartedAt = Date.now();
          logChannelTrace('login.wait.start', traceId);
          try {
            waitResult = await hostChannelsWaitAuthorization(authorizationChannelType, sessionKey, {
              traceId,
              timeoutMs: 300_000,
              signal: waitController.signal,
            });
            logChannelTrace('login.wait.end', traceId, { outcome: ['progress', 'connected', 'target_rejected'].includes(waitResult.outcome) ? waitResult.outcome : 'unknown', durationMs: Date.now() - waitStartedAt });
          } catch (error) {
            logChannelTrace('login.wait.end', traceId, { outcome: 'error', errorCode: channelErrorCode(error), durationMs: Date.now() - waitStartedAt });
            if (waitController.signal.aborted) { outcome = 'cancelled'; return; }
            throw error;
          }
          if (waitController.signal.aborted) { outcome = 'cancelled'; return; }
          if (waitResult.sessionKey) {
            sessionKey = waitResult.sessionKey;
            authSessionKeyRef.current = waitResult.sessionKey;
          }
          if (waitResult.qrDataUrl || waitResult.authorizationUrl) {
            setQrImageFailed(false);
            setAuthPrompt((current) => ({
              ...current,
              qrDataUrl: waitResult.qrDataUrl ?? current?.qrDataUrl,
              authorizationUrl: waitResult.authorizationUrl ?? current?.authorizationUrl,
              sessionKey,
            }));
          }
          if (waitResult.outcome === 'connected') {
            qrAccountIdRef.current = null;
            authSessionKeyRef.current = null;
            qrWaitAbortControllerRef.current = null;
            setConnecting(false);
            outcome = 'confirmed';
            logChannelTrace('login.confirmed', traceId);
            onChannelAddedRef.current();
            return;
          }
          if (waitResult.outcome === 'cancelled') {
            outcome = 'cancelled';
            return;
          }
          if (waitResult.outcome !== 'progress') {
            throw new Error(waitResult.outcome === 'target_rejected'
              ? 'Channel authorization was rejected'
              : 'Channel authorization outcome is unknown');
          }
        }
        return;
      }

      // Step 1: Validate credentials against the actual service API
      if (shouldValidateToken) {
        const validationStartedAt = Date.now();
        activePhase = 'validation';
        phaseStartedAt = validationStartedAt;
        logChannelTrace('validation.start', traceId);
        const validationResponse = await hostChannelsValidateCredentials(selectedType, configValues, { traceId });
        logChannelTrace('validation.end', traceId, { outcome: validationResponse.valid ? 'valid' : 'invalid', durationMs: Date.now() - validationStartedAt });

        activePhase = null;
        if (!validationResponse.valid) {
          outcome = 'validation_rejected';
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

      // Step 2: Activate channel configuration
      const config: Record<string, unknown> = { ...configValues };
      const configStartedAt = Date.now();
      activePhase = 'config';
      phaseStartedAt = configStartedAt;
      logChannelTrace('config.start', traceId);
      const saveResult = await hostChannelsConfigure({ channelType: selectedType, accountId, agentId: explicitAgentId, config }, { traceId });
      logChannelTrace('config.end', traceId, { outcome: saveResult.success ? 'confirmed' : 'unconfirmed', durationMs: Date.now() - configStartedAt });
      activePhase = null;
      if (!saveResult?.success) {
        throw new Error(saveResult?.error || 'Failed to save channel config');
      }
      if (typeof saveResult.warning === 'string' && saveResult.warning) {
        toast.warning(saveResult.warning);
      }

      outcome = 'confirmed';
      toast.success(t('toast.channelSaved', { name: meta.name }));

      // Brief delay so user can see the success state before dialog closes
      await new Promise((resolve) => setTimeout(resolve, 800));
      onChannelAdded();
    } catch (error) {
      clearQrGenerateTimeout();
      outcome = 'error';
      if (activePhase) logChannelTrace(`${activePhase}.end`, traceId, { outcome, errorCode: channelErrorCode(error), durationMs: Date.now() - phaseStartedAt });
      logChannelTrace('create.error', traceId, { errorCode: channelErrorCode(error) });
      toast.error(t('toast.configFailed', { error: channelErrorCode(error) }));
      setConnecting(false);
    } finally {
      logChannelTrace('create.submit.end', traceId, { outcome, durationMs: Date.now() - startedAt });
      logChannelTrace('create.final', traceId, { outcome, durationMs: Date.now() - startedAt });
    }
  };

  const handleRefreshCode = () => {
    setQrImageFailed(false);
    void handleConnect();
  };

  const openDocs = () => {
    if (meta?.docsPath) {
      void invokeIpc('shell:openResourcePath', meta.docsPath).catch((error) => {
        console.error(`[startup-trace] ${JSON.stringify({ source: 'channel-renderer', phase: 'docs.error', errorCode: channelErrorCode(error) })}`);
        toast.error(t('toast.openDocsFailed', { error }));
      });
    }
  };


  const isFormValid = () => {
    if (!meta) return false;
    if (isConfiguredChannelEdit && agentIdToSave) return true;
    if (isConfiguredChannelEdit && Object.keys(configValues).length === 0) return false;
    if (shouldStartAuthorization) return true;

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
  const regularFields = shouldStartAuthorization ? [] : meta?.configFields.filter((field) => !WEIXIN_ADVANCED_FIELD_KEYS.has(field.key)) ?? [];
  const advancedFields = isWeixinChannel
    ? meta?.configFields.filter((field) => WEIXIN_ADVANCED_FIELD_KEYS.has(field.key)) ?? []
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <Card
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-[1.35rem] shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-start justify-between gap-4 border-b border-border/70 p-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[0.95rem] bg-secondary shadow-sm">
              {meta ? <ChannelIcon id={meta.iconId} className="h-7 w-7" /> : <Plus className="h-5 w-5" />}
            </span>
            <div className="min-w-0">
              <CardTitle className="text-lg">
                {selectedType
                  ? isExistingTarget
                    ? t('dialog.updateTitle', { name: CHANNEL_NAMES[selectedType] })
                    : t('dialog.configureTitle', { name: CHANNEL_NAMES[selectedType] })
                  : t('dialog.addTitle')}
              </CardTitle>
              <CardDescription className="mt-1 line-clamp-2 leading-5">
                {selectedType && isExistingTarget
                  ? t('dialog.existingDesc')
                  : meta ? t(meta.description) : t('dialog.selectDesc')}
              </CardDescription>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="-mr-2 -mt-2 shrink-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4 p-5">
          {target.kind === 'catalog' ? (
            // Channel type selection
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {getPrimaryChannels().map((type) => {
                const channelMeta = CHANNEL_META[type];
                return (
                  <button
                    key={type}
                    onClick={() => onTargetChange({ kind: 'new', type })}
                    className="group rounded-[1rem] border border-border/90 bg-background/35 p-4 text-left transition-[background-color,border-color,box-shadow] duration-150 hover:border-foreground/20 hover:bg-secondary/60 hover:shadow-whisper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="grid h-10 w-10 place-items-center rounded-[0.85rem] bg-secondary shadow-sm">
                        <ChannelIcon id={channelMeta.iconId} className="h-6 w-6" />
                      </span>
                      <Badge variant="secondary">
                        {t(channelConnectionLabelKey(channelMeta.connectionType))}
                      </Badge>
                    </div>
                    <p className="mt-3 font-semibold tracking-[-0.02em]">{channelMeta.name}</p>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                      {t(channelMeta.description)}
                    </p>
                  </button>
                );
              })}
            </div>
          ) : authPrompt ? (
            // QR/link authorization display
            <div className="rounded-[1.15rem] border border-border/90 bg-secondary/45 p-5 text-center">
              <p className="text-sm font-medium text-foreground">
                {authPrompt.qrDataUrl ? t('dialog.scanQR', { name: meta?.name }) : t('dialog.openAuthorization', { name: meta?.name })}
              </p>
              {authPrompt.qrDataUrl ? (
                <div className="mt-4 flex justify-center">
                  <div className="rounded-[1rem] border bg-white p-3 shadow-sm">
                    {!qrImageFailed ? (
                      <img
                        src={authPrompt.qrDataUrl}
                        alt={t('dialog.qrImageAlt', { name: meta?.name || 'QR Code' })}
                        className="h-56 w-56 object-contain"
                        onError={() => setQrImageFailed(true)}
                      />
                    ) : (
                      <div className="flex h-56 w-56 items-center justify-center bg-gray-100">
                        <QrCode className="h-28 w-28 text-gray-400" />
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
              <p className="mt-4 text-xs text-muted-foreground">{t('dialog.waitingForScan')}</p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {authPrompt.authorizationUrl ? (
                  <Button
                    variant="outline"
                    onClick={() => invokeIpc('shell:openExternal', authPrompt.authorizationUrl)}
                  >
                    {t('dialog.openAuthorizationLink')}
                  </Button>
                ) : null}
                <Button variant="outline" onClick={handleRefreshCode}>
                  {t('dialog.refreshCode')}
                </Button>
              </div>
            </div>
          ) : !configReady ? (
            // Loading saved config
            <div className="flex min-h-24 items-center justify-center py-8">
              {showConfigLoading ? (
                <>
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-sm text-muted-foreground">{t('dialog.loadingConfig')}</span>
                </>
              ) : null}
            </div>
          ) : (
            // Connection form
            <div className="space-y-4">
              {showSetupModeSwitch && (
                <div className="grid grid-cols-2 gap-2 rounded-[0.95rem] bg-secondary/60 p-1">
                  <button
                    type="button"
                    className={cn(
                      'rounded-[0.75rem] px-3 py-2 text-sm font-medium transition-colors',
                      effectiveSetupMode === 'guided' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => setSetupMode('guided')}
                    disabled={connecting}
                  >
                    {t('dialog.setupModeGuided')}
                  </button>
                  <button
                    type="button"
                    className={cn(
                      'rounded-[0.75rem] px-3 py-2 text-sm font-medium transition-colors',
                      effectiveSetupMode === 'credential' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => setSetupMode('credential')}
                    disabled={connecting}
                  >
                    {t('dialog.setupModeCredential')}
                  </button>
                </div>
              )}

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
                    disabled={!meta?.docsPath}
                  >
                    <BookOpen className="h-3 w-3 mr-1" />
                    {t('dialog.viewDocs')}
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
                  disabled={isConfiguredChannelEdit}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="channel-agent">{t('dialog.agent')}</Label>
                <SelectPrimitive.Root
                  value={selectedAgentId ? `agent:${selectedAgentId}` : 'keep'}
                  onValueChange={(value) => setSelectedAgentId(value === 'keep' ? '' : value.slice('agent:'.length))}
                  disabled={connecting}
                >
                  <SelectPrimitive.Trigger
                    id="channel-agent"
                    className="flex h-11 w-full items-center justify-between gap-2 rounded-[var(--radius-interactive)] border border-input bg-card px-4 py-2 text-[15px] text-foreground ring-offset-background transition-[border-color,box-shadow,background-color,color] duration-150 hover:border-border focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/15 focus-visible:shadow-[var(--shadow-focus)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="min-w-0 truncate"><SelectPrimitive.Value /></span>
                    <SelectPrimitive.Icon asChild>
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </SelectPrimitive.Icon>
                  </SelectPrimitive.Trigger>
                  <SelectPrimitive.Portal>
                    <SelectPrimitive.Content
                      position="popper"
                      sideOffset={4}
                      collisionPadding={12}
                      aria-label={t('dialog.agent')}
                      className="z-50 w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-24px)] max-h-[min(20rem,var(--radix-select-content-available-height))] overflow-hidden rounded-[var(--radius-interactive)] border border-border bg-popover text-popover-foreground shadow-lg"
                    >
                      <SelectPrimitive.Viewport className="select-scroll-viewport max-h-[inherit] overflow-y-auto overscroll-contain p-1">
                        {[{ id: '', name: t('dialog.agentDefault') }, ...agentOptions].map((agent) => (
                          <SelectPrimitive.Item
                            key={agent.id}
                            value={agent.id ? `agent:${agent.id}` : 'keep'}
                            className="relative flex cursor-default select-none items-center rounded-md py-2 pl-3 pr-8 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                          >
                            <SelectPrimitive.ItemText>
                              {agent.id && agent.name && agent.name !== agent.id ? `${agent.name} (${agent.id})` : agent.name || agent.id}
                            </SelectPrimitive.ItemText>
                            <SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center">
                              <Check className="h-4 w-4" />
                            </SelectPrimitive.ItemIndicator>
                          </SelectPrimitive.Item>
                        ))}
                      </SelectPrimitive.Viewport>
                    </SelectPrimitive.Content>
                  </SelectPrimitive.Portal>
                </SelectPrimitive.Root>
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
                <Button variant="outline" onClick={isConfiguredChannelEdit ? onClose : () => onTargetChange({ kind: 'catalog' })}>
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
                        {shouldStartAuthorization ? t('dialog.startingAuthorization') : shouldStartQrLogin ? t('dialog.generatingQR') : t('dialog.validatingAndSaving')}
                      </>
                    ) : shouldStartAuthorization ? (
                      t('dialog.startAuthorization')
                    ) : shouldStartQrLogin ? (
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
