import i18n from '@/i18n';
import { selectChatSelection } from '@/plugins/chat/chat-session';
import { useComposerDraftStore } from '@/plugins/chat/composer-drafts';
import { useChatStore } from '@/plugins/chat/store';
import type { AppPluginDevelopment, AppPluginKind, AppPluginManifest } from '@/types/desktop/app-plugin';

export type PluginDevelopmentSummary = AppPluginDevelopment & {
  state: 'active' | 'installed' | 'stopped';
  revision?: number;
  manifest?: AppPluginManifest;
  digest?: string;
};

export function stagePluginDevelopmentPrompt(category: AppPluginKind): boolean {
  const { currentComposerDraftKey } = selectChatSelection(useChatStore.getState());
  if (!currentComposerDraftKey) return false;
  const prompt = i18n.t('applicationPlugins:makePrompt', { category: i18n.t(`applicationPlugins:category.${category}`) });
  useComposerDraftStore.getState().setDraft(currentComposerDraftKey, (draft) => `${draft}${draft && !draft.endsWith('\n') ? '\n' : ''}${prompt}`);
  return true;
}
