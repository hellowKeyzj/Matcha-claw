import { type ReactNode, useMemo } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Boxes, CircleDot, Compass, Network, ServerCog, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { RemoteFleetTargetPreviewEmptyState } from './RemoteFleetTargetPreviewEmptyState';
import { RemoteFleetTargetPreviewStatusBadge } from './RemoteFleetTargetPreviewStatusBadge';

export type RemoteFleetTargetPreviewEndpointStatus = 'available' | 'draining' | 'retired' | 'offline' | 'unknown' | string;

export interface RemoteFleetTargetPreviewEndpoint {
  readonly id: string;
  readonly nodeId?: string;
  readonly runtimeId?: string;
  readonly url?: string;
  readonly protocol?: string;
  readonly status?: RemoteFleetTargetPreviewEndpointStatus;
  readonly labels?: readonly string[];
}

export interface RemoteFleetTargetPreviewCapability {
  readonly id: string;
  readonly endpointId?: string;
  readonly nodeId?: string;
  readonly runtimeId?: string;
  readonly displayName?: string;
  readonly operationIds?: readonly string[];
  readonly status?: string;
}

export interface RemoteFleetTargetPreviewSelector {
  readonly endpointIds?: readonly string[];
  readonly nodeIds?: readonly string[];
  readonly runtimeIds?: readonly string[];
  readonly labels?: readonly string[];
  readonly operationIds?: readonly string[];
}

interface RemoteFleetTargetPreviewProps {
  readonly endpoints: readonly RemoteFleetTargetPreviewEndpoint[];
  readonly capabilities: readonly RemoteFleetTargetPreviewCapability[];
  readonly selectorPreview?: RemoteFleetTargetPreviewSelector;
}

type EndpointPreview = {
  readonly endpoint: RemoteFleetTargetPreviewEndpoint;
  readonly operationIds: readonly string[];
  readonly exclusionReason: 'draining' | 'retired' | null;
};

type CapabilityOperationIndex = {
  readonly operationIdsByEndpointId: ReadonlyMap<string, readonly string[]>;
  readonly operationIdsByRuntimeId: ReadonlyMap<string, readonly string[]>;
  readonly operationIdsByNodeId: ReadonlyMap<string, readonly string[]>;
};

type SelectorSectionKey = 'endpointIds' | 'nodeIds' | 'runtimeIds' | 'labels' | 'operations';

type SelectorSection = {
  readonly key: SelectorSectionKey;
  readonly values: readonly string[];
};

function hasSelectorConstraints(selector?: RemoteFleetTargetPreviewSelector): boolean {
  return Boolean(
    selector?.endpointIds?.length ||
    selector?.nodeIds?.length ||
    selector?.runtimeIds?.length ||
    selector?.labels?.length ||
    selector?.operationIds?.length,
  );
}

function endpointMatchesIdentityAndLabels(endpoint: RemoteFleetTargetPreviewEndpoint, selector?: RemoteFleetTargetPreviewSelector): boolean {
  if (!selector) return true;
  if (selector.endpointIds?.length && !selector.endpointIds.includes(endpoint.id)) return false;
  if (selector.nodeIds?.length && !endpoint.nodeId) return false;
  if (selector.nodeIds?.length && !selector.nodeIds.includes(endpoint.nodeId ?? '')) return false;
  if (selector.runtimeIds?.length && !endpoint.runtimeId) return false;
  if (selector.runtimeIds?.length && !selector.runtimeIds.includes(endpoint.runtimeId ?? '')) return false;
  if (selector.labels?.length) {
    const labels = new Set(endpoint.labels ?? []);
    if (!selector.labels.every((label) => labels.has(label))) return false;
  }
  return true;
}

function addOperationIds(index: Map<string, Set<string>>, key: string | undefined, operationIds: readonly string[] | undefined): void {
  if (!key || !operationIds?.length) return;
  const indexedOperationIds = index.get(key) ?? new Set<string>();
  for (const operationId of operationIds) {
    indexedOperationIds.add(operationId);
  }
  index.set(key, indexedOperationIds);
}

