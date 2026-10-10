/* eslint-disable react-refresh/only-export-components */
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import type { TeamGraphNodeRecord } from '@/types/team-design';
import type {
  CronScheduleDraft,
  CustomCronSchedule,
  TeamGraphCronCustomKind,
  TeamGraphCronPresetId,
  TeamGraphStartTriggerMode,
  TeamStartEditorProps,
} from './team-node-editor-types';

const START_CRON_PRESETS: Array<{ presetId: Exclude<TeamGraphCronPresetId, 'custom'>; cron: string }> = [
  { presetId: 'every10Minutes', cron: '*/10 * * * *' },
  { presetId: 'every30Minutes', cron: '*/30 * * * *' },
  { presetId: 'hourly', cron: '0 * * * *' },
  { presetId: 'dailyAt9', cron: '0 9 * * *' },
];
const START_CRON_CUSTOM_KIND_IDS: TeamGraphCronCustomKind[] = ['intervalMinutes', 'intervalHours', 'dailyAt'];
const DEFAULT_CUSTOM_CRON_SCHEDULE: CustomCronSchedule = { kind: 'intervalMinutes', intervalMinutes: '10', intervalHours: '1', time: '09:00' };
export const DEFAULT_CRON_SCHEDULE: CronScheduleDraft = { mode: 'simple', presetId: 'every10Minutes', custom: DEFAULT_CUSTOM_CRON_SCHEDULE };
const FIELD_CLASS = 'min-w-0 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

