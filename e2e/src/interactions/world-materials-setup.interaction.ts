import { Interaction, notes } from '@serenity-js/core';
import { WorldMaterialsSetup } from '../abilities/world-materials-setup.ability.js';

export const InstallSignedWorldMaterials = () => Interaction.where('#actor trusts, installs and enables only the original signed materials package through normal UI', async actor => {
  const ability = actor.abilityTo(WorldMaterialsSetup);
  let primaryFailure: unknown;
  try { await ability.setup(); }
  catch (error) { primaryFailure = error; throw error; }
  finally {
    try { await notes().set('worldMaterialsSetup', ability.evidence()).performAs(actor); }
    catch (error) { throw new AggregateError(primaryFailure === undefined ? [error] : [primaryFailure, error], 'Original materials setup failure and evidence failure retained'); }
  }
});
export const RetainWorldMaterialsSetup = () => Interaction.where('#actor retains original materials operation custody without replay or rollback', async actor => {
  const ability = actor.abilityTo(WorldMaterialsSetup);
  let primaryFailure: unknown;
  try { await ability.preserve(); }
  catch (error) { primaryFailure = error; throw error; }
  finally {
    try { await notes().set('worldMaterialsSetup', ability.evidence()).performAs(actor); }
    catch (error) { throw new AggregateError(primaryFailure === undefined ? [error] : [primaryFailure, error], 'Materials confirmation cleanup and evidence failures retained'); }
  }
});