function sortOperationIndex(index: Map<string, Set<string>>): ReadonlyMap<string, readonly string[]> {
  return new Map(
    Array.from(index.entries(), ([key, operationIds]) => [
      key,
      Array.from(operationIds).sort((first, second) => first.localeCompare(second)),
    ]),
  );
}

function buildCapabilityOperationIndex(capabilities: readonly RemoteFleetTargetPreviewCapability[]): CapabilityOperationIndex {
  const operationIdsByEndpointId = new Map<string, Set<string>>();
  const operationIdsByRuntimeId = new Map<string, Set<string>>();
  const operationIdsByNodeId = new Map<string, Set<string>>();

  for (const capability of capabilities) {
    addOperationIds(operationIdsByEndpointId, capability.endpointId, capability.operationIds);
    addOperationIds(operationIdsByRuntimeId, capability.runtimeId, capability.operationIds);
    addOperationIds(operationIdsByNodeId, capability.nodeId, capability.operationIds);
  }

  return {
    operationIdsByEndpointId: sortOperationIndex(operationIdsByEndpointId),
    operationIdsByRuntimeId: sortOperationIndex(operationIdsByRuntimeId),
    operationIdsByNodeId: sortOperationIndex(operationIdsByNodeId),
  };
}

function operationIdsForEndpoint(
  endpoint: RemoteFleetTargetPreviewEndpoint,
  capabilityOperationIndex: CapabilityOperationIndex,
  selector?: RemoteFleetTargetPreviewSelector,
): string[] {
  const operationIds = new Set<string>();
  for (const operationId of capabilityOperationIndex.operationIdsByEndpointId.get(endpoint.id) ?? []) {
    operationIds.add(operationId);
  }
  if (endpoint.runtimeId) {
    for (const operationId of capabilityOperationIndex.operationIdsByRuntimeId.get(endpoint.runtimeId) ?? []) {
      operationIds.add(operationId);
    }
  }
  if (endpoint.nodeId) {
    for (const operationId of capabilityOperationIndex.operationIdsByNodeId.get(endpoint.nodeId) ?? []) {
      operationIds.add(operationId);
    }
  }

  const selectedOperationIds = selector?.operationIds?.length
    ? Array.from(operationIds).filter((operationId) => selector.operationIds?.includes(operationId))
    : Array.from(operationIds);
  return selectedOperationIds.sort((first, second) => first.localeCompare(second));
}

function exclusionReasonForEndpoint(endpoint: RemoteFleetTargetPreviewEndpoint): EndpointPreview['exclusionReason'] {
  if (endpoint.status === 'draining') return 'draining';
  if (endpoint.status === 'retired') return 'retired';
  return null;
}

function buildEndpointPreviews(
  endpoints: readonly RemoteFleetTargetPreviewEndpoint[],
  capabilityOperationIndex: CapabilityOperationIndex,
  selector?: RemoteFleetTargetPreviewSelector,
): EndpointPreview[] {
  return endpoints
    .filter((endpoint) => endpointMatchesIdentityAndLabels(endpoint, selector))
    .map((endpoint) => ({
      endpoint,
      operationIds: operationIdsForEndpoint(endpoint, capabilityOperationIndex, selector),
      exclusionReason: exclusionReasonForEndpoint(endpoint),
    }))
    .filter((preview) => !selector?.operationIds?.length || preview.operationIds.length > 0)
    .sort((first, second) => first.endpoint.id.localeCompare(second.endpoint.id));
}

function selectorSections(selector?: RemoteFleetTargetPreviewSelector): SelectorSection[] {
  return ([
    { key: 'endpointIds', values: selector?.endpointIds ?? [] },
    { key: 'nodeIds', values: selector?.nodeIds ?? [] },
    { key: 'runtimeIds', values: selector?.runtimeIds ?? [] },
    { key: 'labels', values: selector?.labels ?? [] },
    { key: 'operations', values: selector?.operationIds ?? [] },
  ] satisfies SelectorSection[]).filter((section) => section.values.length > 0);
}

