import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore, type AttachedFileMeta } from '@/stores/chat';
import { useSubagentsStore } from '@/stores/subagents';
import { agentScope, buildSessionIdentityKey, runtimeEndpointsEqual } from '@/types/desktop/runtime-address';
import { ChatSidePanel, type ChatSidePanelPresentation } from './components/ChatSidePanel';
import type { ChatRenderItem } from './chat-render-item-model';
import { collectChatArtifactGroups, type ChatArtifactGroup } from './artifacts';
import type { WorkspaceFileContext } from '@/lib/host-api';
import { resolveArtifactWorkspaceRoot } from './artifact-workspace';
import { resolveArtifactGroupKeyForFile, resolvePreviewableArtifactGroupTarget, resolveArtifactWorkbenchSelection } from './artifact-workbench';
import { supportsInlineDiff, type GeneratedFile } from '@/lib/generated-files';
import { type ArtifactPreviewTarget, buildArtifactPreviewTargetFromAttachedFile, buildArtifactPreviewTargetFromGeneratedFile, DIRECTORY_MIME_TYPE } from '@/components/file-preview/types';
import { Button } from '@/components/ui/button';
import { pickLocalDirectory } from '@/services/local-path-picker';
import { invokeIpc } from '@/lib/api-client';
import { toast } from 'sonner';
import { selectChatSelection, useChatAgent } from './chat-session';

type ChatArtifactSection = 'changes' | 'preview' | 'workspace';
type OpenGeneratedArtifactOptions = {
  preserveSection?: boolean | 'current';
};
type FocusArtifactTargetOptions = {
  preserveSection?: 'workspace';
};

export interface ChatArtifactViewportContent {
  workspaceContext: WorkspaceFileContext;
  artifactGroups: ChatArtifactGroup[];
  onOpenArtifactFile: (file: GeneratedFile) => void;
  onOpenAttachedArtifact: (file: AttachedFileMeta) => boolean;
}

export interface ChatArtifactSlots {
  viewportPane: (showArtifacts: () => void) => ReactNode;
  sidePanel: (presentation: ChatSidePanelPresentation, showArtifacts: () => void) => ReactNode;
}

const ChatArtifactViewport = memo(function ChatArtifactViewport({ render, showArtifacts }: {
  render: (showArtifacts: () => void) => ReactNode;
  showArtifacts: () => void;
}) {
  return render(showArtifacts);
});

