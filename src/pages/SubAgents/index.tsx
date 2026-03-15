import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { normalizeSubagentNameToSlug } from '@/features/subagents/domain/workspace';
import { buildSettingsSectionLink } from '@/lib/sections';
import { getSubagentTemplateById, getSubagentTemplateCatalog } from '@/services/openclaw/subagent-template-catalog';
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
  const [templateDialogSubmitting, setTemplateDialogSubmitting] = useState(false);
  const [activeTemplate, setActiveTemplate] = useState<SubagentTemplateDetail | null>(null);
  const gatewayState = useGatewayStore((state) => state.status.state);
  const wasGatewayRunningRef = useRef(gatewayState === 'running');
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

  const templateCategoryCountById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const template of templateCatalog.templates) {
      const categoryId = template.categoryId?.trim();
      if (!categoryId) {
        continue;
      }
      counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1);
    }
    return counts;
  }, [templateCatalog.templates]);

  const templateCategories = useMemo(() => {
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
  }, [templateCatalog.categories, templateCategoryCountById]);

  const filteredTemplates = useMemo(() => {
    if (selectedTemplateCategory === 'all') {
      return templateCatalog.templates;
    }
    return templateCatalog.templates.filter((template) => template.categoryId === selectedTemplateCategory);
  }, [selectedTemplateCategory, templateCatalog.templates]);

  useEffect(() => {
    if (selectedTemplateCategory === 'all') {
      return;
    }
    const exists = templateCategories.some((category) => category.id === selectedTemplateCategory);
    if (!exists) {
      setSelectedTemplateCategory('all');
    }
  }, [selectedTemplateCategory, templateCategories]);

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
    setTemplateLoadingId(templateId);
    setTemplateError(null);
    try {
      const detail = await getSubagentTemplateById(templateId);
      setActiveTemplate(detail);
      setTemplateDialogOpen(true);
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : 'Failed to load template');
    } finally {
      setTemplateLoadingId(null);
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
              onClick={() => navigate(buildSettingsSectionLink('aiProviders'))}
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

        {templatesExpanded && templatesLoading && (
          <p className="text-sm text-muted-foreground">{t('templates.loading')}</p>
        )}
        {templatesExpanded && !templatesLoading && templateError && (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive">
            {t('templates.error', { message: templateError })}
          </p>
        )}
        {templatesExpanded && !templatesLoading && !templateError && templateCatalog.templates.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('templates.empty')}</p>
        )}
        {templatesExpanded && !templatesLoading && !templateError && templateCatalog.templates.length > 0 && (
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
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filteredTemplates.map((template) => (
              <article key={template.id} className="rounded-md border bg-background p-3">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-base">
                    {template.emoji || '\uD83E\uDD16'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">
                        {tTemplate(`templates.${template.id}.name`, { defaultValue: template.name })}
                      </h3>
                      <span className="shrink-0 whitespace-nowrap rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium leading-none text-primary">
                        {t('templates.badge')}
                      </span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{template.id}</p>
                    {(
                      tTemplate(`templates.${template.id}.summary`, { defaultValue: template.summary ?? '' }) || ''
                    ) && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {tTemplate(`templates.${template.id}.summary`, { defaultValue: template.summary ?? '' })}
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
                  >
                    {templateLoadingId === template.id ? t('templates.loadingButton') : t('templates.load')}
                  </Button>
                </div>
              </article>
              ))}
            </div>
          </>
        )}
      </section>

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

      {!loading && agents.length === 0 && (
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
          await updateAgent({
            agentId: editingAgentId,
            name: values.name,
            workspace: values.workspace,
            model: values.model || undefined,
          });
          setDialogOpen(false);
        }}
        onClose={() => setDialogOpen(false)}
      />

      <SubagentTemplateLoadDialog
        open={templateDialogOpen}
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
          setTemplateDialogOpen(false);
          setActiveTemplate(null);
        }}
      />
    </section>
  );
}

export default SubAgents;