function selectorSectionLabel(t: TFunction<'common'>, key: SelectorSectionKey): string {
  return t(`remoteFleet.targetPreview.selectorSections.${key}`);
}

function selectorSummaryLabel(t: TFunction<'common'>, selector?: RemoteFleetTargetPreviewSelector): string {
  const sections = selectorSections(selector);
  if (sections.length === 0) {
    return t('remoteFleet.targetPreview.selectorSummary.unscoped');
  }

  if (sections.length === 1) {
    return t('remoteFleet.targetPreview.selectorSummary.single', {
      label: selectorSectionLabel(t, sections[0].key),
      count: sections[0].values.length,
    });
  }

  return t('remoteFleet.targetPreview.selectorSummary.multiple', { count: sections.length });
}

function selectorSummaryDetail(t: TFunction<'common'>, selector?: RemoteFleetTargetPreviewSelector): string {
  const sections = selectorSections(selector);
  if (sections.length === 0) {
    return t('remoteFleet.targetPreview.selectorSummary.allEndpointsDetail');
  }

  return sections
    .map((section) => t('remoteFleet.targetPreview.selectorSummary.dimensionCount', {
      label: selectorSectionLabel(t, section.key),
      count: section.values.length,
    }))
    .join(' · ');
}

function DetailChipGroup({ label, values, tone = 'neutral' }: { readonly label: string; readonly values: readonly string[]; readonly tone?: 'neutral' | 'accent' }) {
  if (values.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <Badge
            key={`${label}:${value}`}
            variant="outline"
            className={cn(
              'max-w-full border shadow-none',
              tone === 'accent'
                ? 'border-sky-500/20 bg-sky-500/10 text-sky-800 dark:text-sky-200'
                : 'border-border/80 bg-background text-foreground',
            )}
          >
            {value}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function DetailMetric({ label, value, tone = 'neutral' }: { readonly label: string; readonly value: string | number; readonly tone?: 'neutral' | 'success' | 'warning' }) {
  return (
    <div
      className={cn(
        'rounded-2xl border px-3 py-3',
        tone === 'success' && 'border-emerald-500/20 bg-emerald-500/10',
        tone === 'warning' && 'border-amber-500/20 bg-amber-500/10',
        tone === 'neutral' && 'border-border/70 bg-background/80',
      )}
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tracking-[-0.02em] text-foreground">{value}</div>
    </div>
  );
}

function DetailMetaRow({ label, value }: { readonly label: string; readonly value?: string }) {
  if (!value) return null;

  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-background/80 px-3 py-2.5 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all text-right font-medium text-foreground">{value}</span>
    </div>
  );
}

function ExclusionNotice({ reason, t }: { readonly reason: NonNullable<EndpointPreview['exclusionReason']>; readonly t: TFunction<'common'> }) {
  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
      <div className="flex items-center gap-2 font-medium">
        <ShieldAlert className="h-4 w-4" />
        {t('remoteFleet.targetPreview.exclusion.title')}
      </div>
      <p className="mt-1 leading-6 text-amber-800 dark:text-amber-200">
        {t('remoteFleet.targetPreview.exclusion.description', { status: reason })}
      </p>
    </div>
  );
}

function EndpointDetailSection({
  title,
  description,
  icon,
  previews,
  empty,
  t,
}: {
  readonly title: string;
  readonly description: string;
  readonly icon: ReactNode;
  readonly previews: readonly EndpointPreview[];
  readonly empty: ReactNode;
  readonly t: TFunction<'common'>;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-background text-foreground">
            {icon}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
        </div>
        <Badge variant="outline" className="border-border/70 bg-background text-foreground shadow-none">{previews.length}</Badge>
      </div>

      {previews.length === 0 ? empty : (
        <div className="space-y-3">
          {previews.map((preview) => <EndpointDetailCard key={preview.endpoint.id} preview={preview} t={t} />)}
        </div>
      )}
    </section>
  );
}

