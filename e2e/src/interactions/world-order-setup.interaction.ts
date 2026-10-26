import { Interaction, notes } from '@serenity-js/core';
import { WorldPackageSetup } from '../abilities/world-package-setup.ability.js';
import { WorldOrderSetup } from '../abilities/world-order-setup.ability.js';
import { WorldOrderAccess } from '../abilities/world-order-access.ability.js';

export const GrantWorldOrderActivation = () => Interaction.where('#actor confirms only the explicitly authorized exact order activation grant through the administrator UI', async actor => {
  const result = await actor.abilityTo(WorldOrderAccess).grantActivation();
  await notes().set('worldOrderActivationGrant', result).performAs(actor);
});

export const GrantWorldOrderMaterialsExecution = () => Interaction.where('#actor confirms only the finite exact Source materials execution grant through the administrator UI, without upload or Import', async actor => {
  const ability = actor.abilityTo(WorldOrderAccess);
  let primaryFailure: unknown;
  try { await ability.grantMaterialsExecution(); }
  catch (error) { primaryFailure = error; throw error; }
  finally {
    try { await notes().set('worldOrderMaterialsExecutionGrant', ability.evidence()).performAs(actor); }
    catch (error) { throw new AggregateError(primaryFailure === undefined ? [error] : [primaryFailure, error], 'Materials execution grant evidence failed; retain the original failure and grant custody without resend'); }
  }
});

export const GrantWorldOrderFourArmExecution = () => Interaction.where('#actor confirms separate finite execution-Service and desktop grants with exact public preflight, without running any arm or importing materials', async actor => {
  const ability = actor.abilityTo(WorldOrderAccess);
  let primaryFailure: unknown;
  try { await ability.grantFourArmExecution(); }
  catch (error) { primaryFailure = error; throw error; }
  finally {
    try { await notes().set('worldOrderFourArmExecutionGrant', ability.evidence()).performAs(actor); }
    catch (error) { throw new AggregateError(primaryFailure === undefined ? [error] : [primaryFailure, error], 'Four-arm grant evidence failed; retain both original grant custodies and the primary failure without resend'); }
  }
});

export const GrantWorldOrderChangeSetExecution = () => Interaction.where('#actor confirms only read/write on the exact original-operation-proved ChangeSet for the desktop human', async actor => {
  const ability = actor.abilityTo(WorldOrderAccess);
  let primaryFailure: unknown;
  try { await ability.grantChangeSetExecution(); }
  catch (error) { primaryFailure = error; throw error; }
  finally {
    try { await notes().set('worldOrderChangeSetGrant', ability.evidence()).performAs(actor); }
    catch (error) { throw new AggregateError(primaryFailure === undefined ? [error] : [primaryFailure, error], 'ChangeSet grant evidence failed; retain the original failure and finite grant custody without resend'); }
  }
});

export const ActivateWorldOrderOracle = () => Interaction.where('#actor installs and activates the exact independent arithmetic Oracle through normal UI', async actor => {
  const setup = await actor.abilityTo(WorldPackageSetup).setup(
    '.scratch/world-implementation-2026-10-21/world-order-oracle-20261027-r2.zip',
    'lock:order-line-total:20261027:execution-r1',
    '.scratch/e2e-acceptance-2026-10-24-licensed-current-targets-1793090348415994300/serenity-report/test-runs/2026-10-27T08-39-11.287Z/db.json',
    actor.abilityTo(WorldOrderAccess).evidence().receipt,
    actor.abilityTo(WorldPackageSetup).continuationFromEnvironment(
      '.scratch/e2e-acceptance-2026-10-24-licensed-current-targets-1793095250608078500/serenity-report/test-runs/2026-10-27T10-00-54.144Z/db.json',
    ),
  );
  await notes().set('worldOrderPackageSetup', setup).performAs(actor);
});

export const PrepareWorldOrderExecutionBranch = () => Interaction.where('#actor registers the new arithmetic Task and validates its real Function/Strategy branch without changing r1 history', async actor => {
  const ability = actor.abilityTo(WorldOrderSetup);
  let primaryFailure: unknown;
  try {
    const setup = actor.abilityTo(WorldPackageSetup).evidence();
    if (!setup.implementation || !setup.ports || !setup.lockId) throw new Error('Order Oracle activation has no exact public implementation/ports/lock');
    await ability.prepareTaskAndBranch({ implementation: setup.implementation, ports: setup.ports, lockId: setup.lockId });
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    try { await notes().set('worldOrderExecutionSetup', ability.evidence()).performAs(actor); }
    catch (error) { throw new AggregateError(primaryFailure === undefined ? [error] : [primaryFailure, error], 'Order execution setup evidence failed; retain the original failure and receipts'); }
  }
});

export const RetainWorldOrderSetupEvidence = () => Interaction.where('#actor retains exact setup receipts and any unknown original request without undo or replay', async actor => {
  await notes().set('worldOrderExecutionSetup', actor.abilityTo(WorldOrderSetup).evidence()).performAs(actor);
  await notes().set('worldOrderActivationGrant', actor.abilityTo(WorldOrderAccess).evidence()).performAs(actor);
  await notes().set('worldOrderPackageSetup', actor.abilityTo(WorldPackageSetup).evidence()).performAs(actor);
});
