import { TeamNavigationIcon } from '@/components/icons/navigation';
import { applicationNavigation, applicationPages } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { chatComposerContent, chatThreadHeader, chatWorkspaceContent } from '@/plugins/chat/extensions';
import { TEAMS_FEATURE_ENABLED } from './feature-flag';
import { observeTeamExecutionTargets } from './execution-targets';

const TeamsPage = lazyWithPreload(() => import('./pages'));
const TeamChatPage = lazyWithPreload(() => import('./pages/TeamChat'));
const TeamSessionHeader = lazyWithPreload(async () => ({ default: (await import('./chat/TeamSessionHeader')).TeamSessionHeader }));
const TeamChatWorkspace = lazyWithPreload(async () => ({ default: (await import('./chat/TeamChatWorkspace')).TeamChatWorkspace }));

export const teamsPlugin = definePlugin({
  id: 'teams',
  requires: ['app-shell', 'chat'],
  activate: observeTeamExecutionTargets,
  contributes: [
    contribute(chatComposerContent, { id: 'teams', order: 10, load: () => import('./chat/TeamComposerActions').then((module) => module.TeamComposerActions) }),
    contribute(chatWorkspaceContent, { id: 'teams', order: 10, component: TeamChatWorkspace }),
    contribute(chatThreadHeader, { id: 'teams', order: 10, component: TeamSessionHeader }),
    contribute(applicationPages, TEAMS_FEATURE_ENABLED
      ? { id: 'teams', path: '/teams', component: TeamsPage, viewport: 'document', preload: TeamsPage.preload }
      : { id: 'teams', path: '/teams', redirectTo: '/' }),
    contribute(applicationPages, TEAMS_FEATURE_ENABLED
      ? { id: 'team-chat', path: '/teams/:teamId', component: TeamChatPage, viewport: 'document', preload: TeamChatPage.preload }
      : { id: 'team-chat', path: '/teams/:teamId', redirectTo: '/' }),
    ...(TEAMS_FEATURE_ENABLED ? [contribute(applicationNavigation, {
      id: 'teams',
      to: '/teams',
      label: 'common:sidebar.teams',
      icon: TeamNavigationIcon,
      order: 30,
    })] : []),
  ],
});
