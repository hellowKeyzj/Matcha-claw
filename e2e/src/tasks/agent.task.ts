import { Ensure, equals, isGreaterThan } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait } from '@serenity-js/core';
import { Clear, Click, Enter, Select, isEnabled, isVisible } from '@serenity-js/web';
import {
  ConfirmWorkspaceAgent, PrepareWorkspaceAgent, SubmitWorkspaceAgent, SubmitWorkspaceAgentDeletion,
} from '../interactions/chat.interaction.js';
import { AccountPage } from '../pages/account.page.js';
import { AgentPage } from '../pages/agent.page.js';
import { ChatPage } from '../pages/chat.page.js';
import {
  AvailableModelCount, DeleteAgentDialogMatches, ExistingModelValue, OpenClawManagementIsAvailable,
  OpenClawManagementIsSelected, WorkspaceAgentCardName, WorkspaceAgentCardSelector,
  WorkspaceAgentChatSelector, WorkspaceAgentIsSelected, WorkspaceAgentName, WorkspaceAgentNameCount,
  WorkspaceAgentWasCreated,
} from '../questions/agent.question.js';
import { ChatIsVisible } from '../questions/chat.question.js';
import { EnterChat } from './chat.task.js';

const OpenOpenClawManagement = () => Task.where('#actor opens the OpenClaw Agent management UI',
  EnterChat(),
  Check.whether(ChatPage.switchboard, isVisible()).andIfSo(Click.on(ChatPage.switchboardBackdrop)),
  Check.whether(ChatPage.fullscreenPanel, isVisible()).andIfSo(Click.on(ChatPage.closeSidePanel)),
  Check.whether(AccountPage.expandSidebar, isVisible()).andIfSo(Click.on(AccountPage.expandSidebar)),
  Click.on(AgentPage.navigation),
  Wait.upTo(Duration.ofSeconds(45)).until(OpenClawManagementIsAvailable(), equals(true)),
  Check.whether(AgentPage.openClawRuntime, isVisible()).andIfSo(Click.on(AgentPage.openClawRuntime)),
  Wait.until(OpenClawManagementIsSelected(), equals(true)),
  Click.on(AgentPage.myAgentsTab),
  Clear.theValueOf(AgentPage.search),
  Wait.upTo(Duration.ofSeconds(45)).until(AgentPage.newAgent, isEnabled()),
  Wait.until(AgentPage.grid, isVisible()),
);

export const CreateWorkspaceAgent = () => Task.where('#actor creates an independent OpenClaw Agent with an existing model',
  OpenOpenClawManagement(),
  PrepareWorkspaceAgent(),
  Ensure.that(WorkspaceAgentNameCount(), equals(0)),
  Click.on(AgentPage.newAgent),
  Wait.until(AgentPage.createDialog, isVisible()),
  Enter.theValue(WorkspaceAgentName()).into(AgentPage.name),
  Wait.upTo(Duration.ofSeconds(45)).until(AgentPage.model, isEnabled()),
  Wait.until(AvailableModelCount(), isGreaterThan(0)),
  Select.value(ExistingModelValue()).from(AgentPage.model),
  Wait.until(AgentPage.create, isEnabled()),
  Ensure.that(OpenClawManagementIsSelected(), equals(true)),
  Ensure.that(AgentPage.createDialogs.count(), equals(1)),
  SubmitWorkspaceAgent(),
  Wait.upTo(Duration.ofSeconds(45)).until(AgentPage.createDialogs.count(), equals(0)),
  Wait.upTo(Duration.ofSeconds(45)).until(WorkspaceAgentNameCount(), equals(1)),
  Ensure.that(OpenClawManagementIsSelected(), equals(true)),
  ConfirmWorkspaceAgent(),
);

export const OpenWorkspaceAgentChat = () => Task.where('#actor opens the confirmed Agent through its own Chat entry',
  Ensure.that(OpenClawManagementIsSelected(), equals(true)),
  Ensure.that(WorkspaceAgentCardName(), equals(WorkspaceAgentName())),
  Wait.until(AgentPage.chat(WorkspaceAgentCardSelector()), isEnabled()),
  Click.on(AgentPage.chat(WorkspaceAgentCardSelector())),
  Wait.upTo(Duration.ofSeconds(45)).until(ChatIsVisible(), equals(true)),
  Click.on(ChatPage.identity),
  Click.on(ChatPage.agentsTab),
  Wait.upTo(Duration.ofSeconds(45)).until(ChatPage.agent(WorkspaceAgentChatSelector()), isVisible()),
  Ensure.that(WorkspaceAgentIsSelected(), equals('true')),
  Click.on(ChatPage.switchboardBackdrop),
);

export const DeleteWorkspaceAgent = () => Task.where('#actor deletes only this case\'s confirmed OpenClaw Agent and its files',
  Check.whether(WorkspaceAgentWasCreated(), equals(true)).andIfSo(
    OpenOpenClawManagement(),
    Ensure.that(WorkspaceAgentCardName(), equals(WorkspaceAgentName())),
    Click.on(AgentPage.more(WorkspaceAgentCardSelector())),
    Click.on(AgentPage.deleteMenuItem),
    Wait.until(AgentPage.deleteDialog, isVisible()),
    Ensure.that(DeleteAgentDialogMatches(), equals(true)),
    Ensure.that(OpenClawManagementIsSelected(), equals(true)),
    Ensure.that(AgentPage.deleteDialogs.count(), equals(1)),
    SubmitWorkspaceAgentDeletion(),
    Wait.upTo(Duration.ofSeconds(45)).until(AgentPage.deleteDialogs.count(), equals(0)),
    Wait.until(AgentPage.card(WorkspaceAgentCardSelector()).isVisible(), equals(false)),
    Ensure.that(OpenClawManagementIsSelected(), equals(true)),
  ),
);

export const DismissAgentDialogs = () => Task.where('#actor leaves any unfinished Agent form without repeating a mutation',
  Check.whether(AgentPage.createDialog, isVisible()).andIfSo(
    Wait.upTo(Duration.ofSeconds(45)).until(AgentPage.closeCreate, isEnabled()),
    Click.on(AgentPage.closeCreate),
  ),
  Check.whether(AgentPage.deleteDialog, isVisible()).andIfSo(
    Wait.upTo(Duration.ofSeconds(45)).until(AgentPage.closeDelete, isEnabled()),
    Click.on(AgentPage.closeDelete),
  ),
);
