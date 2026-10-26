import { Interaction, notes } from '@serenity-js/core';
import { Attribute, Click, Text } from '@serenity-js/web';
import { UseChat } from '../abilities/use-chat.ability.js';
import { AgentPage } from '../pages/agent.page.js';
import { ChatPage } from '../pages/chat.page.js';

export const DropPng = () => Interaction.where('#actor drops a real PNG onto the chat composer',
  actor => UseChat.as(actor).dropPng(),
);

export const RememberPngSessionBaseline = () => Interaction.where('#actor records complete directory identities before the only PNG send',
  actor => UseChat.as(actor).rememberPngSessionBaseline(),
);

export const RememberPngSession = () => Interaction.where('#actor records the complete current PNG session identity from its directory entry', async actor => {
  const testId = await UseChat.as(actor).rememberPngSession();
  await notes<{ pngSessionAvatar: string }>().set('pngSessionAvatar', testId).performAs(actor);
});

export const ObserveSentImage = () => Interaction.where('#actor waits for the sent message\'s image to decode', async actor => {
  await notes<{ sentImageDecoded: boolean }>().set('sentImageDecoded', false).performAs(actor);
  const decoded = await UseChat.as(actor).waitForSentImage();
  await notes<{ sentImageDecoded: boolean }>().set('sentImageDecoded', decoded).performAs(actor);
});

export const ExpandSessionBuckets = () => Interaction.where('#actor expands only collapsed session time buckets', async actor => {
  const buckets = await actor.answer(ChatPage.collapsedSessionBuckets);
  for (const bucket of buckets.reverse()) await Click.on(bucket).performAs(actor);
});

export const PrepareWorkspaceAgent = () => Interaction.where('#actor records existing Agent IDs and chooses a unique name', async actor => {
  const previousIds = await actor.answer(Text.ofAll(AgentPage.ids));
  const name = UseChat.as(actor).prepareWorkspaceAgent(previousIds);
  await notes<{ workspaceAgentName: string }>().set('workspaceAgentName', name).performAs(actor);
});

export const SubmitWorkspaceAgent = () => Interaction.where('#actor submits Workspace Agent creation exactly once', async actor => {
  UseChat.as(actor).submitWorkspaceAgent();
  await Click.on(AgentPage.create).performAs(actor);
});

export const ConfirmWorkspaceAgent = () => Interaction.where('#actor records only a newly confirmed Agent identity', async actor => {
  const name = await actor.answer(notes<{ workspaceAgentName: string }>().get('workspaceAgentName'));
  const idElement = AgentPage.idForName(name);
  const id = UseChat.as(actor).confirmWorkspaceAgent(
    await actor.answer(Text.of(idElement)),
    await actor.answer(Text.of(AgentPage.nameForName(name))),
    await actor.answer(Attribute.called('title').of(idElement)),
    await actor.answer(Attribute.called('aria-label').of(AgentPage.moreForName(name))),
    await actor.answer(Attribute.called('aria-label').of(AgentPage.chatForName(name))),
  );
  await notes<{ workspaceAgentId: string }>().set('workspaceAgentId', id).performAs(actor);
});

export const SubmitWorkspaceAgentDeletion = () => Interaction.where('#actor confirms deletion of only the recorded Workspace Agent, once', async actor => {
  const id = await actor.answer(notes<{ workspaceAgentId: string }>().get('workspaceAgentId'));
  UseChat.as(actor).submitWorkspaceAgentDeletion(id);
  await Click.on(AgentPage.delete).performAs(actor);
});
