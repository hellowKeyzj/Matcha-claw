import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import { AgentResourceCard, AgentResourceFooter, AgentResourceGrid } from '@/components/common/AgentPage';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { buildTemplateAvatarSeed } from '@/lib/agent-avatar';
import { cn } from '@/lib/utils';
import { prefetchSubagentTemplateById } from '@/services/openclaw/subagent-template-catalog';
import type { SubagentTemplateCatalogResult, SubagentTemplateSummary } from '@/types/subagent';
import { SubagentResourceToolbar } from './SubagentResourceToolbar';

const INITIAL_TEMPLATE_CARD_BATCH = 9;
const TEMPLATE_CARD_BATCH_SIZE = 18;
const TEMPLATE_CARD_SCROLL_THRESHOLD_PX = 180;
const templateVisibleCounts = new Map<string, number>();

function templateVisibleCountKey(search: string, category: string): string {
  return JSON.stringify([category, search]);
}

const TemplateCatalogCard = memo(function TemplateCatalogCard({
  template,
  name,
  summary,
  loading,
  disabled,
  compact,
  onPrefetch,
  onLoad,
}: {
  template: SubagentTemplateSummary;
  name: string;
  summary: string;
  loading: boolean;
  disabled: boolean;
  compact: boolean;
  onPrefetch: (templateId: string) => void;
  onLoad: (templateId: string) => void;
}) {
  const { t } = useTranslation('subagents');
  const category = template.categoryId
    ? t(`templates.categories.${template.categoryId}`, { defaultValue: template.categoryId })
    : t('templates.badge');
  return (
    <AgentResourceCard
      className={cn('gap-4 p-4', compact && 'md:flex-row md:items-center')}
      onMouseEnter={() => onPrefetch(template.id)}
      onFocus={() => onPrefetch(template.id)}
    >
      <div className={cn('flex min-w-0 items-center gap-3', compact && 'md:w-64 md:shrink-0')}>
        <AgentAvatar
          avatarSeed={buildTemplateAvatarSeed(template.id)}
          agentId={template.id}
          agentName={name}
          className="size-11 shrink-0 rounded-2xl border border-border/70 shadow-sm ring-1 ring-background/70"
          alt=""
        />
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold" title={name}>{name}</h3>
          <p className="mt-1 truncate text-xs text-muted-foreground">{category}</p>
        </div>
      </div>
      <div className={cn('min-w-0 flex-1', !compact && 'min-h-10')}>
        {summary && <p className="line-clamp-2 text-sm leading-5 text-muted-foreground">{summary}</p>}
      </div>
      <AgentResourceFooter className={cn('justify-end', compact && 'md:mt-0 md:shrink-0')}>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 gap-2 px-1 text-xs text-foreground"
          disabled={loading || disabled}
          title={disabled ? t('form.modelUnavailable') : undefined}
          onClick={() => onLoad(template.id)}
          onMouseEnter={() => onPrefetch(template.id)}
          onFocus={() => onPrefetch(template.id)}
        >
          {loading ? t('templates.loadingButton') : t('templates.view')}
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Button>
      </AgentResourceFooter>
    </AgentResourceCard>
  );
});

