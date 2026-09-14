import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, Plus, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { AgentPage, AgentPageSection, AgentResourceCard, AgentResourceGrid } from '@/components/common/AgentPage';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { invokeIpc } from '@/lib/api-client';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import { normalizeSubagentNameToSlug } from '@/features/subagents/domain/workspace';
import {
  getSubagentTemplateById,
  getSubagentTemplateCatalog,
} from '@/services/openclaw/subagent-template-catalog';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentSkillConfigStore } from '@/stores/agent-skill-config';
import { useAgentToolConfigStore } from '@/stores/agent-tool-config';
import { useSubagentsStore } from '@/stores/subagents';
import type { SubagentCloudPackage, SubagentSummary, SubagentTemplateCatalogResult, SubagentTemplateDetail } from '@/types/subagent';
import { useTranslation } from 'react-i18next';
import { isGatewayOperational, isGatewayRecovering } from '@/lib/gateway-status';
import { resolveModelCatalogEntry, resolveModelRuntimeReference } from '@/lib/provider-models';
import { SubagentCard } from './components/SubagentCard';
import { SubagentDeleteDialog } from './components/SubagentDeleteDialog';
import { SubagentFormDialog } from './components/SubagentFormDialog';
import { SubagentTemplateLoadDialog } from './components/SubagentTemplateLoadDialog';
import { SubagentTemplateLibrary } from './components/SubagentTemplateLibrary';
import { SubagentResourceToolbar } from './components/SubagentResourceToolbar';

type DialogMode = 'create' | 'edit';
type SubagentEditorTab = 'basic' | 'persona' | 'skills' | 'tools';
type AgentListState = 'starting' | 'loading' | 'ready';
const SUBAGENTS_HEAVY_CONTENT_IDLE_TIMEOUT_MS = 320;
const EMPTY_AGENTS: SubagentSummary[] = [];

function packageLabel(packageInfo: SubagentCloudPackage): string {
  return packageInfo.displayName?.trim()
    || packageInfo.name?.trim()
    || packageInfo.packageVersionId;
}

const AGENT_CONFIG_FILE_FILTERS = [
  { name: 'MatchaClaw Agent Config', extensions: ['matchaclaw-agent.json', 'json'] },
  { name: 'JSON', extensions: ['json'] },
  { name: 'All Files', extensions: ['*'] },
];

