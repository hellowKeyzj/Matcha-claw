/**
 * Cron Page
 * Manage scheduled tasks
 */
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  Plus,
  Clock,
  Bot,
  Play,
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
  ChevronDown,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TaskCenterPageTitle } from '@/components/task-center/page-title';
import {
  TaskCenterEmptyState,
  TaskCenterStatusFilter,
  TaskCenterSurface,
  TaskCenterToolbar,
} from '@/components/task-center/surface';
import { useChatStore } from '@/stores/chat';
import { useCronStore } from '@/stores/cron';
import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';
import { useSubagentsStore } from '@/stores/subagents';
import { isGatewayOperational, isGatewayPreparing } from '@/lib/gateway-status';
import { hostChannelsFetchSnapshot } from '@/lib/channel-runtime';
import { resolveModelCatalogEntry, resolveModelRuntimeReference } from '@/lib/provider-models';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import { formatRelativeTime, cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { CronJob, CronJobCreateInput, CronJobUpdateInput, ScheduleType } from '@/types/cron';
import { CHANNEL_NAMES, type ChannelType } from '@/types/channel';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

const periodicOptions: { type: ScheduleType; expr: string }[] = [
  { type: 'hourly', expr: '0 * * * *' },
  { type: 'daily', expr: '0 9 * * *' },
  { type: 'weekdays', expr: '0 9 * * 1-5' },
  { type: 'weekly', expr: '0 9 * * 1' },
  { type: 'custom', expr: '' },
];

const DEFAULT_CRON_EXPR = '0 9 * * *';

type ScheduleMode = 'periodic' | 'once';

type ScheduleForm = {
  mode: ScheduleMode;
  periodicType: ScheduleType;
  cronExpr: string;
  onceDate: string;
  onceTime: string;
};

type BuildScheduleResult =
  | { ok: true; schedule: CronJobCreateInput['schedule']; previewExpr?: string }
  | { ok: false; errorKey: 'toast.scheduleRequired' | 'toast.onceTimeRequired' | 'toast.onceFutureRequired' };

type DeliveryChannelAccount = {
  accountId: string;
  name: string;
};

type DeliveryChannelGroup = {
  channelType: string;
  accounts: DeliveryChannelAccount[];
  defaultAccountId?: string;
};

type CronStatusFilter = 'all' | 'active' | 'running' | 'paused' | 'failed';

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

function padDatePart(value: number): string {
  return String(value).padStart(2, '0');
}

function toLocalDateInputValue(date: Date): string {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

function toLocalTimeInputValue(date: Date): string {
  return `${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
}

function createDefaultOnceDateTime(): { onceDate: string; onceTime: string } {
  const nextHour = new Date(Date.now() + 60 * 60_000);
  return {
    onceDate: toLocalDateInputValue(nextHour),
    onceTime: toLocalTimeInputValue(nextHour),
  };
}

function getCronExprFromSchedule(schedule: CronJob['schedule'] | undefined): string | null {
  if (!schedule) {
    return null;
  }
  if (typeof schedule === 'string') {
    return schedule;
  }
  if (schedule.kind === 'cron') {
    return schedule.expr;
  }
  return null;
}

function getPeriodicTypeFromCron(expr: string): ScheduleType {
  const matched = periodicOptions.find((option) => option.expr === expr && option.type !== 'custom');
  return matched?.type ?? 'custom';
}

function createScheduleForm(schedule: CronJob['schedule'] | undefined): ScheduleForm {
  const defaultOnce = createDefaultOnceDateTime();
  if (schedule && typeof schedule === 'object' && schedule.kind === 'at') {
    const at = new Date(schedule.at);
    if (!Number.isNaN(at.getTime())) {
      return {
        mode: 'once',
        periodicType: 'daily',
        cronExpr: DEFAULT_CRON_EXPR,
        onceDate: toLocalDateInputValue(at),
        onceTime: toLocalTimeInputValue(at),
      };
    }
  }

  const expr = getCronExprFromSchedule(schedule) ?? DEFAULT_CRON_EXPR;
  return {
    mode: 'periodic',
    periodicType: getPeriodicTypeFromCron(expr),
    cronExpr: expr,
    onceDate: defaultOnce.onceDate,
    onceTime: defaultOnce.onceTime,
  };
}

function buildScheduleInput(form: ScheduleForm): BuildScheduleResult {
  if (form.mode === 'periodic') {
    const expr = form.periodicType === 'custom'
      ? form.cronExpr.trim()
      : periodicOptions.find((option) => option.type === form.periodicType)?.expr ?? DEFAULT_CRON_EXPR;
    if (!expr) {
      return { ok: false, errorKey: 'toast.scheduleRequired' };
    }
    return { ok: true, schedule: expr, previewExpr: expr };
  }

  if (!form.onceDate || !form.onceTime) {
    return { ok: false, errorKey: 'toast.onceTimeRequired' };
  }
  const onceAt = new Date(`${form.onceDate}T${form.onceTime}`);
  if (Number.isNaN(onceAt.getTime()) || onceAt.getTime() <= Date.now()) {
    return { ok: false, errorKey: 'toast.onceFutureRequired' };
  }
  return { ok: true, schedule: { kind: 'at', at: onceAt.toISOString() } };
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
  const option = periodicOptions.find((entry) => entry.expr === cron && entry.type !== 'custom');
  if (option) return t(`periodic.${option.type}`);
  if (cron === '* * * * *') return t('presets.everyMinute');
  if (cron === '*/5 * * * *') return t('presets.every5Min');
  if (cron === '*/15 * * * *') return t('presets.every15Min');
  if (cron === '0 18 * * *') return t('presets.daily6pm');
  if (cron === '0 9 1 * *') return t('presets.monthly1st');

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

function isFailedCronJob(job: CronJob): boolean {
  return Boolean(job.lastRun && !job.lastRun.success);
}

function matchesCronStatusFilter(job: CronJob, filter: CronStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return job.enabled;
  if (filter === 'running') return Boolean(job.runningAt);
  if (filter === 'paused') return !job.enabled;
  return isFailedCronJob(job);
}

function formatCronDateTime(value: string | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatCronDeliveryText(job: CronJob): string | null {
  if (job.delivery?.mode === 'announce' && job.delivery.channel) {
    const channelName = CHANNEL_NAMES[job.delivery.channel as ChannelType] || job.delivery.channel;
    const account = job.delivery.accountId ? ` (${job.delivery.accountId})` : '';
    const target = job.delivery.to ? ` -> ${job.delivery.to}` : '';
    return `${channelName}${account}${target}`;
  }

  if (job.target) {
    const channelName = job.target.channelName || CHANNEL_NAMES[job.target.channelType as ChannelType] || job.target.channelType;
    const recipient = job.target.recipient ? ` -> ${job.target.recipient}` : '';
    return `${channelName}${recipient}`;
  }

  return null;
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
    next.setSeconds(0, 0);
    next.setMinutes(Math.floor(next.getMinutes() / 5) * 5 + 5);
    return next.toLocaleString();
  }

  if (scheduleExpr === '*/15 * * * *') {
    next.setSeconds(0, 0);
    next.setMinutes(Math.floor(next.getMinutes() / 15) * 15 + 15);
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
    const daysUntilMonday = (8 - day) % 7;
    if (daysUntilMonday > 0 || next <= now) {
      next.setDate(next.getDate() + (daysUntilMonday || 7));
    }
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
  agents: Array<{ id: string; name: string }>;
  defaultAgentId: string;
  onClose: () => void;
  onSave: (input: CronJobCreateInput | CronJobUpdateInput) => Promise<void>;
}

function TaskDialog({ job, agents, defaultAgentId, onClose, onSave }: TaskDialogProps) {
  const { t } = useTranslation('cron');
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState(job?.name || '');
  const [agentId, setAgentId] = useState(job?.agentId || defaultAgentId);
  const [message, setMessage] = useState(job?.message || '');
  const [selectedModel, setSelectedModel] = useState(job?.model || '');
  const [modelTouched, setModelTouched] = useState(false);
  const availableModels = useSubagentsStore((state) => state.availableModels);
  const modelsLoading = useSubagentsStore((state) => state.modelsLoading);
  const loadAvailableModels = useSubagentsStore((state) => state.loadAvailableModels);
  const selectedModelEntry = resolveModelCatalogEntry(availableModels, selectedModel);
  const selectedModelLabel = selectedModelEntry?.displayLabel || selectedModel || t('dialog.followAgent');
  const initialScheduleForm = useMemo(() => createScheduleForm(job?.schedule), [job?.schedule]);
  const initialDelivery = job?.delivery
    ? job.delivery.mode === 'announce' ? job.delivery : null
    : job?.target
      ? {
        mode: 'announce' as const,
        channel: normalizeCronDeliveryChannel(job.target.channelType),
        to: job.target.recipient || job.target.channelId,
        ...(job.target.channelId ? { accountId: job.target.channelId } : {}),
      }
      : null;
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(initialScheduleForm.mode);
  const [periodicType, setPeriodicType] = useState<ScheduleType>(initialScheduleForm.periodicType);
  const [cronExpr, setCronExpr] = useState(initialScheduleForm.cronExpr);
  const [onceDate, setOnceDate] = useState(initialScheduleForm.onceDate);
  const [onceTime, setOnceTime] = useState(initialScheduleForm.onceTime);
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [deliveryMode, setDeliveryMode] = useState<'none' | 'announce'>(initialDelivery?.mode === 'announce' ? 'announce' : 'none');
  const [deliveryTouched, setDeliveryTouched] = useState(false);
  const [deliveryChannel, setDeliveryChannel] = useState(initialDelivery?.channel?.trim() || '');
  const [deliveryTarget, setDeliveryTarget] = useState(initialDelivery?.to || '');
  const [selectedDeliveryAccountId, setSelectedDeliveryAccountId] = useState(initialDelivery?.accountId || '');
  const [deliveryChannelTouched, setDeliveryChannelTouched] = useState(false);
  const [deliveryAccountTouched, setDeliveryAccountTouched] = useState(false);
  const [deliveryChannels, setDeliveryChannels] = useState<DeliveryChannelGroup[]>([]);
  const [deliveryChannelsLoading, setDeliveryChannelsLoading] = useState(false);
  const [deliveryChannelsLoaded, setDeliveryChannelsLoaded] = useState(false);
  const skills = useSkillsStore((state) => state.skills);
  const skillsInitialLoading = useSkillsStore((state) => state.initialLoading);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const availableSkills = useMemo(() => skills.filter((skill) => (
    skill.enabled
    && skill.eligible === true
    && skill.selectable !== false
    && !skill.unavailableReason
    && !skill.missingCategories?.length
  )), [skills]);
  const scheduleResult = buildScheduleInput({ mode: scheduleMode, periodicType, cronExpr, onceDate, onceTime });
  const schedulePreview = scheduleResult.ok && scheduleResult.previewExpr ? estimateNextRun(scheduleResult.previewExpr) : null;
  const deliveryChannelOptions = useMemo(() => {
    const options = [...deliveryChannels];
    if (deliveryChannel && !options.some((entry) => entry.channelType === deliveryChannel)) {
      options.push({
        channelType: deliveryChannel,
        accounts: [],
      });
    }
    return options;
  }, [deliveryChannel, deliveryChannels]);
  const selectedDeliveryChannelGroup = deliveryChannelOptions.find((entry) => entry.channelType === deliveryChannel);
  const deliveryAccountOptions = selectedDeliveryChannelGroup?.accounts ?? [];
  const requiresExplicitDeliveryAccount = deliveryMode === 'announce' && isWeChatDeliveryChannel(deliveryChannel);
  const agentOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const agent of agents) {
      if (!agent.id) {
        continue;
      }
      options.set(agent.id, agent.name || agent.id);
    }
    if (!options.has(defaultAgentId)) {
      options.set(defaultAgentId, defaultAgentId);
    }
    if (job?.agentId && !options.has(job.agentId)) {
      options.set(job.agentId, job.agentId);
    }
    return Array.from(options, ([id, name]) => ({ id, name }));
  }, [agents, defaultAgentId, job?.agentId]);
  const selectedAgentName = agentOptions.find((agent) => agent.id === agentId)?.name ?? agentId ?? defaultAgentId;

  useEffect(() => {
    void loadAvailableModels();
  }, [loadAvailableModels]);

  useEffect(() => {
    const { snapshotReady, initialLoading } = useSkillsStore.getState();
    if (!snapshotReady && !initialLoading) {
      void fetchSkills({ silent: true });
    }
  }, [fetchSkills]);

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
        setDeliveryChannelsLoaded(true);
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
    if (job || !deliveryChannelsLoaded || deliveryMode !== 'announce' || deliveryChannel.trim()) {
      return;
    }
    const firstSupported = deliveryChannels.find((entry) => isSupportedCronDeliveryChannel(entry.channelType));
    if (firstSupported?.channelType) {
      setDeliveryChannel(firstSupported.channelType);
    }
  }, [deliveryChannels, deliveryChannel, deliveryChannelsLoaded, deliveryMode, job]);

  useEffect(() => {
    if (!agentId) {
      setAgentId(job?.agentId || defaultAgentId);
    }
  }, [agentId, defaultAgentId, job?.agentId]);

  useEffect(() => {
    if (deliveryMode !== 'announce') {
      return;
    }
    if (!deliveryChannelsLoaded || selectedDeliveryAccountId || deliveryAccountTouched) {
      return;
    }
    if (job && !deliveryChannelTouched) {
      return;
    }
    const currentChannel = deliveryChannelOptions.find((entry) => entry.channelType === deliveryChannel);
    const nextDefault = currentChannel?.defaultAccountId || currentChannel?.accounts[0]?.accountId || '';
    if (nextDefault) {
      setSelectedDeliveryAccountId(nextDefault);
    }
  }, [
    deliveryAccountTouched,
    deliveryChannel,
    deliveryChannelOptions,
    deliveryChannelTouched,
    deliveryChannelsLoaded,
    deliveryMode,
    job,
    selectedDeliveryAccountId,
  ]);

  const insertSkillInstruction = (skillName: string) => {
    const instruction = t('dialog.useSkillInstruction', { name: skillName });
    setMessage((current) => `${current}${current && !/\s$/.test(current) ? '\n' : ''}${instruction}`);
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error(t('toast.nameRequired'));
      return;
    }
    if (!message.trim()) {
      toast.error(t('toast.messageRequired'));
      return;
    }

    const shouldSubmitSchedule = !job || scheduleTouched;
    const finalSchedule = shouldSubmitSchedule
      ? buildScheduleInput({ mode: scheduleMode, periodicType, cronExpr, onceDate, onceTime })
      : null;
    if (finalSchedule && !finalSchedule.ok) {
      toast.error(t(finalSchedule.errorKey));
      return;
    }

    const shouldSubmitDelivery = !job || deliveryTouched;
    const normalizedDeliveryChannel = normalizeCronDeliveryChannel(deliveryChannel);
    const finalDelivery = deliveryMode === 'announce'
      ? {
        mode: 'announce' as const,
        channel: normalizedDeliveryChannel,
        to: deliveryTarget.trim(),
        ...(selectedDeliveryAccountId.trim() ? { accountId: selectedDeliveryAccountId.trim() } : {}),
      }
      : { mode: 'none' as const };
    if (shouldSubmitDelivery && finalDelivery.mode === 'announce' && !finalDelivery.channel) {
      toast.error(t('toast.deliveryChannelRequired'));
      return;
    }
    if (shouldSubmitDelivery && finalDelivery.mode === 'announce' && !isSupportedCronDeliveryChannel(finalDelivery.channel)) {
      toast.error(t('toast.deliveryChannelUnsupported'));
      return;
    }
    if (shouldSubmitDelivery && finalDelivery.mode === 'announce' && !finalDelivery.to) {
      toast.error(t('toast.deliveryTargetRequired'));
      return;
    }
    if (shouldSubmitDelivery && finalDelivery.mode === 'announce' && isWeChatDeliveryChannel(finalDelivery.channel) && !selectedDeliveryAccountId.trim()) {
      toast.error(t('toast.deliveryAccountRequiredWeChat'));
      return;
    }

    const input: CronJobCreateInput | CronJobUpdateInput = {
      name: name.trim(),
      agentId: agentId.trim() || defaultAgentId,
      message: message.trim(),
      enabled: job?.enabled ?? true,
      ...(!job || modelTouched ? { model: resolveModelRuntimeReference(availableModels, selectedModel) ?? null } : {}),
      ...(shouldSubmitDelivery ? { delivery: finalDelivery } : {}),
      ...(finalSchedule && finalSchedule.ok ? { schedule: finalSchedule.schedule } : {}),
    };

    setSaving(true);
    try {
      await onSave(input);
      onClose();
      toast.success(job ? t('toast.updated') : t('toast.created'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
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
        role="dialog"
        aria-modal="true"
        aria-labelledby="cron-task-dialog-title"
        className="flex h-[94vh] max-h-[760px] w-full max-w-[1024px] flex-col overflow-hidden p-0 shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <CardHeader className="flex-row items-start justify-between space-y-0 border-b p-5">
          <div className="min-w-0">
            <CardTitle id="cron-task-dialog-title" className="text-lg">
              {job ? t('dialog.editTitle') : t('dialog.createTitle')}
            </CardTitle>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('common:actions.close', 'Close')}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>

        <CardContent className="min-h-0 flex-1 overflow-hidden p-0">
          <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
            <aside className="min-h-0 space-y-5 overflow-y-auto border-b bg-muted/20 p-5 lg:border-b-0 lg:border-r">
              <section className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="agent">{t('dialog.agent')}</Label>
                  <Select
                    id="agent"
                    value={agentId}
                    onChange={(event) => setAgentId(event.target.value)}
                  >
                    {agentOptions.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="rounded-xl border bg-card p-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <p className="truncate text-sm font-medium text-foreground">{selectedAgentName}</p>
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {agentId || defaultAgentId}
                  </p>
                </div>
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-foreground">{t('dialog.deliveryTitle')}</h3>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant={deliveryMode === 'none' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      setDeliveryMode('none');
                      setDeliveryTouched(true);
                    }}
                  >
                    {t('dialog.deliveryModeNone')}
                  </Button>
                  <Button
                    type="button"
                    variant={deliveryMode === 'announce' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      setDeliveryMode('announce');
                      setDeliveryTouched(true);
                    }}
                  >
                    {t('dialog.deliveryModeAnnounce')}
                  </Button>
                </div>

                {deliveryMode === 'announce' && (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="delivery-channel">{t('dialog.deliveryChannel')}</Label>
                      <Select
                        id="delivery-channel"
                        value={deliveryChannel}
                        disabled={deliveryChannelsLoading}
                        onChange={(event) => {
                          setDeliveryChannel(event.target.value);
                          setSelectedDeliveryAccountId('');
                          setDeliveryTouched(true);
                          setDeliveryChannelTouched(true);
                          setDeliveryAccountTouched(false);
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

                    <div className="space-y-1.5">
                      <Label htmlFor="delivery-account">{t('dialog.deliveryAccount')}</Label>
                      <Select
                        id="delivery-account"
                        value={selectedDeliveryAccountId}
                        disabled={deliveryAccountOptions.length === 0}
                        onChange={(event) => {
                          setSelectedDeliveryAccountId(event.target.value);
                          setDeliveryTouched(true);
                          setDeliveryAccountTouched(true);
                        }}
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

                    <div className="space-y-1.5">
                      <Label htmlFor="delivery-target">{t('dialog.deliveryTarget')}</Label>
                      <Input
                        id="delivery-target"
                        placeholder={t('dialog.deliveryTargetPlaceholder')}
                        value={deliveryTarget}
                        onChange={(event) => {
                          setDeliveryTarget(event.target.value);
                          setDeliveryTouched(true);
                        }}
                      />
                      <p className="text-xs text-muted-foreground">{t('dialog.deliveryTargetDesc')}</p>
                    </div>
                  </div>
                )}
              </section>
            </aside>

            <main className="min-h-0 overflow-y-auto p-5">
              <div className="space-y-5">
                <section className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="name">{t('dialog.taskName')}</Label>
                    <Input
                      id="name"
                      placeholder={t('dialog.taskNamePlaceholder')}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="message">{t('dialog.message')}</Label>
                    <div className="rounded-[calc(var(--radius-interactive)+2px)] border border-input bg-card transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15 focus-within:shadow-[var(--shadow-focus)]">
                      <Textarea
                        id="message"
                        placeholder={t('dialog.messagePlaceholder')}
                        value={message}
                        onChange={(event) => setMessage(event.target.value)}
                        rows={7}
                        className="min-h-[180px] resize-none border-0 bg-transparent focus-visible:ring-0 focus-visible:shadow-none"
                      />
                      <div className="flex min-w-0 items-center gap-2 px-3 pb-3 pt-1">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={modelsLoading}
                              aria-label={t('dialog.model')}
                              title={selectedModelLabel}
                              className="h-8 min-w-0 max-w-[min(65%,16rem)] shrink rounded-full px-3 text-xs text-muted-foreground"
                            >
                              <span className="truncate">{selectedModelLabel}</span>
                              {modelsLoading ? (
                                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-label={t('common:status.loading')} />
                              ) : (
                                <ChevronDown className="h-3 w-3 shrink-0" />
                              )}
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="start"
                            className="w-72 max-h-[min(16rem,var(--radix-dropdown-menu-content-available-height))] max-w-[calc(100vw-2rem)] overflow-y-auto"
                          >
                            <DropdownMenuItem
                              onSelect={() => {
                                setSelectedModel('');
                                setModelTouched(true);
                              }}
                            >
                              <span className="truncate">{t('dialog.followAgent')}</span>
                            </DropdownMenuItem>
                            {selectedModel && !selectedModelEntry && (
                              <DropdownMenuItem
                                onSelect={() => {
                                  setSelectedModel(selectedModel);
                                  setModelTouched(true);
                                }}
                              >
                                <span className="truncate" title={selectedModel}>{selectedModel}</span>
                              </DropdownMenuItem>
                            )}
                            {availableModels.map((model) => (
                              <DropdownMenuItem
                                key={model.id}
                                onSelect={() => {
                                  setSelectedModel(resolveModelRuntimeReference(availableModels, model.id) || '');
                                  setModelTouched(true);
                                }}
                              >
                                <span className="truncate" title={model.displayLabel}>{model.displayLabel}</span>
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={skillsInitialLoading || availableSkills.length === 0}
                              className="h-8 shrink-0 gap-1.5 rounded-full px-3 text-xs text-muted-foreground"
                            >
                              <Sparkles className="h-3.5 w-3.5" />
                              {t('dialog.skills')}
                              <ChevronDown className="h-3 w-3" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="start"
                            className="max-h-[min(18rem,var(--radix-dropdown-menu-content-available-height))] max-w-[min(24rem,calc(100vw-2rem))] overflow-y-auto"
                          >
                            {availableSkills.map((skill) => (
                              <DropdownMenuItem key={skill.id} onSelect={() => insertSkillInstruction(skill.name)}>
                                <span className="truncate" title={skill.name}>{skill.name}</span>
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="space-y-3 rounded-xl border bg-muted/20 p-4">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">
                      {t('dialog.schedulePlan', { defaultValue: 'Schedule plan' })}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {schedulePreview
                        ? t('dialog.schedulePreview', { time: schedulePreview, defaultValue: `Next run: ${schedulePreview}` })
                        : t('dialog.noSchedulePreview', { defaultValue: 'Next run appears after the schedule is saved.' })}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 rounded-full border bg-card p-1">
                    <Button
                      type="button"
                      variant={scheduleMode === 'periodic' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="rounded-full shadow-none"
                      onClick={() => {
                        setScheduleMode('periodic');
                        setScheduleTouched(true);
                      }}
                    >
                      {t('dialog.periodicTab')}
                    </Button>
                    <Button
                      type="button"
                      variant={scheduleMode === 'once' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="rounded-full shadow-none"
                      onClick={() => {
                        setScheduleMode('once');
                        setScheduleTouched(true);
                      }}
                    >
                      {t('dialog.onceTab')}
                    </Button>
                  </div>
                  {scheduleMode === 'periodic' ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-2 xl:grid-cols-5">
                        {periodicOptions.map((option) => (
                          <Button
                            key={option.type}
                            type="button"
                            variant={periodicType === option.type ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => {
                              setPeriodicType(option.type);
                              setScheduleTouched(true);
                            }}
                            className="justify-start px-3"
                          >
                            <Timer className="h-3.5 w-3.5" />
                            <span className="truncate">{t(`periodic.${option.type}`)}</span>
                          </Button>
                        ))}
                      </div>
                      {periodicType === 'custom' && (
                        <div className="space-y-1.5">
                          <Label htmlFor="cron-expr">{t('dialog.cronPlaceholder')}</Label>
                          <Input
                            id="cron-expr"
                            placeholder={t('dialog.cronPlaceholder')}
                            value={cronExpr}
                            onChange={(event) => {
                              setCronExpr(event.target.value);
                              setScheduleTouched(true);
                            }}
                            className="font-mono"
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="once-date">{t('dialog.onceDate', { defaultValue: 'Date' })}</Label>
                        <Input
                          id="once-date"
                          type="date"
                          value={onceDate}
                          onChange={(event) => {
                            setOnceDate(event.target.value);
                            setScheduleTouched(true);
                          }}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="once-time">{t('dialog.onceTime', { defaultValue: 'Time' })}</Label>
                        <Input
                          id="once-time"
                          type="time"
                          value={onceTime}
                          onChange={(event) => {
                            setOnceTime(event.target.value);
                            setScheduleTouched(true);
                          }}
                        />
                      </div>
                    </div>
                  )}
                </section>
              </div>
            </main>
          </div>
        </CardContent>

        <div className="flex shrink-0 justify-end gap-2 border-t bg-background p-4">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common:actions.cancel', 'Cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('common:status.saving', 'Saving...')}
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" />
                {job ? t('dialog.saveChanges') : t('dialog.createTitle')}
              </>
            )}
          </Button>
        </div>
      </Card>
    </div>
  );
}

// Job Row Component
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
  const agents = useSubagentsStore((state) => (
    Array.isArray(state.agentsResource.data) ? state.agentsResource.data : []
  ));
  const agentName = agents.find((agent) => agent.id === job.agentId)?.name ?? job.agentId;
  const isRunning = Boolean(job.runningAt);
  const failedLastRun = isFailedCronJob(job);
  const actionsDisabled = isMutating || triggering;
  const deliveryText = formatCronDeliveryText(job);

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
    <div
      data-testid={`cron-job-card-${job.id}`}
      className={cn(
        'grid grid-cols-[112px_minmax(0,1fr)_auto] items-center gap-5 border-b px-5 py-4 text-sm last:border-b-0 transition-colors hover:bg-muted/20',
        job.enabled && 'bg-primary/[0.012]'
      )}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <Timer className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium text-foreground">{parseCronSchedule(job.schedule, t)}</span>
        </div>
      </div>

      <div className="min-w-0 space-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <p
            data-testid={`cron-job-card-title-${job.id}`}
            className="min-w-0 truncate text-[15px] font-semibold text-foreground"
            title={job.name}
          >
            {job.name}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {isRunning ? (
              <Badge variant="default">{t('stats.running')}</Badge>
            ) : !job.enabled ? (
              <Badge variant="secondary">{t('stats.paused')}</Badge>
            ) : null}
            {failedLastRun ? <Badge variant="destructive">{t('stats.failed')}</Badge> : null}
            {isMutating ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
          </div>
        </div>

        <div className="flex min-w-0 items-start gap-2 rounded-lg bg-muted/25 px-3 py-2">
          <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <p className="line-clamp-2 min-w-0 text-xs leading-5 text-muted-foreground" title={job.message}>
            {job.message}
          </p>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5">
            <Bot className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate text-foreground">{agentName}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{job.enabled ? formatCronDateTime(job.nextRun) : '-'}</span>
          </span>
          {job.lastRun ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <History className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{t('card.last')}: {formatRelativeTime(job.lastRun.time)}</span>
              {job.lastRun.success ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
              ) : (
                <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
              )}
            </span>
          ) : null}
          {isRunning && job.runningAt ? (
            <span className="truncate">{t('stats.running')}: {formatRelativeTime(job.runningAt)}</span>
          ) : null}
          {deliveryText ? (
            <span className="truncate" title={deliveryText}>{deliveryText}</span>
          ) : null}
        </div>

        {failedLastRun && job.lastRun?.error ? (
          <p className="line-clamp-1 text-xs text-destructive" title={job.lastRun.error}>
            {job.lastRun.error}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div data-testid={`cron-job-card-switch-${job.id}`} className="flex shrink-0 items-center">
          <Switch
            checked={job.enabled}
            disabled={isMutating}
            onCheckedChange={onToggle}
          />
        </div>
        <div className="flex justify-end gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleTrigger}
          disabled={actionsDisabled || isRunning}
          title={t('card.runNow')}
          aria-label={t('card.runNow')}
        >
          {triggering ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onEdit}
          disabled={isMutating}
          title={t('common:actions.edit', 'Edit')}
          aria-label={t('common:actions.edit', 'Edit')}
        >
          <Edit className="h-4 w-4" />
        </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive hover:text-destructive"
            onClick={handleDelete}
            disabled={isMutating}
            title={t('common:actions.delete', 'Delete')}
            aria-label={t('common:actions.delete', 'Delete')}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
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
  const gatewayInitialized = useGatewayStore((state) => state.isInitialized);
  const defaultAgentId = useChatStore((state) => {
    const meta = state.loadedSessions[state.currentSessionKey]?.meta;
    return meta?.agentId ?? 'main';
  });
  const agentsResource = useSubagentsStore((state) => state.agentsResource);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const requestedAgentsLoadRef = useRef(false);
  const [showDialog, setShowDialog] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | undefined>();
  const [jobToDelete, setJobToDelete] = useState<{ id: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState<CronStatusFilter>('all');

  const isGatewayRunning = isGatewayOperational(gatewayStatus);
  const gatewayPreparing = isGatewayPreparing(gatewayStatus, gatewayInitialized);
  const availableAgents = Array.isArray(agentsResource.data)
    ? agentsResource.data.map((agent) => ({ id: agent.id, name: agent.name || agent.id }))
    : [];
  const manualRefreshBusy = refreshing || mutating;
  const showInitialLoading = !snapshotReady && initialLoading;
  const showRefreshingHint = useDelayedFlag(refreshing && snapshotReady, 180);

  // Fetch jobs on mount
  useEffect(() => {
    if (isGatewayRunning) {
      void fetchJobs({ silent: true });
    }
  }, [fetchJobs, isGatewayRunning]);

  useEffect(() => {
    if (!isGatewayRunning) {
      requestedAgentsLoadRef.current = false;
      return;
    }
    if (agentsResource.status === 'ready') {
      requestedAgentsLoadRef.current = false;
      return;
    }
    if (agentsResource.status !== 'idle' && agentsResource.status !== 'error') {
      return;
    }
    if (requestedAgentsLoadRef.current) {
      return;
    }
    requestedAgentsLoadRef.current = true;
    void loadAgents({ silent: true });
  }, [agentsResource.status, isGatewayRunning, loadAgents]);

  // Statistics
  const cronStatusCounts = useMemo(() => ({
    total: jobs.length,
    active: jobs.filter((job) => job.enabled).length,
    running: jobs.filter((job) => Boolean(job.runningAt)).length,
    paused: jobs.filter((job) => !job.enabled).length,
    failed: jobs.filter(isFailedCronJob).length,
  }), [jobs]);
  const statusFilterOptions = useMemo(() => ([
    {
      value: 'all' as const,
      label: t('filters.all', { defaultValue: 'All' }),
      count: cronStatusCounts.total,
    },
    {
      value: 'active' as const,
      label: t('filters.active', { defaultValue: 'Active' }),
      count: cronStatusCounts.active,
    },
    {
      value: 'running' as const,
      label: t('filters.running', { defaultValue: 'Running' }),
      count: cronStatusCounts.running,
    },
    {
      value: 'paused' as const,
      label: t('filters.paused', { defaultValue: 'Paused' }),
      count: cronStatusCounts.paused,
    },
    {
      value: 'failed' as const,
      label: t('filters.failed', { defaultValue: 'Failed' }),
      count: cronStatusCounts.failed,
    },
  ]), [cronStatusCounts, t]);
  const filteredJobs = useMemo(
    () => jobs.filter((job) => matchesCronStatusFilter(job, statusFilter)),
    [jobs, statusFilter],
  );

  const handleSave = useCallback(async (input: CronJobCreateInput | CronJobUpdateInput) => {
    if (!isGatewayRunning) {
      throw new Error(gatewayPreparing ? t('gatewayPreparing') : t('gatewayWarning'));
    }
    if (editingJob) {
      await updateJob(editingJob.id, input);
    } else {
      await createJob(input as CronJobCreateInput);
    }
  }, [isGatewayRunning, editingJob, gatewayPreparing, createJob, updateJob, t]);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    if (!isGatewayRunning) {
      toast.error(gatewayPreparing ? t('gatewayPreparing') : t('gatewayWarning'));
      return;
    }
    try {
      await toggleJob(id, enabled);
      toast.success(enabled ? t('toast.enabled') : t('toast.paused'));
    } catch {
      toast.error(t('toast.failedUpdate'));
    }
  }, [isGatewayRunning, gatewayPreparing, toggleJob, t]);

  return (
    <div className="space-y-5">
      {!embedded && (
        <header className="flex items-center justify-between">
          <TaskCenterPageTitle title={t('title')} subtitle={t('subtitle')} />
        </header>
      )}

      <TaskCenterToolbar
        actions={(
          <>
            {showRefreshingHint && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('common:status.loading', 'Loading...')}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              aria-label={t('refresh')}
              title={t('refresh')}
              onClick={() => { void fetchJobs(); }}
              disabled={!isGatewayRunning || manualRefreshBusy}
            >
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setEditingJob(undefined);
                setShowDialog(true);
              }}
              disabled={!isGatewayRunning || mutating}
            >
              <Plus className="h-4 w-4" />
              {t('newTask')}
            </Button>
          </>
        )}
      >
        {statusFilterOptions.map((option) => (
          <TaskCenterStatusFilter
            key={option.value}
            label={option.label}
            count={option.count}
            active={statusFilter === option.value}
            onClick={() => setStatusFilter(option.value)}
          />
        ))}
      </TaskCenterToolbar>

      {!isGatewayRunning && (
        <Card className={gatewayPreparing ? 'border-border bg-muted/30' : 'border-yellow-500 bg-yellow-50 dark:bg-yellow-900/10'}>
          <CardContent className="flex items-center gap-3 py-4">
            {gatewayPreparing ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : (
              <AlertCircle className="h-5 w-5 text-yellow-600" />
            )}
            <span className={gatewayPreparing ? 'text-muted-foreground' : 'text-yellow-700 dark:text-yellow-400'}>
              {gatewayPreparing ? t('gatewayPreparing') : t('gatewayWarning')}
            </span>
          </CardContent>
        </Card>
      )}

      {error && (
        <Card className="border-destructive">
          <CardContent className="flex items-center gap-2 py-4 text-destructive">
            <AlertCircle className="h-5 w-5" />
            {error}
          </CardContent>
        </Card>
      )}

      {showInitialLoading ? (
        <TaskCenterSurface>
          <div className="overflow-x-auto">
            <div className="min-w-[760px] divide-y">
              {Array.from({ length: 5 }).map((_, index) => (
                <div
                  key={`cron-loading-row-${index}`}
                  className="grid grid-cols-[112px_minmax(0,1fr)_140px] items-center gap-5 px-5 py-4"
                >
                  <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                  <div className="space-y-2">
                    <div className="h-4 w-64 animate-pulse rounded bg-muted" />
                    <div className="h-10 w-full animate-pulse rounded-lg bg-muted" />
                    <div className="h-3 w-80 animate-pulse rounded bg-muted" />
                  </div>
                  <div className="ml-auto h-8 w-28 animate-pulse rounded-full bg-muted" />
                </div>
              ))}
            </div>
          </div>
        </TaskCenterSurface>
      ) : jobs.length === 0 ? (
        <TaskCenterSurface>
          <TaskCenterEmptyState
            icon={Clock}
            title={t('empty.title')}
            description={t('empty.description')}
          >
            <Button
              onClick={() => {
                setEditingJob(undefined);
                setShowDialog(true);
              }}
              disabled={!isGatewayRunning}
            >
              <Plus className="h-4 w-4" />
              {t('empty.create')}
            </Button>
          </TaskCenterEmptyState>
        </TaskCenterSurface>
      ) : (
        <TaskCenterSurface>
          {filteredJobs.length === 0 ? (
            <TaskCenterEmptyState
              icon={Clock}
              title={t('list.noMatches', { defaultValue: 'No scheduled tasks match this filter.' })}
            />
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[760px] divide-y">
                {filteredJobs.map((job) => (
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
                    onTrigger={async () => {
                      if (!isGatewayRunning) {
                        throw new Error(gatewayPreparing ? t('gatewayPreparing') : t('gatewayWarning'));
                      }
                      return triggerJob(job.id);
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </TaskCenterSurface>
      )}

      {/* Create/Edit Dialog */}
      {showDialog && (
        <TaskDialog
          job={editingJob}
          agents={availableAgents}
          defaultAgentId={defaultAgentId}
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
        onError={(deleteError) => {
          toast.error(t('toast.failedDelete', { error: deleteError instanceof Error ? deleteError.message : String(deleteError) }));
        }}
        onCancel={() => setJobToDelete(null)}
      />
    </div>
  );
}

export default Cron;
