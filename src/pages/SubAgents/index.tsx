import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { invokeIpc } from '@/lib/api-client';
import { normalizeSubagentNameToSlug } from '@/features/subagents/domain/workspace';
import {
  getSubagentTemplateById,
  getSubagentTemplateCatalog,
  prefetchSubagentTemplateById,
} from '@/services/openclaw/subagent-template-catalog';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import type { SubagentSummary, SubagentTemplateCatalogResult, SubagentTemplateDetail } from '@/types/subagent';
import { useTranslation } from 'react-i18next';
import { SubagentCard } from './components/SubagentCard';
import { SubagentDeleteDialog } from './components/SubagentDeleteDialog';
import { SubagentFormDialog } from './components/SubagentFormDialog';
import { SubagentManageDialog } from './components/SubagentManageDialog';
import { SubagentTemplateLoadDialog } from './components/SubagentTemplateLoadDialog';

type DialogMode = 'create' | 'edit';
const SUBAGENTS_HEAVY_CONTENT_IDLE_TIMEOUT_MS = 320;
const INITIAL_TEMPLATE_CARD_BATCH = 9;
const TEMPLATE_CARD_BATCH_SIZE = 18;
const TEMPLATE_CARD_SCROLL_THRESHOLD_PX = 180;

export function SubAgents() {
  const { t } = useTranslation('subagents');
  const { t: tTemplate } = useTranslation('subagentTemplates');
  const navigate = useNavigate();
  const agents = useSubagentsStore((state) => state.agents);
  const loading = useSubagentsStore((state) => state.loading);
  const error = useSubagentsStore((state) => state.error);
  const availableModels = useSubagentsStore((state) => state.availableModels);
  const modelsLoading = useSubagentsStore((state) => state.modelsLoading);
  const draftByFile = useSubagentsStore((state) => state.draftByFile);
  const draftError = useSubagentsStore((state) => state.draftError);
  const managedAgentId = useSubagentsStore((state) => state.managedAgentId);
  const draftPromptByAgent = useSubagentsStore((state) => state.draftPromptByAgent);
  const draftGeneratingByAgent = useSubagentsStore((state) => state.draftGeneratingByAgent);
  const draftApplyingByAgent = useSubagentsStore((state) => state.draftApplyingByAgent);
  const draftApplySuccessByAgent = useSubagentsStore((state) => state.draftApplySuccessByAgent);
  const draftRawOutputByAgent = useSubagentsStore((state) => state.draftRawOutputByAgent);
  const persistedFilesByAgent = useSubagentsStore((state) => state.persistedFilesByAgent);
  const previewDiffByFile = useSubagentsStore((state) => state.previewDiffByFile);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const loadAvailableModels = useSubagentsStore((state) => state.loadAvailableModels);
  const setManagedAgentId = useSubagentsStore((state) => state.setManagedAgentId);
  const loadPersistedFilesForAgent = useSubagentsStore((state) => state.loadPersistedFilesForAgent);
  const setDraftPromptForAgent = useSubagentsStore((state) => state.setDraftPromptForAgent);
  const cancelDraft = useSubagentsStore((state) => state.cancelDraft);
  const createAgent = useSubagentsStore((state) => state.createAgent);
  const updateAgent = useSubagentsStore((state) => state.updateAgent);
  const deleteAgent = useSubagentsStore((state) => state.deleteAgent);
  const createAgentFromTemplate = useSubagentsStore((state) => state.createAgentFromTemplate);
  const generateDraftFromPrompt = useSubagentsStore((state) => state.generateDraftFromPrompt);
  const generatePreviewDiffByFile = useSubagentsStore((state) => state.generatePreviewDiffByFile);
  const applyDraft = useSubagentsStore((state) => state.applyDraft);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<DialogMode>('create');
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [templateCatalog, setTemplateCatalog] = useState<SubagentTemplateCatalogResult>({ categories: [], templates: [] });
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templatesExpanded, setTemplatesExpanded] = useState(false);
  const [selectedTemplateCategory, setSelectedTemplateCategory] = useState<string>('all');
  const [templateLoadingId, setTemplateLoadingId] = useState<string | null>(null);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [templateDialogLoading, setTemplateDialogLoading] = useState(false);
  const [templateDialogSubmitting, setTemplateDialogSubmitting] = useState(false);
  const [activeTemplate, setActiveTemplate] = useState<SubagentTemplateDetail | null>(null);
  const [subagentsHeavyContentReady, setSubagentsHeavyContentReady] = useState(
    () => import.meta.env.MODE === 'test',
  );
  const [visibleTemplateCount, setVisibleTemplateCount] = useState(INITIAL_TEMPLATE_CARD_BATCH);
  const gatewayState = useGatewayStore((state) => state.status.state);
  const wasGatewayRunningRef = useRef(gatewayState === 'running');
  const templateLoadRequestIdRef = useRef(0);
  const prefetchedTemplateIdsRef = useRef<Set<string>>(new Set());
  const templateCardScrollRef = useRef<HTMLDivElement | null>(null);
  const draftPrompt = managedAgentId ? (draftPromptByAgent[managedAgentId] ?? '') : '';
  const generatingDraft = managedAgentId ? Boolean(draftGeneratingByAgent[managedAgentId]) : false;
  const persistedContentByFile = managedAgentId ? (persistedFilesByAgent[managedAgentId] ?? {}) : {};
  const hasAnyDraft = Object.values(draftByFile).some((draft) => Boolean(draft));
  const hasApprovedDraft = Object.values(draftByFile).some((draft) => Boolean(draft) && !draft?.needsReview);
  const applySucceeded = managedAgentId ? Boolean(draftApplySuccessByAgent[managedAgentId]) : false;
  const applyingDraft = managedAgentId ? Boolean(draftApplyingByAgent[managedAgentId]) : false;
  const draftRawOutput = managedAgentId ? (draftRawOutputByAgent[managedAgentId] ?? '') : '';
  const hasAvailableModels = availableModels.length > 0;
  const showNoModelGuide = !modelsLoading && !hasAvailableModels;

  useEffect(() => {
    void loadAgents();
    void loadAvailableModels();
  }, [loadAgents, loadAvailableModels]);

  useEffect(() => {
    const isGatewayRunning = gatewayState === 'running';
    if (isGatewayRunning && !wasGatewayRunningRef.current) {
      void loadAgents();
      void loadAvailableModels();
    }
    wasGatewayRunningRef.current = isGatewayRunning;
  }, [gatewayState, loadAgents, loadAvailableModels]);

  useEffect(() => {
    if (!managedAgentId) {
      return;
    }
    void loadPersistedFilesForAgent(managedAgentId);
  }, [managedAgentId, loadPersistedFilesForAgent]);

  useEffect(() => {
    let cancelled = false;
    const loadTemplateCatalog = async () => {
      setTemplatesLoading(true);
      setTemplateError(null);
      try {
        const catalog = await getSubagentTemplateCatalog();
        if (!cancelled) {
          setTemplateCatalog(catalog);
        }
      } catch (error) {
        if (!cancelled) {
          setTemplateCatalog({ categories: [], templates: [] });
          setTemplateError(error instanceof Error ? error.message : 'Failed to load templates');
        }
      } finally {
        if (!cancelled) {
          setTemplatesLoading(false);
        }
      }
    };
    void loadTemplateCatalog();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let rafId: number | undefined;
    let timeoutId: number | undefined;
    let idleId: number | undefined;

    const markReady = () => {
      if (!cancelled) {
        setSubagentsHeavyContentReady(true);
      }
    };

    const scheduleIdle = () => {
      if ('requestIdleCallback' in window && typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(markReady, { timeout: SUBAGENTS_HEAVY_CONTENT_IDLE_TIMEOUT_MS });
      } else {
        timeoutId = window.setTimeout(markReady, 120);
      }
    };

    rafId = window.requestAnimationFrame(() => {
      scheduleIdle();
    });

    return () => {
      cancelled = true;
      if (typeof rafId === 'number') {
        window.cancelAnimationFrame(rafId);
      }
      if (typeof timeoutId === 'number') {
        window.clearTimeout(timeoutId);
      }
      if (typeof idleId === 'number' && 'cancelIdleCallback' in window && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      }
    };
  }, []);

  const templateCategoryCountById = useMemo(() => {
    if (!subagentsHeavyContentReady) {
      return new Map<string, number>();
    }
    const counts = new Map<string, number>();
    for (const template of templateCatalog.templates) {
      const categoryId = template.categoryId?.trim();
      if (!categoryId) {
        continue;
      }
      counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1);
    }
    return counts;
  }, [subagentsHeavyContentReady, templateCatalog.templates]);

  const templateCategories = useMemo(() => {
    if (!subagentsHeavyContentReady) {
      return [];
    }
    const usedCategoryIds = new Set(templateCategoryCountById.keys());
    const categoriesFromCatalog = templateCatalog.categories
      .filter((category) => usedCategoryIds.has(category.id))
      .sort((a, b) => {
        const aOrder = a.order ?? Number.MAX_SAFE_INTEGER;
        const bOrder = b.order ?? Number.MAX_SAFE_INTEGER;
        if (aOrder !== bOrder) {
          return aOrder - bOrder;
        }
        return a.id.localeCompare(b.id);
      });

    const knownIds = new Set(categoriesFromCatalog.map((category) => category.id));
    const fallbackCategories = [...usedCategoryIds]
      .filter((id) => !knownIds.has(id))
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({ id }));
    return [...categoriesFromCatalog, ...fallbackCategories];
  }, [subagentsHeavyContentReady, templateCatalog.categories, templateCategoryCountById]);

  const filteredTemplates = useMemo(() => {
    if (!subagentsHeavyContentReady) {
      return [];
    }
    if (selectedTemplateCategory === 'all') {
      return templateCatalog.templates;
    }
    return templateCatalog.templates.filter((template) => template.categoryId === selectedTemplateCategory);
  }, [selectedTemplateCategory, subagentsHeavyContentReady, templateCatalog.templates]);
  const deferredFilteredTemplates = useDeferredValue(filteredTemplates);
  const visibleTemplates = useMemo(
    () => deferredFilteredTemplates.slice(0, visibleTemplateCount),
    [deferredFilteredTemplates, visibleTemplateCount],
  );
  const displayedTemplateCount = Math.min(visibleTemplateCount, deferredFilteredTemplates.length);

  useEffect(() => {
    if (!templatesExpanded) {
      return;
    }
    setVisibleTemplateCount(INITIAL_TEMPLATE_CARD_BATCH);
  }, [selectedTemplateCategory, templatesExpanded]);

  const appendVisibleTemplates = useCallback(() => {
    setVisibleTemplateCount((prev) => {
      if (prev >= deferredFilteredTemplates.length) {
        return prev;
      }
      return Math.min(prev + TEMPLATE_CARD_BATCH_SIZE, deferredFilteredTemplates.length);
    });
  }, [deferredFilteredTemplates.length]);

  const handleTemplateCardScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (displayedTemplateCount >= deferredFilteredTemplates.length) {
      return;
    }
    const target = event.currentTarget;
    const remain = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (remain <= TEMPLATE_CARD_SCROLL_THRESHOLD_PX) {
      appendVisibleTemplates();
    }
  }, [appendVisibleTemplates, deferredFilteredTemplates.length, displayedTemplateCount]);

  useEffect(() => {
    if (!templatesExpanded || !subagentsHeavyContentReady) {
      return;
    }
    if (displayedTemplateCount >= deferredFilteredTemplates.length) {
      return;
    }
    const container = templateCardScrollRef.current;
    if (!container) {
      return;
    }
    if (container.scrollHeight <= container.clientHeight + 8) {
      appendVisibleTemplates();
    }
  }, [
    appendVisibleTemplates,
    deferredFilteredTemplates.length,
    displayedTemplateCount,
    subagentsHeavyContentReady,
    templatesExpanded,
    visibleTemplates.length,
  ]);

  useEffect(() => {
    if (!subagentsHeavyContentReady || selectedTemplateCategory === 'all') {
      return;
    }
    const exists = templateCategories.some((category) => category.id === selectedTemplateCategory);
    if (!exists) {
      setSelectedTemplateCategory('all');
    }
  }, [selectedTemplateCategory, subagentsHeavyContentReady, templateCategories]);

  const prefetchTemplateDetail = useCallback((templateId: string) => {
    const normalizedId = templateId.trim();
    if (!normalizedId) {
      return;
    }
    if (prefetchedTemplateIdsRef.current.has(normalizedId)) {
      return;
    }
    prefetchedTemplateIdsRef.current.add(normalizedId);
    void prefetchSubagentTemplateById(normalizedId).catch(() => {
      prefetchedTemplateIdsRef.current.delete(normalizedId);
    });
  }, []);

  useEffect(() => {
    if (!subagentsHeavyContentReady || !templatesExpanded || templatesLoading || deferredFilteredTemplates.length === 0) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | undefined;
    let idleId: number | undefined;

    const sleep = (ms: number) => new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms);
    });

    const runPrefetch = async () => {
      for (const template of deferredFilteredTemplates.slice(0, 4)) {
        if (cancelled) {
          return;
        }
        prefetchTemplateDetail(template.id);
        await sleep(80);
      }
    };

    if ('requestIdleCallback' in window && typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(() => {
        void runPrefetch();
      }, { timeout: 500 });
    } else {
      timeoutId = window.setTimeout(() => {
        void runPrefetch();
      }, 120);
    }

    return () => {
      cancelled = true;
      if (typeof timeoutId === 'number') {
        window.clearTimeout(timeoutId);
      }
      if (typeof idleId === 'number' && 'cancelIdleCallback' in window && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      }
    };
  }, [deferredFilteredTemplates, prefetchTemplateDetail, subagentsHeavyContentReady, templatesExpanded, templatesLoading]);

  const editingAgent: SubagentSummary | undefined = editingAgentId
    ? agents.find((agent) => agent.id === editingAgentId)
    : undefined;

  const openCreateDialog = () => {
    setDialogMode('create');
    setEditingAgentId(null);
    setDialogOpen(true);
  };

  const openEditDialog = (agentId: string) => {
    setDialogMode('edit');
    setEditingAgentId(agentId);
    setDialogOpen(true);
  };

  const handleLoadTemplate = async (templateId: string) => {
    const requestId = templateLoadRequestIdRef.current + 1;
    templateLoadRequestIdRef.current = requestId;
    setTemplateLoadingId(templateId);
    setTemplateError(null);
    setTemplateDialogOpen(true);
    setTemplateDialogLoading(true);
    setActiveTemplate(null);
    try {
      const detail = await getSubagentTemplateById(templateId);
      if (templateLoadRequestIdRef.current !== requestId) {
        return;
      }
      setActiveTemplate(detail);
    } catch (error) {
      if (templateLoadRequestIdRef.current !== requestId) {
        return;
      }
      setTemplateDialogOpen(false);
      setTemplateError(error instanceof Error ? error.message : 'Failed to load template');
    } finally {
      if (templateLoadRequestIdRef.current === requestId) {
        setTemplateDialogLoading(false);
        setTemplateLoadingId(null);
      }
    }
  };

  const closeManageDialog = async () => {
    const agentId = managedAgentId;
    if (!agentId) {
      setManagedAgentId(null);
      return;
    }
    try {
      await cancelDraft(agentId);
    } catch {
      // Error state is already set by store.
    } finally {
      setManagedAgentId(null);
    }
  };

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Button onClick={openCreateDialog}>{t('newSubagent')}</Button>
      </header>

      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {showNoModelGuide && (
        <div className="rounded-md border border-amber-300/60 bg-amber-50/70 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <p>{t('modelGuide.description')}</p>
          <div className="mt-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => navigate('/providers')}
            >
              {t('modelGuide.action')}
            </Button>
          </div>
        </div>
      )}

      <section className="space-y-3 rounded-lg border bg-card/40 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{t('templates.title')}</h2>
            <p className="text-xs text-muted-foreground">
              {t('templates.subtitle', { count: templateCatalog.templates.length })}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-expanded={templatesExpanded}
              onClick={() => setTemplatesExpanded((prev) => !prev)}
            >
              <ChevronDown className={`mr-1 h-4 w-4 transition-transform ${templatesExpanded ? 'rotate-180' : ''}`} />
              {templatesExpanded ? t('templates.collapse') : t('templates.expand')}
            </Button>
          </div>
        </div>

        {templatesExpanded && !subagentsHeavyContentReady && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={`subagents-template-filter-placeholder-${index}`} className="h-8 w-20 animate-pulse rounded-md bg-muted" />
              ))}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={`subagents-template-card-placeholder-${index}`} className="rounded-md border bg-background p-3">
                  <div className="h-4 w-3/5 animate-pulse rounded bg-muted" />
                  <div className="mt-2 h-3 w-4/5 animate-pulse rounded bg-muted" />
                  <div className="mt-4 h-8 w-full animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          </div>
        )}
        {templatesExpanded && subagentsHeavyContentReady && templatesLoading && (
          <p className="text-sm text-muted-foreground">{t('templates.loading')}</p>
        )}
        {templatesExpanded && subagentsHeavyContentReady && !templatesLoading && templateError && (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive">
            {t('templates.error', { message: templateError })}
          </p>
        )}
        {templatesExpanded && subagentsHeavyContentReady && !templatesLoading && !templateError && templateCatalog.templates.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('templates.empty')}</p>
        )}
        {templatesExpanded && subagentsHeavyContentReady && !templatesLoading && !templateError && templateCatalog.templates.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant={selectedTemplateCategory === 'all' ? 'default' : 'outline'}
                onClick={() => setSelectedTemplateCategory('all')}
              >
                {t('templates.categories.all')} ({templateCatalog.templates.length})
              </Button>
              {templateCategories.map((category) => (
                <Button
                  key={category.id}
                  type="button"
                  size="sm"
                  variant={selectedTemplateCategory === category.id ? 'default' : 'outline'}
                  onClick={() => setSelectedTemplateCategory(category.id)}
                >
                  {t(`templates.categories.${category.id}`, { defaultValue: category.id })} (
                  {templateCategoryCountById.get(category.id) ?? 0})
                </Button>
              ))}
            </div>
            {deferredFilteredTemplates.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('templates.empty')}</p>
            ) : (
              <>
                <div
                  ref={templateCardScrollRef}
                  className="max-h-[56vh] overflow-y-auto pr-1"
                  onScroll={handleTemplateCardScroll}
                >
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {visibleTemplates.map((template) => {
                      const localizedTemplateName = tTemplate(`templates.${template.id}.name`, { defaultValue: template.name });
                      const localizedSummary = tTemplate(`templates.${template.id}.summary`, { defaultValue: template.summary ?? '' }) || '';
                      return (
                        <article
                          key={template.id}
                          className="rounded-md border bg-background p-3"
                          onMouseEnter={() => prefetchTemplateDetail(template.id)}
                          onFocus={() => prefetchTemplateDetail(template.id)}
                          onMouseDown={() => prefetchTemplateDetail(template.id)}
                        >
                          <div className="flex items-start gap-3">
                            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-base">
                              {template.emoji || '\uD83E\uDD16'}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-2">
                                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">
                                  {localizedTemplateName}
                                </h3>
                                <span className="shrink-0 whitespace-nowrap rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium leading-none text-primary">
                                  {t('templates.badge')}
                                </span>
                              </div>
                              <p className="truncate text-xs text-muted-foreground">{template.id}</p>
                              {localizedSummary && (
                                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                                  {localizedSummary}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="mt-3">
                            <Button
                              size="sm"
                              variant="outline"
                              className="w-full"
                              disabled={templateLoadingId === template.id || modelsLoading || availableModels.length === 0}
                              onClick={() => {
                                void handleLoadTemplate(template.id);
                              }}
                              onMouseEnter={() => prefetchTemplateDetail(template.id)}
                              onFocus={() => prefetchTemplateDetail(template.id)}
                            >
                              {templateLoadingId === template.id ? t('templates.loadingButton') : t('templates.load')}
                            </Button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </div>
                {displayedTemplateCount < deferredFilteredTemplates.length && (
                  <div className="rounded-md border border-dashed px-3 py-2 text-center">
                    <p className="text-xs text-muted-foreground">
                      {t('templates.pagination.showing', { shown: displayedTemplateCount, total: deferredFilteredTemplates.length })}
                    </p>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </section>

      {!subagentsHeavyContentReady ? (
        <div data-testid="subagent-card-grid" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={`subagents-card-placeholder-${index}`} className="rounded-lg border bg-card p-4">
              <div className="h-5 w-2/5 animate-pulse rounded bg-muted" />
              <div className="mt-3 h-3 w-4/5 animate-pulse rounded bg-muted" />
              <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted" />
              <div className="mt-4 h-8 w-full animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      ) : (
        <div data-testid="subagent-card-grid" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => (
            <SubagentCard
              key={agent.id}
              agent={agent}
              editLocked={false}
              deleteLocked={Boolean(agent.isDefault)}
              manageLocked={false}
              modelReady={Boolean(agent.model?.trim())}
              onEdit={() => openEditDialog(agent.id)}
              onDelete={() => {
                setDeletingAgentId(agent.id);
              }}
              onManage={() => {
                setManagedAgentId(agent.id);
              }}
              onChat={() => {
                const query = new URLSearchParams({ agent: agent.id }).toString();
                navigate(`/?${query}`);
              }}
            />
          ))}
        </div>
      )}

      {subagentsHeavyContentReady && !loading && agents.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      )}
      <SubagentDeleteDialog
        open={Boolean(deletingAgentId)}
        agentId={deletingAgentId}
        deleting={deleting}
        onConfirm={async () => {
          if (!deletingAgentId) {
            return;
          }
          setDeleting(true);
          try {
            await deleteAgent(deletingAgentId);
            setDeletingAgentId(null);
          } finally {
            setDeleting(false);
          }
        }}
        onClose={() => setDeletingAgentId(null)}
      />
      <SubagentManageDialog
        open={Boolean(managedAgentId)}
        agentId={managedAgentId}
        draftPrompt={draftPrompt}
        generatingDraft={generatingDraft}
        applyingDraft={applyingDraft}
        hasAnyDraft={hasAnyDraft}
        hasApprovedDraft={hasApprovedDraft}
        applySucceeded={applySucceeded}
        draftByFile={draftByFile}
        draftError={draftError}
        draftRawOutput={draftRawOutput}
        previewDiffByFile={previewDiffByFile}
        persistedContentByFile={persistedContentByFile}
        onDraftPromptChange={(prompt) => {
          if (!managedAgentId) {
            return;
          }
          setDraftPromptForAgent(managedAgentId, prompt);
        }}
        onGenerateDraft={async () => {
          if (!managedAgentId || !draftPrompt.trim()) {
            return;
          }
          try {
            await generateDraftFromPrompt(managedAgentId, draftPrompt.trim());
          } catch {
            // Error state is already set by store.
          }
        }}
        onGenerateDiffPreview={generatePreviewDiffByFile}
        onApplyDraft={async () => {
          if (!managedAgentId) {
            return;
          }
          try {
            await applyDraft(managedAgentId);
          } catch {
            // Error state is already set by store.
          }
        }}
        onClose={() => {
          void closeManageDialog();
        }}
      />

      <SubagentFormDialog
        open={dialogOpen}
        mode={dialogMode}
        lockBasicInfo={Boolean(dialogMode === 'edit' && editingAgent?.isDefault)}
        title={dialogMode === 'create' ? t('createDialogTitle') : t('editDialogTitle')}
        existingAgents={agents}
        modelOptions={availableModels}
        modelsLoading={modelsLoading}
        initialValues={editingAgent}
        onSubmit={async (values) => {
          if (dialogMode === 'create') {
            try {
              const createdAgentId = await createAgent({
                name: values.name,
                workspace: values.workspace,
                model: values.model,
                ...(values.emoji ? { emoji: values.emoji } : {}),
              });
              const resolvedAgentId = createdAgentId || normalizeSubagentNameToSlug(values.name);
              setManagedAgentId(resolvedAgentId);
              void loadPersistedFilesForAgent(resolvedAgentId);
              setDraftPromptForAgent(resolvedAgentId, values.prompt);
              setDialogOpen(false);
            } catch {
              // Error state is already set by store; keep dialog open for user correction/retry.
            }
            return;
          }
          if (!editingAgentId) {
            return;
          }
          const isDefaultAgent = Boolean(editingAgent?.isDefault);
          const resolvedName = isDefaultAgent
            ? (editingAgent?.name ?? values.name)
            : values.name;
          let resolvedWorkspace = isDefaultAgent
            ? (editingAgent?.workspace ?? values.workspace)
            : values.workspace;
          if (isDefaultAgent && !resolvedWorkspace.trim()) {
            try {
              const rawWorkspaceDir = await invokeIpc<unknown>('openclaw:getWorkspaceDir');
              const workspaceDir = typeof rawWorkspaceDir === 'string' ? rawWorkspaceDir.trim() : '';
              if (workspaceDir) {
                resolvedWorkspace = workspaceDir;
              }
            } catch {
              // best-effort fallback only
            }
          }
          await updateAgent({
            agentId: editingAgentId,
            name: resolvedName,
            workspace: resolvedWorkspace,
            model: values.model || undefined,
          });
          setDialogOpen(false);
        }}
        onClose={() => setDialogOpen(false)}
      />

      <SubagentTemplateLoadDialog
        open={templateDialogOpen}
        loading={templateDialogLoading}
        template={activeTemplate}
        modelOptions={availableModels}
        modelsLoading={modelsLoading}
        submitting={templateDialogSubmitting}
        onSubmit={async (modelId) => {
          if (!activeTemplate) {
            return;
          }
          setTemplateDialogSubmitting(true);
          try {
            const localizedTemplateName = tTemplate(`templates.${activeTemplate.id}.name`, {
              defaultValue: activeTemplate.name,
            });
            const createdAgentId = await createAgentFromTemplate({
              template: activeTemplate,
              model: modelId,
              localizedName: localizedTemplateName,
            });
            setManagedAgentId(createdAgentId);
            void loadPersistedFilesForAgent(createdAgentId);
            setTemplateDialogOpen(false);
          } finally {
            setTemplateDialogSubmitting(false);
          }
        }}
        onClose={() => {
          templateLoadRequestIdRef.current += 1;
          setTemplateDialogOpen(false);
          setTemplateDialogLoading(false);
          setActiveTemplate(null);
        }}
      />
    </section>
  );
}

export default SubAgents;
