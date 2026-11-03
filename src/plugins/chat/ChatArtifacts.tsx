import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '@/plugins/chat/store';
import type { AttachedFileMeta } from '@/plugins/message-rendering/attachments';
import { useSubagentsStore } from '@/plugins/agents/stores/subagents';
import { agentScope, runtimeEndpointsEqual } from '@/types/desktop/runtime-address';
import { ChatArtifactContext } from './artifact-context';
import type { ChatRenderItem } from '@/plugins/message-rendering/chat-render-item-model';
import { collectChatArtifactGroups, type ChatArtifactGroup } from '@/plugins/chat/artifacts';
import type { WorkspaceFileContext } from '@/lib/host-api';
import { resolveArtifactWorkspaceRoot } from '@/plugins/chat/artifact-workspace';
import type { GeneratedFile } from '@/plugins/files/generated-files';
import { useFilePreviewSupport } from '@/plugins/files/extensions';
import { buildArtifactPreviewTargetFromAttachedFile, buildArtifactPreviewTargetFromGeneratedFile } from '@/plugins/files/types';
import { useOpenFileWorkspacePage } from '@/plugins/files/workspace';
import { useWorkspace } from '@/plugins/workspace/context';
import { Button } from '@/components/ui/button';
import { pickLocalDirectory } from '@/lib/local-path-picker';
import { toast } from 'sonner';
import { selectChatSelection, useChatAgent } from '@/plugins/chat/chat-session';

export interface ChatArtifactViewportContent {
  workspaceContext: WorkspaceFileContext;
  artifactGroups: ChatArtifactGroup[];
  onOpenArtifactFile: (file: GeneratedFile) => void;
  onOpenAttachedArtifact: (file: AttachedFileMeta) => boolean;
}

export interface ChatArtifactSlots {
  viewportPane: () => ReactNode;
}

const ChatArtifactViewport = memo(function ChatArtifactViewport({ render }: {
  render: () => ReactNode;
}) {
  return render();
});

export const ChatArtifacts = memo(function ChatArtifacts({ renderItems, renderViewport, children }: {
  renderItems: ChatRenderItem[];
  renderViewport: (artifacts: ChatArtifactViewportContent) => ReactNode;
  children: (slots: ChatArtifactSlots) => ReactNode;
}) {
  const { t } = useTranslation('chat');
  const workspace = useWorkspace();
  const openFile = useOpenFileWorkspacePage(workspace);
  const supportsInlineDiff = useFilePreviewSupport('diff');
  const supportsPreview = useFilePreviewSupport('preview');
  const { currentConversation, currentAgentId } = useChatStore(useShallow(selectChatSelection));
  const currentConversationEndpoint = currentConversation?.endpoint ?? null;
  const { currentAgent } = useChatAgent();
  const currentWorkspacePath = currentAgent?.workspace?.trim() ?? '';
  const currentConfigurationScope = useMemo(() => currentConversationEndpoint && currentAgentId
    ? agentScope(currentConversationEndpoint, currentAgentId) : null, [currentAgentId, currentConversationEndpoint]);
  const updateAgent = useSubagentsStore((state) => state.updateAgent);
  const newSession = useChatStore((state) => state.newSession);
  const canChooseWorkspaceForCurrentAgent = !!currentAgent
    && currentConversationEndpoint?.kind === 'native-runtime' && currentConversationEndpoint.runtimeAdapterId === 'openclaw'
    && (currentAgent.kind !== 'system' || Boolean(currentAgent.isDefault))
    && !!currentAgentId;
  const artifactGroups = useMemo(() => collectChatArtifactGroups(renderItems), [renderItems]);
  const artifactFiles = useMemo(() => artifactGroups.flatMap((group) => group.files), [artifactGroups]);
  const artifactWorkspaceRoot = useMemo(() => currentConversationEndpoint?.kind === 'native-runtime'
    ? currentWorkspacePath || null
    : resolveArtifactWorkspaceRoot({ currentWorkspace: currentWorkspacePath, artifactFiles, artifactFocusedFile: null }),
  [artifactFiles, currentWorkspacePath, currentConversationEndpoint]);
  const artifactWorkspaceContext = useMemo(() => ({
    workspaceRoot: artifactWorkspaceRoot || undefined,
    agentScope: currentConfigurationScope ?? undefined,
  }), [artifactWorkspaceRoot, currentConfigurationScope]);
  const openGeneratedArtifact = useCallback((file: GeneratedFile) => {
    const group = artifactGroups.find((entry) => entry.files.includes(file))
      ?? artifactGroups.find((entry) => entry.files.some((candidate) => candidate.filePath === file.filePath && candidate.toolId === file.toolId));
    openFile({
      file: buildArtifactPreviewTargetFromGeneratedFile(file),
      workspaceContext: artifactWorkspaceContext,
      group,
      mode: file.sourceTool === 'edit' && supportsInlineDiff(file) ? 'diff' : 'preview',
    });
  }, [artifactGroups, artifactWorkspaceContext, openFile, supportsInlineDiff]);
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
  const sessionIdentity = currentConversation?.kind === 'session' ? currentConversation.sessionIdentity : undefined;
  const handleOpenAttachedArtifact = useCallback((file: AttachedFileMeta) => {
    const target = buildArtifactPreviewTargetFromAttachedFile(file, sessionIdentity);
    if (!target || target.mediaSource && !supportsPreview(target)) return false;
    openFile({ file: target, workspaceContext: artifactWorkspaceContext });
    return true;
  }, [artifactWorkspaceContext, openFile, sessionIdentity, supportsPreview]);
  const renderArtifactViewport = useCallback(() => renderViewport({
    workspaceContext: artifactWorkspaceContext,
    artifactGroups,
    onOpenArtifactFile: openGeneratedArtifact,
    onOpenAttachedArtifact: handleOpenAttachedArtifact,
  }), [artifactGroups, artifactWorkspaceContext, handleOpenAttachedArtifact, openGeneratedArtifact, renderViewport]);
  return <ChatArtifactContext.Provider value={{ artifactGroups, artifactWorkspaceRoot, artifactWorkspaceContext, workspaceRecoveryAction }}>
    {children({ viewportPane: () => <ChatArtifactViewport render={renderArtifactViewport} /> })}
  </ChatArtifactContext.Provider>;
});
