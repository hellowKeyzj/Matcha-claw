import { createContext, useContext, type ReactNode } from 'react';
import type { GeneratedFile } from '@/plugins/files/generated-files';
import type { ArtifactPreviewTarget } from '@/plugins/files/types';
import type { FilePreviewMode } from '@/plugins/files/extensions';
import type { WorkspaceFileContext } from '@/lib/host-api';

export interface ChatArtifactContextValue {
  artifactWorkbenchFullscreen: boolean;
  onToggleArtifactWorkbenchFullscreen: () => void;
  artifactGroups: Array<{
    graphItemKey: string;
    anchorItemKey?: string;
    triggerItemKey?: string;
    replyItemKey?: string;
    files: GeneratedFile[];
  }>;
  artifactFocusedGroupKey?: string | null;
  artifactFocusedGroupFiles?: GeneratedFile[];
  artifactFocusedFile: ArtifactPreviewTarget | null;
  artifactActiveSection: 'changes' | 'preview' | 'workspace';
  artifactViewMode: FilePreviewMode;
  artifactWorkspaceRoot: string | null;
  artifactWorkspaceContext?: WorkspaceFileContext;
  workspaceRecoveryAction?: ReactNode;
  onArtifactFocusFile: (file: ArtifactPreviewTarget, options?: { preserveSection?: 'workspace' }) => void;
  onOpenGeneratedArtifactFile: (file: GeneratedFile, options?: { preserveSection?: boolean | 'current' }) => void;
  onOpenArtifactGroup: (groupKey: string, options?: { preserveSection?: boolean | 'current' }) => void;
  onArtifactSectionChange: (section: 'changes' | 'preview' | 'workspace') => void;
  onArtifactViewModeChange: (mode: FilePreviewMode) => void;
  onArtifactRevealInFileManager: (filePath: string) => void;
}

export const ChatArtifactContext = createContext<ChatArtifactContextValue | null>(null);

export function useChatArtifactContext(): ChatArtifactContextValue {
  const context = useContext(ChatArtifactContext);
  if (!context) throw new Error('Chat artifacts require their workspace owner');
  return context;
}
