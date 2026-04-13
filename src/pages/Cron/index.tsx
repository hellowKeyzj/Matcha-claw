/**
 * Cron Page
 * Manage scheduled tasks
 */
import { useEffect, useState, useCallback } from 'react';
import {
  Plus,
  Clock,
  Play,
  Pause,
  Trash2,
  Edit,
  RefreshCw,
  X,
  Calendar,
  AlertCircle,
  CheckCircle2,
  XCircle,
  MessageSquare,
  Loader2,
  Timer,
  History,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TaskCenterPageTitle } from '@/components/task-center/page-title';
import { TaskCenterStatCard } from '@/components/task-center/stat-card';
import { TASK_CENTER_SURFACE_CARD_CLASS } from '@/components/task-center/styles';
import { useCronStore } from '@/stores/cron';
import { useGatewayStore } from '@/stores/gateway';
import { hostChannelsFetchSnapshot } from '@/lib/channel-runtime';
import { formatRelativeTime, cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { CronJob, CronJobCreateInput, ScheduleType } from '@/types/cron';
import { CHANNEL_ICONS, CHANNEL_NAMES, type ChannelType } from '@/types/channel';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

// Common cron schedule presets
const schedulePresets: { key: string; value: string; type: ScheduleType }[] = [
  { key: 'everyMinute', value: '* * * * *', type: 'interval' },
  { key: 'every5Min', value: '*/5 * * * *', type: 'interval' },
  { key: 'every15Min', value: '*/15 * * * *', type: 'interval' },
  { key: 'everyHour', value: '0 * * * *', type: 'interval' },
  { key: 'daily9am', value: '0 9 * * *', type: 'daily' },
  { key: 'daily6pm', value: '0 18 * * *', type: 'daily' },
  { key: 'weeklyMon', value: '0 9 * * 1', type: 'weekly' },
  { key: 'monthly1st', value: '0 9 1 * *', type: 'monthly' },
];

type DeliveryChannelAccount = {
  accountId: string;
  name: string;
};

type DeliveryChannelGroup = {
  channelType: string;
  accounts: DeliveryChannelAccount[];
  defaultAccountId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCronDeliveryChannel(channelType: string): string {
  const normalized = channelType.trim();
  if (normalized === 'wechat') {
    return 'openclaw-weixin';
  }
  return normalized;
}

function isWeChatDeliveryChannel(channelType: string): boolean {
  return normalizeCronDeliveryChannel(channelType) === 'openclaw-weixin';
}

function isSupportedCronDeliveryChannel(channelType: string): boolean {
  return normalizeCronDeliveryChannel(channelType).length > 0;
}

function parseDeliveryChannelGroups(snapshot: unknown): DeliveryChannelGroup[] {
  if (!isRecord(snapshot)) {
    return [];
  }
  const channelOrder = Array.isArray(snapshot.channelOrder)
    ? snapshot.channelOrder.filter((item): item is string => typeof item === 'string')
    : [];
  const channelMap = isRecord(snapshot.channels) ? snapshot.channels : {};
  const channelAccounts = isRecord(snapshot.channelAccounts) ? snapshot.channelAccounts : {};
  const defaultAccountMap = isRecord(snapshot.channelDefaultAccountId) ? snapshot.channelDefaultAccountId : {};
  const orderedChannelTypes = channelOrder.length > 0 ? channelOrder : Object.keys(channelMap);
  const groups: DeliveryChannelGroup[] = [];
  for (const channelType of orderedChannelTypes) {
    const summary = channelMap[channelType];
    if (!isRecord(summary)) {
      continue;
    }
    const configured = summary.configured === true || summary.running === true;
    if (!configured) {
      continue;
    }
    const accountsRaw = Array.isArray(channelAccounts[channelType]) ? channelAccounts[channelType] : [];
    const accounts: DeliveryChannelAccount[] = [];
    for (const account of accountsRaw) {
      if (!isRecord(account)) {
        continue;
      }
      const accountId = typeof account.accountId === 'string' ? account.accountId.trim() : '';
      if (!accountId) {
        continue;
      }
      const accountName = typeof account.name === 'string' && account.name.trim()
        ? account.name.trim()
        : accountId;
      accounts.push({ accountId, name: accountName });
    }
    const defaultAccountId = typeof defaultAccountMap[channelType] === 'string'
      ? defaultAccountMap[channelType].trim()
      : undefined;
    groups.push({
      channelType,
      accounts,
      ...(defaultAccountId ? { defaultAccountId } : {}),
    });
  }
  return groups;
}

// Parse cron schedule to human-readable format
// Handles both plain cron strings and Gateway CronSchedule objects:
//   { kind: "cron", expr: "...", tz?: "..." }
//   { kind: "every", everyMs: number }
//   { kind: "at", at: "..." }
function parseCronSchedule(schedule: unknown, t: TFunction<'cron'>): string {
  // Handle Gateway CronSchedule object format
  if (schedule && typeof schedule === 'object') {
    const s = schedule as { kind?: string; expr?: string; tz?: string; everyMs?: number; at?: string };
    if (s.kind === 'cron' && typeof s.expr === 'string') {
      return parseCronExpr(s.expr, t);
    }
    if (s.kind === 'every' && typeof s.everyMs === 'number') {
      const ms = s.everyMs;
      if (ms < 60_000) return t('schedule.everySeconds', { count: Math.round(ms / 1000) });
      if (ms < 3_600_000) return t('schedule.everyMinutes', { count: Math.round(ms / 60_000) });
      if (ms < 86_400_000) return t('schedule.everyHours', { count: Math.round(ms / 3_600_000) });
      return t('schedule.everyDays', { count: Math.round(ms / 86_400_000) });
    }
    if (s.kind === 'at' && typeof s.at === 'string') {
      try {
        return t('schedule.onceAt', { time: new Date(s.at).toLocaleString() });
      } catch {
        return t('schedule.onceAt', { time: s.at });
      }
    }
    return String(schedule);
  }

  // Handle plain cron string
  if (typeof schedule === 'string') {
    return parseCronExpr(schedule, t);
  }

  return String(schedule ?? t('schedule.unknown'));
}

// Parse a plain cron expression string to human-readable text
function parseCronExpr(cron: string, t: TFunction<'cron'>): string {
  const preset = schedulePresets.find((p) => p.value === cron);
  if (preset) return t(`presets.${preset.key}` as const);

  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, , dayOfWeek] = parts;

  if (minute === '*' && hour === '*') return t('presets.everyMinute');
  if (minute.startsWith('*/')) return t('schedule.everyMinutes', { count: Number(minute.slice(2)) });
  if (hour === '*' && minute === '0') return t('presets.everyHour');
  if (dayOfWeek !== '*' && dayOfMonth === '*') {
    return t('schedule.weeklyAt', { day: dayOfWeek, time: `${hour}:${minute.padStart(2, '0')}` });
  }
  if (dayOfMonth !== '*') {
    return t('schedule.monthlyAtDay', { day: dayOfMonth, time: `${hour}:${minute.padStart(2, '0')}` });
  }
  if (hour !== '*') {
    return t('schedule.dailyAt', { time: `${hour}:${minute.padStart(2, '0')}` });
  }

  return cron;
}

function estimateNextRun(scheduleExpr: string): string | null {
  const now = new Date();
  const next = new Date(now.getTime());

  if (scheduleExpr === '* * * * *') {
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + 1);
    return next.toLocaleString();
  }

  if (scheduleExpr === '*/5 * * * *') {
    const delta = 5 - (next.getMinutes() % 5 || 5);
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + delta);
    return next.toLocaleString();
  }

  if (scheduleExpr === '*/15 * * * *') {
    const delta = 15 - (next.getMinutes() % 15 || 15);
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + delta);
    return next.toLocaleString();
  }

  if (scheduleExpr === '0 * * * *') {
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next.toLocaleString();
  }

  if (scheduleExpr === '0 9 * * *' || scheduleExpr === '0 18 * * *') {
    const targetHour = scheduleExpr === '0 9 * * *' ? 9 : 18;
    next.setSeconds(0, 0);
    next.setHours(targetHour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toLocaleString();
  }

  if (scheduleExpr === '0 9 * * 1') {
    next.setSeconds(0, 0);
    next.setHours(9, 0, 0, 0);
    const day = next.getDay();
    const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
    next.setDate(next.getDate() + daysUntilMonday);
    return next.toLocaleString();
  }

  if (scheduleExpr === '0 9 1 * *') {
    next.setSeconds(0, 0);
    next.setDate(1);
    next.setHours(9, 0, 0, 0);
    if (next <= now) next.setMonth(next.getMonth() + 1);
    return next.toLocaleString();
  }

  return null;
}

