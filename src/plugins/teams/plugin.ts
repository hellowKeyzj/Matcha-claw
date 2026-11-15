import { applicationSettings } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { chatComposerContent, chatThreadHeader, chatWorkspaceContent } from '@/plugins/chat/extensions';
import { observeTeamExecutionTargets } from './execution-targets';

const TeamPromptsSettings = lazyWithPreload(() => import('./settings/TeamPromptsSettings'));
const TeamSessionHeader = lazyWithPreload(async () => ({ default: (await import('./chat/TeamSessionHeader')).TeamSessionHeader }));
const TeamChatWorkspace = lazyWithPreload(async () => ({ default: (await import('./chat/TeamChatWorkspace')).TeamChatWorkspace }));

export const teamsPlugin = definePlugin({
  id: 'teams',
  requires: ['app-shell', 'chat', 'files'],
  activate: observeTeamExecutionTargets,
  contributes: [
    contribute(applicationSettings, { id: 'team-prompts', label: 'teams:prompts.title', order: 45, component: TeamPromptsSettings, layout: 'workspace', keepMounted: true, developerOnly: true }),
    contribute(chatComposerContent, { id: 'teams', order: 10, load: () => import('./chat/TeamComposerActions').then((module) => module.TeamComposerActions) }),
    contribute(chatWorkspaceContent, { id: 'teams', order: 10, component: TeamChatWorkspace }),
    contribute(chatThreadHeader, { id: 'teams', order: 10, component: TeamSessionHeader }),
  ],
});