export function normalizeWebhookPathInput(value: string): string {
  return value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizeWebhookPublicBaseUrlInput(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function buildWebhookRoutePreview(path: string): string {
  const normalizedPath = normalizeWebhookPathInput(path);
  return normalizedPath ? `/api/team-runtime/webhooks/${normalizedPath}` : '/api/team-runtime/webhooks/{path}';
}

export function buildWebhookPublicUrl(publicBaseUrl: string, path: string): string {
  const normalizedBaseUrl = normalizeWebhookPublicBaseUrlInput(publicBaseUrl);
  if (!normalizedBaseUrl || !isValidWebhookPublicBaseUrl(normalizedBaseUrl)) return '';
  return `${normalizedBaseUrl}${buildWebhookRoutePreview(path)}`;
}

function isValidWebhookPublicBaseUrl(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function cronPresetIdForExpression(cronExpression: string): TeamGraphCronPresetId {
  return START_CRON_PRESETS.find((preset) => preset.cron === cronExpression)?.presetId ?? 'custom';
}

function readCustomCronSchedule(cronExpression: string): CustomCronSchedule | null {
  const everyMinutesMatch = /^\*\/(\d+) \* \* \* \*$/.exec(cronExpression);
  if (everyMinutesMatch?.[1]) {
    return { ...DEFAULT_CUSTOM_CRON_SCHEDULE, kind: 'intervalMinutes', intervalMinutes: everyMinutesMatch[1] };
  }
  const everyHoursMatch = /^0 \*\/(\d+) \* \* \*$/.exec(cronExpression);
  if (everyHoursMatch?.[1]) {
    return { ...DEFAULT_CUSTOM_CRON_SCHEDULE, kind: 'intervalHours', intervalHours: everyHoursMatch[1] };
  }
  const dailyAtMatch = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cronExpression);
  if (dailyAtMatch?.[1] && dailyAtMatch[2]) {
    return { ...DEFAULT_CUSTOM_CRON_SCHEDULE, kind: 'dailyAt', time: `${dailyAtMatch[2].padStart(2, '0')}:${dailyAtMatch[1].padStart(2, '0')}` };
  }
  return null;
}

export function readPositiveIntegerInRange(value: string, min: number, max: number): number | null {
  const trimmedValue = value.trim();
  if (!/^\d+$/.test(trimmedValue)) return null;
  const parsed = Number.parseInt(trimmedValue, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function buildCustomCronExpression(input: CustomCronSchedule): string | null {
  if (input.kind === 'intervalMinutes') {
    const minutes = readPositiveIntegerInRange(input.intervalMinutes, 1, 59);
    return minutes === null ? null : `*/${minutes} * * * *`;
  }
  if (input.kind === 'intervalHours') {
    const hours = readPositiveIntegerInRange(input.intervalHours, 1, 23);
    return hours === null ? null : `0 */${hours} * * *`;
  }
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(input.time.trim());
  if (!timeMatch?.[1] || !timeMatch[2]) return null;
  const hours = readPositiveIntegerInRange(timeMatch[1], 0, 23);
  const minutes = readPositiveIntegerInRange(timeMatch[2], 0, 59);
  return hours === null || minutes === null ? null : `${minutes} ${hours} * * *`;
}

function readCronSchedule(expression: string): CronScheduleDraft {
  const presetId = cronPresetIdForExpression(expression);
  if (presetId !== 'custom') return { mode: 'simple', presetId, custom: DEFAULT_CUSTOM_CRON_SCHEDULE };
  const custom = readCustomCronSchedule(expression);
  return custom && buildCustomCronExpression(custom) === expression
    ? { mode: 'simple', presetId, custom }
    : { mode: 'expression', expression };
}

export function buildCronExpression(schedule: CronScheduleDraft): string | null {
  if (schedule.mode === 'expression') return schedule.expression;
  return schedule.presetId === 'custom'
    ? buildCustomCronExpression(schedule.custom)
    : START_CRON_PRESETS.find((preset) => preset.presetId === schedule.presetId)!.cron;
}

export function readStartTrigger(node: TeamGraphNodeRecord | null): { mode: TeamGraphStartTriggerMode; cron: CronScheduleDraft; path: string } {
  const trigger = node?.config?.trigger;
  return {
    mode: trigger?.mode ?? 'manual',
    cron: trigger?.mode === 'cron' ? readCronSchedule(trigger.cron) : DEFAULT_CRON_SCHEDULE,
    path: trigger?.mode === 'webhook' ? trigger.path : '',
  };
}

export function TeamStartEditor({
  editable,
  disabled,
  labels,
  triggerMode,
  webhookPath,
  webhookPublicBaseUrl,
  cronSchedule,
  webhookAuth,
  copiedWebhookPublicUrl,
  onTriggerModeChange,
  onWebhookPathChange,
  onWebhookPublicBaseUrlChange,
  onCronScheduleChange,
  onCopyWebhookPublicUrl,
}: TeamStartEditorProps) {
  const id = useId();
  const cronExpression = buildCronExpression(cronSchedule);
  const webhookPublicUrl = buildWebhookPublicUrl(webhookPublicBaseUrl, webhookPath);
  const baseUrlInvalid = !isValidWebhookPublicBaseUrl(webhookPublicBaseUrl);
  const normalizedPath = normalizeWebhookPathInput(webhookPath);
  const pathError = !normalizedPath ? labels.startWebhookPathRequired : normalizedPath.includes('..') ? labels.startWebhookPathInvalid : null;
  const triggerLabels = { manual: labels.startTriggerManual, webhook: labels.startTriggerWebhook, cron: labels.startTriggerCron };

  return (
    <div className="space-y-5 text-sm">
      <label className="grid gap-2 text-xs font-medium text-muted-foreground">
        {labels.startTriggerMode}
        {editable ? (
          <select
            className={FIELD_CLASS}
            value={triggerMode}
            disabled={disabled}
            aria-describedby={`${id}-trigger-hint`}
            onChange={(event) => onTriggerModeChange(event.target.value as TeamGraphStartTriggerMode)}
          >
            <option value="manual">{labels.startTriggerManual}</option>
            <option value="webhook">{labels.startTriggerWebhook}</option>
            <option value="cron">{labels.startTriggerCron}</option>
          </select>
        ) : <span className="text-sm font-normal text-foreground">{triggerLabels[triggerMode]}</span>}
      </label>
      <p id={`${id}-trigger-hint`} className="text-xs leading-relaxed text-muted-foreground">{labels.startTriggerHint}</p>

      {triggerMode === 'cron' ? (
        <div className="space-y-3">
          {editable ? (
            <fieldset disabled={disabled} className="space-y-3">
              <label className="grid gap-2 text-xs font-medium text-muted-foreground">
                {labels.startCronSchedule}
                <select
                  className={FIELD_CLASS}
                  value={cronSchedule.mode === 'expression' ? 'expression' : cronSchedule.presetId}
                  aria-describedby={cronSchedule.mode === 'expression' ? `${id}-expression-hint` : undefined}
                  onChange={(event) => onCronScheduleChange({ mode: 'simple', presetId: event.target.value as TeamGraphCronPresetId, custom: cronSchedule.mode === 'simple' ? cronSchedule.custom : DEFAULT_CUSTOM_CRON_SCHEDULE })}
                >
                  {cronSchedule.mode === 'expression' ? <option value="expression" disabled>{labels.startCronKeepExpression}</option> : null}
                  {START_CRON_PRESETS.map(({ presetId }) => <option key={presetId} value={presetId}>{labels.startCronSchedules[presetId]}</option>)}
                  <option value="custom">{labels.startCronSchedules.custom}</option>
                </select>
              </label>
              {cronSchedule.mode === 'simple' && cronSchedule.presetId === 'custom' ? (
                <div className="grid grid-cols-2 items-start gap-3">
                  <label className="grid gap-2 text-xs font-medium text-muted-foreground">
                    {labels.startCronCustomKind}
                    <select
                      className={FIELD_CLASS}
                      value={cronSchedule.custom.kind}
                      onChange={(event) => onCronScheduleChange({ ...cronSchedule, custom: { ...cronSchedule.custom, kind: event.target.value as TeamGraphCronCustomKind } })}
                    >
                      {START_CRON_CUSTOM_KIND_IDS.map((kind) => <option key={kind} value={kind}>{labels.startCronCustomKinds[kind]}</option>)}
                    </select>
                  </label>
                  {cronSchedule.custom.kind === 'dailyAt' ? (
                    <label className="grid gap-2 text-xs font-medium text-muted-foreground">
                      {labels.startCronCustomTime}
                      <input
                        className={FIELD_CLASS}
                        type="time"
                        required
                        value={cronSchedule.custom.time}
                        aria-invalid={cronExpression === null}
                        aria-describedby={cronExpression === null ? `${id}-cron-error` : undefined}
                        onChange={(event) => onCronScheduleChange({ ...cronSchedule, custom: { ...cronSchedule.custom, time: event.target.value } })}
                      />
                    </label>
                  ) : (
                    <label className="grid gap-2 text-xs font-medium text-muted-foreground">
                      {cronSchedule.custom.kind === 'intervalMinutes' ? labels.startCronCustomIntervalMinutes : labels.startCronCustomIntervalHours}
                      <input
                        className={FIELD_CLASS}
                        type="number"
                        min={1}
                        max={cronSchedule.custom.kind === 'intervalMinutes' ? 59 : 23}
                        step={1}
                        required
                        value={cronSchedule.custom[cronSchedule.custom.kind]}
                        aria-invalid={cronExpression === null}
                        aria-describedby={cronExpression === null ? `${id}-cron-error` : undefined}
                        onChange={(event) => onCronScheduleChange({ ...cronSchedule, custom: { ...cronSchedule.custom, [cronSchedule.custom.kind]: event.target.value } })}
                      />
                    </label>
                  )}
                </div>
              ) : null}
            </fieldset>
          ) : <p className="text-xs font-medium text-muted-foreground">{labels.startCronSchedule}</p>}
          {cronExpression === null ? (
            <p id={`${id}-cron-error`} role="status" className="text-xs text-destructive">{labels.startCronCustomValueRequired}</p>
          ) : <pre className="whitespace-pre-wrap break-all font-mono text-xs text-foreground">{cronExpression}</pre>}
          {editable && cronSchedule.mode === 'expression' ? (
            <p id={`${id}-expression-hint`} className="text-xs leading-relaxed text-muted-foreground">{labels.startCronExpressionHint}</p>
          ) : null}
        </div>
      ) : null}

      {triggerMode === 'webhook' ? (
        <div className="space-y-5">
          <label className="grid gap-2 text-xs font-medium text-muted-foreground">
            {labels.startWebhookPath}
            <input
              className={`${FIELD_CLASS} font-mono`}
              value={webhookPath}
              readOnly={!editable}
              disabled={disabled}
              required
              aria-invalid={Boolean(pathError)}
              aria-describedby={pathError ? `${id}-path-error` : undefined}
              onChange={(event) => onWebhookPathChange(event.target.value)}
            />
          </label>
          {pathError ? <p id={`${id}-path-error`} role="status" className="text-xs text-destructive">{pathError}</p> : null}
          {editable ? (
            <div className="space-y-2">
              <label className="grid gap-2 text-xs font-medium text-muted-foreground">
                {labels.startWebhookPublicBaseUrl}
                <input
                  className={`${FIELD_CLASS} font-mono`}
                  type="url"
                  value={webhookPublicBaseUrl}
                  disabled={disabled}
                  aria-invalid={baseUrlInvalid}
                  aria-describedby={`${id}-base-url-hint${baseUrlInvalid ? ` ${id}-base-url-error` : ''}`}
                  onChange={(event) => onWebhookPublicBaseUrlChange(event.target.value)}
                />
              </label>
              <p id={`${id}-base-url-hint`} className="text-xs leading-relaxed text-muted-foreground">{labels.startWebhookPublicBaseUrlHint}</p>
              {baseUrlInvalid ? <p id={`${id}-base-url-error`} role="status" className="text-xs text-destructive">{labels.startWebhookPublicBaseUrlInvalid}</p> : null}
            </div>
          ) : null}
          <dl className="space-y-4 border-t border-border pt-4 text-xs">
            <div className="space-y-1.5">
              <dt className="font-medium text-muted-foreground">{labels.startWebhookPathPreview}</dt>
              <dd className="break-all font-mono text-foreground">{buildWebhookRoutePreview(webhookPath)}</dd>
            </div>
            <div className="space-y-1.5">
              <dt className="font-medium text-muted-foreground">{labels.startWebhookToken}</dt>
              <dd className="flex items-center justify-between gap-3">
                <span className="min-w-0 break-all font-mono text-foreground">{webhookAuth?.maskedToken || labels.startWebhookTokenUnavailable}</span>
                <Button type="button" variant="outline" size="sm" className="shrink-0" disabled>{labels.copyWebhookToken}</Button>
              </dd>
            </div>
            <div className="space-y-1.5">
              <dt className="font-medium text-muted-foreground">{labels.startWebhookPublicUrl}</dt>
              <dd className="flex items-start justify-between gap-3">
                <span className="min-w-0 break-all font-mono text-foreground">{webhookPublicUrl || labels.startWebhookPublicUrlUnavailable}</span>
                <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={disabled || !webhookPublicUrl} onClick={onCopyWebhookPublicUrl}>
                  <span role="status">{copiedWebhookPublicUrl ? labels.copiedWebhookPublicUrl : labels.copyWebhookPublicUrl}</span>
                </Button>
              </dd>
            </div>
          </dl>
          <p className="text-xs leading-relaxed text-muted-foreground">{labels.startWebhookPathPreviewHint}</p>
        </div>
      ) : null}
    </div>
  );
}
