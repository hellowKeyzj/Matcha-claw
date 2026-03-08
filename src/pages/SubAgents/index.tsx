import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { normalizeSubagentNameToSlug } from '@/lib/subagent/workspace';
import { buildSettingsSectionLink } from '@/lib/settings/sections';
import { useSubagentsStore } from '@/stores/subagents';
import type { SubagentSummary } from '@/types/subagent';
import { useTranslation } from 'react-i18next';
import { SubagentCard } from './components/SubagentCard';
import { SubagentDeleteDialog } from './components/SubagentDeleteDialog';
import { SubagentFormDialog } from './components/SubagentFormDialog';
import { SubagentManageDialog } from './components/SubagentManageDialog';

type DialogMode = 'create' | 'edit';

const MAIN_AGENT_ID = 'main';

export function SubAgents() {
  const { t } = useTranslation('subagents');
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
  const loadAgentsForDisplay = useSubagentsStore((state) => state.loadAgentsForDisplay);
  const loadAvailableModels = useSubagentsStore((state) => state.loadAvailableModels);
  const setManagedAgentId = useSubagentsStore((state) => state.setManagedAgentId);
  const loadPersistedFilesForAgent = useSubagentsStore((state) => state.loadPersistedFilesForAgent);
  const setDraftPromptForAgent = useSubagentsStore((state) => state.setDraftPromptForAgent);
  const cancelDraft = useSubagentsStore((state) => state.cancelDraft);
  const createAgent = useSubagentsStore((state) => state.createAgent);
  const updateAgent = useSubagentsStore((state) => state.updateAgent);
  const deleteAgent = useSubagentsStore((state) => state.deleteAgent);
  const generateDraftFromPrompt = useSubagentsStore((state) => state.generateDraftFromPrompt);
  const generatePreviewDiffByFile = useSubagentsStore((state) => state.generatePreviewDiffByFile);
  const applyDraft = useSubagentsStore((state) => state.applyDraft);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<DialogMode>('create');
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
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
    loadAgentsForDisplay();
    loadAvailableModels();
  }, [loadAgentsForDisplay, loadAvailableModels]);

  useEffect(() => {
    if (!managedAgentId) {
      return;
    }
    void loadPersistedFilesForAgent(managedAgentId);
  }, [managedAgentId, loadPersistedFilesForAgent]);

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

      <div data-testid="subagent-card-grid" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => (
          <SubagentCard
            key={agent.id}
            agent={agent}
            locked={agent.id === MAIN_AGENT_ID}
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
    </section>
  );
}

export default SubAgents;
