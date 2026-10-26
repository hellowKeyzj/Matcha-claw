import { Question, notes } from '@serenity-js/core';
import { Attribute, Text } from '@serenity-js/web';
import { ChatPage } from '../pages/chat.page.js';
import { SessionLifecyclePage } from '../pages/session-lifecycle.page.js';

type LifecycleNotes = {
  sessionLifecycle: { title: string; selector: string; marker: string; prompt: string; cancellationPrompt: string };
  lifecycleCompleted: boolean;
  lifecyclePersisted: boolean;
  lifecycleCancelled: boolean;
  lifecycleDeleted: boolean;
};

export const LifecycleTitle = () => notes<LifecycleNotes>().get('sessionLifecycle').title;
export const LifecyclePrompt = () => notes<LifecycleNotes>().get('sessionLifecycle').prompt;
export const LifecycleCancellationPrompt = () => notes<LifecycleNotes>().get('sessionLifecycle').cancellationPrompt;
export const LifecycleDeleteDialogMatches = () => Question.about('the application deletion dialog names only this owned session', async actor => {
  const title = await actor.answer(LifecycleTitle());
  const label = await actor.answer(Attribute.called('aria-label').of(SessionLifecyclePage.deleteDialog));
  return label === `删除 ${title}` || label === `Delete ${title}`;
});
export const LifecycleSelector = () => notes<LifecycleNotes>().get('sessionLifecycle').selector;
export const LifecycleCatalogTitle = () => Text.of(SessionLifecyclePage.title(LifecycleSelector()));
export const LifecycleCatalogEntryIsPresent = () => ChatPage.session(LifecycleSelector()).isPresent();
export const LifecycleAssistantIsVisible = () => SessionLifecyclePage.assistant(notes<LifecycleNotes>().get('sessionLifecycle').marker).isVisible();
export const LifecycleUserIsVisible = () => SessionLifecyclePage.user(notes<LifecycleNotes>().get('sessionLifecycle').prompt).isVisible();
export const LifecycleTurnCompleted = () => notes<LifecycleNotes>().get('lifecycleCompleted');
export const LifecycleTurnPersisted = () => notes<LifecycleNotes>().get('lifecyclePersisted');
export const LifecycleTurnCancelled = () => notes<LifecycleNotes>().get('lifecycleCancelled');
export const LifecycleSessionDeleted = () => notes<LifecycleNotes>().get('lifecycleDeleted');
