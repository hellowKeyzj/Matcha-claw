import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { AgentPage, AgentPageSection, AgentResourceGrid } from '@/components/common/AgentPage';
import { LoadingState } from '@/components/common/LoadingSpinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { invokeIpc } from '@/lib/api-client';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import { useIdleReady } from '@/lib/idle-ready';
import { normalizeSubagentNameToSlug } from '@/features/subagents/domain/workspace';
import {
  getSubagentTemplateById,
  getSubagentTemplateCatalog,
} from '@/services/openclaw/subagent-template-catalog';
import { useChatStore } from '@/stores/chat';
import { isRuntimeEndpointReady, isRuntimeEndpointStarting, selectManagementEndpoint, selectManagementRuntime, useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { agentScope, buildCapabilityScopeKey } from '@/types/desktop/runtime-address';
import { buildAgentSkillConfigKey, useAgentSkillConfigStore } from '@/stores/agent-skill-config';
import { buildAgentToolConfigKey, useAgentToolConfigStore } from '@/stores/agent-tool-config';
import { getSubagentManagementScope, useSubagentsStore } from '@/stores/subagents';
import type { SubagentCloudPackage, SubagentSummary, SubagentTemplateCatalogResult, SubagentTemplateDetail } from '@/types/subagent';
import { useTranslation } from 'react-i18next';
import { resolveModelCatalogEntry, resolveModelRuntimeReference } from '@/lib/provider-models';
import { SubagentCard } from './components/SubagentCard';
import { SubagentDeleteDialog } from './components/SubagentDeleteDialog';
import { SubagentFormDialog } from './components/SubagentFormDialog';
import { SubagentTemplateLoadDialog } from './components/SubagentTemplateLoadDialog';
import { SubagentTemplateLibrary } from './components/SubagentTemplateLibrary';
import { SubagentResourceToolbar } from './components/SubagentResourceToolbar';

type DialogMode = 'create' | 'edit';
type SubagentEditorTab = 'basic' | 'persona' | 'skills' | 'tools';
type AgentListState = 'directoryLoading' | 'directoryError' | 'none' | 'starting' | 'unavailable' | 'noAgent' | 'loading' | 'error' | 'ready';
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
  const endpoint = useRuntimeEndpointsStore(selectManagementEndpoint);
  const selectedRuntime = useRuntimeEndpointsStore(selectManagementRuntime);
  const directoryStatus = useRuntimeEndpointsStore((state) => state.status);
  const directoryError = useRuntimeEndpointsStore((state) => state.error);
  const refreshRuntimeEndpoints = useRuntimeEndpointsStore((state) => state.refresh);
  const openAgentConversation = useChatStore((state) => state.openAgentConversation);
  const nativeManaged = endpoint?.kind === 'native-runtime' && endpoint.runtimeAdapterId === 'matcha-agent';
  const managementScope = getSubagentManagementScope(endpoint);
  const managementKey = managementScope ? buildCapabilityScopeKey(managementScope) : '';
  const runtimeReady = Boolean(selectedRuntime && isRuntimeEndpointReady(selectedRuntime));
  const managementReady = directoryStatus === 'ready' && runtimeReady && Boolean(managementScope);
  const resourceScope = useSubagentsStore((state) => state.managementScope);
  const resourceMatches = Boolean(managementKey && resourceScope && buildCapabilityScopeKey(resourceScope) === managementKey);
  const agentsResource = useSubagentsStore((state) => state.agentsResource);
  const agents = resourceMatches && Array.isArray(agentsResource.data) ? agentsResource.data : EMPTY_AGENTS;
  const cloudPackages = useSubagentsStore((state) => state.cloudPackages);
  const loadCloudPackages = useSubagentsStore((state) => state.loadCloudPackages);
  const installedCloudPackages = useSubagentsStore((state) => state.installedCloudPackages);
  const cloudLoading = useSubagentsStore((state) => state.cloudLoading);
  const cloudError = useSubagentsStore((state) => state.cloudError);
  const myCloudPackages = useSubagentsStore((state) => state.myCloudPackages);
  const myCloudLoading = useSubagentsStore((state) => state.myCloudLoading);
  const myCloudError = useSubagentsStore((state) => state.myCloudError);
  const cloudPublishingByVersionId = useSubagentsStore((state) => state.cloudPublishingByVersionId);
  const cloudInstallingByVersionId = useSubagentsStore((state) => state.cloudInstallingByVersionId);
  const loadMyCloudPackages = useSubagentsStore((state) => state.loadMyCloudPackages);
  const publishCloudAgentPackage = useSubagentsStore((state) => state.publishCloudAgentPackage);
  const mutating = useSubagentsStore((state) => state.mutating);
  const error = useSubagentsStore((state) => state.error);
  const availableModels = useSubagentsStore((state) => state.availableModels);
  const modelsLoading = useSubagentsStore((state) => state.modelsLoading);
  const storedManagedAgentId = useSubagentsStore((state) => state.managedAgentId);
  const managedAgentId = resourceMatches ? storedManagedAgentId : null;
  const persistedFilesByAgent = useSubagentsStore((state) => state.persistedFilesByAgent);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const loadAvailableModels = useSubagentsStore((state) => state.loadAvailableModels);
  const setManagedAgentId = useSubagentsStore((state) => state.setManagedAgentId);
  const setManagementScope = useSubagentsStore((state) => state.setManagementScope);
  const loadPersistedFilesForAgent = useSubagentsStore((state) => state.loadPersistedFilesForAgent);
  const createAgent = useSubagentsStore((state) => state.createAgent);
  const updateAgent = useSubagentsStore((state) => state.updateAgent);
  const deleteAgent = useSubagentsStore((state) => state.deleteAgent);
  const exportAgentConfig = useSubagentsStore((state) => state.exportAgentConfig);
  const exportAgentPackage = useSubagentsStore((state) => state.exportAgentPackage);
  const uploadAgentPackageToCloud = useSubagentsStore((state) => state.uploadAgentPackageToCloud);
  const installAgentPackageFromCloud = useSubagentsStore((state) => state.installAgentPackageFromCloud);
  const importAgentConfig = useSubagentsStore((state) => state.importAgentConfig);
  const createAgentFromTemplate = useSubagentsStore((state) => state.createAgentFromTemplate);
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
  const editingScope = useMemo(() => endpoint && editingAgentId ? agentScope(endpoint, editingAgentId) : null, [endpoint, editingAgentId]);
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
  const templateLoadRequestIdRef = useRef(0);
  const persistedContentByFile = resourceMatches && managedAgentId ? (persistedFilesByAgent[managedAgentId] ?? {}) : {};
  const skillConfigKey = editingScope && editingAgentId ? buildAgentSkillConfigKey(editingScope, editingAgentId) : null;
  const toolConfigKey = editingScope && editingAgentId ? buildAgentToolConfigKey(editingScope, editingAgentId) : null;
  const editingSkillConfigView = !nativeManaged && skillConfigKey ? (skillConfigViewByAgentId[skillConfigKey] ?? null) : null;
  const editingSkillConfigLoading = !nativeManaged && skillConfigKey ? Boolean(skillConfigLoadingByAgentId[skillConfigKey]) : false;
  const editingSkillConfigError = !nativeManaged && skillConfigKey ? (skillConfigErrorByAgentId[skillConfigKey] ?? null) : null;
  const editingToolConfigView = toolConfigKey ? (toolConfigViewByAgentId[toolConfigKey] ?? null) : null;
  const editingToolConfigLoading = toolConfigKey ? Boolean(toolConfigLoadingByAgentId[toolConfigKey]) : false;
  const editingToolConfigError = toolConfigKey ? (toolConfigErrorByAgentId[toolConfigKey] ?? null) : null;
  const isCurrentPage = useCallback(() => {
    const directory = useRuntimeEndpointsStore.getState();
    const selectedScope = getSubagentManagementScope(selectManagementEndpoint(directory));
    const runtime = selectManagementRuntime(directory);
    return resourceMatches && resourceScope !== null
      && useSubagentsStore.getState().managementScope === resourceScope
      && selectedScope !== null && buildCapabilityScopeKey(selectedScope) === buildCapabilityScopeKey(resourceScope)
      && directory.status === 'ready' && runtime !== null && isRuntimeEndpointReady(runtime);
  }, [resourceMatches, resourceScope]);
  const hasAvailableModels = availableModels.length > 0;
  const hasLoadedAgents = resourceMatches && agentsResource.hasLoadedOnce;
  const subagentsContentReady = useIdleReady(hasLoadedAgents);
  const agentListState: AgentListState = directoryStatus === 'idle' || directoryStatus === 'loading'
    ? 'directoryLoading'
    : directoryStatus === 'error' ? 'directoryError'
      : !selectedRuntime ? 'none'
        : !runtimeReady ? (isRuntimeEndpointStarting(selectedRuntime) ? 'starting' : 'unavailable')
          : !managementScope ? 'noAgent'
            : resourceMatches && !hasLoadedAgents && agentsResource.status === 'error' ? 'error'
              : !hasLoadedAgents ? 'loading' : 'ready';
  const agentListMessage = agentListState === 'directoryError' ? t('common:runtimeScope.loadFailed')
    : agentListState === 'none' ? t('common:runtimeScope.none')
      : agentListState === 'noAgent' ? t('common:runtimeScope.selectAgent')
        : agentListState === 'starting' || agentListState === 'unavailable'
          ? t(`common:runtimeScope.${agentListState}`, { runtime: selectedRuntime?.displayName })
          : agentListState === 'error' ? agentsResource.error
            : t('common:runtimeScope.loading');
  const agentListBusy = agentListState === 'directoryLoading' || agentListState === 'starting';
  const showNoModelGuide = !nativeManaged && agentListState === 'ready' && !modelsLoading && !hasAvailableModels;
  const showRefreshingHint = useDelayedFlag(
    managementReady && hasLoadedAgents && agentsResource.status === 'loading',
    180,
  );

  useEffect(() => {
    if (!cloudPackagesOpen) return;
    void loadCloudPackages();
    void loadMyCloudPackages();
  }, [cloudPackagesOpen, loadCloudPackages, loadMyCloudPackages]);

  useEffect(() => {
    setManagementScope(getSubagentManagementScope(selectManagementEndpoint(useRuntimeEndpointsStore.getState())));
    setDialogOpen(false);
    setEditingAgentId(null);
    setDeletingAgentId(null);
    setDeleting(false);
    setCloudPackagesOpen(false);
    templateLoadRequestIdRef.current += 1;
    setTemplateDialogOpen(false);
    setTemplateDialogLoading(false);
    setTemplateDialogSubmitting(false);
  }, [managementKey, resourceScope, setManagementScope]);

  useEffect(() => {
    if (!managementReady || !resourceMatches) return;
    const scope = useSubagentsStore.getState().managementScope;
    if (scope) void loadAgents({ silent: true, scope }).catch(() => {
      // Error state is already set by the subagents store.
    });
    if (!nativeManaged) void loadAvailableModels();
  }, [resourceScope, resourceMatches, managementReady, nativeManaged, loadAgents, loadAvailableModels]);

  useEffect(() => {
    if (!managedAgentId || !resourceScope || !resourceMatches || !managementReady) {
      return;
    }
    void loadPersistedFilesForAgent(managedAgentId, resourceScope).catch(() => {});
  }, [managedAgentId, resourceScope, resourceMatches, managementReady, loadPersistedFilesForAgent]);

  useEffect(() => {
    if (!managedAgentId || !managementReady || dialogOpen || editingAgentId) {
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
  }, [agents, dialogOpen, editingAgentId, managedAgentId, managementReady, setManagedAgentId, t]);

  useEffect(() => {
    if (!editingAgentId || !editingScope || !resourceMatches || !managementReady || !dialogOpen || dialogMode !== 'edit') {
      return;
    }
    if (!nativeManaged) void loadAgentSkillConfig(editingAgentId, editingScope).catch(() => {
      // Error state is already set by the skill config store.
    });
    void loadAgentToolConfig(editingAgentId, editingScope).catch(() => {
      // Error state is already set by the tool config store.
    });
  }, [dialogMode, dialogOpen, editingAgentId, editingScope, resourceMatches, managementReady, nativeManaged, loadAgentSkillConfig, loadAgentToolConfig]);

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

  const filteredAgents = useMemo(() => {
    if (!subagentsContentReady) return EMPTY_AGENTS;
    if (!deferredAgentSearch) return agents;
    return agents.filter((agent) => (
      `${agent.id} ${agent.name ?? ''} ${agent.description ?? ''} ${agent.model ?? ''}`
        .toLocaleLowerCase().includes(deferredAgentSearch)
    ));
  }, [agents, deferredAgentSearch, subagentsContentReady]);

  const editingAgent: SubagentSummary | undefined = editingAgentId
    ? (agents.find((agent) => agent.id === editingAgentId) ?? (editingAgentId === managedAgentId ? { id: editingAgentId, name: editingAgentId } : undefined))
    : undefined;

  const openCreateDialog = () => {
    if (!isCurrentPage()) return;
    setDialogMode('create');
    setDialogInitialTab('basic');
    setEditingAgentId(null);
    setManagedAgentId(null);
    setDialogOpen(true);
  };

  const openEditDialog = useCallback((agentId: string, initialTab: SubagentEditorTab = 'basic') => {
    if (!isCurrentPage()) return;
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
  }, [agents, isCurrentPage, setManagedAgentId, t]);

  const handleDeleteAgent = useCallback((agentId: string) => {
    if (!isCurrentPage()) return;
    setDeletingAgentId(agentId);
  }, [isCurrentPage]);

  const handleOpenCloudPackages = useCallback(() => {
    if (!nativeManaged && isCurrentPage()) setCloudPackagesOpen(true);
  }, [isCurrentPage, nativeManaged]);

  const handleChat = useCallback((agentId: string) => {
    if (!endpoint || !isCurrentPage()) return;
    openAgentConversation(agentId, endpoint);
    navigate('/');
  }, [endpoint, isCurrentPage, navigate, openAgentConversation]);

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

  const closeFormDialog = () => {
    setDialogOpen(false);
    setEditingAgentId(null);
    setManagedAgentId(null);
  };

  const handleExportAgentConfig = useCallback(async (agent: SubagentSummary) => {
    if (!isCurrentPage()) return;
    if (agent.sealed) {
      toast.error(t('sealed.configExportDisabled'));
      return;
    }
    try {
      const packageData = await exportAgentConfig(agent.id);
      if (!isCurrentPage()) return;
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
  }, [exportAgentConfig, isCurrentPage, t]);

  const handleExportAgentPackage = useCallback(async (agent: SubagentSummary) => {
    if (!isCurrentPage()) return;
    try {
      const result = await exportAgentPackage(agent.id);
      toast.success(t('transfer.exportPackageSuccess', { fileName: result.fileName }));
    } catch (error) {
      toast.error(t('transfer.exportPackageFailed', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [exportAgentPackage, isCurrentPage, t]);

  const cloudPackageErrorMessage = useCallback((error: unknown, fallback: string) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = ['MATCHA_PACKAGE_CLOUD_ENVELOPE_REQUIRED', 'MATCHA_PACKAGE_VERSION_NOT_PUBLISHABLE'].find((value) => message.includes(value));
    return t(code ? `cloudPackages.errors.${code}` : fallback);
  }, [t]);

  const handlePublishCloudAgentPackage = async (packageVersionId: string) => {
    try {
      await publishCloudAgentPackage(packageVersionId);
      toast.success(t('cloudPackages.published'));
    } catch (error) {
      toast.error(cloudPackageErrorMessage(error, 'cloudPackages.publishFailed'));
    }
  };

  const handleUploadAgentPackageToCloud = useCallback(async (agent: SubagentSummary) => {
    if (!isCurrentPage()) return;
    try {
      const result = await uploadAgentPackageToCloud(agent.id);
      toast.success(t('transfer.uploadPackageSuccess', { fileName: result.fileName ?? agent.name ?? agent.id }));
    } catch (error) {
      toast.error(cloudPackageErrorMessage(error, 'cloudPackages.uploadFailed'));
    }
  }, [cloudPackageErrorMessage, isCurrentPage, t, uploadAgentPackageToCloud]);

  const handleInstallAgentPackageFromCloud = useCallback(async (packageInfo: SubagentCloudPackage) => {
    if (!isCurrentPage()) return;
    try {
      const result = await installAgentPackageFromCloud(packageInfo.packageVersionId);
      if (!isCurrentPage()) return;
      if (result.warning) {
        toast.warning(result.warning);
      } else {
        toast.success(t('transfer.installPackageSuccess', { agentId: result.agentId }));
      }
      if (resourceScope) void loadPersistedFilesForAgent(result.agentId, resourceScope).catch(() => {});
    } catch (error) {
      toast.error(cloudPackageErrorMessage(error, 'cloudPackages.installFailed'));
    }
  }, [cloudPackageErrorMessage, installAgentPackageFromCloud, isCurrentPage, loadPersistedFilesForAgent, resourceScope, t]);

  const handleImportAgentConfig = useCallback(async () => {
    if (!isCurrentPage()) return;
    try {
      const result = await invokeIpc<{ canceled?: boolean; filePath?: string; content?: string }>('dialog:readSelectedTextFile', {
        title: t('transfer.importDialogTitle'),
        properties: ['openFile'],
        filters: AGENT_CONFIG_FILE_FILTERS,
      });
      if (result?.canceled || typeof result?.content !== 'string') {
        return;
      }
      if (!resourceScope || !isCurrentPage()) return;
      const importResult = await importAgentConfig(JSON.parse(result.content) as unknown, resourceScope);
      if (!isCurrentPage()) return;
      void loadPersistedFilesForAgent(importResult.agentId, resourceScope).catch(() => {});
      setManagedAgentId(importResult.agentId);
      if (importResult.warning) {
        toast.warning(importResult.warning);
      } else {
        toast.success(t('transfer.importSuccess'));
      }
    } catch (error) {
      toast.error(t('transfer.importFailed', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [importAgentConfig, isCurrentPage, loadPersistedFilesForAgent, resourceScope, setManagedAgentId, t]);

  return (
    <AgentPage>
      <Tabs value={activeTab} onValueChange={(value) => updateAgentQuery('tab', value, 'agents')} className="space-y-6">
        <AgentPageSection actions={
          <>
            {(showRefreshingHint || mutating) && (
              <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="size-2 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
                {mutating ? t('status.mutating') : t('status.refreshing')}
              </span>
            )}
            <Button variant="outline" size="sm" className="gap-2 rounded-full" disabled={!managementReady || !resourceMatches} onClick={handleImportAgentConfig}>
              <Upload className="size-4" aria-hidden="true" />
              {t('transfer.import')}
            </Button>
            {activeTab === 'agents' && (
              <Button size="sm" className="gap-2 rounded-full" disabled={!managementReady || !resourceMatches} onClick={openCreateDialog}>
                <Plus className="size-4" aria-hidden="true" />
                {t('newSubagent')}
              </Button>
            )}
          </>
        }>
          <TabsList variant="line" aria-label={t('title')}>
            <TabsTrigger value="agents" className="gap-2">
              {t('tabs.agents')}
              {hasLoadedAgents && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{agents.length}</span>}
            </TabsTrigger>
            <TabsTrigger value="templates" className="gap-2">
              {t('tabs.templates')}
              {!templatesLoading && !templateError && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{templateCatalog.templates.length}</span>}
            </TabsTrigger>
          </TabsList>
        </AgentPageSection>

        {resourceMatches && error && (agentListState !== 'error' || activeTab !== 'agents') && (
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
              loading={templatesLoading || !subagentsContentReady}
              error={templateError}
              templateLoadingId={templateLoadingId}
              modelsUnavailable={false}
              onLoad={handleLoadTemplateCard}
            />
          )}
        </TabsContent>
        <TabsContent value="agents" className="mt-0 space-y-6">
          {agentListState === 'ready' && subagentsContentReady && (
            <SubagentResourceToolbar
              search={agentSearch}
              onSearchChange={(value) => updateAgentQuery('search', value)}
              searchLabel={t('search.agents')}
              countLabel={t('results.agents', { total: filteredAgents.length })}
              view={agentView}
              onViewChange={(value) => updateAgentQuery('view', value, 'grid')}
            />
          )}
          {agentListState === 'loading' || agentListBusy || (agentListState === 'ready' && !subagentsContentReady) ? (
            <LoadingState label={t('common:status.loading')} />
          ) : agentListState !== 'ready' ? (
            <div role={agentListState === 'directoryError' || agentListState === 'error' ? 'alert' : 'status'} className="flex min-h-[360px] flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border bg-card/60 p-8 text-center">
              <div className="space-y-1">
                <h3 className="text-base font-medium text-foreground">{agentListMessage}</h3>
                {agentListState === 'directoryError' && directoryError && <p className="text-sm text-muted-foreground">{directoryError}</p>}
              </div>
              {!agentListBusy && <Button variant="outline" size="sm" onClick={() => {
                if (agentListState === 'error' && resourceScope && isCurrentPage()) {
                  void loadAgents({ scope: resourceScope }).catch(() => {
                    // Error state is already set by the subagents store.
                  });
                } else {
                  void refreshRuntimeEndpoints();
                }
              }}>{t('common:runtimeScope.retry')}</Button>}
            </div>
          ) : (
            <AgentResourceGrid data-testid="subagent-card-grid" className={agentView === 'list' ? 'md:grid-cols-1 xl:grid-cols-1' : undefined}>
              {filteredAgents.map((agent) => (
                <SubagentCard
                  key={agent.id}
                  agent={agent}
                  nativeManaged={nativeManaged}
                  compact={agentView === 'list'}
                  modelLabel={resolveModelCatalogEntry(availableModels, agent.model)?.modelLabel ?? agent.model?.trim()}
                  editLocked={(agent.kind === 'system' && !agent.isDefault) || Boolean(agent.sealed)}
                  deleteLocked={Boolean(agent.isDefault) || agent.kind === 'system'}
                  exportLocked={agent.kind === 'system' || Boolean(agent.sealed)}
                  packageExportLocked={nativeManaged || agent.kind === 'system'}
                  modelReady={nativeManaged || ((agent.kind !== 'system' || Boolean(agent.isDefault)) && Boolean(agent.model?.trim()))}
                  onEdit={openEditDialog}
                  onDelete={handleDeleteAgent}
                  onExport={handleExportAgentConfig}
                  onExportPackage={handleExportAgentPackage}
                  onUploadPackageToCloud={handleUploadAgentPackageToCloud}
                  onOpenCloudPackages={handleOpenCloudPackages}
                  onChat={handleChat}
                />
              ))}
            </AgentResourceGrid>
          )}
          {agentListState === 'ready' && subagentsContentReady && agentsResource.hasLoadedOnce && filteredAgents.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">{t(agents.length ? 'search.empty' : 'empty')}</p>
          )}
        </TabsContent>
      </Tabs>
      {deletingAgentId && <SubagentDeleteDialog
        nativeManaged={nativeManaged}
        key={`${managementKey}:${deletingAgentId ?? ""}`}
        open={Boolean(deletingAgentId)}
        agentId={deletingAgentId}
        deleting={deleting}
        onConfirm={async (deleteFiles) => {
          if (!deletingAgentId) {
            return;
          }
          setDeleting(true);
          try {
            if (!resourceScope || !isCurrentPage()) return;
            await deleteAgent(deletingAgentId, deleteFiles, resourceScope);
            if (isCurrentPage()) setDeletingAgentId(null);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
          } finally {
            if (isCurrentPage()) setDeleting(false);
          }
        }}
        onClose={() => setDeletingAgentId(null)}
      />}
      {dialogOpen && <SubagentFormDialog
        key={`${managementKey}:${dialogMode}:${editingAgentId ?? ''}:${dialogOpen}`}
        nativePolicyScope={nativeManaged ? editingScope : null}
        open={dialogOpen}
        mode={dialogMode}
        managedWorkspace={nativeManaged}
        agentId={editingAgentId}
        initialTab={dialogInitialTab}
        lockBasicInfo={Boolean(!nativeManaged && dialogMode === 'edit' && editingAgent?.isDefault)}
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
        persistedContentByFile={persistedContentByFile}
        onSubmit={async (values) => {
          if (!resourceScope || !isCurrentPage()) return;
          if (dialogMode === 'create') {
            try {
              const createResult = await createAgent({
                name: values.name,
                description: values.description,
                ...(nativeManaged ? {} : { workspace: values.workspace }),
                model: nativeManaged ? values.model.trim() || undefined : resolveModelRuntimeReference(availableModels, values.model),
                avatarSeed: values.avatarSeed,
                avatarStyle: values.avatarStyle,
              }, { scope: resourceScope });
              if (!isCurrentPage()) return;
              if (createResult.warning) {
                toast.warning(createResult.warning);
              }
              closeFormDialog();
            } catch {
              // Error state is already set by store; keep dialog open for user correction/retry.
            }
            return;
          }
          if (!editingAgentId || !editingScope) {
            return;
          }
          const isDefaultAgent = !nativeManaged && Boolean(editingAgent?.isDefault);
          const resolvedName = isDefaultAgent
            ? (editingAgent?.name ?? values.name)
            : values.name;
          const resolvedWorkspace = isDefaultAgent
            ? (editingAgent?.workspace ?? values.workspace)
            : values.workspace;
          if (values.skillConfig) {
            await setAgentSkillConfig({
              agentId: editingAgentId,
              revision: values.skillConfig.revision,
              selection: values.skillConfig.selection,
            }, editingScope);
          }
          if (!isCurrentPage()) return;
          if (values.toolConfig) {
            await setAgentToolConfig({
              agentId: editingAgentId,
              revision: values.toolConfig.revision,
              selection: values.toolConfig.selection,
            }, editingScope);
          }
          if (!isCurrentPage()) return;
          await updateAgent({
            agentId: editingAgentId,
            name: resolvedName,
            description: values.description,
            ...(nativeManaged ? {} : { workspace: resolvedWorkspace }),
            model: nativeManaged ? values.model.trim() || undefined : resolveModelRuntimeReference(availableModels, values.model),
            avatarSeed: values.avatarSeed,
            avatarStyle: values.avatarStyle,
          }, resourceScope);
          if (isCurrentPage()) closeFormDialog();
        }}
        onClose={closeFormDialog}
      />}

      <Sheet open={cloudPackagesOpen} onOpenChange={setCloudPackagesOpen}>
        <SheetContent aria-describedby={undefined} className="w-[28rem] overflow-y-auto sm:max-w-[28rem]">
          <SheetHeader>
            <SheetTitle>{t('cloudPackages.title')}</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-2">
            <h3 className="text-sm font-semibold">{t('cloudPackages.mineTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('cloudPackages.mineDescription')}</p>
            {myCloudLoading ? <p role="status">{t('cloudPackages.loading')}</p> : myCloudError ? (
              <div role="alert">
                <p className="text-sm text-destructive">{t('cloudPackages.loadFailed')}</p>
                <Button variant="outline" size="sm" onClick={() => void loadMyCloudPackages()}>{t('cloudPackages.retry')}</Button>
              </div>
            ) : myCloudPackages.length === 0 ? <p className="text-sm text-muted-foreground">{t('cloudPackages.mineEmpty')}</p> : myCloudPackages.map((item) => (
              <div key={item.packageVersionId} className="rounded-lg border p-3">
                <p className="truncate text-sm font-medium">{packageLabel(item)}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">{item.version}</p>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="text-xs">{t(`cloudPackages.status.${item.status}`, { defaultValue: t('cloudPackages.status.unknown') })}</span>
                  {item.status === 'draft' && <Button size="sm" disabled={Boolean(cloudPublishingByVersionId[item.packageVersionId])} onClick={() => void handlePublishCloudAgentPackage(item.packageVersionId)}>{t(cloudPublishingByVersionId[item.packageVersionId] ? 'cloudPackages.publishing' : 'cloudPackages.publish')}</Button>}
                </div>
              </div>
            ))}
            <h3 className="pt-4 text-sm font-semibold">{t('cloudPackages.marketTitle')}</h3>
            {cloudLoading ? <p role="status">{t('cloudPackages.loading')}</p> : cloudError ? (
              <div role="alert">
                <p className="text-sm text-destructive">{t('cloudPackages.loadFailed')}</p>
                <Button variant="outline" size="sm" onClick={() => void loadCloudPackages()}>{t('cloudPackages.retry')}</Button>
              </div>
            ) : cloudPackages.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('cloudPackages.empty')}</p>
            ) : cloudPackages.map((packageInfo) => (
              <div key={packageInfo.packageVersionId} className="rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{packageLabel(packageInfo)}</p>
                  <p className="truncate text-xs text-muted-foreground">{packageInfo.version}</p>
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  {installedCloudPackages.some((item) => item.packageType === 'agent' && (item.packageVersionId === packageInfo.packageVersionId || item.packageSha256 === packageInfo.version)) ? <span className="text-sm text-muted-foreground">{t('cloudPackages.installed')}</span> : (
                    <Button size="sm" disabled={!managementReady || !resourceMatches || !packageInfo.downloadable || Boolean(cloudInstallingByVersionId[packageInfo.packageVersionId])} onClick={() => void handleInstallAgentPackageFromCloud(packageInfo)}>
                      {t(cloudInstallingByVersionId[packageInfo.packageVersionId] ? 'cloudPackages.installing' : 'cloudPackages.install')}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      <SubagentTemplateLoadDialog
        key={managementKey}
        nativeManaged={nativeManaged}
        open={templateDialogOpen}
        loading={templateDialogLoading}
        template={activeTemplate}
        modelOptions={availableModels}
        modelsLoading={modelsLoading}
        submitting={templateDialogSubmitting}
        canApply={managementReady && resourceMatches}
        onSubmit={async (modelId) => {
          if (!activeTemplate || !resourceScope || !isCurrentPage()) {
            return;
          }
          setTemplateDialogSubmitting(true);
          try {
            const localizedTemplateName = tTemplate(`templates.${activeTemplate.id}.name`, {
              defaultValue: activeTemplate.name,
            });
            const createResult = await createAgentFromTemplate({
              template: activeTemplate,
              model: nativeManaged ? modelId.trim() : resolveModelRuntimeReference(availableModels, modelId) ?? modelId,
              localizedName: localizedTemplateName,
            }, resourceScope);
            if (!isCurrentPage()) return;
            setManagedAgentId(createResult.agentId);
            if (resourceScope) void loadPersistedFilesForAgent(createResult.agentId, resourceScope).catch(() => {});
            setTemplateDialogOpen(false);
            if (createResult.warning) {
              toast.warning(createResult.warning);
            }
          } finally {
            if (isCurrentPage()) setTemplateDialogSubmitting(false);
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
