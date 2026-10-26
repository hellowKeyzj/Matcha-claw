import { Question, notes } from '@serenity-js/core';
import { Attribute, Text } from '@serenity-js/web';
import { AgentPage } from '../pages/agent.page.js';
import { ChatPage } from '../pages/chat.page.js';

type AgentNotes = { workspaceAgentName: string; workspaceAgentId: string };

export const WorkspaceAgentName = () => notes<AgentNotes>().get('workspaceAgentName');
export const WorkspaceAgentId = () => notes<AgentNotes>().get('workspaceAgentId');
export const WorkspaceAgentWasCreated = () => notes<AgentNotes>().has('workspaceAgentId');
export const WorkspaceAgentCardSelector = () => WorkspaceAgentId().as(id => `article:has(p[title=${JSON.stringify(id)}])`);
export const WorkspaceAgentChatSelector = () => WorkspaceAgentId().as(id => `[data-testid=${JSON.stringify(`agent-item-${id}`)}]`);
export const WorkspaceAgentNameCount = () => AgentPage.namedCards(WorkspaceAgentName()).count();
export const AvailableModelCount = () => AgentPage.availableModels.count();
export const ExistingModelValue = () => Attribute.called('value').of(AgentPage.availableModels.first());
export const OpenClawManagementIsAvailable = () => Question.about('OpenClaw management is available in the UI', async actor =>
  await actor.answer(AgentPage.openClawRuntime.isVisible()) || await actor.answer(AgentPage.onlyOpenClawRuntime.isVisible()),
);
export const OpenClawManagementIsSelected = () => Question.about('OpenClaw management is selected in the UI', async actor =>
  await actor.answer(AgentPage.onlyOpenClawRuntime.isPresent())
  || (await actor.answer(AgentPage.openClawRuntime.isPresent())
    && await actor.answer(Attribute.called('aria-checked').of(AgentPage.openClawRuntime)) === 'true'),
);
export const WorkspaceAgentIsSelected = () => Attribute.called('aria-current').of(ChatPage.agent(WorkspaceAgentChatSelector()));
export const WorkspaceAgentCardName = () => Text.of(AgentPage.cardName(WorkspaceAgentCardSelector()));
export const DeleteAgentDialogMatches = () => Question.about('the deletion dialog targets the confirmed Workspace Agent', async actor => {
  const id = await actor.answer(WorkspaceAgentId());
  const title = await actor.answer(Attribute.called('aria-label').of(AgentPage.deleteDialog));
  return title === `删除 ${id}` || title === `Delete ${id}`;
});
