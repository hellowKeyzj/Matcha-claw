import { memo, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { ChatWorkspaceContentProps } from '@/plugins/chat/extensions';
import { buildSessionIdentityKey } from '@/types/desktop/runtime-address';
import { useTeamsStore } from '../store';
import { buildTeamGraphPageRequest, type TeamGraphSurface } from './runtime-surface';
import { useWorkspace } from '@/plugins/workspace/context';

export const TeamChatWorkspace = memo(function TeamChatWorkspace({ isActive, enabled, visible, sessionIdentity, ownership }: ChatWorkspaceContentProps) {
  const { t } = useTranslation('teams');
  const { openPage } = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const designTeamId = ownership?.kind === 'team' && ownership.roleId === 'leader' ? ownership.teamId : null;
  const teamGraphTeamId = ownership?.kind === 'team' ? ownership.teamId : null;
  const teamGraphRunId = ownership?.kind === 'team' ? ownership.teamRunId : null;
  const designTeamKnown = useTeamsStore((state) => Boolean(designTeamId && state.teams.some((team) => team.id === designTeamId)));
  const openedDesignNavigationRef = useRef<string | null>(null);
  useEffect(() => {
    const surface = (location.state as { teamDesignSurface?: TeamGraphSurface } | null)?.teamDesignSurface;
    if (!surface || openedDesignNavigationRef.current === location.key || !enabled || !sessionIdentity
      || surface.teamId !== teamGraphTeamId || surface.runId !== teamGraphRunId
      || buildSessionIdentityKey(surface.sourceSessionIdentity) !== buildSessionIdentityKey(sessionIdentity)) return;
    const request = buildTeamGraphPageRequest(surface);
    if (!request) return;
    openedDesignNavigationRef.current = location.key;
    openPage(request.page);
  }, [location.key, location.state, enabled, sessionIdentity, teamGraphTeamId, teamGraphRunId, openPage]);

  if (!visible || !isActive || !designTeamId || designTeamKnown) return null;
  return <div role="alert" className="flex items-center gap-2 p-3 text-sm text-destructive">
    {t('chat.teamNotFound')}
    <Button variant="outline" size="sm" onClick={() => navigate('/teams')}>{t('chat.backToList')}</Button>
  </div>;
});