export function SubagentTemplateLibrary({
  catalog,
  loading,
  error,
  templateLoadingId,
  modelsUnavailable,
  onLoad,
}: {
  catalog: SubagentTemplateCatalogResult;
  loading: boolean;
  error: string | null;
  templateLoadingId: string | null;
  modelsUnavailable: boolean;
  onLoad: (templateId: string) => void;
}) {
  const { t } = useTranslation('subagents');
  const { t: tTemplate } = useTranslation('subagentTemplates');
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get('templateSearch') ?? '';
  const view = searchParams.get('templateView') === 'list' ? 'list' : 'grid';
  const selectedCategory = searchParams.get('category') ?? 'all';
  const updateQuery = useCallback((key: string, value: string, defaultValue = '') => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value === defaultValue) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const prefetchedIdsRef = useRef(new Set<string>());
  const deferredSearch = useDeferredValue(search.trim().toLocaleLowerCase());
  const [pagination, setPagination] = useState(() => ({
    search: deferredSearch,
    category: selectedCategory,
    count: templateVisibleCounts.get(templateVisibleCountKey(deferredSearch, selectedCategory)) ?? INITIAL_TEMPLATE_CARD_BATCH,
  }));
  const visibleCount = pagination.search === deferredSearch && pagination.category === selectedCategory
    ? pagination.count : INITIAL_TEMPLATE_CARD_BATCH;
  if (pagination.search !== deferredSearch || pagination.category !== selectedCategory) {
    setPagination({
      search: deferredSearch,
      category: selectedCategory,
      count: templateVisibleCounts.get(templateVisibleCountKey(deferredSearch, selectedCategory)) ?? INITIAL_TEMPLATE_CARD_BATCH,
    });
  }

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const template of catalog.templates) {
      const id = template.categoryId?.trim();
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [catalog.templates]);

  const categories = useMemo(() => {
    const fromCatalog = catalog.categories
      .filter((category) => categoryCounts.has(category.id))
      .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
    const knownIds = new Set(fromCatalog.map((category) => category.id));
    const remaining = [...categoryCounts.keys()]
      .filter((id) => !knownIds.has(id))
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({ id }));
    return [...fromCatalog, ...remaining];
  }, [catalog.categories, categoryCounts]);

  const localizedTemplates = useMemo(() => catalog.templates.map((template) => {
    const name = tTemplate(`templates.${template.id}.name`, { defaultValue: template.name });
    const summary = tTemplate(`templates.${template.id}.summary`, { defaultValue: template.summary ?? '' }) || '';
    return { template, name, summary, searchText: `${template.id} ${name} ${summary}`.toLocaleLowerCase() };
  }), [catalog.templates, tTemplate]);
  const filteredTemplates = useMemo(() => localizedTemplates.filter(({ template, searchText }) => (
    (selectedCategory === 'all' || template.categoryId === selectedCategory)
    && (!deferredSearch || searchText.includes(deferredSearch))
  )), [deferredSearch, localizedTemplates, selectedCategory]);
  const deferredTemplates = useDeferredValue(filteredTemplates);
  const visibleTemplates = useMemo(() => deferredTemplates.slice(0, visibleCount), [deferredTemplates, visibleCount]);
  const displayedCount = Math.min(visibleCount, deferredTemplates.length);

  useEffect(() => {
    if (!loading && !error && selectedCategory !== 'all' && !categoryCounts.has(selectedCategory)) updateQuery('category', 'all', 'all');
  }, [categoryCounts, selectedCategory, loading, error, updateQuery]);

  const appendVisibleTemplates = useCallback(() => {
    setPagination((previous) => {
      if (previous.count >= deferredTemplates.length) return previous;
      const nextCount = Math.min(previous.count + TEMPLATE_CARD_BATCH_SIZE, deferredTemplates.length);
      templateVisibleCounts.set(templateVisibleCountKey(previous.search, previous.category), nextCount);
      return { ...previous, count: nextCount };
    });
  }, [deferredTemplates.length]);

  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) appendVisibleTemplates();
    }, {
      root: sentinel.closest('[data-page-scroll]'),
      rootMargin: `0px 0px ${TEMPLATE_CARD_SCROLL_THRESHOLD_PX}px 0px`,
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [appendVisibleTemplates, displayedCount, loading, error]);

  const prefetchTemplateDetail = useCallback((templateId: string) => {
    const normalizedId = templateId.trim();
    if (!normalizedId || prefetchedIdsRef.current.has(normalizedId)) return;
    prefetchedIdsRef.current.add(normalizedId);
    void prefetchSubagentTemplateById(normalizedId).catch(() => {
      prefetchedIdsRef.current.delete(normalizedId);
    });
  }, []);

  useEffect(() => {
    if (loading || deferredTemplates.length === 0) return;
    let cancelled = false;
    let timeoutId: number | undefined;
    let idleId: number | undefined;
    const runPrefetch = async () => {
      for (const { template } of deferredTemplates.slice(0, 4)) {
        if (cancelled) return;
        prefetchTemplateDetail(template.id);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
      }
    };
    if ('requestIdleCallback' in window && typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(() => { void runPrefetch(); }, { timeout: 500 });
    } else {
      timeoutId = window.setTimeout(() => { void runPrefetch(); }, 120);
    }
    return () => {
      cancelled = true;
      if (typeof timeoutId === 'number') window.clearTimeout(timeoutId);
      if (typeof idleId === 'number' && 'cancelIdleCallback' in window && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      }
    };
  }, [deferredTemplates, loading, prefetchTemplateDetail]);

  return (
    <div className="space-y-6">
      <SubagentResourceToolbar
        search={search}
        onSearchChange={(value) => updateQuery('templateSearch', value)}
        searchLabel={t('search.templates')}
        countLabel={t('results.templates', { total: filteredTemplates.length })}
        view={view}
        onViewChange={(value) => updateQuery('templateView', value, 'grid')}
      >
        <Select
          value={selectedCategory}
          onChange={(event) => updateQuery('category', event.target.value, 'all')}
          aria-label={t('filters.category')}
          className="h-10 w-auto max-w-full text-sm"
        >
          <option value="all">{t('templates.categories.all')} ({catalog.templates.length})</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {t(`templates.categories.${category.id}`, { defaultValue: category.id })} ({categoryCounts.get(category.id) ?? 0})
            </option>
          ))}
        </Select>
      </SubagentResourceToolbar>
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">{t('templates.loading')}</p>
      ) : error ? (
        <p role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {t('templates.error', { message: error })}
        </p>
      ) : deferredTemplates.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t(catalog.templates.length ? 'search.empty' : 'templates.empty')}</p>
      ) : (
        <>
          <AgentResourceGrid className={view === 'list' ? 'md:grid-cols-1 xl:grid-cols-1' : undefined}>
            {visibleTemplates.map(({ template, name, summary }) => (
              <TemplateCatalogCard
                key={template.id}
                template={template}
                name={name}
                summary={summary}
                loading={templateLoadingId === template.id}
                disabled={modelsUnavailable}
                compact={view === 'list'}
                onPrefetch={prefetchTemplateDetail}
                onLoad={onLoad}
              />
            ))}
          </AgentResourceGrid>
          {displayedCount < deferredTemplates.length && (
            <div ref={loadMoreRef} className="flex items-center justify-center gap-3">
              <span className="text-xs text-muted-foreground">{t('templates.pagination.showing', { shown: displayedCount, total: deferredTemplates.length })}</span>
              <Button type="button" size="sm" variant="ghost" onClick={appendVisibleTemplates}>{t('templates.pagination.loadMore')}</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
