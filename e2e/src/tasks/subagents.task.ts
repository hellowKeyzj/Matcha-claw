import { Ensure, equals } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait } from '@serenity-js/core';
import { Clear, Click, Select, Text, isEnabled, isVisible } from '@serenity-js/web';
import { ConfirmWorkspaceAgent } from '../interactions/chat.interaction.js';
import {
  BoundSubagentSkillSelection, ChooseExistingSubagentSkill, ObserveDeletedSubagentRoute, ObserveKnownSubagentTemplate,
  ObserveNativeSubagentsAndRejection, ObserveOpenClawSubagentBoundary, ObserveOwnedSubagentConfiguration,
  RecoverUnconfirmedSubagent, ReloadSubagentProjection, RememberSubagentRoster,
} from '../interactions/subagents.interaction.js';
import { AgentPage } from '../pages/agent.page.js';
import { ChatPage } from '../pages/chat.page.js';
import { SubagentsPage } from '../pages/subagents.page.js';
import { OpenClawManagementIsAvailable, OpenClawManagementIsSelected, WorkspaceAgentCardSelector, WorkspaceAgentName } from '../questions/agent.question.js';
import {
  BoundedSubagentConfiguration, ChosenSubagentSkillIsChecked, SubagentConfiguration, SubagentRecoveryIsNeeded,
  SubagentRecoverySelector, SubagentSkillsInherit, SubagentToolProfile, SubagentToolsInherit,
} from '../questions/subagents.question.js';
import { CreateWorkspaceAgent, DeleteWorkspaceAgent, DismissAgentDialogs } from './agent.task.js';
import { EnterChat } from './chat.task.js';

export const OpenSubagents = () => Task.where('#actor opens the real OpenClaw Subagents roster through navigation',
  EnterChat(),
  Check.whether(ChatPage.switchboard, isVisible()).andIfSo(Click.on(ChatPage.switchboardBackdrop)),
  Click.on(AgentPage.navigation),
  Wait.upTo(Duration.ofSeconds(45)).until(OpenClawManagementIsAvailable(), equals(true)),
  Check.whether(AgentPage.openClawRuntime, isVisible()).andIfSo(Click.on(AgentPage.openClawRuntime)),
  Wait.until(OpenClawManagementIsSelected(), equals(true)),
  Click.on(AgentPage.myAgentsTab),
  Clear.theValueOf(AgentPage.search),
  Click.on(SubagentsPage.gridView),
  Wait.upTo(Duration.ofSeconds(45)).until(AgentPage.grid, isVisible()),
  Wait.until(AgentPage.newAgent, isEnabled()),
);

export const ReadOpenClawSubagentBoundary = () => Task.where('#actor inspects the current OpenClaw list and missing-Agent read contract',
  OpenSubagents(), ObserveOpenClawSubagentBoundary(),
);
export const ReadNativeSubagentsAndInvalidRequest = () => Task.where('#actor distinguishes a supported native roster from a malformed request',
  ObserveNativeSubagentsAndRejection(),
);
export const ProbeDeletedSubagentRoute = () => Task.where('#actor verifies the historical route stays unavailable', ObserveDeletedSubagentRoute());
export const ReadKnownSubagentTemplate = () => Task.where('#actor reads a known public template with matching identity and recursive redaction', ObserveKnownSubagentTemplate());

export const CreateIndependentSubagent = () => Task.where('#actor creates only a unique independent Agent for configuration persistence',
  OpenSubagents(), RememberSubagentRoster(), CreateWorkspaceAgent(),
);

const OpenOwnedSubagentEditor = () => Task.where('#actor opens only the confirmed new Agent editor',
  OpenSubagents(),
  Click.on(SubagentsPage.edit(WorkspaceAgentCardSelector())),
  Wait.until(SubagentsPage.editor, isVisible()),
);
const SaveSubagentConfiguration = () => Task.where('#actor saves its Agent configuration once and waits for the real form to close',
  Wait.until(SubagentsPage.save, isEnabled()),
  Ensure.that(SubagentsPage.editDialogs.count(), equals(1)),
  Click.on(SubagentsPage.save),
  Wait.upTo(Duration.ofSeconds(45)).until(SubagentsPage.editDialogs.count(), equals(0)),
);

