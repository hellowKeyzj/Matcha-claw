import type { ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Database,
  Loader2,
  MoreHorizontal,
  Network,
  Pencil,
  RefreshCw,
  Server,
  SquareTerminal,
  Trash2,
  Unplug,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type {
  RemoteFleetAgentSummary,
  RemoteFleetAuditEventSummary,
  RemoteFleetCapabilitySummary,
  RemoteFleetCommandSummary,
  RemoteFleetConnectionSummary,
  RemoteFleetEndpointSummary,
  RemoteFleetEnvironmentSummary,
  RemoteFleetLeaseSummary,
  RemoteFleetManagedResourceSummary,
  RemoteFleetNodeSummary,
  RemoteFleetRuntimeSummary,
  RemoteFleetTerminalSessionSummary,
} from '@/stores/remote-fleet';
import type { RemoteFleetTerminalDrawerTarget } from './remote-fleet-terminal-types';
import type {
  RemoteFleetConsoleSelection,
  RemoteFleetConsoleSelectionKind,
  RemoteFleetDetailTab,
} from './remote-fleet-console-types';
import {
  RemoteFleetEmptyPanel,
  RemoteFleetFieldRow,
  RemoteFleetMonoValue,
  RemoteFleetStatusBadge,
  remoteFleetStatusVariant,
  safeRemoteFleetDisplayValue,
} from './remote-fleet-console-shared';

type Translate = (key: string, options?: Record<string, unknown>) => string;
type RemoteFleetSelectionKind = NonNullable<RemoteFleetConsoleSelectionKind>;
type DetailFieldValue = string | number | readonly string[];

type DetailFact = {
  readonly label: string;
  readonly value?: DetailFieldValue;
  readonly mono?: boolean;
};

type DetailListItem = {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly status?: string;
  readonly meta?: ReactNode;
};

type DetailAction = {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly loading?: boolean;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly destructive?: boolean;
  readonly alwaysVisible?: boolean;
  readonly onAction: () => void | Promise<void>;
};

type BreadcrumbItem = {
  readonly kind: RemoteFleetSelectionKind;
  readonly id: string;
  readonly label: string;
  readonly current?: boolean;
};

type TerminalPresentation =
  | {
    readonly mode: 'target';
    readonly target: RemoteFleetTerminalDrawerTarget;
  }
  | {
    readonly mode: 'agent';
    readonly relatedRuntime?: RemoteFleetRuntimeSummary;
  }
  | {
    readonly mode: 'unavailable';
    readonly reason: string;
  };

type DetailViewModel = {
  readonly kind: RemoteFleetSelectionKind;
  readonly title: string;
  readonly description: string;
  readonly guidance?: string;
  readonly status?: string;
  readonly attentionReason?: string;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly actions: readonly DetailAction[];
  readonly facts: readonly DetailFact[];
  readonly associationCounts: readonly DetailFact[];
  readonly associatedEnvironmentItems?: readonly DetailListItem[];
  readonly capabilityItems: readonly DetailListItem[];
  readonly leaseItems: readonly DetailListItem[];
  readonly commandItems: readonly DetailListItem[];
  readonly auditItems: readonly DetailListItem[];
  readonly terminal: TerminalPresentation;
};

const REMOTE_FLEET_DETAIL_TABS: readonly RemoteFleetDetailTab[] = [
  'overview',
  'terminal',
  'commands',
  'audit',
  'capabilities',
];
const REMOTE_FLEET_DETAIL_ITEM_LIMIT = 6;
const REMOTE_FLEET_TERMINAL_ATTACH_OPERATION_ID = 'remoteFleet.terminal.attach';

export interface RemoteFleetDetailPanelProps {
  readonly selection: RemoteFleetConsoleSelection;
  readonly activeTab: RemoteFleetDetailTab;
  readonly onActiveTabChange: (tab: RemoteFleetDetailTab) => void;
  readonly showBackAction?: boolean;
  readonly onBackToIndex?: () => void;
  readonly loading: boolean;
  readonly mutatingAction: string | null;
  readonly connections: readonly RemoteFleetConnectionSummary[];
  readonly environments: readonly RemoteFleetEnvironmentSummary[];
  readonly managedResources: readonly RemoteFleetManagedResourceSummary[];
  readonly nodes: readonly RemoteFleetNodeSummary[];
  readonly agents: readonly RemoteFleetAgentSummary[];
  readonly runtimes: readonly RemoteFleetRuntimeSummary[];
  readonly endpoints: readonly RemoteFleetEndpointSummary[];
  readonly capabilities: readonly RemoteFleetCapabilitySummary[];
  readonly commands: readonly RemoteFleetCommandSummary[];
  readonly leases: readonly RemoteFleetLeaseSummary[];
  readonly terminalSessions: readonly RemoteFleetTerminalSessionSummary[];
  readonly auditEvents: readonly RemoteFleetAuditEventSummary[];
  readonly onProbe: (nodeId: string) => Promise<void>;
  readonly onProbeConnection: (connectionId: string) => Promise<void>;
  readonly onEditConnection?: (connection: RemoteFleetConnectionSummary) => void;
  readonly onRequestDeleteConnection: (connection: RemoteFleetConnectionSummary) => void;
  readonly onRemove: (nodeId: string) => Promise<void>;
  readonly onInstallAgent: (nodeId: string) => Promise<void>;
  readonly onDeployEnvironment: (environmentId: string) => Promise<void>;
  readonly onRequestDeleteEnvironment: (environment: RemoteFleetEnvironmentSummary, relatedManagedResources: readonly RemoteFleetManagedResourceSummary[]) => void;
  readonly onRevokeAgent: (agentId: string) => Promise<void>;
  readonly onStart: (runtime: RemoteFleetRuntimeSummary) => Promise<void>;
  readonly onStop: (runtime: RemoteFleetRuntimeSummary) => Promise<void>;
  readonly onOpenTerminal: (target: RemoteFleetTerminalDrawerTarget) => void;
  readonly onDrainEndpoint: (endpointId: string) => Promise<void>;
  readonly onRetireEndpoint: (endpointId: string) => Promise<void>;
  readonly onSyncCapabilities: (endpoint: RemoteFleetEndpointSummary) => Promise<void>;
}

function truncateDetailItems<T>(items: readonly T[]): readonly T[] {
  return items.slice(0, REMOTE_FLEET_DETAIL_ITEM_LIMIT);
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value != null;
}

function safeText(value: string): string {
  return safeRemoteFleetDisplayValue(value);
}

function safeAddressLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (url.host) {
      const path = url.pathname === '/' ? '' : url.pathname;
      return safeRemoteFleetDisplayValue(`${url.protocol}//${url.host}${path}`);
    }
  } catch {
    // Fall through to sanitize non-standard addresses without dropping their port.
  }

  const withoutCredentials = value
    .replace(/^((?:[a-z][a-z\d+.-]*:)?\/\/)[^/\s]*@/i, '$1')
    .replace(/^[^/\s]*@/, '');
  const safeValue = withoutCredentials.replace(/[?#].*$/, '');
  return safeRemoteFleetDisplayValue(safeValue);
}

function displayNameForConnection(connection: RemoteFleetConnectionSummary | undefined): string | undefined {
  if (!connection) return undefined;
  return safeText(connection.displayName || safeAddressLabel(connection.endpointUrl) || connection.id);
}

function displayNameForEnvironment(environment: RemoteFleetEnvironmentSummary | undefined): string | undefined {
  if (!environment) return undefined;
  return safeText(environment.displayName || environment.description || environment.id);
}

function displayNameForManagedResource(resource: RemoteFleetManagedResourceSummary | undefined): string | undefined {
  if (!resource) return undefined;
  return safeText(resource.displayName || resource.remoteResourceId || resource.id);
}

function isCustomConnection(connection: RemoteFleetConnectionSummary): boolean {
  return connection.connectionKind === 'custom' || connection.targetKind === 'custom';
}

function isCustomEnvironment(environment: RemoteFleetEnvironmentSummary): boolean {
  return environment.environmentKind === 'custom' || environment.targetKind === 'custom';
}

function auditEventConnectionId(event: RemoteFleetAuditEventSummary): string | undefined {
  return (event as RemoteFleetAuditEventSummary & { readonly connectionId?: string }).connectionId;
}

function auditEventEnvironmentId(event: RemoteFleetAuditEventSummary): string | undefined {
  return (event as RemoteFleetAuditEventSummary & { readonly environmentId?: string }).environmentId;
}

function auditEventManagedResourceId(event: RemoteFleetAuditEventSummary): string | undefined {
  return (event as RemoteFleetAuditEventSummary & { readonly managedResourceId?: string }).managedResourceId;
}

function terminalUnavailableReasonForTarget(
  input: {
    readonly status?: string;
    readonly targetKind?: string;
    readonly endpointId?: string;
    readonly endpointStatus?: string;
    readonly endpointCapabilities?: readonly RemoteFleetCapabilitySummary[];
  },
  t: Translate,
): string | undefined {
  if (input.status === 'disabled') {
    return t('remoteFleet.terminal.unavailable.disabled', { defaultValue: 'Terminal access is disabled for this target.' });
  }
  if (input.targetKind === 'custom') {
    if (!input.endpointId) {
      return t('remoteFleet.terminal.unavailable.customNeedsEndpoint', { defaultValue: 'This custom target needs a runtime endpoint before a terminal can be opened.' });
    }
    const hasTerminalCapability = (input.endpointCapabilities ?? []).some((capability) => (
      capability.status === 'current' && capability.operationIds?.includes(REMOTE_FLEET_TERMINAL_ATTACH_OPERATION_ID)
    ));
    if (!hasTerminalCapability) {
      return t('remoteFleet.terminal.unavailable.customMissingCapability', { defaultValue: 'This endpoint does not currently advertise terminal access.' });
    }
  }
  if (input.endpointStatus === 'draining' || input.endpointStatus === 'retired') {
    return t('remoteFleet.terminal.unavailable.endpointUnavailable', { defaultValue: 'Terminal access is unavailable while the endpoint is draining or retired.' });
  }
  return undefined;
}

function breadcrumbItem(
  kind: RemoteFleetSelectionKind,
  id: string,
  label: string,
  current = false,
): BreadcrumbItem {
  return { kind, id, label, current: current || undefined };
}

function detailTabLabel(tab: RemoteFleetDetailTab, t: Translate): string {
  switch (tab) {
    case 'overview':
      return t('remoteFleet.detail.tabs.overview', { defaultValue: 'Overview' });
    case 'terminal':
      return t('remoteFleet.detail.tabs.terminal', { defaultValue: 'Terminal' });
    case 'commands':
      return t('remoteFleet.detail.tabs.commands', { defaultValue: 'Commands' });
    case 'audit':
      return t('remoteFleet.detail.tabs.audit', { defaultValue: 'Audit' });
    case 'capabilities':
      return t('remoteFleet.detail.tabs.capabilities', { defaultValue: 'Capabilities' });
  }
}

function kindLabel(kind: RemoteFleetSelectionKind, t: Translate): string {
  return t(`remoteFleet.detail.kinds.${kind}`, { defaultValue: kind });
}

function capabilityListItems(
  capabilities: readonly RemoteFleetCapabilitySummary[],
  t: Translate,
): readonly DetailListItem[] {
  return capabilities.map((capability) => ({
    id: `${capability.nodeId ?? 'fleet'}:${capability.id}`,
    title: safeText(capability.displayName || capability.id),
    status: capability.status,
    meta: <RemoteFleetFieldRow label={t('remoteFleet.fields.operations', { defaultValue: 'Operations' })} value={capability.operationIds} />,
  }));
}

function commandListItems(
  commands: readonly RemoteFleetCommandSummary[],
  t: Translate,
  showMessage = false,
): readonly DetailListItem[] {
  return commands.map((command) => ({
    id: command.id,
    title: safeText(command.command || command.id),
    status: command.status,
    subtitle: command.updatedAt || command.createdAt || t('remoteFleet.detail.noTimestamp.command', { defaultValue: 'No command timestamp' }),
    meta: showMessage && command.message
      ? <RemoteFleetFieldRow label={t('remoteFleet.fields.message', { defaultValue: 'Message' })} value={safeRemoteFleetDisplayValue(command.message)} />
      : undefined,
  }));
}

function auditListItems(
  events: readonly RemoteFleetAuditEventSummary[],
  t: Translate,
  showMessage = false,
): readonly DetailListItem[] {
  return events.map((event) => ({
    id: event.id,
    title: safeText(event.eventName || event.id),
    subtitle: event.occurredAt || t('remoteFleet.detail.noTimestamp.event', { defaultValue: 'No event timestamp' }),
    meta: showMessage && event.message
      ? <RemoteFleetFieldRow label={t('remoteFleet.fields.message', { defaultValue: 'Message' })} value={safeRemoteFleetDisplayValue(event.message)} />
      : undefined,
  }));
}

function leaseListItems(leases: readonly RemoteFleetLeaseSummary[], t: Translate): readonly DetailListItem[] {
  return truncateDetailItems(leases).map((lease) => ({
    id: lease.id,
    title: safeText(lease.ownerId || lease.id),
    status: lease.status,
    subtitle: lease.expiresAt,
    meta: <RemoteFleetFieldRow label={t('remoteFleet.fields.owner', { defaultValue: 'Owner' })} value={lease.ownerKind} />,
  }));
}

function LoadingState({ t }: { readonly t: Translate }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="border-b border-border/70 px-5 py-5">
        <div className="h-3 w-40 animate-pulse rounded-full bg-muted" />
        <div className="mt-4 h-8 w-72 max-w-full animate-pulse rounded-lg bg-muted" />
        <p className="mt-3 text-sm text-muted-foreground">
          {t('remoteFleet.detail.loadingDescription', { defaultValue: 'Loading the selected Remote Fleet resource.' })}
        </p>
      </div>
      <div className="space-y-5 p-5">
        <div className="h-16 animate-pulse rounded-xl bg-muted/70" />
        <div className="h-28 animate-pulse rounded-xl bg-muted/60" />
        <div className="h-40 animate-pulse rounded-xl bg-muted/50" />
      </div>
    </section>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 items-start justify-center overflow-auto p-6">
      <div className="w-full max-w-lg">
        <RemoteFleetEmptyPanel icon={icon} title={title} description={description} />
      </div>
    </section>
  );
}