export const ChatArtifacts = memo(function ChatArtifacts({ renderItems, renderViewport, children }: {
  renderItems: ChatRenderItem[];
  renderViewport: (artifacts: ChatArtifactViewportContent) => ReactNode;
  children: (slots: ChatArtifactSlots) => ReactNode;
}) {
  const { t } = useTranslation('chat');
  const { currentConversation, currentComposerDraftKey, currentWorkspaceIdentity, currentAgentId } = useChatStore(useShallow(selectChatSelection));
  const currentConversationEndpoint = currentConversation?.endpoint ?? null;
  const { currentAgent } = useChatAgent();
  const currentWorkspacePath = currentAgent?.workspace?.trim() ?? '';
  const currentConfigurationScope = useMemo(() => currentConversationEndpoint && currentAgentId
    ? agentScope(currentConversationEndpoint, currentAgentId) : null, [currentAgentId, currentConversationEndpoint]);
  const updateAgent = useSubagentsStore((state) => state.updateAgent);
  const newSession = useChatStore((state) => state.newSession);
  const [artifactActiveSection, setArtifactActiveSection] = useState<ChatArtifactSection>('changes');
  const [artifactFocusedGroupKey, setArtifactFocusedGroupKey] = useState<string | null>(null);
  const [artifactFocusedFilePath, setArtifactFocusedFilePath] = useState<string | null>(null);
  const [artifactFocusedFileOverride, setArtifactFocusedFileOverride] = useState<ArtifactPreviewTarget | null>(null);
  const [artifactViewMode, setArtifactViewMode] = useState<'preview' | 'diff'>('diff');
  const [artifactSelectionOwnerKey, setArtifactSelectionOwnerKey] = useState(currentComposerDraftKey);
  if (artifactSelectionOwnerKey !== currentComposerDraftKey) {
    setArtifactSelectionOwnerKey(currentComposerDraftKey);
    setArtifactFocusedGroupKey(null);
    setArtifactFocusedFilePath(null);
    setArtifactFocusedFileOverride(null);
  }
  const canChooseWorkspaceForCurrentAgent = !!currentAgent
    && currentConversationEndpoint?.kind === 'native-runtime' && currentConversationEndpoint.runtimeAdapterId === 'openclaw'
    && (currentAgent.kind !== 'system' || Boolean(currentAgent.isDefault))
    && !!currentAgentId;
  const artifactGroups = useMemo(() => collectChatArtifactGroups(renderItems), [renderItems]);
  const artifactFiles = useMemo(
    () => artifactGroups.flatMap((group) => group.files),
    [artifactGroups],
  );
  const artifactWorkbenchSelection = useMemo(() => resolveArtifactWorkbenchSelection({
    artifactGroups,
    focusedGroupKey: artifactFocusedGroupKey,
    focusedFilePath: artifactFocusedFilePath,
    focusedFileOverride: artifactFocusedFileOverride,
  }), [artifactFocusedFileOverride, artifactFocusedFilePath, artifactFocusedGroupKey, artifactGroups]);
  const artifactFocusedGroupFiles = artifactWorkbenchSelection.focusedGroupFiles;
  const artifactFocusedFile = artifactWorkbenchSelection.focusedFile;
  const defaultArtifactWorkspaceRoot = useMemo(() => {
    if (currentConversationEndpoint?.kind === 'native-runtime') {
      return currentAgent?.workspace?.trim() || null;
    }
    return resolveArtifactWorkspaceRoot({
      currentWorkspace: currentAgent?.workspace,
      artifactFiles,
      artifactFocusedFile,
    });
  }, [artifactFiles, artifactFocusedFile, currentAgent?.workspace, currentConversationEndpoint]);
  const artifactWorkspaceRoot = defaultArtifactWorkspaceRoot;
  const artifactWorkspaceContext = useMemo(() => ({
    workspaceRoot: artifactWorkspaceRoot || undefined,
    agentScope: currentConfigurationScope ?? undefined,
  }), [artifactWorkspaceRoot, currentConfigurationScope]);
  const openGeneratedArtifact = useCallback((file: GeneratedFile, showArtifacts: () => void, options?: OpenGeneratedArtifactOptions) => {
    const canShowChanges = supportsInlineDiff(file);
    const nextTarget = buildArtifactPreviewTargetFromGeneratedFile(file);
    setArtifactFocusedGroupKey(resolveArtifactGroupKeyForFile(artifactGroups, file.filePath));
    setArtifactFocusedFilePath(file.filePath);
    setArtifactFocusedFileOverride(nextTarget);

    const showChanges = canShowChanges && (options?.preserveSection
      ? artifactActiveSection === 'changes'
      : file.sourceTool === 'edit');
    setArtifactActiveSection(showChanges ? 'changes' : 'preview');
    setArtifactViewMode(showChanges ? 'diff' : 'preview');
    showArtifacts();
  }, [artifactActiveSection, artifactGroups]);
  const handleOpenArtifactGroup = useCallback((groupKey: string, showArtifacts: () => void, options?: OpenGeneratedArtifactOptions) => {
    const group = artifactGroups.find((entry) => entry.graphItemKey === groupKey) ?? null;
    if (!group) {
      return false;
    }
    const focusTarget = resolvePreviewableArtifactGroupTarget(group, artifactFocusedFilePath);
    if (!focusTarget) {
      return false;
    }
    setArtifactFocusedGroupKey(group.graphItemKey);
    setArtifactFocusedFilePath(focusTarget.filePath);
    setArtifactFocusedFileOverride(focusTarget);

    const matchedGeneratedFile = group.files.find((file) => file.filePath === focusTarget.filePath) ?? null;
    if (matchedGeneratedFile) {
      const canShowChanges = supportsInlineDiff(matchedGeneratedFile);
      const showChanges = canShowChanges && (options?.preserveSection
        ? artifactActiveSection === 'changes'
        : matchedGeneratedFile.sourceTool === 'edit');
      if (showChanges) {
        setArtifactActiveSection('changes');
        setArtifactViewMode('diff');
      } else if (options?.preserveSection && artifactActiveSection === 'workspace') {
        setArtifactActiveSection('workspace');
        if (artifactViewMode === 'diff' && !canShowChanges) {
          setArtifactViewMode('preview');
        }
      } else {
        setArtifactActiveSection('preview');
        setArtifactViewMode('preview');
      }
    } else if (focusTarget.isDirectory || focusTarget.mimeType === DIRECTORY_MIME_TYPE) {
      setArtifactActiveSection('workspace');
    } else {
      setArtifactActiveSection('preview');
      setArtifactViewMode('preview');
    }
    showArtifacts();
    return true;
  }, [artifactActiveSection, artifactFocusedFilePath, artifactGroups, artifactViewMode]);
  const handleArtifactFocusTarget = useCallback((file: ArtifactPreviewTarget, options?: FocusArtifactTargetOptions) => {
    const matchedGeneratedFile = artifactFiles.find((entry) => entry.filePath === file.filePath);
    setArtifactFocusedGroupKey(resolveArtifactGroupKeyForFile(artifactGroups, file.filePath));
    setArtifactFocusedFilePath(file.filePath);
    setArtifactFocusedFileOverride(matchedGeneratedFile
      ? buildArtifactPreviewTargetFromGeneratedFile(matchedGeneratedFile)
      : file);
    if (file.isDirectory || file.mimeType === DIRECTORY_MIME_TYPE) {
      setArtifactActiveSection('workspace');
      return;
    }
    if (options?.preserveSection === 'workspace') {
      setArtifactActiveSection('workspace');
      if (artifactViewMode === 'diff' && !supportsInlineDiff(file)) {
        setArtifactViewMode('preview');
      }
      return;
    }
    setArtifactActiveSection('preview');
    if (artifactViewMode === 'diff' && !supportsInlineDiff(file)) {
      setArtifactViewMode('preview');
      return;
    }
    setArtifactViewMode('preview');
  }, [artifactFiles, artifactGroups, artifactViewMode]);
  const handleArtifactSectionChange = useCallback((section: ChatArtifactSection) => {
    if (section === 'changes' && (!artifactFocusedFile || !supportsInlineDiff(artifactFocusedFile))) return;
    setArtifactActiveSection(section);
    if (section !== 'workspace') setArtifactViewMode(section === 'changes' ? 'diff' : 'preview');
  }, [artifactFocusedFile]);
  useEffect(() => {
    if (artifactGroups.length > 0 || artifactFocusedGroupKey === null) {
      return;
    }
    setArtifactFocusedGroupKey(null);
  }, [artifactFocusedGroupKey, artifactGroups.length]);
  useEffect(() => {
    if (!artifactFocusedFile && artifactActiveSection !== 'workspace') {
      setArtifactActiveSection('workspace');
      return;
    }
    if (artifactFocusedFile && artifactActiveSection === 'workspace' && artifactFiles.length > 0) {
      return;
    }
  }, [artifactActiveSection, artifactFiles.length, artifactFocusedFile]);
  useEffect(() => {
    if (artifactActiveSection !== 'changes') {
      return;
    }
    if (!artifactFocusedFile || supportsInlineDiff(artifactFocusedFile)) {
      return;
    }
    setArtifactActiveSection('preview');
    setArtifactViewMode('preview');
  }, [artifactActiveSection, artifactFocusedFile]);
  const [workspaceRecoveryPending, setWorkspaceRecoveryPending] = useState(false);
  const handleChooseWorkspaceForCurrentAgent = useCallback(async () => {
    if (!canChooseWorkspaceForCurrentAgent || !currentAgent || workspaceRecoveryPending) {
      return;
    }
    const conversation = useChatStore.getState().currentConversation;
    const isCurrent = () => useChatStore.getState().currentConversation === conversation;
    setWorkspaceRecoveryPending(true);
    try {
      const selectedPath = await pickLocalDirectory({
        title: t('workspaceUnavailable.pickTitle'),
        defaultPath: currentWorkspacePath || undefined,
        buttonLabel: t('workspaceUnavailable.pickButton'),
      });
      if (!selectedPath || !isCurrent()) {
        return;
      }
      await updateAgent({
        agentId: currentAgentId,
        name: currentAgent.name ?? currentAgentId,
        workspace: selectedPath,
        model: currentAgent.model,
      });
      if (!isCurrent()) return;
      await newSession(currentAgentId);
      const selected = useChatStore.getState().currentConversation;
      if (conversation && selected?.agentId === conversation.agentId && runtimeEndpointsEqual(selected.endpoint, conversation.endpoint)) {
        toast.success(t('workspaceUnavailable.updateSuccess'));
      }
    } catch (error) {
      if (isCurrent()) toast.error(t('workspaceUnavailable.updateFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setWorkspaceRecoveryPending(false);
    }
  }, [canChooseWorkspaceForCurrentAgent, currentAgent, currentAgentId, currentWorkspacePath, newSession, t, updateAgent, workspaceRecoveryPending]);
  const workspaceRecoveryAction = canChooseWorkspaceForCurrentAgent ? (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto justify-start whitespace-normal p-0 text-left text-xs"
      disabled={workspaceRecoveryPending}
      onClick={() => {
        void handleChooseWorkspaceForCurrentAgent();
      }}
    >
      {workspaceRecoveryPending
        ? t('workspaceUnavailable.updating')
        : t('workspaceUnavailable.chooseWorkspaceAndNewSession')}
    </Button>
  ) : null;
  const handleOpenAttachedArtifact = useCallback((file: AttachedFileMeta, showArtifacts: () => void) => {
    if (file.source === 'user-upload') return false;
    const target = buildArtifactPreviewTargetFromAttachedFile(file);
    if (!target) return false;
    handleArtifactFocusTarget(target);
    showArtifacts();
    return true;
  }, [handleArtifactFocusTarget]);
  const renderArtifactViewport = useCallback((showArtifacts: () => void) => renderViewport({
    workspaceContext: artifactWorkspaceContext,
    artifactGroups,
    onOpenArtifactFile: (file) => openGeneratedArtifact(file, showArtifacts),
    onOpenAttachedArtifact: (file) => handleOpenAttachedArtifact(file, showArtifacts),
  }), [artifactGroups, artifactWorkspaceContext, handleOpenAttachedArtifact, openGeneratedArtifact, renderViewport]);
  return children({
    viewportPane: (showArtifacts) => <ChatArtifactViewport render={renderArtifactViewport} showArtifacts={showArtifacts} />,
    sidePanel: (presentation, showArtifacts) => <ChatSidePanel
      key={currentWorkspaceIdentity ? buildSessionIdentityKey(currentWorkspaceIdentity) : currentComposerDraftKey}
      {...presentation}
      artifactGroups={artifactGroups}
      artifactFocusedGroupKey={artifactWorkbenchSelection.focusedGroupKey}
      artifactFocusedGroupFiles={artifactFocusedGroupFiles}
      artifactFocusedFile={artifactFocusedFile}
      artifactActiveSection={artifactActiveSection}
      artifactViewMode={artifactViewMode}
      artifactWorkspaceRoot={artifactWorkspaceRoot}
      artifactWorkspaceContext={artifactWorkspaceContext}
      workspaceRecoveryAction={workspaceRecoveryAction}
      onArtifactFocusFile={handleArtifactFocusTarget}
      onOpenGeneratedArtifactFile={(file, options) => openGeneratedArtifact(file, showArtifacts, options)}
      onOpenArtifactGroup={(groupKey, options) => handleOpenArtifactGroup(groupKey, showArtifacts, options)}
      onArtifactSectionChange={handleArtifactSectionChange}
      onArtifactViewModeChange={setArtifactViewMode}
      sessionIdentity={currentWorkspaceIdentity ?? undefined}
      onArtifactRevealInFileManager={(filePath) => {
        void invokeIpc('shell:showItemInFolder', filePath).then((result) => {
          if (result && typeof result === 'object' && 'success' in result && (result as { success?: boolean }).success === false) {
            toast.error(t('artifacts.revealFailed'));
          }
        }).catch(() => { toast.error(t('artifacts.revealFailed')); });
      }}
    />,
  });
});
