/* eslint-disable react-refresh/only-export-components */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const REMOTE_FLEET_SHORT_VALUE_LENGTH = 42;
const REMOTE_FLEET_URL_TAIL_LENGTH = 18;
const REMOTE_FLEET_SENSITIVE_VALUE_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----|bearer\s+[a-z0-9._~+/=-]+|(?:token|password|secret|private[-_]?key|ticket|authorization|stdout|stderr)\s*[=:]|[?&](?:token|password|secret|ticket|authorization)=/i;

type RemoteFleetFieldValue = string | number | readonly string[];

function isRemoteFleetStringArray(value: RemoteFleetFieldValue | undefined): value is readonly string[] {
  return Array.isArray(value);
}

export function remoteFleetStatusVariant(status?: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (!status || status === 'unknown') return 'outline';
  if (
    status === 'online'
    || status === 'running'
    || status === 'connected'
    || status === 'succeeded'
    || status === 'available'
    || status === 'ready'
    || status === 'active'
    || status === 'enrolled'
    || status === 'installed'
    || status === 'environment-ready'
    || status === 'registered'
    || status === 'observed'
    || status === 'matcha-managed'
    || status === 'current'
  ) return 'secondary';
  if (
    status === 'deploying'
    || status === 'provisioning'
    || status === 'installing'
    || status === 'discovered'
    || status === 'starting'
    || status === 'stopping'
    || status === 'busy'
    || status === 'queued'
    || status === 'opening'
    || status === 'closing'
    || status === 'deleting'
    || status === 'unverified'
    || status === 'degraded'
    || status === 'stale'
  ) return 'default';
  if (
    status === 'offline'
    || status === 'stopped'
    || status === 'disabled'
    || status === 'draining'
    || status === 'retired'
    || status === 'not-installed'
    || status === 'deleted'
    || status === 'external'
    || status === 'released'
    || status === 'closed'
    || status === 'pruned'
    || status === 'cancelled'
    || status === 'expired'
  ) return 'outline';
  if (
    status === 'error'
    || status === 'failed'
    || status === 'unhealthy'
    || status === 'revoked'
    || status === 'orphaned'
    || status === 'conflict'
    || status === 'timed-out'
  ) return 'destructive';
  return 'default';
}

function shortenRemoteFleetTimestamp(value: string): string {
  const timestampMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!timestampMatch) return value;
  return timestampMatch[3]
    ? `${timestampMatch[1]} ${timestampMatch[2]} ${timestampMatch[3]}`
    : `${timestampMatch[1]} ${timestampMatch[2]}`;
}

function shortenRemoteFleetMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const edgeLength = Math.max(8, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, edgeLength)}…${value.slice(-edgeLength)}`;
}

function shortenRemoteFleetUrl(value: string, maxLength: number): string {
  try {
    const url = new URL(value);
    const pathAndSearch = `${url.pathname}${url.search}`;
    const shortPathAndSearch = pathAndSearch.length > REMOTE_FLEET_URL_TAIL_LENGTH
      ? `…${pathAndSearch.slice(-REMOTE_FLEET_URL_TAIL_LENGTH)}`
      : pathAndSearch;
    const displayValue = `${url.host}${shortPathAndSearch === '/' ? '' : shortPathAndSearch}`;
    return shortenRemoteFleetMiddle(displayValue, maxLength);
  } catch {
    return shortenRemoteFleetMiddle(value, maxLength);
  }
}

export function isSensitiveRemoteFleetDisplayValue(value: string): boolean {
  return REMOTE_FLEET_SENSITIVE_VALUE_PATTERN.test(value);
}

export function safeRemoteFleetDisplayValue(value: string): string {
  return isSensitiveRemoteFleetDisplayValue(value) ? '••••••' : value;
}

export function safeRemoteFleetTitle(value: string): string | undefined {
  return isSensitiveRemoteFleetDisplayValue(value) ? undefined : value;
}

export function shortenRemoteFleetValue(value: string, maxLength = REMOTE_FLEET_SHORT_VALUE_LENGTH): string {
  const safeValue = safeRemoteFleetDisplayValue(value);
  if (safeValue !== value) return safeValue;
  const timestampValue = shortenRemoteFleetTimestamp(value);
  if (timestampValue !== value) return timestampValue;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return shortenRemoteFleetUrl(value, maxLength);
  return shortenRemoteFleetMiddle(value, maxLength);
}

export function remoteFleetStatusLabel(status: string | undefined, t: (key: string, options?: Record<string, unknown>) => string): string {
  return status ? t(`remoteFleet.statuses.${status}`, { defaultValue: status }) : t('remoteFleet.common.unknown', { defaultValue: '未知' });
}

export function RemoteFleetStatusBadge({ status }: { readonly status?: string }) {
  const { t } = useTranslation('common');
  return <Badge variant={remoteFleetStatusVariant(status)}>{remoteFleetStatusLabel(status, t)}</Badge>;
}

export function RemoteFleetProviderBadge({ label }: { readonly label: string }) {
  const displayLabel = safeRemoteFleetDisplayValue(label);
  return <Badge variant="outline" className="max-w-[8rem] truncate" title={safeRemoteFleetTitle(label)}>{displayLabel}</Badge>;
}

export function RemoteFleetEmptyPanel({
  icon,
  title,
  description,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="rounded-md border border-dashed border-border/70 px-4 py-5 text-center text-xs text-muted-foreground">
      <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
        {icon}
      </div>
      <div className="font-medium text-foreground">{title}</div>
      <p className="mx-auto mt-1 max-w-sm leading-relaxed">{description}</p>
    </div>
  );
}

export function RemoteFleetMonoValue({
  value,
  title,
  truncate = true,
  shorten = true,
  className,
}: {
  readonly value: string | number;
  readonly title?: string;
  readonly truncate?: boolean;
  readonly shorten?: boolean;
  readonly className?: string;
}) {
  const stringValue = String(value);
  const displayValue = shorten && typeof value === 'string'
    ? shortenRemoteFleetValue(value)
    : stringValue;

  return (
    <span
      className={cn(
        'min-w-0 max-w-full font-mono text-[11px] text-foreground/90',
        truncate ? 'truncate' : 'break-all',
        className,
      )}
      title={title ?? safeRemoteFleetTitle(stringValue)}
    >
      {displayValue}
    </span>
  );
}

function remoteFleetFieldDisplayValue(value: string | number, shorten: boolean): string {
  if (typeof value === 'number') return String(value);
  return shorten ? shortenRemoteFleetValue(value) : value;
}

export function RemoteFleetFieldRow({
  label,
  value,
  mono = false,
  truncate = true,
  shorten = true,
}: {
  readonly label: string;
  readonly value?: RemoteFleetFieldValue;
  readonly mono?: boolean;
  readonly truncate?: boolean;
  readonly shorten?: boolean;
}) {
  if (isRemoteFleetStringArray(value)) {
    if (value.length === 0) return null;
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <span className="shrink-0 font-medium text-foreground">{label}</span>
        {value.map((item) => (
          <Badge key={item} variant="outline" className="max-w-44" title={safeRemoteFleetTitle(item)}>
            {shorten ? shortenRemoteFleetValue(item, 28) : item}
          </Badge>
        ))}
      </div>
    );
  }
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const stringValue = String(value);
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
      <span className="shrink-0 font-medium text-foreground">{label}</span>
      {mono ? (
        <RemoteFleetMonoValue value={value} truncate={truncate} shorten={shorten} />
      ) : (
        <span className={cn('min-w-0', truncate ? 'truncate' : 'break-words')} title={safeRemoteFleetTitle(stringValue)}>
          {remoteFleetFieldDisplayValue(value, shorten)}
        </span>
      )}
    </div>
  );
}