export function SubAgents() {
  const { t } = useTranslation('subagents');
  const { t: tTemplate } = useTranslation('subagentTemplates');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') === 'templates' ? 'templates' : 'agents';
  const agentSearch = searchParams.get('search') ?? '';
  const agentView = searchParams.get('view') === 'list' ? 'list' : 'grid';
  const deferredAgentSearch = useDeferredValue(agentSearch.trim().toLocaleLowerCase());
  const updateAgentQuery = (key: string, value: string, defaultValue = '') => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value === defaultValue) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: key !== 'tab' });
  };
  const agentsResource = useSubagentsStore((state) => state.agentsResource);
  const agents = Array.isArray(agentsResource.data) ? agentsResource.data : EMPTY_AGENTS;
  const cloudPackages = useSubagentsStore((state) => state.cloudPackages);
  const loadCloudPackages = useSubagentsStore((state) => state.loadCloudPackages);
  const mutating = useSubagentsStore((state) => state.mutating);
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
  const draftIncludeCurrentFilesByAgent = useSubagentsStore((state) => state.draftIncludeCurrentFilesByAgent);
  const persistedFilesByAgent = useSubagentsStore((state) => state.persistedFilesByAgent);
  const previewDiffByFile = useSubagentsStore((state) => state.previewDiffByFile);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const loadAvailableModels = useSubagentsStore((state) => state.loadAvailableModels);
  const setManagedAgentId = useSubagentsStore((state) => state.setManagedAgentId);
  const loadPersistedFilesForAgent = useSubagentsStore((state) => state.loadPersistedFilesForAgent);
  const setDraftPromptForAgent = useSubagentsStore((state) => state.setDraftPromptForAgent);
  const setDraftIncludeCurrentFilesForAgent = useSubagentsStore((state) => state.setDraftIncludeCurrentFilesForAgent);
  const cancelDraft = useSubagentsStore((state) => state.cancelDraft);
  const createAgent = useSubagentsStore((state) => state.createAgent);
  const updateAgent = useSubagentsStore((state) => state.updateAgent);
  const deleteAgent = useSubagentsStore((state) => state.deleteAgent);
  const exportAgentConfig = useSubagentsStore((state) => state.exportAgentConfig);
  const exportAgentPackage = useSubagentsStore((state) => state.exportAgentPackage);
  const uploadAgentPackageToCloud = useSubagentsStore((state) => state.uploadAgentPackageToCloud);
  const downloadAgentPackageFromCloud = useSubagentsStore((state) => state.downloadAgentPackageFromCloud);
  const installAgentPackageFromCloud = useSubagentsStore((state) => state.installAgentPackageFromCloud);
  const importAgentConfig = useSubagentsStore((state) => state.importAgentConfig);
  const createAgentFromTemplate = useSubagentsStore((state) => state.createAgentFromTemplate);
  const generateDraftFromPrompt = useSubagentsStore((state) => state.generateDraftFromPrompt);
  const generatePreviewDiffByFile = useSubagentsStore((state) => state.generatePreviewDiffByFile);
  const applyDraft = useSubagentsStore((state) => state.applyDraft);
  const skillConfigViewByAgentId = useAgentSkillConfigStore((state) => state.viewByAgentId);
  const skillConfigLoadingByAgentId = useAgentSkillConfigStore((state) => state.loadingByAgentId);
  const skillConfigErrorByAgentId = useAgentSkillConfigStore((state) => state.errorByAgentId);
  const loadAgentSkillConfig = useAgentSkillConfigStore((state) => state.loadAgentSkillConfig);
  const setAgentSkillConfig = useAgentSkillConfigStore((state) => state.setAgentSkillConfig);
  const toolConfigViewByAgentId = useAgentToolConfigStore((state) => state.viewByAgentId);
  const toolConfigLoadingByAgentId = useAgentToolConfigStore((state) => state.loadingByAgentId);
  const toolConfigErrorByAgentId = useAgentToolConfigStore((state) => state.errorByAgentId);
  const loadAgentToolConfig = useAgentToolConfigStore((state) => state.loadAgentToolConfig);
  const setAgentToolConfig = useAgentToolConfigStore((state) => state.setAgentToolConfig);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<DialogMode>('create');
  const [dialogInitialTab, setDialogInitialTab] = useState<SubagentEditorTab>('basic');
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [templateCatalog, setTemplateCatalog] = useState<SubagentTemplateCatalogResult>({ categories: [], templates: [] });
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templateLoadingId, setTemplateLoadingId] = useState<string | null>(null);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [templateDialogLoading, setTemplateDialogLoading] = useState(false);
  const [templateDialogSubmitting, setTemplateDialogSubmitting] = useState(false);
  const [cloudPackagesOpen, setCloudPackagesOpen] = useState(false);
  const [activeTemplate, setActiveTemplate] = useState<SubagentTemplateDetail | null>(null);
  const [subagentsHeavyContentReady, setSubagentsHeavyContentReady] = useState(
    () => import.meta.env.MODE === 'test' || agents.length > 0 || agentsResource.hasLoadedOnce,
  );
  const gatewayInitialized = useGatewayStore((state) => state.isInitialized);
  const gatewayStatus = useGatewayStore((state) => state.status);
  const gatewayOperational = isGatewayOperational(gatewayStatus);
  const templateLoadRequestIdRef = useRef(0);
  const hasRequestedAgentsForCurrentGatewayRunRef = useRef(false);
  const draftPrompt = managedAgentId ? (draftPromptByAgent[managedAgentId] ?? '') : '';
  const generatingDraft = managedAgentId ? Boolean(draftGeneratingByAgent[managedAgentId]) : false;
  const includeCurrentFiles = managedAgentId ? Boolean(draftIncludeCurrentFilesByAgent[managedAgentId]) : false;
  const persistedContentByFile = managedAgentId ? (persistedFilesByAgent[managedAgentId] ?? {}) : {};
  const hasAnyDraft = Object.values(draftByFile).some((draft) => Boolean(draft));
  const hasApprovedDraft = Object.values(draftByFile).some((draft) => Boolean(draft) && !draft?.needsReview);
  const applySucceeded = managedAgentId ? Boolean(draftApplySuccessByAgent[managedAgentId]) : false;
  const applyingDraft = managedAgentId ? Boolean(draftApplyingByAgent[managedAgentId]) : false;
  const draftRawOutput = managedAgentId ? (draftRawOutputByAgent[managedAgentId] ?? '') : '';
  const editingSkillConfigView = editingAgentId ? (skillConfigViewByAgentId[editingAgentId] ?? null) : null;
  const editingSkillConfigLoading = editingAgentId ? Boolean(skillConfigLoadingByAgentId[editingAgentId]) : false;
  const editingSkillConfigError = editingAgentId ? (skillConfigErrorByAgentId[editingAgentId] ?? null) : null;
  const editingToolConfigView = editingAgentId ? (toolConfigViewByAgentId[editingAgentId] ?? null) : null;
  const editingToolConfigLoading = editingAgentId ? Boolean(toolConfigLoadingByAgentId[editingAgentId]) : false;
  const editingToolConfigError = editingAgentId ? (toolConfigErrorByAgentId[editingAgentId] ?? null) : null;
  const hasAvailableModels = availableModels.length > 0;
  const hasAgentCards = agents.length > 0;
  const gatewayPending = !gatewayInitialized || isGatewayRecovering(gatewayStatus);
  const agentListState: AgentListState = gatewayPending && !agentsResource.hasLoadedOnce
    ? 'starting'
    : (!hasAgentCards && !agentsResource.hasLoadedOnce && (
      agentsResource.status === 'loading'
      || agentsResource.status === 'idle'
      || !subagentsHeavyContentReady
    ) ? 'loading' : 'ready');
  const showNoModelGuide = agentListState !== 'starting' && !modelsLoading && !hasAvailableModels;
  const showRefreshingHint = useDelayedFlag(
    agentsResource.hasLoadedOnce && agentsResource.status === 'loading',
    180,
  );

  useEffect(() => {
    if (!gatewayOperational) {
      return;
    }
    void loadAvailableModels();
    void loadCloudPackages().catch(() => undefined);
  }, [gatewayOperational, loadAvailableModels, loadCloudPackages]);

  useEffect(() => {
    if (!gatewayOperational) {
      hasRequestedAgentsForCurrentGatewayRunRef.current = false;
      return;
    }
    if (hasRequestedAgentsForCurrentGatewayRunRef.current) {
      return;
    }
    hasRequestedAgentsForCurrentGatewayRunRef.current = true;
    if (agentsResource.status !== 'loading') {
      void loadAgents({ silent: true });
    }
  }, [agentsResource.status, gatewayOperational, loadAgents]);

  useEffect(() => {
    if (!managedAgentId) {
      return;
    }
    void loadPersistedFilesForAgent(managedAgentId);
  }, [managedAgentId, loadPersistedFilesForAgent]);

  useEffect(() => {
    if (!managedAgentId || dialogOpen || editingAgentId) {
      return;
    }
    const managedAgent = agents.find((agent) => agent.id === managedAgentId);
    if (managedAgent?.sealed) {
      setManagedAgentId(null);
      toast.error(t('sealed.editDisabled'));
      return;
    }
    setDialogMode('edit');
    setDialogInitialTab('persona');
    setEditingAgentId(managedAgentId);
    setDialogOpen(true);
  }, [agents, dialogOpen, editingAgentId, managedAgentId, setManagedAgentId, t]);

  useEffect(() => {
    if (!editingAgentId || !dialogOpen || dialogMode !== 'edit') {
      return;
    }
    void loadAgentSkillConfig(editingAgentId).catch(() => {
      // Error state is already set by the skill config store.
    });
    void loadAgentToolConfig(editingAgentId).catch(() => {
      // Error state is already set by the tool config store.
    });
  }, [dialogMode, dialogOpen, editingAgentId, loadAgentSkillConfig, loadAgentToolConfig]);

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
    if (agents.length > 0 && !subagentsHeavyContentReady) {
      setSubagentsHeavyContentReady(true);
    }
  }, [agents.length, subagentsHeavyContentReady]);

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

  const filteredAgents = useMemo(() => {
    if (!deferredAgentSearch) return agents;
    return agents.filter((agent) => (
      `${agent.id} ${agent.name ?? ''} ${agent.description ?? ''} ${agent.model ?? ''}`
        .toLocaleLowerCase().includes(deferredAgentSearch)
    ));
  }, [agents, deferredAgentSearch]);

  const editingAgent: SubagentSummary | undefined = editingAgentId
    ? (agents.find((agent) => agent.id === editingAgentId) ?? (editingAgentId === managedAgentId ? { id: editingAgentId, name: editingAgentId } : undefined))
    : undefined;

  const openCreateDialog = () => {
    setDialogMode('create');
    setDialogInitialTab('basic');
    setEditingAgentId(null);
    setManagedAgentId(null);
    setDialogOpen(true);
  };

  const openEditDialog = (agentId: string, initialTab: SubagentEditorTab = 'basic') => {
    const agent = agents.find((entry) => entry.id === agentId);
    if (agent?.sealed) {
      toast.error(t('sealed.editDisabled'));
      return;
    }
    setDialogMode('edit');
    setDialogInitialTab(initialTab);
    setEditingAgentId(agentId);
    setManagedAgentId(agentId);
    setDialogOpen(true);
  };

  const handleLoadTemplate = useCallback(async (templateId: string) => {
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
  }, []);

  const handleLoadTemplateCard = useCallback((templateId: string) => {
    void handleLoadTemplate(templateId);
  }, [handleLoadTemplate]);

  const closeFormDialog = async () => {
    const agentId = managedAgentId;
    setDialogOpen(false);
    setEditingAgentId(null);
    setManagedAgentId(null);
    if (!agentId) {
      return;
    }
    try {
      await cancelDraft(agentId);
    } catch {
      // Error state is already set by store.
    }
  };

  const handleExportAgentConfig = useCallback(async (agent: SubagentSummary) => {
    if (agent.sealed) {
      toast.error(t('sealed.configExportDisabled'));
      return;
    }
    try {
      const packageData = await exportAgentConfig(agent.id);
      const fileNameBase = normalizeSubagentNameToSlug(packageData.agent.name) || agent.id;
      const result = await invokeIpc<{ canceled?: boolean; filePath?: string }>('dialog:writeSelectedTextFile', {
        title: t('transfer.exportDialogTitle'),
        defaultPath: `${fileNameBase}.matchaclaw-agent.json`,
        filters: AGENT_CONFIG_FILE_FILTERS,
      }, `${JSON.stringify(packageData, null, 2)}\n`);
      if (result?.canceled) {
        return;
      }
      toast.success(t('transfer.exportSuccess'));
    } catch (error) {
      toast.error(t('transfer.exportFailed', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [exportAgentConfig, t]);

  const handleExportAgentPackage = useCallback(async (agent: SubagentSummary) => {
    try {
      const result = await exportAgentPackage(agent.id);
      toast.success(t('transfer.exportPackageSuccess', { fileName: result.fileName }));
    } catch (error) {
      toast.error(t('transfer.exportPackageFailed', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [exportAgentPackage, t]);

  const handleUploadAgentPackageToCloud = useCallback(async (agent: SubagentSummary) => {
    try {
      const result = await uploadAgentPackageToCloud(agent.id);
      toast.success(t('transfer.uploadPackageSuccess', { fileName: result.fileName ?? agent.name ?? agent.id }));
      void loadCloudPackages().catch(() => undefined);
    } catch (error) {
      toast.error(t('transfer.uploadPackageFailed', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [loadCloudPackages, t, uploadAgentPackageToCloud]);

  const handleDownloadAgentPackageFromCloud = useCallback(async (packageInfo: SubagentCloudPackage) => {
    try {
      const result = await downloadAgentPackageFromCloud(packageInfo.packageVersionId);
      toast.success(t('transfer.downloadPackageSuccess', { fileName: result.fileName }));
    } catch (error) {
      toast.error(t('transfer.downloadPackageFailed', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [downloadAgentPackageFromCloud, t]);

  const handleInstallAgentPackageFromCloud = useCallback(async (packageInfo: SubagentCloudPackage) => {
    try {
      const result = await installAgentPackageFromCloud(packageInfo.packageVersionId);
      if (result.warning) {
        toast.warning(result.warning);
      } else {
        toast.success(t('transfer.installPackageSuccess', { agentId: result.agentId }));
      }
      void loadPersistedFilesForAgent(result.agentId);
    } catch (error) {
      toast.error(t('transfer.installPackageFailed', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [installAgentPackageFromCloud, loadPersistedFilesForAgent, t]);

  const handleImportAgentConfig = useCallback(async () => {
    try {
      const result = await invokeIpc<{ canceled?: boolean; filePath?: string; content?: string }>('dialog:readSelectedTextFile', {
        title: t('transfer.importDialogTitle'),
        properties: ['openFile'],
        filters: AGENT_CONFIG_FILE_FILTERS,
      });
      if (result?.canceled || typeof result?.content !== 'string') {
        return;
      }
      const importResult = await importAgentConfig(JSON.parse(result.content) as unknown);
      void loadPersistedFilesForAgent(importResult.agentId);
      setManagedAgentId(importResult.agentId);
      if (importResult.warning) {
        toast.warning(importResult.warning);
      } else {
        toast.success(t('transfer.importSuccess'));
      }
    } catch (error) {
      toast.error(t('transfer.importFailed', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [importAgentConfig, loadPersistedFilesForAgent, setManagedAgentId, t]);

  return (
    <AgentPage>
      <Tabs value={activeTab} onValueChange={(value) => updateAgentQuery('tab', value, 'agents')} className="space-y-6">
        <AgentPageSection actions={
          <>
            {(showRefreshingHint || mutating) && (
              <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="size-2 animate-pulse rounded-full bg-primary" />
                {mutating ? t('status.mutating') : t('status.refreshing')}
              </span>
            )}
            {agentListState !== 'starting' && (
              <Button variant="outline" size="sm" className="gap-2 rounded-full" onClick={handleImportAgentConfig}>
                <Upload className="size-4" aria-hidden="true" />
                {t('transfer.import')}
              </Button>
            )}
            {activeTab === 'agents' && agentListState !== 'starting' && (
              <Button size="sm" className="gap-2 rounded-full" onClick={openCreateDialog}>
                <Plus className="size-4" aria-hidden="true" />
                {t('newSubagent')}
              </Button>
            )}
          </>
        }>
          <TabsList variant="line" aria-label={t('title')}>
            <TabsTrigger value="agents" className="gap-2">
              {t('tabs.agents')}
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{agents.length}</span>
            </TabsTrigger>
            <TabsTrigger value="templates" className="gap-2">
              {t('tabs.templates')}
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{templateCatalog.templates.length}</span>
            </TabsTrigger>
          </TabsList>
        </AgentPageSection>

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

        <TabsContent value="templates" className="mt-0">
          {activeTab === 'templates' && (
            <SubagentTemplateLibrary
              catalog={templateCatalog}
              loading={templatesLoading || !subagentsHeavyContentReady}
              error={templateError}
              templateLoadingId={templateLoadingId}
              modelsUnavailable={modelsLoading || !hasAvailableModels}
              onLoad={handleLoadTemplateCard}
            />
          )}
        </TabsContent>
        <TabsContent value="agents" className="mt-0 space-y-6">
          {agentListState !== 'starting' && (
            <SubagentResourceToolbar
              search={agentSearch}
              onSearchChange={(value) => updateAgentQuery('search', value)}
              searchLabel={t('search.agents')}
              countLabel={t('results.agents', { total: filteredAgents.length })}
              view={agentView}
              onViewChange={(value) => updateAgentQuery('view', value, 'grid')}
            />
          )}
          {agentListState === 'starting' ? (
            <div role="status" className="flex min-h-[360px] flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border bg-card/60 p-8 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl border border-border bg-muted/40 text-muted-foreground">
                <Loader2 className="size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-medium text-foreground">{t('startup.title')}</h3>
                <p className="text-sm text-muted-foreground">{t('startup.description')}</p>
              </div>
            </div>
          ) : agentListState === 'loading' ? (
            <AgentResourceGrid data-testid="subagent-card-grid" aria-busy="true">
              {Array.from({ length: 6 }).map((_, index) => (
                <AgentResourceCard key={index} className="gap-5">
                  <div className="flex items-center gap-3">
                    <div className="size-10 animate-pulse rounded-xl bg-muted" />
                    <div className="h-4 w-2/5 animate-pulse rounded bg-muted" />
                  </div>
                  <div className="h-10 w-4/5 animate-pulse rounded bg-muted" />
                  <div className="h-7 w-full animate-pulse rounded bg-muted" />
                </AgentResourceCard>
              ))}
            </AgentResourceGrid>
          ) : (
            <AgentResourceGrid data-testid="subagent-card-grid" className={agentView === 'list' ? 'md:grid-cols-1 xl:grid-cols-1' : undefined}>
              {filteredAgents.map((agent) => (
                <SubagentCard
                  key={agent.id}
                  agent={agent}
                  compact={agentView === 'list'}
                  modelLabel={resolveModelCatalogEntry(availableModels, agent.model)?.modelLabel ?? agent.model?.trim()}
                  editLocked={(agent.kind === 'system' && !agent.isDefault) || Boolean(agent.sealed)}
                  deleteLocked={Boolean(agent.isDefault) || agent.kind === 'system'}
                  exportLocked={agent.kind === 'system' || Boolean(agent.sealed)}
                  packageExportLocked={agent.kind === 'system'}
                  modelReady={(agent.kind !== 'system' || Boolean(agent.isDefault)) && Boolean(agent.model?.trim())}
                  onEdit={() => openEditDialog(agent.id)}
                  onDelete={() => {
                    setDeletingAgentId(agent.id);
                  }}
                  onExport={() => {
                    void handleExportAgentConfig(agent);
                  }}
                  onExportPackage={() => {
                    void handleExportAgentPackage(agent);
                  }}
                  onUploadPackageToCloud={() => {
                    void handleUploadAgentPackageToCloud(agent);
                  }}
                  onOpenCloudPackages={() => {
                    setCloudPackagesOpen(true);
                  }}
                  onChat={() => {
                    const query = new URLSearchParams({ agent: agent.id }).toString();
                    navigate(`/?${query}`);
                  }}
                />
              ))}
            </AgentResourceGrid>
          )}
          {agentListState === 'ready' && agentsResource.hasLoadedOnce && filteredAgents.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">{t(agents.length ? 'search.empty' : 'empty')}</p>
          )}
        </TabsContent>
      </Tabs>
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
      <SubagentFormDialog
        open={dialogOpen}
        mode={dialogMode}
        agentId={editingAgentId}
        initialTab={dialogInitialTab}
        lockBasicInfo={Boolean(dialogMode === 'edit' && editingAgent?.isDefault)}
        title={dialogMode === 'create' ? t('createDialogTitle') : t('editDialogTitle')}
        existingAgents={agents}
        modelOptions={availableModels}
        modelsLoading={modelsLoading}
        initialValues={editingAgent}
        skillConfigView={editingSkillConfigView}
        skillConfigLoading={editingSkillConfigLoading}
        skillConfigError={editingSkillConfigError}
        toolConfigView={editingToolConfigView}
        toolConfigLoading={editingToolConfigLoading}
        toolConfigError={editingToolConfigError}
        draftPrompt={draftPrompt}
        generatingDraft={generatingDraft}
        applyingDraft={applyingDraft}
        includeCurrentFiles={includeCurrentFiles}
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
        onIncludeCurrentFilesChange={(nextIncludeCurrentFiles) => {
          if (!managedAgentId) {
            return;
          }
          setDraftIncludeCurrentFilesForAgent(managedAgentId, nextIncludeCurrentFiles);
        }}
        onGenerateDraft={async () => {
          if (!managedAgentId || !draftPrompt.trim()) {
            return;
          }
          try {
            await generateDraftFromPrompt({
              agentId: managedAgentId,
              prompt: draftPrompt.trim(),
              includeCurrentFiles,
            });
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
        onSubmit={async (values) => {
          if (dialogMode === 'create') {
            try {
              const createResult = await createAgent({
                name: values.name,
                description: values.description,
                workspace: values.workspace,
                model: resolveModelRuntimeReference(availableModels, values.model),
                avatarSeed: values.avatarSeed,
                avatarStyle: values.avatarStyle,
              });
              const resolvedAgentId = createResult.agentId || normalizeSubagentNameToSlug(values.name);
              setDraftPromptForAgent(resolvedAgentId, values.prompt);
              setEditingAgentId(resolvedAgentId);
              setManagedAgentId(resolvedAgentId);
              setDialogMode('edit');
              setDialogInitialTab('persona');
              void loadPersistedFilesForAgent(resolvedAgentId);
              void loadAgentSkillConfig(resolvedAgentId).catch(() => {
                // Error state is already set by the skill config store.
              });
              void loadAgentToolConfig(resolvedAgentId).catch(() => {
                // Error state is already set by the tool config store.
              });
              if (createResult.warning) {
                toast.warning(createResult.warning);
              }
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
          const resolvedWorkspace = isDefaultAgent
            ? (editingAgent?.workspace ?? values.workspace)
            : values.workspace;
          await updateAgent({
            agentId: editingAgentId,
            name: resolvedName,
            description: values.description,
            workspace: resolvedWorkspace,
            model: resolveModelRuntimeReference(availableModels, values.model),
            avatarSeed: values.avatarSeed,
            avatarStyle: values.avatarStyle,
          });
          if (values.skillConfig) {
            const latestSkillConfig = await loadAgentSkillConfig(editingAgentId, { force: true, silent: true });
            await setAgentSkillConfig({
              agentId: editingAgentId,
              revision: latestSkillConfig.revision,
              selection: values.skillConfig.selection,
            });
          }
          if (values.toolConfig) {
            const latestToolConfig = await loadAgentToolConfig(editingAgentId, { force: true, silent: true });
            await setAgentToolConfig({
              agentId: editingAgentId,
              revision: latestToolConfig.revision,
              selection: values.toolConfig.selection,
            });
          }
          await closeFormDialog();
        }}
        onClose={() => {
          void closeFormDialog();
        }}
      />

      <Sheet open={cloudPackagesOpen} onOpenChange={setCloudPackagesOpen}>
        <SheetContent aria-describedby={undefined} className="w-[28rem] sm:max-w-[28rem]">
          <SheetHeader>
            <SheetTitle>{t('cloudPackages.title')}</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-2">
            {cloudPackages.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('cloudPackages.empty')}</p>
            ) : cloudPackages.map((packageInfo) => (
              <div key={packageInfo.packageVersionId} className="rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{packageLabel(packageInfo)}</p>
                  <p className="truncate text-xs text-muted-foreground">{packageInfo.version}</p>
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => void handleDownloadAgentPackageFromCloud(packageInfo)}>
                    {t('cloudPackages.download')}
                  </Button>
                  <Button size="sm" onClick={() => void handleInstallAgentPackageFromCloud(packageInfo)}>
                    {t('cloudPackages.install')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>

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
            const createResult = await createAgentFromTemplate({
              template: activeTemplate,
              model: resolveModelRuntimeReference(availableModels, modelId) ?? modelId,
              localizedName: localizedTemplateName,
            });
            setManagedAgentId(createResult.agentId);
            void loadPersistedFilesForAgent(createResult.agentId);
            setTemplateDialogOpen(false);
            if (createResult.warning) {
              toast.warning(createResult.warning);
            }
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
    </AgentPage>
  );
}

export default SubAgents;
