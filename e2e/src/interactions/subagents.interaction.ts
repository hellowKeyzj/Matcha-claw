import { Interaction, notes } from '@serenity-js/core';
import { Attribute, Click } from '@serenity-js/web';
import { Subagents } from '../abilities/subagents.ability.js';
import { SubagentsPage } from '../pages/subagents.page.js';

export const ObserveOpenClawSubagentBoundary = () => Interaction.where('#actor reads the public OpenClaw roster and a unique missing Agent configuration', async actor => {
  await notes().set('subagentsBoundary', await actor.abilityTo(Subagents).inspectOpenClawBoundary()).performAs(actor);
});

export const ObserveNativeSubagentsAndRejection = () => Interaction.where('#actor reads the supported native roster and exact invalid-request rejection', async actor => {
  await notes().set('subagentsNative', await actor.abilityTo(Subagents).inspectNativeAndInvalidRequest()).performAs(actor);
});

export const ObserveDeletedSubagentRoute = () => Interaction.where('#actor probes only the deleted public Subagent route', async actor => {
  await notes().set('subagentsDeletedRoute', await actor.abilityTo(Subagents).inspectDeletedRoute()).performAs(actor);
});

export const ObserveKnownSubagentTemplate = () => Interaction.where('#actor reads a real catalog ID and the same public template detail without private fields', async actor => {
  await notes().set('subagentsTemplate', await actor.abilityTo(Subagents).inspectKnownTemplate()).performAs(actor);
});

export const RememberSubagentRoster = () => Interaction.where('#actor records the pre-creation public Agent identities', async actor => {
  await notes().set('subagentsPreviousIds', await actor.abilityTo(Subagents).rememberRoster()).performAs(actor);
});

export const ObserveOwnedSubagentConfiguration = () => Interaction.where('#actor reads only the owned Agent public skill and tool settings', async actor => {
  const agentId = await actor.answer(notes<{ workspaceAgentId: string }>().get('workspaceAgentId'));
  await notes().set('subagentsConfiguration', await actor.abilityTo(Subagents).inspectConfiguration(agentId)).performAs(actor);
});

export const ChooseExistingSubagentSkill = () => Interaction.where('#actor selects one already-installed Skill from the public options', async actor => {
  const agentId = await actor.answer(notes<{ workspaceAgentId: string }>().get('workspaceAgentId'));
  const choice = await actor.abilityTo(Subagents).chooseExistingSkill(agentId);
  await notes().set('subagentsSkillKey', choice.skillKey).performAs(actor);
  await notes().set('subagentsSkillName', choice.skillName).performAs(actor);
});

export const BoundSubagentSkillSelection = () => Interaction.where('#actor bounds its own Agent to exactly one existing Skill using the UI', async actor => {
  const displayName = await actor.answer(notes<{ subagentsSkillName: string }>().get('subagentsSkillName'));
  const switches = await actor.answer(SubagentsPage.skillSwitches);
  let selectedLabel: string | undefined;
  for (const skill of switches) {
    const label = await actor.answer(Attribute.called('aria-label').of(skill));
    if (await actor.answer(Attribute.called('aria-checked').of(skill)) === 'true') await Click.on(skill).performAs(actor);
    if (label === `切换技能 ${displayName}` || label === `Toggle skill ${displayName}`) selectedLabel = label;
  }
  if (!selectedLabel) throw new Error('The publicly selected existing Skill is missing from the real Agent editor');
  await notes().set('subagentsSkillLabel', selectedLabel).performAs(actor);
  await Click.on(SubagentsPage.skill(selectedLabel)).performAs(actor);
});

export const ReloadSubagentProjection = () => Interaction.where('#actor reloads the same Renderer without restarting Electron', actor =>
  actor.abilityTo(Subagents).reloadProjection(),
);

export const RecoverUnconfirmedSubagent = () => Interaction.where('#actor resolves only its unique new Agent before UI cleanup', async actor => {
  const notepad = notes<{ workspaceAgentName: string; workspaceAgentId: string; subagentsPreviousIds: string[] }>();
  if (!await actor.answer(notepad.has('workspaceAgentName')) || await actor.answer(notepad.has('workspaceAgentId'))) return;
  const name = await actor.answer(notepad.get('workspaceAgentName'));
  const id = await actor.abilityTo(Subagents).findCreatedAgent(name, await actor.answer(notepad.get('subagentsPreviousIds')));
  if (id) await notes().set('subagentsRecoveryId', id).performAs(actor);
});