function EndpointDetailCard({ preview, t }: { readonly preview: EndpointPreview; readonly t: TFunction<'common'> }) {
  const { endpoint, operationIds, exclusionReason } = preview;
  const bindingLabel = endpoint.runtimeId
    ? t('remoteFleet.targetPreview.binding.runtimeLinked')
    : endpoint.nodeId
      ? t('remoteFleet.targetPreview.binding.nodeLinked')
      : t('remoteFleet.targetPreview.binding.direct');

  return (
    <article className="rounded-[1.5rem] border border-border/70 bg-background/90 p-4 shadow-[var(--shadow-whisper)]">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold tracking-[-0.02em] text-foreground">{endpoint.id}</span>
            <RemoteFleetTargetPreviewStatusBadge status={endpoint.status} />
            {endpoint.protocol ? <Badge variant="outline" className="border-border/70 bg-muted/40 text-foreground shadow-none">{endpoint.protocol}</Badge> : null}
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <DetailMetric label={t('remoteFleet.targetPreview.metrics.operations')} value={operationIds.length} tone={operationIds.length > 0 ? 'success' : 'warning'} />
            <DetailMetric label={t('remoteFleet.targetPreview.metrics.labels')} value={endpoint.labels?.length ?? 0} />
            <DetailMetric label={t('remoteFleet.targetPreview.metrics.binding')} value={bindingLabel} />
          </div>
        </div>

        <div className="min-w-[220px] space-y-2">
          <DetailMetaRow label={t('remoteFleet.targetPreview.meta.node')} value={endpoint.nodeId} />
          <DetailMetaRow label={t('remoteFleet.targetPreview.meta.runtime')} value={endpoint.runtimeId} />
          <DetailMetaRow label={t('remoteFleet.targetPreview.meta.url')} value={endpoint.url} />
        </div>
      </div>

      <div className="mt-4 space-y-4 border-t border-border/60 pt-4">
        <DetailChipGroup label={t('remoteFleet.targetPreview.chips.operationsInScope')} values={operationIds} tone="accent" />
        <DetailChipGroup label={t('remoteFleet.targetPreview.chips.labels')} values={endpoint.labels ?? []} />
        {operationIds.length === 0 ? (
          <RemoteFleetTargetPreviewEmptyState
            icon={<Compass className="h-4 w-4" />}
            title={t('remoteFleet.targetPreview.empty.noOperations.title')}
            description={t('remoteFleet.targetPreview.empty.noOperations.description')}
          />
        ) : null}
        {exclusionReason ? <ExclusionNotice reason={exclusionReason} t={t} /> : null}
      </div>
    </article>
  );
}

