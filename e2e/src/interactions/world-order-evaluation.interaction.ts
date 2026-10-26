import { Interaction, notes } from '@serenity-js/core';
import { WorldOrderEvaluation } from '../abilities/world-order-evaluation.ability.js';

export const PrepareOrderEvaluation = (setup?: Parameters<WorldOrderEvaluation['prepare']>[0]) => Interaction.where('#actor assembles immutable author data with the exact public Task, branch and independent Oracle binding lock required for case registration', async actor => {
  const ability = actor.abilityTo(WorldOrderEvaluation);
  try { await ability.prepare(setup); } finally { await notes().set('worldOrderEvaluation', ability.evidence()).performAs(actor); }
});
export const ChooseOrderEvaluationContext = () => Interaction.where('#actor selects the exact authorized branch and Task through real UI catalogs', async actor => {
  await notes().set('worldOrderEvaluation', await actor.abilityTo(WorldOrderEvaluation).chooseContext()).performAs(actor);
});
export const FillOrderEvaluationCase = (index: number) => Interaction.where(`#actor fills authored case ${index + 1} using the real input and independent expected file controls`, async actor => {
  await notes().set('worldOrderEvaluation', await actor.abilityTo(WorldOrderEvaluation).fillCase(index)).performAs(actor);
});
export const ArmOrderEvaluationWrite = (kind: 'case' | 'suite' | 'evaluation') => Interaction.where(`#actor arms one ${kind} UI submission, retaining original custody on every unknown`, async actor => {
  await notes().set('worldOrderEvaluation', await actor.abilityTo(WorldOrderEvaluation).arm(kind)).performAs(actor);
});
export const ConfirmOrderEvaluationWrite = (kind: 'case' | 'suite' | 'evaluation') => Interaction.where(`#actor reads the original ${kind} operation and exact public result without retrying`, async actor => {
  const ability = actor.abilityTo(WorldOrderEvaluation);
  try { await ability.confirm(kind); } finally { await notes().set('worldOrderEvaluation', ability.evidence()).performAs(actor); }
});
export const VerifyOrderEvaluationRegistrations = () => Interaction.where('#actor reads all eight exact registered tests, original Task pin, protected split and original operation custody', async actor => {
  const ability = actor.abilityTo(WorldOrderEvaluation);
  try { await ability.verifyRegistrations(); } finally { await notes().set('worldOrderEvaluation', ability.evidence()).performAs(actor); }
});
export const FillOrderEvaluationSuite = () => Interaction.where('#actor adds all eight exact tests and imports three real FrozenPlans beside the public candidate strategy', async actor => {
  await notes().set('worldOrderEvaluation', await actor.abilityTo(WorldOrderEvaluation).fillSuite()).performAs(actor);
});
export const FillOrderEvaluationRun = () => Interaction.where('#actor selects the confirmed four-arm suite and its exact zero-model/source execution budget', async actor => {
  await notes().set('worldOrderEvaluation', await actor.abilityTo(WorldOrderEvaluation).fillEvaluation()).performAs(actor);
});
export const ShowOrderEvaluationReport = () => Interaction.where('#actor opens only the original operation report and verifies its real case rows', async actor => {
  await notes().set('worldOrderEvaluation', await actor.abilityTo(WorldOrderEvaluation).showReport()).performAs(actor);
});
export const PreserveOrderEvaluationEvidence = () => Interaction.where('#actor retains history and original unknown request custody without mutation or recovery', async actor => {
  await notes().set('worldOrderEvaluation', await actor.abilityTo(WorldOrderEvaluation).preserve()).performAs(actor);
});
