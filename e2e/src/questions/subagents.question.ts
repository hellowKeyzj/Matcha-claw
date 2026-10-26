import { Question, notes } from '@serenity-js/core';
import { Attribute, Text, Value } from '@serenity-js/web';
import { AgentPage } from '../pages/agent.page.js';
import { SubagentsPage } from '../pages/subagents.page.js';

type SubagentNotes = {
  subagentsBoundary: { ids: string[]; missingAgentId: string; requestedAgentId: string; support: { supportType: string; reason?: string }; redacted: boolean };
  subagentsNative: { nativeRosterReady: boolean; defaultId: string; rejected: unknown; redacted: boolean };
  subagentsDeletedRoute: { rejected: boolean; message?: string; redacted: boolean };
  subagentsTemplate: { knownId: string; detailId: string; redacted: boolean };
  subagentsConfiguration: { skillMode: string; skillKeys: string[]; toolMode: string; toolPolicy: unknown; redacted: boolean };
  subagentsSkillKey: string; subagentsSkillLabel: string; subagentsRecoveryId: string;
};

export const MissingSubagentSupport = () => notes<SubagentNotes>().get('subagentsBoundary').as(boundary => boundary.support);
export const MissingSubagentIdentityMatches = () => notes<SubagentNotes>().get('subagentsBoundary').as(boundary => boundary.missingAgentId === boundary.requestedAgentId);
export const PublicRosterMatchesSubagentUI = () => Question.about('each public OpenClaw Agent has the same identity in the Renderer roster', async actor => {
  const ids = await actor.answer(notes<SubagentNotes>().get('subagentsBoundary').as(boundary => boundary.ids));
  const visibleIds = await actor.answer(Text.ofAll(AgentPage.ids));
  return ids.length === visibleIds.length && ids.every(id => visibleIds.includes(id));
});
export const NativeSubagentRosterIsReady = () => notes<SubagentNotes>().get('subagentsNative').as(result => result.nativeRosterReady);
export const InvalidSubagentRejection = () => notes<SubagentNotes>().get('subagentsNative').as(result => result.rejected);
export const DeletedSubagentRoute = () => notes<SubagentNotes>().get('subagentsDeletedRoute');
export const KnownSubagentTemplateMatches = () => notes<SubagentNotes>().get('subagentsTemplate').as(template => template.knownId === template.detailId && template.redacted);
export const SubagentConfiguration = () => notes<SubagentNotes>().get('subagentsConfiguration');
export const BoundedSubagentConfiguration = () => notes<SubagentNotes>().get('subagentsSkillKey').as(skillKey => ({
  skillMode: 'usesExplicitSkillAllowlist', skillKeys: [skillKey], toolMode: 'usesAgentToolPolicy',
  toolPolicy: { profile: 'minimal', allow: [], deny: ['gateway', 'nodes'] }, redacted: true,
}));
export const SubagentSkillsInherit = () => Attribute.called('aria-checked').of(SubagentsPage.inheritSkills);
export const SubagentToolsInherit = () => Attribute.called('aria-checked').of(SubagentsPage.inheritTools);
export const ChosenSubagentSkillIsChecked = () => Attribute.called('aria-checked').of(SubagentsPage.skill(notes<SubagentNotes>().get('subagentsSkillLabel')));
export const SubagentToolProfile = () => Value.of(SubagentsPage.toolProfile);
export const SubagentRecoveryIsNeeded = () => notes<SubagentNotes>().has('subagentsRecoveryId');
export const SubagentRecoverySelector = () => notes<SubagentNotes>().get('subagentsRecoveryId').as(id => `article:has(p[title=${JSON.stringify(id)}])`);
