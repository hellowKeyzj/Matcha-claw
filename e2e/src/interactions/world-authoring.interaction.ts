import { Interaction, notes } from '@serenity-js/core';
import { Selected, Text } from '@serenity-js/web';
import { WorldAuthoring } from '../abilities/world-authoring.ability.js';
import { WorldAuthoringPage } from '../pages/world-authoring.page.js';

export const PrepareIndependentWorldNoOp = () => Interaction.where('#actor binds the exact zero-effect Task and either reads the complete original NoOp or explicitly prepares a new proposal', async actor => {
  const scope = await actor.answer(Selected.valueOf(WorldAuthoringPage.scope));
  const prepared = await actor.abilityTo(WorldAuthoring).prepareNoOp(scope);
  await notes().set('worldNoOp', prepared).performAs(actor);
  if (prepared.readback) {
    await notes().set('worldNoOpInitial', prepared.readback).performAs(actor);
    await notes().set('worldNoOpReadback', prepared.readback).performAs(actor);
  }
});

export const MarkWorldNoOpSubmission = (kind: 'proposal' | 'validation') => Interaction.where(
  `#actor fences and records the single UI NoOp ${kind} attempt before clicking`, async actor => {
    await notes().set('worldNoOpSubmission', actor.abilityTo(WorldAuthoring).markNoOpSubmission(kind)).performAs(actor);
  },
);

export const ReadWorldNoOp = (phase: 'proposal' | 'before-validation' | 'validation' | 'replay' | 'refresh') => Interaction.where(
  `#actor records the ${phase} phase using the complete public NoOp and active head without any API mutation`, async actor => {
    const id = await actor.answer(Text.of(WorldAuthoringPage.changeId));
    const readback = await actor.abilityTo(WorldAuthoring).readNoOp(id, phase);
    await notes().set('worldNoOpReadback', readback).performAs(actor);
    if (phase === 'proposal') await notes().set('worldNoOpInitial', readback).performAs(actor);
    if (phase === 'validation' || phase === 'replay') await notes().set('worldNoOpValidation', readback).performAs(actor);
    if (phase === 'refresh') await notes().set('worldNoOpRefresh', readback).performAs(actor);
  },
);

export const UploadWorldDefinition = (batch: 'first' | 'replacement') => Interaction.where(
  `#actor imports the ${batch} definition through the real file input without submitting a World command`, async actor => {
    const scope = await actor.answer(Selected.valueOf(WorldAuthoringPage.scope));
    await actor.abilityTo(WorldAuthoring).uploadDefinition(batch, scope);
  },
);
