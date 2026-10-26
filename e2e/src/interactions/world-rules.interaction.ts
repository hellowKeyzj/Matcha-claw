import { Interaction, notes } from '@serenity-js/core';
import { Click } from '@serenity-js/web';
import { WorldRules } from '../abilities/world-rules.ability.js';
import { WorldRulesPage } from '../pages/world-rules.page.js';

type Stage = 'q' | 'r' | 'unknown';

export const ReadWorldRuleBinding = () => Interaction.where('#actor requires the explicit authored public PQR binding before opening any evaluation', async actor => {
  await notes().set('worldRuleBinding', await actor.abilityTo(WorldRules).loadBinding()).performAs(actor);
});
export const ReadWorldRulePrerequisites = () => Interaction.where('#actor reads real canonical subjects, Rules, exact branch, both times and original Sources without submitting a command', async actor => {
  await notes().set('worldRulePrerequisites', await actor.abilityTo(WorldRules).prepare()).performAs(actor);
});
export const ChooseWorldRuleStage = (stage: Stage) => Interaction.where(`#actor prepares the exact authored ${stage} form, retaining false and null`, async actor => {
  await notes().set('worldRuleForm', actor.abilityTo(WorldRules).form(stage)).performAs(actor);
});
export const OpenWorldRuleCatalog = (stage: Stage) => Interaction.where('#actor selects the exact authored Rule in the normal definition catalog', async actor => {
  const { reference } = actor.abilityTo(WorldRules).form(stage);
  await Click.on(WorldRulesPage.catalogRule(reference.id, reference.revision)).performAs(actor);
});
export const SelectWorldRuleBranch = () => Interaction.where('#actor selects only the exact branch revision through the normal paginated UI directory', async actor => {
  await actor.abilityTo(WorldRules).selectExactBranch();
});
export const FillWorldRuleArguments = (stage: Stage) => Interaction.where(`#actor fills the normal ${stage} parameter controls and explicit valid interval`, async actor => {
  await actor.abilityTo(WorldRules).fillArguments(stage);
});
export const MarkWorldRuleEvaluation = (stage: Stage) => Interaction.where(`#actor fences one ${stage} UI submission and observes only public World operation hints`, async actor => {
  await actor.abilityTo(WorldRules).mark(stage);
});
export const CaptureWorldRuleOperation = (stage: Stage) => Interaction.where(`#actor retains the single actual ${stage} OperationKey without intercepting invoke or replaying a request`, async actor => {
  await notes().set('worldRuleOperationKey', await actor.abilityTo(WorldRules).captureOperation(stage)).performAs(actor);
});
export const ConfirmWorldRuleEvaluation = (stage: Stage) => Interaction.where(`#actor reads the exact ${stage} completed full rule_evaluated receipt, not merely acceptance`, async actor => {
  await notes().set('worldRuleReceipt', await actor.abilityTo(WorldRules).confirm(stage)).performAs(actor);
});
export const ReadWorldRuleChain = () => Interaction.where('#actor verifies both derived fields, historical known-time replay, original Source evidence, rooted two-level Explain and the pending unknown control using only public reads', async actor => {
  await notes().set('worldRuleChain', await actor.abilityTo(WorldRules).verifyChain()).performAs(actor);
});
export const ReleaseWorldRuleObservation = () => Interaction.where('#actor releases only its own public event observer, retaining every durable fact and any unknown original operation', async actor => {
  await actor.abilityTo(WorldRules).releaseObservation();
});
