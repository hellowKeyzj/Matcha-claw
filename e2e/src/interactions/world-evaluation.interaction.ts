import { Interaction, notes } from '@serenity-js/core';
import { WorldEvaluation } from '../abilities/world-evaluation.ability.js';

export const BeginWorldEvaluation = () => Interaction.where('#actor pins the approved original and reads only public evaluation status, without inspecting profile custody', async actor => {
  await notes().set('worldEvaluation', await actor.abilityTo(WorldEvaluation).begin()).performAs(actor);
});
export const ArmWorldEvaluationSelection = () => Interaction.where('#actor fences selection of the unchanged original, never an unresolved replacement', async actor => {
  await notes().set('worldEvaluation', actor.abilityTo(WorldEvaluation).select()).performAs(actor);
});
export const CompleteWorldEvaluationPicker = () => Interaction.where('#actor selects the approved original in the owned OS file picker without native confirmation', async actor => {
  await actor.abilityTo(WorldEvaluation).completePicker();
});
export const RecordWorldEvaluationPreview = () => Interaction.where('#actor records the exact eight-field UI preview after the native picker closes', async actor => {
  await notes().set('worldEvaluation', actor.abilityTo(WorldEvaluation).preview()).performAs(actor);
});
export const ArmWorldEvaluationConfirmation = (action: 'cancel' | 'submit') => Interaction.where(
  `#actor records the single application confirmation ${action} before clicking`, async actor => {
    await notes().set('worldEvaluation', actor.abilityTo(WorldEvaluation).arm(action)).performAs(actor);
  },
);
export const ReadWorldEvaluation = (phase: 'cancelled' | 'confirmed' | 'existing-config' | 'returned') => Interaction.where(
  `#actor records ${phase} from exact public world:evaluationStatus without any API mutation`, async actor => {
    await notes().set('worldEvaluation', await actor.abilityTo(WorldEvaluation).observe(phase)).performAs(actor);
  },
);
export const RecordWorldEvaluationEvidence = () => Interaction.where('#actor preserves the original identity and last phase, including unconfirmed submission, without retrying', async actor => {
  await notes().set('worldEvaluation', actor.abilityTo(WorldEvaluation).evidence()).performAs(actor);
});
