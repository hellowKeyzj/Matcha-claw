import { Interaction, notes } from '@serenity-js/core';
import { Selected } from '@serenity-js/web';
import { WorldViews } from '../abilities/world-views.ability.js';
import { WorldViewsPage } from '../pages/world-views.page.js';

export const RegisterWorldViewTask = () => Interaction.where('#actor imports and previews one complete zero-effect F Task through the normal file picker, retaining its sole registration request and original receipt', async actor => {
  await notes().set('worldViewTaskSetup', await actor.abilityTo(WorldViews).setupTask()).performAs(actor);
});

export const ReadWorldViewsBindings = (purpose: 'view' | 'false' | 'unknown') => Interaction.where('#actor validates explicit public F bindings before any upload, mutation or execution', async actor => {
  await notes().set('worldViewsBinding', await actor.abilityTo(WorldViews).prepare(purpose)).performAs(actor);
});
export const ReachWorldViewsTask = () => Interaction.where('#actor reaches only the exact original Task through its normal paged management UI', async actor => {
  await actor.abilityTo(WorldViews).reachTask();
});
export const ReachWorldViewsSelection = (kind: 'abstraction' | 'test') => Interaction.where(`#actor locates the original Task's explicitly bound ${kind}, never a substitute`, async actor => {
  await actor.abilityTo(WorldViews).reachSelection(kind);
});
export const ReadRenderedWorldView = () => Interaction.where('#actor checks the actual committed-page receipt, raw-evidence-backed facts, unknown cells and declared abstraction contract', async actor => {
  await notes().set('worldViewsView', await actor.abilityTo(WorldViews).inspectView()).performAs(actor);
});
export const FillWorldViewsInput = () => Interaction.where('#actor fills the original typed input through existing controls, preserving false, null and omitted fields', async actor => {
  await actor.abilityTo(WorldViews).fillInput();
});
export const CheckWorldViewsSession = () => Interaction.where('#actor checks the exact already existing native session exposed by the normal picker without creating or invoking a session', async actor => {
  await actor.abilityTo(WorldViews).checkSession();
});
export const MarkWorldViewsResolution = () => Interaction.where('#actor fences a single UI ResolveTask and subscribes only to public operation resource hints', async actor => {
  await actor.abilityTo(WorldViews).markResolution();
});
export const ReadWorldViewsResolution = () => Interaction.where('#actor reads only this attempt\'s exact operation receipt and observed guard stop outcome; unknown delivery is never replayed', async actor => {
  await notes().set('worldViewsResolution', await actor.abilityTo(WorldViews).inspectResolution(await actor.answer(Selected.valueOf(WorldViewsPage.operationSession)))).performAs(actor);
});
export const ConfirmWorldViewsOriginals = () => Interaction.where('#actor verifies the complete original Task, Oracle pin, abstraction and active basis were not changed', async actor => {
  await notes().set('worldViewsOriginals', await actor.abilityTo(WorldViews).unchanged()).performAs(actor);
});
export const ReleaseWorldViewsObservation = () => Interaction.where('#actor releases only owned public event observation and an unsubmitted owned confirmation, retaining all operation history', async actor => {
  await actor.abilityTo(WorldViews).release();
});
