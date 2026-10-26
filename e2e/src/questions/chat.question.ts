import { Question, notes } from '@serenity-js/core';
import { Attribute, Text, Value } from '@serenity-js/web';
import { AccountPage } from '../pages/account.page.js';
import { ChatPage } from '../pages/chat.page.js';
import { LicensePage } from '../pages/license.page.js';

export const ChatIsVisible = () => Question.about('the complete local Chat is usable', async actor =>
  await actor.answer(ChatPage.workspaceHost.isVisible())
  && await actor.answer(ChatPage.input.isVisible())
  && await actor.answer(ChatPage.input.isEnabled())
  && !await actor.answer(Attribute.called('readonly').of(ChatPage.input).isPresent())
  && !await actor.answer(AccountPage.signInHeading.isVisible())
  && !await actor.answer(LicensePage.heading.isVisible()),
);
export const ChatEntryIsVisible = () => Question.about('local entry, Chat, or local navigation is visible', async actor =>
  await actor.answer(AccountPage.continueLocally.isVisible())
  || await actor.answer(ChatPage.workspaceHost.isVisible())
  || await actor.answer(ChatPage.otherPage.isVisible()),
);
export const ChatInputValue = () => Value.of(ChatPage.input);
export const UserMessageCount = () => ChatPage.userMessages.count();
export const SelectedAgent = () => Attribute.called('title').of(ChatPage.identity);
export const SessionCount = () => ChatPage.sessions.count();
export const SessionErrorCount = () => ChatPage.sessionErrors.count();
export const WorkspaceText = () => Text.of(ChatPage.workspace);
export const AgentsFileIsVisible = () => ChatPage.agentsFile.isVisible();
export const AgentsPreviewTitleIsVisible = () => ChatPage.previewTitle.isVisible();
export const AgentsPreviewText = () => Text.of(ChatPage.preview);
export const PngIsReady = () => ChatPage.readyPng.isVisible();
export const ChatBodyText = () => Text.of(ChatPage.body);
export const SentUserText = () => Text.of(ChatPage.sentText);
export const SentImageIsVisible = () => ChatPage.sentImagePreview.isVisible();
export const SentImageSource = () => Attribute.called('src').of(ChatPage.sentImage);
export const SentImageIsDecoded = () => notes<{ sentImageDecoded: boolean }>().get('sentImageDecoded');
export const SentMessageText = () => Text.of(ChatPage.sentUserRow);
export const CurrentSessionCount = () => ChatPage.currentSessions.count();
export const SessionDirectoryIsReady = () => Question.about('the session directory has finished loading', async actor =>
  await actor.answer(ChatPage.sessionDirectory.isVisible())
  && !await actor.answer(ChatPage.sessionListLoading.isPresent())
  && await actor.answer(SessionErrorCount()) === 0
  && (await actor.answer(ChatPage.sessionDirectoryContents.count()) > 0 || await actor.answer(ChatPage.emptySessionDirectory.isPresent())),
);
export const PngSessionSelector = () => notes<{ pngSessionAvatar: string }>().get('pngSessionAvatar')
  .as(testId => `[data-testid=${JSON.stringify(testId)}]`);

type WorkspacePanelNotes = {
  workspacePanelWasOpen: boolean;
  workspacePanelState: { tab: string; section?: string; fullscreen: boolean };
};
export const WorkspacePanelWasOpen = () => notes<WorkspacePanelNotes>().get('workspacePanelWasOpen');
export const WorkspacePanelStateWasSaved = () => notes<WorkspacePanelNotes>().has('workspacePanelState');
export const SavedWorkspacePanelState = () => notes<WorkspacePanelNotes>().get('workspacePanelState');
export const SavedPanelTabSelector = () => SavedWorkspacePanelState().tab.as(tab => `[data-testid="chat-side-panel-tab-${tab}"]`);
export const SavedArtifactSectionSelector = () => SavedWorkspacePanelState().as(state => `[data-testid=${JSON.stringify(state.section)}]`);
export const WorkspacePanelIsFullscreen = () => Attribute.called('data-artifact-fullscreen').of(ChatPage.sidePanel).as(value => value === 'true');
export const WorkspacePanelState = () => Question.about('the visible Chat side panel state before Agent management', async actor => {
  const open = await actor.answer(ChatPage.sidePanel.isVisible());
  if (!open) throw new Error('Chat side panel must be open before its state is saved');
  const tab = await actor.answer(Attribute.called('data-active-tab').of(ChatPage.sidePanel));
  const section = await actor.answer(ChatPage.activeArtifactSection.isVisible())
    ? await actor.answer(Attribute.called('data-testid').of(ChatPage.activeArtifactSection)) : undefined;
  return {
    open, tab, section,
    fullscreen: await actor.answer(Attribute.called('data-artifact-fullscreen').of(ChatPage.sidePanel)) === 'true',
  };
});
