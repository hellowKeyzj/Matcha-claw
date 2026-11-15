import { createContext, useContext } from 'react';
import type { RunWorkspaceProjection } from '@/types/team-workspace';
import type { TeamNodeDeliverySelection } from './team-node-editor-types';

export const TeamFilePreviewContext = createContext<{
  ready: boolean;
  workspaceStatus?: RunWorkspaceProjection['status'];
  selectFile: (selection: TeamNodeDeliverySelection, ownerId?: string) => void;
} | null>(null);

export function useTeamFilePreview() {
  const context = useContext(TeamFilePreviewContext);
  if (!context) throw new Error('TeamFilePreview is required');
  return context;
}