function DetailBreadcrumbs({
  items,
  showBackAction,
  onBackToIndex,
  t,
}: {
  readonly items: readonly BreadcrumbItem[];
  readonly showBackAction: boolean;
  readonly onBackToIndex?: () => void;
  readonly t: Translate;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      {showBackAction ? (
        <button
          type="button"
          disabled={!onBackToIndex}
          onClick={onBackToIndex}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-45"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('remoteFleet.detail.backToIndex', { defaultValue: 'Fleet index' })}
        </button>
      ) : null}
      {showBackAction && items.length > 0 ? <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-50" /> : null}
      <div className="flex min-w-0 items-center gap-1 overflow-hidden" aria-label={t('remoteFleet.detail.relationshipPath', { defaultValue: 'Resource relationship path' })}>
        {items.map((item, index) => (
          <div key={`${item.kind}:${item.id}`} className="flex min-w-0 items-center gap-1">
            {index > 0 ? <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-50" /> : null}
            <span
              className={cn('truncate', item.current && 'font-medium text-foreground')}
              aria-current={item.current ? 'page' : undefined}
              title={item.label}
            >
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActionIcon({ action }: { readonly action: DetailAction }) {
  if (action.loading) return <Loader2 className="h-4 w-4 animate-spin" />;
  return action.icon ?? null;
}

function PrimaryAction({ action }: { readonly action: DetailAction }) {
  return (
    <Button
      size="sm"
      disabled={action.disabled}
      onClick={() => void action.onAction()}
    >
      <ActionIcon action={action} />
      {action.label}
    </Button>
  );
}

function MoreActions({ actions, t }: { readonly actions: readonly DetailAction[]; readonly t: Translate }) {
  if (actions.length === 0) return null;
  const regularActions = actions.filter((action) => !action.destructive);
  const destructiveActions = actions.filter((action) => action.destructive);

  const renderItem = (action: DetailAction) => (
    <DropdownMenu.Item
      key={action.id}
      disabled={action.disabled}
      onSelect={() => void action.onAction()}
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
        action.destructive && 'text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive',
      )}
    >
      <ActionIcon action={action} />
      <span className="min-w-0 flex-1 truncate">{action.label}</span>
    </DropdownMenu.Item>
  );

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="outline" size="sm" aria-label={t('remoteFleet.detail.moreActions', { defaultValue: 'More actions' })}>
          <MoreHorizontal className="h-4 w-4" />
          {t('remoteFleet.detail.moreActions', { defaultValue: 'More actions' })}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 min-w-52 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-elevated"
        >
          {regularActions.map(renderItem)}
          {regularActions.length > 0 && destructiveActions.length > 0 ? (
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
          ) : null}
          {destructiveActions.map(renderItem)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function DetailTabs({
  activeTab,
  onActiveTabChange,
  t,
}: {
  readonly activeTab: RemoteFleetDetailTab;
  readonly onActiveTabChange: (tab: RemoteFleetDetailTab) => void;
  readonly t: Translate;
}) {
  return (
    <div className="flex shrink-0 gap-5 overflow-x-auto border-b border-border/70 px-5" role="tablist" aria-label={t('remoteFleet.detail.title', { defaultValue: 'Resource detail' })}>
      {REMOTE_FLEET_DETAIL_TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={activeTab === tab}
          onClick={() => onActiveTabChange(tab)}
          className={cn(
            '-mb-px whitespace-nowrap border-b-2 border-transparent px-0.5 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            activeTab === tab && 'border-foreground text-foreground',
          )}
        >
          {detailTabLabel(tab, t)}
        </button>
      ))}
    </div>
  );
}

function DetailSection({
  title,
  description,
  count,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly count?: number;
  readonly children: ReactNode;
}) {
  return (
    <section className="border-b border-border/70 py-5 last:border-b-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description ? <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
        </div>
        {count !== undefined ? <Badge variant="outline">{count}</Badge> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function AttentionSummary({ status, reason, t }: { readonly status?: string; readonly reason?: string; readonly t: Translate }) {
  const isDestructive = remoteFleetStatusVariant(status) === 'destructive';
  const visibleReason = reason ? safeRemoteFleetDisplayValue(reason) : undefined;

  return (
    <div className={cn(
      'flex items-start gap-3 rounded-xl border px-4 py-3',
      isDestructive ? 'border-destructive/35 bg-destructive/10' : 'border-border/70 bg-muted/20',
    )}>
      <AlertTriangle className={cn('mt-0.5 h-4 w-4 shrink-0', isDestructive ? 'text-destructive' : 'text-muted-foreground')} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {t('remoteFleet.detail.attention', { defaultValue: 'Attention' })}
          </span>
          <RemoteFleetStatusBadge status={status} />
        </div>
        <p className="mt-1 break-words text-sm text-muted-foreground">
          {visibleReason ?? t('remoteFleet.detail.noAttentionReason', { defaultValue: 'No attention reason is currently reported.' })}
        </p>
      </div>
    </div>
  );
}

function Facts({ facts }: { readonly facts: readonly DetailFact[] }) {
  const visibleFacts = facts.filter((fact) => fact.value !== undefined && fact.value !== null && fact.value !== '');
  return (
    <div className="grid gap-x-8 gap-y-2 md:grid-cols-2">
      {visibleFacts.map((fact) => (
        <RemoteFleetFieldRow key={fact.label} label={fact.label} value={fact.value} mono={fact.mono} />
      ))}
    </div>
  );
}

function AssociationCounts({ counts }: { readonly counts: readonly DetailFact[] }) {
  return (
    <dl className="divide-y divide-border/70 border-y border-border/70">
      {counts.map((item) => (
        <div key={item.label} className="flex items-center justify-between gap-4 py-2.5 text-sm">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="font-medium tabular-nums text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailList({ items, emptyMessage, emptyIcon }: { readonly items: readonly DetailListItem[]; readonly emptyMessage: string; readonly emptyIcon: ReactNode }) {
  if (items.length === 0) {
    return <RemoteFleetEmptyPanel icon={emptyIcon} title={emptyMessage} description={emptyMessage} />;
  }

  return (
    <div className="divide-y divide-border/70 border-y border-border/70">
      {items.map((item) => (
        <div key={item.id} className="grid gap-3 py-3 md:grid-cols-[minmax(0,1fr)_minmax(8rem,auto)] md:items-start">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 truncate text-sm font-medium text-foreground">{item.title}</span>
              {item.status ? <RemoteFleetStatusBadge status={item.status} /> : null}
            </div>
            {item.subtitle ? <p className="mt-1 truncate text-xs text-muted-foreground">{safeText(item.subtitle)}</p> : null}
            {item.meta ? <div className="mt-2 space-y-1">{item.meta}</div> : null}
          </div>
          <RemoteFleetMonoValue value={item.id} className="md:justify-self-end" />
        </div>
      ))}
    </div>
  );
}

function TerminalTab({
  terminal,
  mutatingAction,
  onOpenTerminal,
  t,
}: {
  readonly terminal: TerminalPresentation;
  readonly mutatingAction: string | null;
  readonly onOpenTerminal: RemoteFleetDetailPanelProps['onOpenTerminal'];
  readonly t: Translate;
}) {
  if (terminal.mode === 'agent') {
    const relatedRuntime = terminal.relatedRuntime;
    return (
      <DetailSection
        title={t('remoteFleet.detail.tabs.terminal', { defaultValue: 'Terminal' })}
        description={t('remoteFleet.detail.agentTerminalUnavailable', { defaultValue: 'Terminal access is not opened directly from an agent. Select the related runtime in Resource Index to use its terminal target.' })}
      >
        <div className="flex flex-col gap-4 rounded-xl border border-dashed border-border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <SquareTerminal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {t('remoteFleet.detail.agentTerminalUnavailable', { defaultValue: 'Terminal access is not opened directly from an agent. Select the related runtime in Resource Index to use its terminal target.' })}
            </p>
          </div>
          {relatedRuntime ? (
            <p className="shrink-0 text-xs text-muted-foreground">
              {safeText(relatedRuntime.displayName || relatedRuntime.id)}
            </p>
          ) : null}
        </div>
      </DetailSection>
    );
  }

  if (terminal.mode === 'unavailable') {
    return (
      <DetailSection
        title={t('remoteFleet.detail.tabs.terminal', { defaultValue: 'Terminal' })}
        description={t('remoteFleet.terminal.description', { defaultValue: 'Open an interactive terminal for a supported remote target.' })}
      >
        <div className="flex items-start gap-3 rounded-xl border border-dashed border-border bg-muted/20 p-4">
          <SquareTerminal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{terminal.reason}</p>
        </div>
      </DetailSection>
    );
  }

  const unavailableReason = terminal.target.unavailableReason;
  return (
    <DetailSection
      title={t('remoteFleet.detail.tabs.terminal', { defaultValue: 'Terminal' })}
      description={terminal.target.description ?? t('remoteFleet.terminal.description', { defaultValue: 'Open an interactive terminal for this target.' })}
    >
      <div className="flex flex-col gap-4 rounded-xl border border-dashed border-border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SquareTerminal className="h-4 w-4 text-muted-foreground" />
            <span className="truncate text-sm font-medium text-foreground">{safeText(terminal.target.title)}</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {unavailableReason ?? t('remoteFleet.terminal.description', { defaultValue: 'Open an interactive terminal for this target.' })}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={mutatingAction !== null || Boolean(unavailableReason)}
          title={unavailableReason}
          onClick={() => onOpenTerminal(terminal.target)}
        >
          <SquareTerminal className="h-4 w-4" />
          {t('remoteFleet.detail.actions.openTerminal', { defaultValue: 'Open terminal' })}
        </Button>
      </div>
    </DetailSection>
  );
}

export function RemoteFleetDetailPanel({
  selection,
  activeTab,
  onActiveTabChange,
  showBackAction = false,
  onBackToIndex,
  loading,
  mutatingAction,
  connections,
  environments,
  managedResources,
  nodes,
  agents,
  runtimes,
  endpoints,
  capabilities,
  commands,
  leases,
  terminalSessions,
  auditEvents,
  onProbe,
  onProbeConnection,
  onEditConnection,
  onRequestDeleteConnection,
  onRemove,
  onInstallAgent,
  onDeployEnvironment,
  onRequestDeleteEnvironment,
  onRevokeAgent,
  onStart,
  onStop,
  onOpenTerminal,
  onDrainEndpoint,
  onRetireEndpoint,
  onSyncCapabilities,
}: RemoteFleetDetailPanelProps) {
  const { t } = useTranslation('common');
  const translate: Translate = t;
  const inventoryIsEmpty = connections.length === 0
    && environments.length === 0
    && managedResources.length === 0
    && nodes.length === 0
    && agents.length === 0
    && runtimes.length === 0
    && endpoints.length === 0;

  if (loading && !selection.kind && inventoryIsEmpty) {
    return <LoadingState t={translate} />;
  }

  if (!selection.kind || !selection.id) {
    return (
      <EmptyState
        icon={<Server className="h-5 w-5" />}
        title={translate('remoteFleet.detail.emptyTitle', { defaultValue: 'Select a Remote Fleet resource' })}
        description={translate('remoteFleet.detail.emptyHint', { defaultValue: 'Choose a connection, environment, resource, node, agent, runtime, or endpoint from the fleet index.' })}
      />
    );
  }

  const allActionsDisabled = mutatingAction !== null;
  const customExternalRuntimeGuidance = translate('remoteFleet.detail.customExternalRuntimeGuidance', { defaultValue: 'Custom targets are managed by an external runtime, so connection checks and environment deployment are unavailable here. Select a related runtime or endpoint in Resource Index to review status and advertised capabilities.' });
  let detail: DetailViewModel | undefined;

  if (selection.kind === 'connection') {
    const connection = connections.find((item) => item.id === selection.id);
    if (connection) {
      const relatedEnvironments = environments.filter((environment) => environment.connectionId === connection.id);
      const relatedEnvironmentIds = new Set(relatedEnvironments.map((environment) => environment.id));
      const relatedManagedResources = managedResources.filter((resource) => resource.connectionId === connection.id || relatedEnvironmentIds.has(resource.environmentId));
      const relatedNodes = nodes.filter((node) => node.connectionId === connection.id);
      const relatedNodeIds = new Set(relatedNodes.map((node) => node.id));
      const relatedRuntimes = runtimes.filter((runtime) => runtime.connectionId === connection.id || Boolean(runtime.nodeId && relatedNodeIds.has(runtime.nodeId)));
      const relatedRuntimeIds = new Set(relatedRuntimes.map((runtime) => runtime.id));
      const relatedEndpoints = endpoints.filter((endpoint) => endpoint.connectionId === connection.id || Boolean(endpoint.nodeId && relatedNodeIds.has(endpoint.nodeId)) || Boolean(endpoint.runtimeId && relatedRuntimeIds.has(endpoint.runtimeId)));
      const relatedEndpointIds = new Set(relatedEndpoints.map((endpoint) => endpoint.id));
      const relatedCapabilities = capabilities.filter((capability) => (
        capability.connectionId === connection.id
        || Boolean(capability.nodeId && relatedNodeIds.has(capability.nodeId))
        || Boolean(capability.runtimeId && relatedRuntimeIds.has(capability.runtimeId))
        || Boolean(capability.endpointId && relatedEndpointIds.has(capability.endpointId))
      ));
      const relatedCommands = commands.filter((command) => command.connectionId === connection.id);
      const relatedAuditEvents = auditEvents.filter((event) => auditEventConnectionId(event) === connection.id);
      const probingConnection = mutatingAction === `probe-connection:${connection.id}`;
      const customConnection = isCustomConnection(connection);
      const terminalNode = relatedNodes.length === 1 ? relatedNodes[0] : undefined;
      const terminal = terminalNode
        ? {
          mode: 'target' as const,
          target: {
            kind: 'node' as const,
            id: terminalNode.id,
            title: translate('remoteFleet.terminal.targetTitle.node', { defaultValue: `Terminal for ${terminalNode.displayName || terminalNode.id}`, name: terminalNode.displayName || terminalNode.id }),
            description: translate('remoteFleet.terminal.targetDescription.node', { defaultValue: 'Connect to the selected remote node.' }),
            unavailableReason: terminalUnavailableReasonForTarget({ status: terminalNode.status, targetKind: terminalNode.targetKind }, translate),
            openTarget: { nodeId: terminalNode.id },
          },
        }
        : {
          mode: 'unavailable' as const,
          reason: relatedNodes.length > 1
            ? translate('remoteFleet.detail.connectionTerminalNeedsNodeSelection', { defaultValue: 'This connection has multiple nodes. Select a Node in Resource Index, then open its terminal.' })
            : translate('remoteFleet.detail.connectionTerminalUnavailable', { defaultValue: 'This connection does not currently have a node terminal target.' }),
        };

      detail = {
        kind: 'connection',
        title: displayNameForConnection(connection) || safeText(connection.id),
        description: safeText(connection.description || translate('remoteFleet.detail.descriptions.connection', { defaultValue: 'Remote connection and its projected resources.' })),
        guidance: customConnection
          ? customExternalRuntimeGuidance
          : relatedEnvironments.length > 0 || relatedManagedResources.length > 0 || relatedNodes.length > 0 || relatedRuntimes.length > 0 || relatedEndpoints.length > 0 || relatedCapabilities.length > 0
            ? translate('remoteFleet.detail.connectionDeleteBlocked', { defaultValue: 'Delete the related environments and resources before deleting this connection.' })
            : undefined,
        status: connection.status,
        attentionReason: connection.reason,
        breadcrumbs: [breadcrumbItem('connection', connection.id, displayNameForConnection(connection) || safeText(connection.id), true)],
        actions: [
          ...(customConnection
            ? []
            : [
              {
                id: 'probe-connection',
                label: translate('remoteFleet.detail.actions.probeConnection', { defaultValue: 'Check connection' }),
                icon: <RefreshCw className="h-4 w-4" />,
                loading: probingConnection,
                disabled: allActionsDisabled,
                onAction: () => onProbeConnection(connection.id),
              },
              ...(onEditConnection
                ? [{
                  id: 'edit-connection',
                  label: translate('remoteFleet.detail.actions.editConnection'),
                  icon: <Pencil className="h-4 w-4" />,
                  disabled: allActionsDisabled,
                  alwaysVisible: true,
                  onAction: () => onEditConnection(connection),
                }]
                : []),
            ]),
          {
            id: 'delete-connection',
            label: translate('remoteFleet.detail.actions.deleteConnection', { defaultValue: 'Delete connection' }),
            icon: <Trash2 className="h-4 w-4" />,
            disabled: allActionsDisabled || relatedEnvironments.length > 0 || relatedManagedResources.length > 0 || relatedNodes.length > 0 || relatedRuntimes.length > 0 || relatedEndpoints.length > 0 || relatedCapabilities.length > 0 || terminalSessions.some((session) => (
              session.status !== 'closed'
              && session.status !== 'failed'
              && session.status !== 'expired'
              && (
                relatedNodes.some((node) => node.id === session.nodeId)
                || Boolean(session.runtimeId && relatedRuntimes.some((runtime) => runtime.id === session.runtimeId))
                || Boolean(session.endpointId && relatedEndpoints.some((endpoint) => endpoint.id === session.endpointId))
              )
            )),
            destructive: true,
            onAction: () => onRequestDeleteConnection(connection),
          },
        ],
        facts: [
          { label: translate('remoteFleet.fields.id', { defaultValue: 'ID' }), value: connection.id, mono: true },
          { label: translate('remoteFleet.fields.endpoint', { defaultValue: 'Endpoint' }), value: safeAddressLabel(connection.endpointUrl), mono: true },
          { label: translate('remoteFleet.fields.kind', { defaultValue: 'Kind' }), value: connection.connectionKind ?? connection.targetKind },
          { label: translate('remoteFleet.fields.labels', { defaultValue: 'Labels' }), value: connection.labels },
          { label: translate('remoteFleet.fields.lastSeen', { defaultValue: 'Last seen' }), value: connection.lastSeenAt },
          { label: translate('remoteFleet.fields.created', { defaultValue: 'Created' }), value: connection.createdAt },
          { label: translate('remoteFleet.fields.updated', { defaultValue: 'Updated' }), value: connection.updatedAt },
        ],
        associationCounts: [
          { label: translate('remoteFleet.detail.metrics.resources', { defaultValue: 'Resources' }), value: relatedManagedResources.length },
          { label: translate('remoteFleet.detail.metrics.runtimes', { defaultValue: 'Runtimes' }), value: relatedRuntimes.length },
          { label: translate('remoteFleet.detail.metrics.endpoints', { defaultValue: 'Endpoints' }), value: relatedEndpoints.length },
        ],
        associatedEnvironmentItems: relatedEnvironments.map((environment) => {
          const deploying = mutatingAction === `deploy-environment:${environment.id}`;
          const customEnvironment = isCustomEnvironment(environment);
          return {
            id: environment.id,
            title: displayNameForEnvironment(environment) || safeText(environment.id),
            subtitle: environment.environmentKind ?? environment.targetKind,
            status: environment.status,
            meta: customEnvironment
              ? <p className="text-xs leading-relaxed text-muted-foreground">{customExternalRuntimeGuidance}</p>
              : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={allActionsDisabled}
                  onClick={() => void onDeployEnvironment(environment.id)}
                >
                  {deploying ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleDot className="h-4 w-4" />}
                  {translate('remoteFleet.detail.actions.deployEnvironment', { defaultValue: 'Deploy environment' })}
                </Button>
              ),
          };
        }),
        capabilityItems: capabilityListItems(relatedCapabilities, translate),
        leaseItems: [],
        commandItems: commandListItems(relatedCommands, translate, true),
        auditItems: auditListItems(relatedAuditEvents, translate, true),
        terminal,
      };
    }
  } else if (selection.kind === 'environment') {
    const environment = environments.find((item) => item.id === selection.id);
    if (environment) {
      const relatedConnection = connections.find((connection) => connection.id === environment.connectionId);
      const relatedManagedResources = managedResources.filter((resource) => resource.environmentId === environment.id || environment.managedResourceIds?.includes(resource.id));
      const relatedResourceIds = new Set(relatedManagedResources.map((resource) => resource.id));
      const relatedNodes = nodes.filter((node) => node.environmentId === environment.id || Boolean(node.managedResourceId && relatedResourceIds.has(node.managedResourceId)));
      const relatedNodeIds = new Set(relatedNodes.map((node) => node.id));
      const relatedRuntimes = runtimes.filter((runtime) => runtime.environmentId === environment.id || Boolean(runtime.nodeId && relatedNodeIds.has(runtime.nodeId)));
      const relatedRuntimeIds = new Set(relatedRuntimes.map((runtime) => runtime.id));
      const relatedEndpoints = endpoints.filter((endpoint) => endpoint.environmentId === environment.id || Boolean(endpoint.nodeId && relatedNodeIds.has(endpoint.nodeId)) || Boolean(endpoint.runtimeId && relatedRuntimeIds.has(endpoint.runtimeId)));
      const relatedEndpointIds = new Set(relatedEndpoints.map((endpoint) => endpoint.id));
      const relatedCapabilities = capabilities.filter((capability) => (
        capability.environmentId === environment.id
        || Boolean(capability.managedResourceId && relatedResourceIds.has(capability.managedResourceId))
        || Boolean(capability.nodeId && relatedNodeIds.has(capability.nodeId))
        || Boolean(capability.runtimeId && relatedRuntimeIds.has(capability.runtimeId))
        || Boolean(capability.endpointId && relatedEndpointIds.has(capability.endpointId))
      ));
      const relatedCommands = commands.filter((command) => command.environmentId === environment.id || Boolean(command.managedResourceId && relatedResourceIds.has(command.managedResourceId)));
      const relatedAuditEvents = auditEvents.filter((event) => {
        const managedResourceId = auditEventManagedResourceId(event);
        return auditEventEnvironmentId(event) === environment.id || Boolean(managedResourceId && relatedResourceIds.has(managedResourceId));
      });
      const deploying = mutatingAction === `deploy-environment:${environment.id}`;
      const deleting = mutatingAction === `delete-environment:${environment.id}`;
      const customEnvironment = isCustomEnvironment(environment);
      const environmentLabel = displayNameForEnvironment(environment) || safeText(environment.id);

      detail = {
        kind: 'environment',
        title: environmentLabel,
        description: safeText(environment.description || translate('remoteFleet.detail.descriptions.environment', { defaultValue: 'Deployment environment and the resources projected beneath it.' })),
        guidance: customEnvironment ? customExternalRuntimeGuidance : undefined,
        status: environment.status,
        attentionReason: environment.reason,
        breadcrumbs: [
          relatedConnection ? breadcrumbItem('connection', relatedConnection.id, displayNameForConnection(relatedConnection) || safeText(relatedConnection.id)) : null,
          breadcrumbItem('environment', environment.id, environmentLabel, true),
        ].filter(isDefined),
        actions: [
          customEnvironment ? null : {
            id: 'deploy-environment',
            label: translate('remoteFleet.detail.actions.deployEnvironment', { defaultValue: 'Deploy environment' }),
            icon: <CircleDot className="h-4 w-4" />,
            loading: deploying,
            disabled: allActionsDisabled,
            onAction: () => onDeployEnvironment(environment.id),
          },
          {
            id: 'delete-environment',
            label: translate('remoteFleet.detail.actions.deleteEnvironment', { defaultValue: 'Delete environment' }),
            icon: <Trash2 className="h-4 w-4" />,
            loading: deleting,
            disabled: allActionsDisabled,
            destructive: true,
            onAction: () => onRequestDeleteEnvironment(environment, relatedManagedResources),
          },
        ].filter(isDefined),
        facts: [
          { label: translate('remoteFleet.fields.id', { defaultValue: 'ID' }), value: environment.id, mono: true },
          { label: translate('remoteFleet.fields.connection', { defaultValue: 'Connection' }), value: displayNameForConnection(relatedConnection) },
          { label: translate('remoteFleet.fields.kind', { defaultValue: 'Kind' }), value: environment.environmentKind ?? environment.targetKind },
          { label: translate('remoteFleet.fields.labels', { defaultValue: 'Labels' }), value: environment.labels },
          { label: translate('remoteFleet.fields.created', { defaultValue: 'Created' }), value: environment.createdAt },
          { label: translate('remoteFleet.fields.updated', { defaultValue: 'Updated' }), value: environment.updatedAt },
        ],
        associationCounts: [
          { label: translate('remoteFleet.detail.metrics.resources', { defaultValue: 'Resources' }), value: relatedManagedResources.length },
          { label: translate('remoteFleet.detail.metrics.runtimes', { defaultValue: 'Runtimes' }), value: relatedRuntimes.length },
          { label: translate('remoteFleet.detail.metrics.endpoints', { defaultValue: 'Endpoints' }), value: relatedEndpoints.length },
          { label: translate('remoteFleet.detail.metrics.capabilities', { defaultValue: 'Capabilities' }), value: relatedCapabilities.length },
        ],
        capabilityItems: capabilityListItems(relatedCapabilities, translate),
        leaseItems: [],
        commandItems: commandListItems(relatedCommands, translate, true),
        auditItems: auditListItems(relatedAuditEvents, translate, true),
        terminal: {
          mode: 'unavailable',
          reason: translate('remoteFleet.detail.environmentTerminalUnavailable', { defaultValue: 'Environments do not expose a terminal target. Select a related node, runtime, or endpoint in Resource Index instead.' }),
        },
      };
    }
  } else if (selection.kind === 'managedResource') {
    const resource = managedResources.find((item) => item.id === selection.id);
    if (resource) {
      const relatedConnection = connections.find((connection) => connection.id === resource.connectionId);
      const relatedEnvironment = environments.find((environment) => environment.id === resource.environmentId);
      const relatedAgents = agents.filter((agent) => agent.managedResourceId === resource.id || agent.nodeId === resource.nodeId);
      const relatedRuntimes = runtimes.filter((runtime) => runtime.managedResourceId === resource.id || runtime.nodeId === resource.nodeId);
      const relatedRuntimeIds = new Set(relatedRuntimes.map((runtime) => runtime.id));
      const relatedEndpoints = endpoints.filter((endpoint) => endpoint.managedResourceId === resource.id || endpoint.nodeId === resource.nodeId || Boolean(endpoint.runtimeId && relatedRuntimeIds.has(endpoint.runtimeId)));
      const relatedEndpointIds = new Set(relatedEndpoints.map((endpoint) => endpoint.id));
      const relatedCapabilities = capabilities.filter((capability) => (
        capability.managedResourceId === resource.id
        || capability.nodeId === resource.nodeId
        || Boolean(capability.runtimeId && relatedRuntimeIds.has(capability.runtimeId))
        || Boolean(capability.endpointId && relatedEndpointIds.has(capability.endpointId))
      ));
      const relatedCommands = commands.filter((command) => command.managedResourceId === resource.id);
      const relatedAuditEvents = auditEvents.filter((event) => auditEventManagedResourceId(event) === resource.id);
      const resourceLabel = displayNameForManagedResource(resource) || safeText(resource.id);

      detail = {
        kind: 'managedResource',
        title: resourceLabel,
        description: safeText(resource.reason || translate('remoteFleet.detail.descriptions.managedResource', { defaultValue: 'Provider-managed remote resource.' })),
        status: resource.status,
        attentionReason: resource.reason,
        breadcrumbs: [
          relatedConnection ? breadcrumbItem('connection', relatedConnection.id, displayNameForConnection(relatedConnection) || safeText(relatedConnection.id)) : null,
          relatedEnvironment ? breadcrumbItem('environment', relatedEnvironment.id, displayNameForEnvironment(relatedEnvironment) || safeText(relatedEnvironment.id)) : null,
          breadcrumbItem('managedResource', resource.id, resourceLabel, true),
        ].filter(isDefined),
        actions: [],
        facts: [
          { label: translate('remoteFleet.fields.id', { defaultValue: 'ID' }), value: resource.id, mono: true },
          { label: translate('remoteFleet.fields.connection', { defaultValue: 'Connection' }), value: displayNameForConnection(relatedConnection) },
          { label: translate('remoteFleet.fields.environment', { defaultValue: 'Environment' }), value: displayNameForEnvironment(relatedEnvironment) },
          { label: translate('remoteFleet.fields.provider', { defaultValue: 'Provider' }), value: resource.providerKind },
          { label: translate('remoteFleet.fields.kind', { defaultValue: 'Kind' }), value: resource.resourceKind },
          { label: translate('remoteFleet.fields.owner', { defaultValue: 'Owner' }), value: resource.ownership },
          { label: translate('remoteFleet.fields.cleanupPolicy', { defaultValue: 'Cleanup policy' }), value: resource.cleanupPolicy },
          { label: translate('remoteFleet.fields.labels', { defaultValue: 'Labels' }), value: resource.labels },
          { label: translate('remoteFleet.fields.lastObserved', { defaultValue: 'Last observed' }), value: resource.lastObservedAt },
        ],
        associationCounts: [
          { label: translate('remoteFleet.detail.metrics.agents', { defaultValue: 'Agents' }), value: relatedAgents.length },
          { label: translate('remoteFleet.detail.metrics.runtimes', { defaultValue: 'Runtimes' }), value: relatedRuntimes.length },
          { label: translate('remoteFleet.detail.metrics.endpoints', { defaultValue: 'Endpoints' }), value: relatedEndpoints.length },
          { label: translate('remoteFleet.detail.metrics.capabilities', { defaultValue: 'Capabilities' }), value: relatedCapabilities.length },
        ],
        capabilityItems: capabilityListItems(relatedCapabilities, translate),
        leaseItems: [],
        commandItems: commandListItems(relatedCommands, translate, true),
        auditItems: auditListItems(relatedAuditEvents, translate, true),
        terminal: {
          mode: 'unavailable',
          reason: translate('remoteFleet.detail.managedResourceTerminalUnavailable', { defaultValue: 'Managed resources do not expose a terminal target. Select the projected node, runtime, or endpoint in Resource Index instead.' }),
        },
      };
    }
  } else if (selection.kind === 'node') {
    const node = nodes.find((item) => item.id === selection.id);
    if (node) {
      const relatedConnection = node.connectionId ? connections.find((connection) => connection.id === node.connectionId) : undefined;
      const relatedEnvironment = node.environmentId ? environments.find((environment) => environment.id === node.environmentId) : undefined;
      const relatedManagedResource = node.managedResourceId ? managedResources.find((resource) => resource.id === node.managedResourceId) : undefined;
      const relatedAgents = agents.filter((agent) => agent.nodeId === node.id);
      const relatedRuntimes = runtimes.filter((runtime) => runtime.nodeId === node.id);
      const relatedEndpoints = endpoints.filter((endpoint) => endpoint.nodeId === node.id);
      const relatedRuntimeIds = new Set(relatedRuntimes.map((runtime) => runtime.id));
      const relatedEndpointIds = new Set(relatedEndpoints.map((endpoint) => endpoint.id));
      const relatedCapabilities = capabilities.filter((capability) => (
        capability.nodeId === node.id
        || Boolean(capability.runtimeId && relatedRuntimeIds.has(capability.runtimeId))
        || Boolean(capability.endpointId && relatedEndpointIds.has(capability.endpointId))
      ));
      const relatedCommands = commands.filter((command) => command.nodeId === node.id);
      const relatedAuditEvents = auditEvents.filter((event) => event.nodeId === node.id);
      const relatedLeases = leases.filter((lease) => Boolean(lease.endpointId && relatedEndpointIds.has(lease.endpointId)));
      const probing = mutatingAction === `probe:${node.id}`;
      const removing = mutatingAction === `remove-node:${node.id}`;
      const installingAgent = mutatingAction === `install-agent:${node.id}`;
      const canInstallAgent = node.targetKind !== 'container' && node.targetKind !== 'k8s-pod';
      const nodeLabel = safeText(node.displayName || node.id);
      const terminalTarget: RemoteFleetTerminalDrawerTarget = {
        kind: 'node',
        id: node.id,
        title: translate('remoteFleet.terminal.targetTitle.node', { defaultValue: `Terminal for ${node.displayName || node.id}`, name: node.displayName || node.id }),
        description: translate('remoteFleet.terminal.targetDescription.node', { defaultValue: 'Connect to the selected remote node.' }),
        unavailableReason: terminalUnavailableReasonForTarget({ status: node.status, targetKind: node.targetKind }, translate),
        openTarget: { nodeId: node.id },
      };

      detail = {
        kind: 'node',
        title: nodeLabel,
        description: safeText(node.description || translate('remoteFleet.detail.descriptions.node', { defaultValue: 'Remote node managed by the fleet control plane.' })),
        status: node.status,
        attentionReason: node.reason,
        breadcrumbs: [
          relatedConnection ? breadcrumbItem('connection', relatedConnection.id, displayNameForConnection(relatedConnection) || safeText(relatedConnection.id)) : null,
          relatedEnvironment ? breadcrumbItem('environment', relatedEnvironment.id, displayNameForEnvironment(relatedEnvironment) || safeText(relatedEnvironment.id)) : null,
          relatedManagedResource ? breadcrumbItem('managedResource', relatedManagedResource.id, displayNameForManagedResource(relatedManagedResource) || safeText(relatedManagedResource.id)) : null,
          breadcrumbItem('node', node.id, nodeLabel, true),
        ].filter(isDefined),
        actions: [
          {
            id: 'probe-node',
            label: translate('remoteFleet.detail.actions.probe', { defaultValue: 'Probe node' }),
            icon: <RefreshCw className="h-4 w-4" />,
            loading: probing,
            disabled: allActionsDisabled,
            onAction: () => onProbe(node.id),
          },
          canInstallAgent ? {
            id: 'install-agent',
            label: translate('remoteFleet.detail.actions.installAgent', { defaultValue: 'Install agent' }),
            icon: <Bot className="h-4 w-4" />,
            loading: installingAgent,
            disabled: allActionsDisabled,
            onAction: () => onInstallAgent(node.id),
          } : null,
          {
            id: 'remove-node',
            label: translate('remoteFleet.detail.actions.remove', { defaultValue: 'Remove node' }),
            icon: <Trash2 className="h-4 w-4" />,
            loading: removing,
            disabled: allActionsDisabled,
            destructive: true,
            onAction: () => onRemove(node.id),
          },
        ].filter(isDefined),
        facts: [
          { label: translate('remoteFleet.fields.id', { defaultValue: 'ID' }), value: node.id, mono: true },
          { label: translate('remoteFleet.fields.kind', { defaultValue: 'Kind' }), value: node.targetKind },
          { label: translate('remoteFleet.fields.endpoint', { defaultValue: 'Endpoint' }), value: safeAddressLabel(node.endpointUrl), mono: true },
          { label: translate('remoteFleet.fields.labels', { defaultValue: 'Labels' }), value: node.labels },
          { label: translate('remoteFleet.fields.lastSeen', { defaultValue: 'Last seen' }), value: node.lastSeenAt },
        ],
        associationCounts: [
          { label: translate('remoteFleet.detail.metrics.agents', { defaultValue: 'Agents' }), value: relatedAgents.length },
          { label: translate('remoteFleet.detail.metrics.runtimes', { defaultValue: 'Runtimes' }), value: relatedRuntimes.length },
          { label: translate('remoteFleet.detail.metrics.endpoints', { defaultValue: 'Endpoints' }), value: relatedEndpoints.length },
          { label: translate('remoteFleet.detail.metrics.capabilities', { defaultValue: 'Capabilities' }), value: relatedCapabilities.length },
        ],
        capabilityItems: capabilityListItems(relatedCapabilities, translate),
        leaseItems: leaseListItems(relatedLeases, translate),
        commandItems: commandListItems(relatedCommands, translate, true),
        auditItems: auditListItems(relatedAuditEvents, translate, true),
        terminal: { mode: 'target', target: terminalTarget },
      };
    }
  } else if (selection.kind === 'agent') {
    const agent = agents.find((item) => item.id === selection.id);
    if (agent) {
      const relatedNode = agent.nodeId ? nodes.find((node) => node.id === agent.nodeId) : undefined;
      const relatedRuntimes = runtimes.filter((runtime) => runtime.agentId === agent.id || runtime.id === agent.runtimeId || Boolean(agent.nodeId && runtime.nodeId === agent.nodeId));
      const relatedRuntimeIds = new Set(relatedRuntimes.map((runtime) => runtime.id));
      const relatedEndpoints = endpoints.filter((endpoint) => Boolean(endpoint.runtimeId && relatedRuntimeIds.has(endpoint.runtimeId)) || Boolean(agent.nodeId && endpoint.nodeId === agent.nodeId));
      const relatedEndpointIds = new Set(relatedEndpoints.map((endpoint) => endpoint.id));
      const relatedCapabilities = capabilities.filter((capability) => (
        Boolean(capability.runtimeId && relatedRuntimeIds.has(capability.runtimeId))
        || Boolean(capability.endpointId && relatedEndpointIds.has(capability.endpointId))
        || Boolean(agent.nodeId && capability.nodeId === agent.nodeId)
      ));
      const relatedCommands = commands.filter((command) => command.agentId === agent.id);
      const relatedAuditEvents = auditEvents.filter((event) => event.agentId === agent.id);
      const relatedRuntime = relatedRuntimes.find((runtime) => runtime.id === agent.runtimeId) ?? relatedRuntimes[0];
      const revoking = mutatingAction === `revoke-agent:${agent.id}`;
      const agentLabel = safeText(agent.displayName || agent.id);

      detail = {
        kind: 'agent',
        title: agentLabel,
        description: translate('remoteFleet.detail.descriptions.agent', { defaultValue: 'RuntimeAgent identity and its projected services.' }),
        status: agent.status,
        breadcrumbs: [
          relatedNode ? breadcrumbItem('node', relatedNode.id, safeText(relatedNode.displayName || relatedNode.id)) : null,
          breadcrumbItem('agent', agent.id, agentLabel, true),
        ].filter(isDefined),
        actions: [
          {
            id: 'revoke-agent',
            label: translate('remoteFleet.detail.actions.revoke', { defaultValue: 'Revoke agent' }),
            icon: <Unplug className="h-4 w-4" />,
            loading: revoking,
            disabled: allActionsDisabled,
            destructive: true,
            onAction: () => onRevokeAgent(agent.id),
          },
        ],
        facts: [
          { label: translate('remoteFleet.fields.id', { defaultValue: 'ID' }), value: agent.id, mono: true },
          { label: translate('remoteFleet.fields.node', { defaultValue: 'Node' }), value: agent.nodeId, mono: true },
          { label: translate('remoteFleet.fields.runtime', { defaultValue: 'Runtime' }), value: agent.runtimeId, mono: true },
          { label: translate('remoteFleet.fields.model', { defaultValue: 'Model' }), value: agent.model },
          { label: translate('remoteFleet.fields.capabilities', { defaultValue: 'Capabilities' }), value: agent.capabilities },
        ],
        associationCounts: [
          { label: translate('remoteFleet.detail.metrics.capabilities', { defaultValue: 'Capabilities' }), value: agent.capabilities?.length ?? 0 },
          { label: translate('remoteFleet.detail.metrics.endpoints', { defaultValue: 'Endpoints' }), value: relatedEndpoints.length },
          { label: translate('remoteFleet.detail.metrics.commands', { defaultValue: 'Commands' }), value: relatedCommands.length },
          { label: translate('remoteFleet.detail.metrics.audit', { defaultValue: 'Audit events' }), value: relatedAuditEvents.length },
        ],
        capabilityItems: capabilityListItems(relatedCapabilities, translate),
        leaseItems: [],
        commandItems: commandListItems(relatedCommands, translate),
        auditItems: auditListItems(relatedAuditEvents, translate),
        terminal: { mode: 'agent', relatedRuntime },
      };
    }
  } else if (selection.kind === 'runtime') {
    const runtime = runtimes.find((item) => item.id === selection.id);
    if (runtime) {
      const relatedNode = runtime.nodeId ? nodes.find((node) => node.id === runtime.nodeId) : undefined;
      const relatedAgent = runtime.agentId ? agents.find((agent) => agent.id === runtime.agentId) : undefined;
      const relatedEndpoint = runtime.endpointId ? endpoints.find((endpoint) => endpoint.id === runtime.endpointId) : undefined;
      const relatedCapabilities = capabilities.filter((capability) => capability.runtimeId === runtime.id || capability.endpointId === runtime.endpointId);
      const relatedCommands = commands.filter((command) => command.runtimeId === runtime.id);
      const relatedAuditEvents = auditEvents.filter((event) => event.runtimeId === runtime.id);
      const relatedLeases = leases.filter((lease) => lease.endpointId === runtime.endpointId);
      const starting = mutatingAction === `start:${runtime.id}`;
      const stopping = mutatingAction === `stop:${runtime.id}`;
      const runtimeLabel = safeText(runtime.displayName || runtime.id);
      const terminalTarget: RemoteFleetTerminalDrawerTarget = {
        kind: 'runtime',
        id: runtime.id,
        title: translate('remoteFleet.terminal.targetTitle.runtime', { defaultValue: `Terminal for ${runtime.displayName || runtime.id}`, name: runtime.displayName || runtime.id }),
        description: translate('remoteFleet.terminal.targetDescription.runtime', { defaultValue: 'Connect to the selected runtime service.' }),
        unavailableReason: terminalUnavailableReasonForTarget({
          status: runtime.status,
          targetKind: relatedNode?.targetKind,
          endpointId: runtime.endpointId,
          endpointStatus: relatedEndpoint?.status,
          endpointCapabilities: relatedCapabilities.filter((capability) => capability.endpointId === runtime.endpointId),
        }, translate),
        openTarget: { runtimeId: runtime.id },
      };

      detail = {
        kind: 'runtime',
        title: runtimeLabel,
        description: translate('remoteFleet.detail.descriptions.runtime', { defaultValue: 'Remote runtime service and endpoint projection.' }),
        status: runtime.status,
        attentionReason: runtime.reason,
        breadcrumbs: [
          relatedNode ? breadcrumbItem('node', relatedNode.id, safeText(relatedNode.displayName || relatedNode.id)) : null,
          relatedAgent ? breadcrumbItem('agent', relatedAgent.id, safeText(relatedAgent.displayName || relatedAgent.id)) : null,
          breadcrumbItem('runtime', runtime.id, runtimeLabel, true),
        ].filter(isDefined),
        actions: [
          {
            id: 'start-runtime',
            label: translate('remoteFleet.detail.actions.start', { defaultValue: 'Start runtime' }),
            icon: <CircleDot className="h-4 w-4" />,
            loading: starting,
            disabled: allActionsDisabled,
            onAction: () => onStart(runtime),
          },
          {
            id: 'stop-runtime',
            label: translate('remoteFleet.detail.actions.stop', { defaultValue: 'Stop runtime' }),
            icon: <Unplug className="h-4 w-4" />,
            loading: stopping,
            disabled: allActionsDisabled,
            onAction: () => onStop(runtime),
          },
        ],
        facts: [
          { label: translate('remoteFleet.fields.id', { defaultValue: 'ID' }), value: runtime.id, mono: true },
          { label: translate('remoteFleet.fields.node', { defaultValue: 'Node' }), value: runtime.nodeId, mono: true },
          { label: translate('remoteFleet.fields.agent', { defaultValue: 'Agent' }), value: runtime.agentId, mono: true },
          { label: translate('remoteFleet.fields.endpoint', { defaultValue: 'Endpoint' }), value: runtime.endpointId, mono: true },
          { label: translate('remoteFleet.fields.started', { defaultValue: 'Started' }), value: runtime.startedAt },
        ],
        associationCounts: [
          { label: translate('remoteFleet.detail.metrics.capabilities', { defaultValue: 'Capabilities' }), value: relatedCapabilities.length },
          { label: translate('remoteFleet.detail.metrics.leases', { defaultValue: 'Leases' }), value: relatedLeases.length },
          { label: translate('remoteFleet.detail.metrics.commands', { defaultValue: 'Commands' }), value: relatedCommands.length },
          { label: translate('remoteFleet.detail.metrics.audit', { defaultValue: 'Audit events' }), value: relatedAuditEvents.length },
        ],
        capabilityItems: capabilityListItems(relatedCapabilities, translate),
        leaseItems: leaseListItems(relatedLeases, translate),
        commandItems: commandListItems(relatedCommands, translate),
        auditItems: auditListItems(relatedAuditEvents, translate),
        terminal: { mode: 'target', target: terminalTarget },
      };
    }
  } else if (selection.kind === 'endpoint') {
    const endpoint = endpoints.find((item) => item.id === selection.id);
    if (endpoint) {
      const relatedNode = endpoint.nodeId ? nodes.find((node) => node.id === endpoint.nodeId) : undefined;
      const relatedRuntime = endpoint.runtimeId ? runtimes.find((runtime) => runtime.id === endpoint.runtimeId) : undefined;
      const relatedCapabilities = capabilities.filter((capability) => capability.endpointId === endpoint.id || capability.runtimeId === endpoint.runtimeId || capability.nodeId === endpoint.nodeId);
      const relatedLeases = leases.filter((lease) => lease.endpointId === endpoint.id);
      const relatedCommands = commands.filter((command) => command.endpointId === endpoint.id);
      const relatedAuditEvents = auditEvents.filter((event) => event.endpointId === endpoint.id);
      const draining = mutatingAction === `drain-endpoint:${endpoint.id}`;
      const retiring = mutatingAction === `retire-endpoint:${endpoint.id}`;
      const syncing = mutatingAction === `sync-capabilities:${endpoint.id}`;
      const terminalTarget: RemoteFleetTerminalDrawerTarget = {
        kind: 'endpoint',
        id: endpoint.id,
        title: translate('remoteFleet.terminal.targetTitle.endpoint', { defaultValue: `Terminal for ${endpoint.id}`, name: endpoint.id }),
        description: translate('remoteFleet.terminal.targetDescription.endpoint', { defaultValue: 'Connect through the selected runtime endpoint.' }),
        unavailableReason: terminalUnavailableReasonForTarget({
          status: relatedNode?.status,
          targetKind: relatedNode?.targetKind,
          endpointId: endpoint.id,
          endpointStatus: endpoint.status,
          endpointCapabilities: relatedCapabilities.filter((capability) => capability.endpointId === endpoint.id),
        }, translate),
        openTarget: { endpointId: endpoint.id },
      };
      const endpointLabel = safeText(endpoint.id);

      detail = {
        kind: 'endpoint',
        title: endpointLabel,
        description: translate('remoteFleet.detail.descriptions.endpoint', { defaultValue: 'Addressable endpoint and its advertised capabilities.' }),
        status: endpoint.status,
        breadcrumbs: [
          relatedNode ? breadcrumbItem('node', relatedNode.id, safeText(relatedNode.displayName || relatedNode.id)) : null,
          relatedRuntime ? breadcrumbItem('runtime', relatedRuntime.id, safeText(relatedRuntime.displayName || relatedRuntime.id)) : null,
          breadcrumbItem('endpoint', endpoint.id, endpointLabel, true),
        ].filter(isDefined),
        actions: [
          {
            id: 'sync-capabilities',
            label: translate('remoteFleet.detail.actions.syncCapabilities', { defaultValue: 'Sync capabilities' }),
            icon: <RefreshCw className="h-4 w-4" />,
            loading: syncing,
            disabled: allActionsDisabled,
            onAction: () => onSyncCapabilities(endpoint),
          },
          {
            id: 'drain-endpoint',
            label: translate('remoteFleet.detail.actions.drain', { defaultValue: 'Drain endpoint' }),
            icon: <CircleDot className="h-4 w-4" />,
            loading: draining,
            disabled: allActionsDisabled,
            onAction: () => onDrainEndpoint(endpoint.id),
          },
          {
            id: 'retire-endpoint',
            label: translate('remoteFleet.detail.actions.retire', { defaultValue: 'Retire endpoint' }),
            icon: <Trash2 className="h-4 w-4" />,
            loading: retiring,
            disabled: allActionsDisabled,
            destructive: true,
            onAction: () => onRetireEndpoint(endpoint.id),
          },
        ],
        facts: [
          { label: translate('remoteFleet.fields.id', { defaultValue: 'ID' }), value: endpoint.id, mono: true },
          { label: translate('remoteFleet.fields.node', { defaultValue: 'Node' }), value: endpoint.nodeId, mono: true },
          { label: translate('remoteFleet.fields.runtime', { defaultValue: 'Runtime' }), value: endpoint.runtimeId, mono: true },
          { label: translate('remoteFleet.fields.url', { defaultValue: 'URL' }), value: safeAddressLabel(endpoint.url), mono: true },
          { label: translate('remoteFleet.fields.protocol', { defaultValue: 'Protocol' }), value: endpoint.protocol },
          { label: translate('remoteFleet.fields.lastProbe', { defaultValue: 'Last probe' }), value: endpoint.lastProbeAt },
          { label: translate('remoteFleet.fields.labels', { defaultValue: 'Labels' }), value: endpoint.labels },
        ],
        associationCounts: [
          { label: translate('remoteFleet.detail.metrics.capabilities', { defaultValue: 'Capabilities' }), value: relatedCapabilities.length },
          { label: translate('remoteFleet.detail.metrics.leases', { defaultValue: 'Leases' }), value: relatedLeases.length },
          { label: translate('remoteFleet.detail.metrics.commands', { defaultValue: 'Commands' }), value: relatedCommands.length },
          { label: translate('remoteFleet.detail.metrics.audit', { defaultValue: 'Audit events' }), value: relatedAuditEvents.length },
        ],
        capabilityItems: capabilityListItems(relatedCapabilities, translate),
        leaseItems: leaseListItems(relatedLeases, translate),
        commandItems: commandListItems(relatedCommands, translate),
        auditItems: auditListItems(relatedAuditEvents, translate),
        terminal: { mode: 'target', target: terminalTarget },
      };
    }
  }

  if (!detail) {
    return (
      <EmptyState
        icon={selection.kind === 'agent' ? <Bot className="h-5 w-5" /> : selection.kind === 'endpoint' ? <Network className="h-5 w-5" /> : selection.kind === 'managedResource' ? <Database className="h-5 w-5" /> : selection.kind === 'environment' ? <Boxes className="h-5 w-5" /> : <Server className="h-5 w-5" />}
        title={translate('remoteFleet.detail.missingTitle', { defaultValue: `${kindLabel(selection.kind, translate)} not found`, kind: kindLabel(selection.kind, translate) })}
        description={translate('remoteFleet.detail.missingHint', { defaultValue: 'Refresh the fleet snapshot or select another resource.' })}
      />
    );
  }

  const primaryAction = detail.actions.find((action) => !action.destructive);
  const visibleActions = detail.actions.filter((action) => action !== primaryAction && action.alwaysVisible);
  const moreActions = detail.actions.filter((action) => action !== primaryAction && !action.alwaysVisible);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="shrink-0 border-b border-border/70 px-5 py-4">
        <DetailBreadcrumbs
          items={detail.breadcrumbs}
          showBackAction={showBackAction}
          onBackToIndex={onBackToIndex}
          t={translate}
        />
        <div className="mt-3 flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{kindLabel(detail.kind, translate)}</Badge>
              <RemoteFleetStatusBadge status={detail.status} />
            </div>
            <h2 className="mt-2 truncate text-2xl font-semibold tracking-tight text-foreground" title={detail.title}>{detail.title}</h2>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">{safeText(detail.description)}</p>
            {detail.guidance ? <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground">{detail.guidance}</p> : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {primaryAction ? <PrimaryAction action={primaryAction} /> : null}
            {visibleActions.map((action) => <PrimaryAction key={action.id} action={action} />)}
            <MoreActions actions={moreActions} t={translate} />
          </div>
        </div>
      </header>

      <DetailTabs activeTab={activeTab} onActiveTabChange={onActiveTabChange} t={translate} />

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5">
        <div className="mx-auto w-full max-w-5xl">
          {activeTab === 'overview' ? (
            <div className="py-5">
              <AttentionSummary status={detail.status} reason={detail.attentionReason} t={translate} />
              <DetailSection
                title={translate('remoteFleet.detail.facts', { defaultValue: 'Key fields' })}
                description={translate('remoteFleet.detail.factsDescription', { defaultValue: 'Stable identifiers and projected resource metadata.' })}
              >
                <Facts facts={detail.facts} />
              </DetailSection>
              <DetailSection
                title={translate('remoteFleet.detail.associations', { defaultValue: 'Associations' })}
                description={translate('remoteFleet.detail.associationsDescription', { defaultValue: 'Related resources and active lease projection.' })}
              >
                <AssociationCounts counts={detail.associationCounts} />
                {detail.associatedEnvironmentItems?.length ? (
                  <div className="mt-5">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <h4 className="text-sm font-medium text-foreground">
                        {translate('remoteFleet.detail.metrics.environments', { defaultValue: 'Environments' })}
                      </h4>
                      <Badge variant="outline">{detail.associatedEnvironmentItems.length}</Badge>
                    </div>
                    <DetailList
                      items={detail.associatedEnvironmentItems}
                      emptyMessage={translate('remoteFleet.detail.emptyEnvironments', { defaultValue: 'No environments are associated with this connection.' })}
                      emptyIcon={<Boxes className="h-4 w-4" />}
                    />
                  </div>
                ) : null}
                {detail.leaseItems.length > 0 ? (
                  <div className="mt-5">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <h4 className="text-sm font-medium text-foreground">{translate('remoteFleet.detail.metrics.leases', { defaultValue: 'Leases' })}</h4>
                      <Badge variant="outline">{detail.leaseItems.length}</Badge>
                    </div>
                    <DetailList
                      items={detail.leaseItems}
                      emptyMessage={translate('remoteFleet.detail.emptyLeases', { defaultValue: 'No leases are associated with this resource.' })}
                      emptyIcon={<CircleDot className="h-4 w-4" />}
                    />
                  </div>
                ) : null}
              </DetailSection>
            </div>
          ) : null}

          {activeTab === 'terminal' ? (
            <TerminalTab terminal={detail.terminal} mutatingAction={mutatingAction} onOpenTerminal={onOpenTerminal} t={translate} />
          ) : null}

          {activeTab === 'commands' ? (
            <DetailSection
              title={translate('remoteFleet.detail.metrics.commands', { defaultValue: 'Commands' })}
              description={translate('remoteFleet.detail.commandsDescription', { defaultValue: 'Commands associated with the selected resource.' })}
              count={detail.commandItems.length}
            >
              <DetailList
                items={detail.commandItems}
                emptyMessage={translate('remoteFleet.detail.emptyCommands', { defaultValue: 'No commands are associated with this resource.' })}
                emptyIcon={<CircleDot className="h-4 w-4" />}
              />
            </DetailSection>
          ) : null}

          {activeTab === 'audit' ? (
            <DetailSection
              title={translate('remoteFleet.detail.metrics.audit', { defaultValue: 'Audit' })}
              description={translate('remoteFleet.detail.auditDescription', { defaultValue: 'Audit events associated with the selected resource.' })}
              count={detail.auditItems.length}
            >
              <DetailList
                items={detail.auditItems}
                emptyMessage={translate('remoteFleet.detail.emptyAudit', { defaultValue: 'No audit events are associated with this resource.' })}
                emptyIcon={<AlertTriangle className="h-4 w-4" />}
              />
            </DetailSection>
          ) : null}

          {activeTab === 'capabilities' ? (
            <DetailSection
              title={translate('remoteFleet.detail.metrics.capabilities', { defaultValue: 'Capabilities' })}
              description={translate('remoteFleet.detail.capabilitiesDescription', { defaultValue: 'Capabilities currently projected for the selected resource.' })}
              count={detail.capabilityItems.length}
            >
              <DetailList
                items={detail.capabilityItems}
                emptyMessage={translate('remoteFleet.detail.emptyCapabilities', { defaultValue: 'No capabilities are projected for this resource.' })}
                emptyIcon={<Network className="h-4 w-4" />}
              />
            </DetailSection>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export default RemoteFleetDetailPanel;
