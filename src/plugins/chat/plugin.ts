import { MessageSquare, Paperclip, Settings2, Target } from 'lucide-react';
import { applicationPages } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { chatComposerActions, chatComposerContent, chatThreadHeader, chatWorkspaceContent, type ChatComposerAction } from './extensions';
import { subscribeChatHostEvents } from './host-observation';

const ChatPage = lazyWithPreload(() => import('./page'));

const composerActions: readonly ChatComposerAction[] = [
  { id: 'attach', order: 10, icon: Paperclip, control: 'attach',
    resolve: ({ t, actionsDisabled }) => ({ label: t('input.attachFiles'), disabled: actionsDisabled }),
    execute: ({ attachFiles }) => attachFiles() },
  { id: 'phrases', order: 30, icon: MessageSquare, control: 'quick-phrase', separatorAfter: true,
    resolve: ({ t, actionsDisabled, quickPhraseOpen }) => ({ label: t('input.quickPhrases'), disabled: actionsDisabled, dialogExpanded: quickPhraseOpen }),
    execute: ({ toggleQuickPhrase }) => toggleQuickPhrase() },
  { id: 'skills', order: 40, icon: Settings2, control: 'skills', testId: 'chat-skill-manager-button',
    resolve: ({ skillManagerLabel, actionsDisabled, skillManagerOpen }) => ({ label: skillManagerLabel ?? '', hidden: skillManagerLabel === undefined, disabled: actionsDisabled, dialogExpanded: skillManagerOpen }),
    execute: ({ openSkillManager }) => openSkillManager() },
  { id: 'goal', order: 60, icon: Target, control: 'goal',
    resolve: ({ t, goalSupported, goalDisabled }) => ({ label: t('goal.set'), hidden: !goalSupported, disabled: goalDisabled }),
    execute: ({ startGoal }) => startGoal() },
];

export const chatPlugin = definePlugin({
  id: 'chat',
  requires: ['app-shell', 'workspace'],
  extensionPoints: [chatComposerActions, chatComposerContent, chatWorkspaceContent, chatThreadHeader],
  contributes: [
    contribute(applicationPages, { id: 'chat', path: '/', component: ChatPage, viewport: 'custom', preload: ChatPage.preload }),
    ...composerActions.map((action) => contribute(chatComposerActions, action)),
  ],
  activate() {
    const unsubscribe = subscribeChatHostEvents();
    let active = true;
    let removeDiagnostics = () => {};
    if (import.meta.env.DEV) {
      void import('@/plugins/chat/memory-diagnostics').then(({ installChatMemoryDiagnosticsDebugApi, collectAppMemoryDiagnostics }) => {
        if (!active) return;
        installChatMemoryDiagnosticsDebugApi(window);
        removeDiagnostics = () => {
          if (window.__MATCHACLAW_DEBUG__?.collectMemoryDiagnostics === collectAppMemoryDiagnostics) {
            delete window.__MATCHACLAW_DEBUG__.collectMemoryDiagnostics;
          }
        };
      });
    }
    return () => {
      active = false;
      removeDiagnostics();
      unsubscribe();
    };
  },
});
