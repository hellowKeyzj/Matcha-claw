import { createContext, useContext, type ReactNode } from 'react';
import type { ChatArtifactGroup } from './artifacts';
import type { WorkspaceFileContext } from '@/lib/host-api';

export interface ChatArtifactContextValue {
  artifactGroups: ChatArtifactGroup[];
  artifactWorkspaceRoot: string | null;
  artifactWorkspaceContext: WorkspaceFileContext;
  workspaceRecoveryAction?: ReactNode;
}

export const ChatArtifactContext = createContext<ChatArtifactContextValue | null>(null);

export function useChatArtifactContext(): ChatArtifactContextValue {
  const context = useContext(ChatArtifactContext);
  if (!context) throw new Error('Chat artifacts require their workspace owner');
  return context;
}