export function RemoteFleetTargetPreview({ endpoints, capabilities, selectorPreview }: RemoteFleetTargetPreviewProps) {
  const { t } = useTranslation('common');
  const capabilityOperationIndex = useMemo(() => buildCapabilityOperationIndex(capabilities), [capabilities]);
  const endpointPreviews = useMemo(
    () => buildEndpointPreviews(endpoints, capabilityOperationIndex, selectorPreview),
    [capabilityOperationIndex, endpoints, selectorPreview],
  );
  const candidateEndpoints = useMemo(
    () => endpointPreviews.filter((preview) => !preview.exclusionReason),
    [endpointPreviews],
  );
  const excludedEndpoints = useMemo(
    () => endpointPreviews.filter((preview) => preview.exclusionReason),
    [endpointPreviews],
  );
  const selectorDimensions = useMemo(() => selectorSections(selectorPreview), [selectorPreview]);

  return (
    <Card className="overflow-hidden border-border/80 bg-card/95">
      <CardHeader className="gap-4 border-b border-border/70 bg-muted/20 pb-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              <Network className="h-3.5 w-3.5" />
              {t('remoteFleet.targetPreview.eyebrow')}
            </div>
            <CardTitle className="text-[1.35rem]">{t('remoteFleet.targetPreview.title')}</CardTitle>
            <CardDescription className="max-w-[48ch] text-sm leading-6">
              {t('remoteFleet.targetPreview.description')}
            </CardDescription>
          </div>

          <div className="grid min-w-full gap-2 sm:grid-cols-3 xl:min-w-[320px] xl:max-w-[360px]">
            <DetailMetric label={t('remoteFleet.targetPreview.metrics.candidates')} value={candidateEndpoints.length} tone={candidateEndpoints.length > 0 ? 'success' : 'warning'} />
            <DetailMetric label={t('remoteFleet.targetPreview.metrics.excluded')} value={excludedEndpoints.length} tone={excludedEndpoints.length > 0 ? 'warning' : 'neutral'} />
            <DetailMetric label={t('remoteFleet.targetPreview.metrics.selector')} value={selectorDimensions.length || t('remoteFleet.targetPreview.selectorSummary.all')} />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6 p-5">
        <section className="rounded-[1.5rem] border border-border/70 bg-muted/25 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <CircleDot className="h-4 w-4" />
                {t('remoteFleet.targetPreview.selectorSummary.title')}
              </div>
              <p className="text-sm font-medium text-foreground">{selectorSummaryLabel(t, selectorPreview)}</p>
              <p className="text-sm leading-6 text-muted-foreground">{selectorSummaryDetail(t, selectorPreview)}</p>
            </div>
            <Badge variant="outline" className="w-fit border-border/70 bg-background text-foreground shadow-none">
              {hasSelectorConstraints(selectorPreview) ? t('remoteFleet.targetPreview.selectorSummary.scopedPreview') : t('remoteFleet.targetPreview.selectorSummary.allEndpoints')}
            </Badge>
          </div>

          {selectorDimensions.length > 0 ? (
            <div className="mt-4 grid gap-3 xl:grid-cols-2">
              {selectorDimensions.map((section) => (
                <div key={section.key} className="rounded-2xl border border-border/70 bg-background/80 p-3">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{selectorSectionLabel(t, section.key)}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {section.values.map((value) => (
                      <Badge key={`${section.key}:${value}`} variant="outline" className="border-border/80 bg-background text-foreground shadow-none">
                        {value}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4">
              <RemoteFleetTargetPreviewEmptyState
                icon={<Compass className="h-4 w-4" />}
                title={t('remoteFleet.targetPreview.empty.noSelector.title')}
                description={t('remoteFleet.targetPreview.empty.noSelector.description')}
              />
            </div>
          )}
        </section>

        <EndpointDetailSection
          title={t('remoteFleet.targetPreview.candidates.title')}
          description={t('remoteFleet.targetPreview.candidates.description')}
          icon={<ServerCog className="h-4 w-4" />}
          previews={candidateEndpoints}
          empty={(
            <RemoteFleetTargetPreviewEmptyState
              icon={<Compass className="h-4 w-4" />}
              title={t('remoteFleet.targetPreview.empty.noCandidates.title')}
              description={t('remoteFleet.targetPreview.empty.noCandidates.description')}
              tone="warning"
            />
          )}
          t={t}
        />

        <EndpointDetailSection
          title={t('remoteFleet.targetPreview.excluded.title')}
          description={t('remoteFleet.targetPreview.excluded.description')}
          icon={<Boxes className="h-4 w-4" />}
          previews={excludedEndpoints}
          empty={(
            <RemoteFleetTargetPreviewEmptyState
              icon={<ShieldAlert className="h-4 w-4" />}
              title={t('remoteFleet.targetPreview.empty.noExclusions.title')}
              description={t('remoteFleet.targetPreview.empty.noExclusions.description')}
            />
          )}
          t={t}
        />
      </CardContent>
    </Card>
  );
}

export default RemoteFleetTargetPreview;