export const SaveBoundedSubagentConfiguration = () => Task.where('#actor saves one existing Skill and the minimal tool policy through the UI',
  ChooseExistingSubagentSkill(), OpenOwnedSubagentEditor(),
  Click.on(SubagentsPage.skillsTab),
  Wait.upTo(Duration.ofSeconds(45)).until(SubagentsPage.inheritSkills, isEnabled()),
  Ensure.that(SubagentSkillsInherit(), equals('true')),
  Click.on(SubagentsPage.inheritSkills), BoundSubagentSkillSelection(),
  Ensure.that(ChosenSubagentSkillIsChecked(), equals('true')),
  Click.on(SubagentsPage.toolsTab),
  Wait.upTo(Duration.ofSeconds(45)).until(SubagentsPage.inheritTools, isEnabled()),
  Ensure.that(SubagentToolsInherit(), equals('true')),
  Click.on(SubagentsPage.inheritTools), Select.value('minimal').from(SubagentsPage.toolProfile),
  SaveSubagentConfiguration(), ObserveOwnedSubagentConfiguration(),
  Ensure.that(SubagentConfiguration(), equals(BoundedSubagentConfiguration())),
);

export const ReloadBoundedSubagentConfiguration = () => Task.where('#actor verifies persisted configuration in a new Renderer projection and the public readback',
  ReloadSubagentProjection(), OpenOwnedSubagentEditor(),
  Click.on(SubagentsPage.skillsTab),
  Wait.upTo(Duration.ofSeconds(45)).until(SubagentsPage.inheritSkills, isEnabled()),
  Ensure.that(SubagentSkillsInherit(), equals('false')),
  Ensure.that(ChosenSubagentSkillIsChecked(), equals('true')),
  Click.on(SubagentsPage.toolsTab),
  Wait.upTo(Duration.ofSeconds(45)).until(SubagentsPage.inheritTools, isEnabled()),
  Ensure.that(SubagentToolsInherit(), equals('false')),
  Ensure.that(SubagentToolProfile(), equals('minimal')),
  ObserveOwnedSubagentConfiguration(),
);

export const RestoreSubagentInheritance = () => Task.where('#actor restores default inheritance and proves it survives another Renderer reload',
  Click.on(SubagentsPage.inheritTools), Click.on(SubagentsPage.skillsTab), Click.on(SubagentsPage.inheritSkills),
  SaveSubagentConfiguration(), ReloadSubagentProjection(), OpenOwnedSubagentEditor(),
  Click.on(SubagentsPage.skillsTab),
  Wait.upTo(Duration.ofSeconds(45)).until(SubagentsPage.inheritSkills, isEnabled()),
  Ensure.that(SubagentSkillsInherit(), equals('true')),
  Click.on(SubagentsPage.toolsTab),
  Wait.upTo(Duration.ofSeconds(45)).until(SubagentsPage.inheritTools, isEnabled()),
  Ensure.that(SubagentToolsInherit(), equals('true')),
  ObserveOwnedSubagentConfiguration(),
);

export const CleanUpIndependentSubagent = () => Task.where('#actor precisely deletes only this case’s owned Agent, including a partially confirmed create',
  Check.whether(SubagentsPage.editor, isVisible()).andIfSo(Click.on(SubagentsPage.close)),
  DismissAgentDialogs(), RecoverUnconfirmedSubagent(),
  Check.whether(SubagentRecoveryIsNeeded(), equals(true)).andIfSo(
    OpenSubagents(),
    Ensure.that(Text.of(AgentPage.cardName(SubagentRecoverySelector())), equals(WorkspaceAgentName())),
    ConfirmWorkspaceAgent(),
  ),
  DeleteWorkspaceAgent(),
);