// Create/Edit Task Dialog
interface TaskDialogProps {
  job?: CronJob;
  onClose: () => void;
  onSave: (input: CronJobCreateInput) => Promise<void>;
}

function TaskDialog({ job, onClose, onSave }: TaskDialogProps) {
  const { t } = useTranslation('cron');
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState(job?.name || '');
  const [message, setMessage] = useState(job?.message || '');
  // Extract cron expression string from CronSchedule object or use as-is if string
  const initialSchedule = (() => {
    const s = job?.schedule;
    if (!s) return '0 9 * * *';
    if (typeof s === 'string') return s;
    if (typeof s === 'object' && 'expr' in s && typeof (s as { expr: string }).expr === 'string') {
      return (s as { expr: string }).expr;
    }
    return '0 9 * * *';
  })();
  const [schedule, setSchedule] = useState(initialSchedule);
  const [customSchedule, setCustomSchedule] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [deliveryMode, setDeliveryMode] = useState<'none' | 'announce'>(
    job?.delivery?.mode === 'announce' ? 'announce' : 'none',
  );
  const [deliveryChannel, setDeliveryChannel] = useState(job?.delivery?.channel?.trim() || '');
  const [deliveryTarget, setDeliveryTarget] = useState(job?.delivery?.to || '');
  const [selectedDeliveryAccountId, setSelectedDeliveryAccountId] = useState(job?.delivery?.accountId || '');
  const [deliveryChannels, setDeliveryChannels] = useState<DeliveryChannelGroup[]>([]);
  const [deliveryChannelsLoading, setDeliveryChannelsLoading] = useState(false);
  const schedulePreview = estimateNextRun(useCustom ? customSchedule : schedule);
  const deliveryChannelOptions = (() => {
    const options = [...deliveryChannels];
    if (deliveryChannel && !options.some((entry) => entry.channelType === deliveryChannel)) {
      options.push({
        channelType: deliveryChannel,
        accounts: [],
      });
    }
    return options;
  })();
  const selectedDeliveryChannelGroup = deliveryChannelOptions.find((entry) => entry.channelType === deliveryChannel);
  const deliveryAccountOptions = selectedDeliveryChannelGroup?.accounts ?? [];
  const requiresExplicitDeliveryAccount = deliveryMode === 'announce' && isWeChatDeliveryChannel(deliveryChannel);

  useEffect(() => {
    let cancelled = false;
    setDeliveryChannelsLoading(true);
    void hostChannelsFetchSnapshot()
      .then((result) => {
        if (cancelled || !result.success) {
          return;
        }
        const groups = parseDeliveryChannelGroups((result as { snapshot?: unknown }).snapshot);
        setDeliveryChannels(groups);
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn('Failed to load delivery channels:', error);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDeliveryChannelsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (deliveryMode !== 'announce' || deliveryChannel.trim()) {
      return;
    }
    const firstSupported = deliveryChannels.find((entry) => isSupportedCronDeliveryChannel(entry.channelType));
    if (firstSupported?.channelType) {
      setDeliveryChannel(firstSupported.channelType);
    }
  }, [deliveryChannels, deliveryChannel, deliveryMode]);

  useEffect(() => {
    if (deliveryMode !== 'announce') {
      if (selectedDeliveryAccountId) {
        setSelectedDeliveryAccountId('');
      }
      return;
    }
    const currentChannel = deliveryChannelOptions.find((entry) => entry.channelType === deliveryChannel);
    const accounts = currentChannel?.accounts ?? [];
    if (accounts.length === 0) {
      if (selectedDeliveryAccountId) {
        setSelectedDeliveryAccountId('');
      }
      return;
    }
    const existed = accounts.some((entry) => entry.accountId === selectedDeliveryAccountId);
    if (existed) {
      return;
    }
    const nextDefault = currentChannel?.defaultAccountId || accounts[0]?.accountId || '';
    setSelectedDeliveryAccountId(nextDefault);
  }, [deliveryChannel, deliveryChannelOptions, deliveryMode, selectedDeliveryAccountId]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error(t('toast.nameRequired'));
      return;
    }
    if (!message.trim()) {
      toast.error(t('toast.messageRequired'));
      return;
    }

    const finalSchedule = useCustom ? customSchedule : schedule;
    if (!finalSchedule.trim()) {
      toast.error(t('toast.scheduleRequired'));
      return;
    }

    const finalDelivery = deliveryMode === 'announce'
      ? {
        mode: 'announce' as const,
        channel: deliveryChannel.trim(),
        to: deliveryTarget.trim(),
        ...(selectedDeliveryAccountId.trim() ? { accountId: selectedDeliveryAccountId.trim() } : {}),
      }
      : { mode: 'none' as const };
    if (finalDelivery.mode === 'announce' && !finalDelivery.channel) {
      toast.error(t('toast.deliveryChannelRequired'));
      return;
    }
    if (finalDelivery.mode === 'announce' && !isSupportedCronDeliveryChannel(finalDelivery.channel)) {
      toast.error(t('toast.deliveryChannelUnsupported'));
      return;
    }
    if (finalDelivery.mode === 'announce' && !finalDelivery.to) {
      toast.error(t('toast.deliveryTargetRequired'));
      return;
    }
    if (finalDelivery.mode === 'announce' && isWeChatDeliveryChannel(finalDelivery.channel) && !selectedDeliveryAccountId.trim()) {
      toast.error(t('toast.deliveryAccountRequiredWeChat'));
      return;
    }

    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        message: message.trim(),
        schedule: finalSchedule,
        delivery: finalDelivery,
        enabled,
      });
      onClose();
      toast.success(job ? t('toast.updated') : t('toast.created'));
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <Card className="w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle>{job ? t('dialog.editTitle') : t('dialog.createTitle')}</CardTitle>
            <CardDescription>{t('dialog.description')}</CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="name">{t('dialog.taskName')}</Label>
            <Input
              id="name"
              placeholder={t('dialog.taskNamePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* Message */}
          <div className="space-y-2">
            <Label htmlFor="message">{t('dialog.message')}</Label>
            <Textarea
              id="message"
              placeholder={t('dialog.messagePlaceholder')}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
            />
          </div>

          {/* Schedule */}
          <div className="space-y-2">
            <Label>{t('dialog.schedule')}</Label>
            {!useCustom ? (
              <div className="grid grid-cols-2 gap-2">
                {schedulePresets.map((preset) => (
                  <Button
                    key={preset.value}
                    type="button"
                    variant={schedule === preset.value ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSchedule(preset.value)}
                    className="justify-start"
                  >
                    <Timer className="h-4 w-4 mr-2" />
                    {t(`presets.${preset.key}` as const)}
                  </Button>
                ))}
              </div>
            ) : (
              <Input
                placeholder={t('dialog.cronPlaceholder')}
                value={customSchedule}
                onChange={(e) => setCustomSchedule(e.target.value)}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setUseCustom(!useCustom)}
              className="text-xs"
            >
              {useCustom ? t('dialog.usePresets') : t('dialog.useCustomCron')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {schedulePreview ? `${t('card.next')}: ${schedulePreview}` : t('dialog.cronPlaceholder')}
            </p>
          </div>

          <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="space-y-1">
              <Label>{t('dialog.deliveryTitle')}</Label>
              <p className="text-xs text-muted-foreground">{t('dialog.deliveryDescription')}</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={deliveryMode === 'none' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setDeliveryMode('none')}
                className="h-auto min-h-9 whitespace-normal break-words text-center leading-5 overflow-visible text-clip"
              >
                {t('dialog.deliveryModeNone')}
              </Button>
              <Button
                type="button"
                variant={deliveryMode === 'announce' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setDeliveryMode('announce')}
                className="h-auto min-h-9 whitespace-normal break-words text-center leading-5 overflow-visible text-clip"
              >
                {t('dialog.deliveryModeAnnounce')}
              </Button>
            </div>

            {deliveryMode === 'announce' && (
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="delivery-channel">{t('dialog.deliveryChannel')}</Label>
                  <Select
                    id="delivery-channel"
                    value={deliveryChannel}
                    disabled={deliveryChannelsLoading}
                    onChange={(event) => {
                      setDeliveryChannel(event.target.value);
                      setSelectedDeliveryAccountId('');
                    }}
                  >
                    <option value="">{t('dialog.selectDeliveryChannel')}</option>
                    {deliveryChannelOptions.map((group) => (
                      <option key={group.channelType} value={group.channelType}>
                        {CHANNEL_NAMES[group.channelType as ChannelType] || group.channelType}
                      </option>
                    ))}
                  </Select>
                  {deliveryMode === 'announce' && isWeChatDeliveryChannel(deliveryChannel) && (
                    <p className="text-xs text-muted-foreground">{t('dialog.deliveryWeChatRequirements')}</p>
                  )}
                </div>

                <div className="space-y-1">
                  <Label htmlFor="delivery-account">{t('dialog.deliveryAccount')}</Label>
                  <Select
                    id="delivery-account"
                    value={selectedDeliveryAccountId}
                    disabled={deliveryAccountOptions.length === 0}
                    onChange={(event) => setSelectedDeliveryAccountId(event.target.value)}
                  >
                    {!requiresExplicitDeliveryAccount && (
                      <option value="">{t('dialog.deliveryAccountAuto')}</option>
                    )}
                    {deliveryAccountOptions.map((account) => (
                      <option key={account.accountId} value={account.accountId}>
                        {account.name}
                      </option>
                    ))}
                  </Select>
                  {requiresExplicitDeliveryAccount && (
                    <p className="text-xs text-muted-foreground">{t('dialog.deliveryWeChatAccountRequired')}</p>
                  )}
                </div>

                <div className="space-y-1">
                  <Label htmlFor="delivery-target">{t('dialog.deliveryTarget')}</Label>
                  <Input
                    id="delivery-target"
                    placeholder={t('dialog.deliveryTargetPlaceholder')}
                    value={deliveryTarget}
                    onChange={(event) => setDeliveryTarget(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{t('dialog.deliveryTargetDesc')}</p>
                </div>
              </div>
            )}
          </div>

          {/* Enabled */}
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('dialog.enableImmediately')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('dialog.enableImmediatelyDesc')}
              </p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button variant="outline" onClick={onClose}>
              {t('common:actions.cancel', 'Cancel')}
            </Button>
            <Button onClick={handleSubmit} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('common:status.saving', 'Saving...')}
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  {job ? t('dialog.saveChanges') : t('dialog.createTitle')}
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Job Card Component
interface CronJobCardProps {
  job: CronJob;
  isMutating: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onTrigger: () => Promise<{ ran: boolean; reason?: string }>;
}

function CronJobCard({ job, isMutating, onToggle, onEdit, onDelete, onTrigger }: CronJobCardProps) {
  const { t } = useTranslation('cron');
  const [triggering, setTriggering] = useState(false);
  const isRunning = Boolean(job.runningAt);
  const actionsDisabled = isMutating || triggering;

  const handleTrigger = async () => {
    setTriggering(true);
    try {
      const result = await onTrigger();
      if (result.ran) {
        toast.success(t('toast.triggered'));
      } else if (result.reason === 'already-running') {
        toast.warning(t('toast.alreadyRunning', '任务已在执行中，请稍后重试'));
      } else {
        toast.warning(t('toast.notTriggered', '任务未触发'));
      }
    } catch (error) {
      console.error('Failed to trigger cron job:', error);
      toast.error(t('toast.failedTrigger', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setTriggering(false);
    }
  };

  const handleDelete = () => {
    onDelete();
  };

  return (
    <Card className={cn(
      TASK_CENTER_SURFACE_CARD_CLASS,
      'transition-colors',
      job.enabled && 'border-primary/30'
    )}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className={cn(
              'rounded-full p-2',
              job.enabled
                ? 'bg-green-100 dark:bg-green-900/30'
                : 'bg-muted'
            )}>
              <Clock className={cn(
                'h-5 w-5',
                job.enabled ? 'text-green-600' : 'text-muted-foreground'
              )} />
            </div>
            <div>
              <CardTitle className="text-lg">{job.name}</CardTitle>
              <CardDescription className="flex items-center gap-2">
                <Timer className="h-3 w-3" />
                {parseCronSchedule(job.schedule, t)}
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={job.enabled ? 'success' : 'secondary'}>
              {job.enabled ? t('stats.active') : t('stats.paused')}
            </Badge>
            {isRunning && (
              <Badge variant="default">{t('stats.running')}</Badge>
            )}
            {isMutating && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
            <Switch
              checked={job.enabled}
              disabled={isMutating}
              onCheckedChange={onToggle}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Message Preview */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50">
          <MessageSquare className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
          <p className="text-sm text-muted-foreground line-clamp-2">
            {job.message}
          </p>
        </div>

        {/* Metadata */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
          {job.delivery?.mode === 'announce' && job.delivery.channel && (
            <span className="flex items-center gap-1">
              {CHANNEL_ICONS[job.delivery.channel as ChannelType]}
              {CHANNEL_NAMES[job.delivery.channel as ChannelType] || job.delivery.channel}
              {job.delivery.accountId ? `(${job.delivery.accountId})` : ''}
              {job.delivery.to ? ` → ${job.delivery.to}` : ''}
            </span>
          )}

          {(!job.delivery || job.delivery.mode !== 'announce') && job.target && (
            <span className="flex items-center gap-1">
              {CHANNEL_ICONS[job.target.channelType as ChannelType]}
              {job.target.channelName}
            </span>
          )}

          {job.lastRun && (
            <span className="flex items-center gap-1">
              <History className="h-4 w-4" />
              {t('card.last')}: {formatRelativeTime(job.lastRun.time)}
              {job.lastRun.success ? (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              ) : (
                <XCircle className="h-4 w-4 text-red-500" />
              )}
            </span>
          )}

          {job.nextRun && job.enabled && (
            <span className="flex items-center gap-1">
              <Calendar className="h-4 w-4" />
              {t('card.next')}: {new Date(job.nextRun).toLocaleString()}
            </span>
          )}
        </div>

        {/* Last Run Error */}
        {job.lastRun && !job.lastRun.success && job.lastRun.error && (
          <div className="flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-sm text-red-600 dark:text-red-400">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{job.lastRun.error}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-1 pt-2 border-t">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleTrigger}
            disabled={actionsDisabled || isRunning}
          >
            {triggering ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            <span className="ml-1">{t('card.runNow')}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={isMutating}>
            <Edit className="h-4 w-4" />
            <span className="ml-1">{t('common:actions.edit', 'Edit')}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={handleDelete} disabled={isMutating}>
            <Trash2 className="h-4 w-4 text-destructive" />
            <span className="ml-1 text-destructive">{t('common:actions.delete', 'Delete')}</span>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface CronProps {
  embedded?: boolean;
}

export function Cron({ embedded = false }: CronProps) {
  const { t } = useTranslation('cron');
  const {
    jobs,
    snapshotReady,
    initialLoading,
    refreshing,
    mutating,
    mutatingByJobId,
    error,
    fetchJobs,
    createJob,
    updateJob,
    toggleJob,
    deleteJob,
    triggerJob,
  } = useCronStore();
  const gatewayStatus = useGatewayStore((state) => state.status);
  const [showDialog, setShowDialog] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | undefined>();
  const [jobToDelete, setJobToDelete] = useState<{ id: string } | null>(null);

  const isGatewayRunning = gatewayStatus.state === 'running';
  const manualRefreshBusy = refreshing || mutating;
  const showInitialLoading = !snapshotReady && initialLoading;

  // Fetch jobs on mount
  useEffect(() => {
    if (isGatewayRunning) {
      void fetchJobs({ silent: true });
    }
  }, [fetchJobs, isGatewayRunning]);

  // Statistics
  const runningJobs = jobs.filter((j) => Boolean(j.runningAt));
  const pausedJobs = jobs.filter((j) => !j.enabled);
  const failedJobs = jobs.filter((j) => j.lastRun && !j.lastRun.success);

  const handleSave = useCallback(async (input: CronJobCreateInput) => {
    if (editingJob) {
      await updateJob(editingJob.id, input);
    } else {
      await createJob(input);
    }
  }, [editingJob, createJob, updateJob]);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    try {
      await toggleJob(id, enabled);
      toast.success(enabled ? t('toast.enabled') : t('toast.paused'));
    } catch {
      toast.error(t('toast.failedUpdate'));
    }
  }, [toggleJob, t]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className={cn('flex items-center', embedded ? 'justify-end' : 'justify-between')}>
        {!embedded && (
          <TaskCenterPageTitle title={t('title')} subtitle={t('subtitle')} />
        )}
        <div className="flex gap-2">
          {refreshing && snapshotReady && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('common:status.loading', 'Loading...')}
            </span>
          )}
          <Button
            variant="outline"
            onClick={() => { void fetchJobs(); }}
            disabled={!isGatewayRunning || manualRefreshBusy}
          >
            <RefreshCw className={cn('h-4 w-4 mr-2', refreshing && 'animate-spin')} />
            {manualRefreshBusy ? t('common:status.loading', 'Loading...') : t('refresh')}
          </Button>
          <Button
            onClick={() => {
              setEditingJob(undefined);
              setShowDialog(true);
            }}
            disabled={!isGatewayRunning || mutating}
          >
            <Plus className="h-4 w-4 mr-2" />
            {t('newTask')}
          </Button>
        </div>
      </div>

      {/* Gateway Warning */}
      {!isGatewayRunning && (
        <Card className="border-yellow-500 bg-yellow-50 dark:bg-yellow-900/10">
          <CardContent className="py-4 flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-yellow-600" />
            <span className="text-yellow-700 dark:text-yellow-400">
              {t('gatewayWarning')}
            </span>
          </CardContent>
        </Card>
      )}

      {/* Statistics */}
      <div className="grid grid-cols-4 gap-4">
        <TaskCenterStatCard
          value={jobs.length}
          label={t('stats.total')}
          icon={Clock}
          iconWrapClassName="bg-primary/10"
          iconClassName="text-primary"
        />
        <TaskCenterStatCard
          value={runningJobs.length}
          label={t('stats.running')}
          icon={Play}
          iconWrapClassName="bg-green-100 dark:bg-green-900/30"
          iconClassName="text-green-600"
        />
        <TaskCenterStatCard
          value={pausedJobs.length}
          label={t('stats.paused')}
          icon={Pause}
          iconWrapClassName="bg-yellow-100 dark:bg-yellow-900/30"
          iconClassName="text-yellow-600"
        />
        <TaskCenterStatCard
          value={failedJobs.length}
          label={t('stats.failed')}
          icon={XCircle}
          iconWrapClassName="bg-red-100 dark:bg-red-900/30"
          iconClassName="text-red-600"
        />
      </div>

      {/* Error Display */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4 text-destructive flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            {error}
          </CardContent>
        </Card>
      )}

      {/* Jobs List */}
      {showInitialLoading ? (
        <Card className={TASK_CENTER_SURFACE_CARD_CLASS}>
          <CardContent className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{t('common:status.loading', 'Loading...')}</span>
          </CardContent>
        </Card>
      ) : jobs.length === 0 ? (
        <Card className={TASK_CENTER_SURFACE_CARD_CLASS}>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Clock className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">{t('empty.title')}</h3>
            <p className="text-muted-foreground text-center mb-4 max-w-md">
              {t('empty.description')}
            </p>
            <Button
              onClick={() => {
                setEditingJob(undefined);
                setShowDialog(true);
              }}
              disabled={!isGatewayRunning}
            >
              <Plus className="h-4 w-4 mr-2" />
              {t('empty.create')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {jobs.map((job) => (
            <CronJobCard
              key={job.id}
              job={job}
              isMutating={Boolean(mutatingByJobId[job.id])}
              onToggle={(enabled) => handleToggle(job.id, enabled)}
              onEdit={() => {
                setEditingJob(job);
                setShowDialog(true);
              }}
              onDelete={() => setJobToDelete({ id: job.id })}
              onTrigger={() => triggerJob(job.id)}
            />
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      {showDialog && (
        <TaskDialog
          job={editingJob}
          onClose={() => {
            setShowDialog(false);
            setEditingJob(undefined);
          }}
          onSave={handleSave}
        />
      )}

      <ConfirmDialog
        open={!!jobToDelete}
        title={t('common:actions.confirm', 'Confirm')}
        message={t('card.deleteConfirm')}
        confirmLabel={t('common:actions.delete', 'Delete')}
        cancelLabel={t('common:actions.cancel', 'Cancel')}
        variant="destructive"
        onConfirm={async () => {
          if (jobToDelete) {
            await deleteJob(jobToDelete.id);
            setJobToDelete(null);
            toast.success(t('toast.deleted'));
          }
        }}
        onCancel={() => setJobToDelete(null)}
      />
    </div>
  );
}

export default Cron;
