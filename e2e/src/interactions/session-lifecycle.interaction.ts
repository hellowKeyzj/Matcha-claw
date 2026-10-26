import { Interaction, notes } from '@serenity-js/core';
import { Click, Text } from '@serenity-js/web';
import { SessionLifecycle } from '../abilities/session-lifecycle.ability.js';
import { ChatPage } from '../pages/chat.page.js';
import { SessionLifecyclePage } from '../pages/session-lifecycle.page.js';

export const CreateOwnedLifecycleSession = () => Interaction.where('#actor creates one exclusively owned lifecycle session without changing the existing model', async actor => {
  actor.abilityTo(SessionLifecycle);
  await notes<{ lifecycleExpandedBuckets: string[] }>().set('lifecycleExpandedBuckets', []).performAs(actor);
  const session = await actor.abilityTo(SessionLifecycle).create();
  await notes<{ sessionLifecycle: typeof session }>().set('sessionLifecycle', session).performAs(actor);
});

export const RenameOwnedLifecycleSession = () => Interaction.where('#actor reconciles the UI-renamed label for the confirmed lifecycle identity', actor =>
  actor.abilityTo(SessionLifecycle).confirmRename());

export const PrepareLifecycleTurn = (cancellation = false) => Interaction.where('#actor reserves one UI send without changing the model or authorization', actor =>
  actor.abilityTo(SessionLifecycle).prepareTurn(cancellation));

export const PrepareLifecycleStop = () => Interaction.where('#actor confirms the exact owned active run before pressing Stop once', actor =>
  actor.abilityTo(SessionLifecycle).prepareAbort());

export const PrepareLifecycleDeletion = () => Interaction.where('#actor reserves one UI deletion of the settled owned session', actor =>
  actor.abilityTo(SessionLifecycle).prepareDeletion());

export const CompleteOwnedLifecycleTurn = () => Interaction.where('#actor sends once using existing authorization and waits for a real final turn', async actor => {
  const completed = await actor.abilityTo(SessionLifecycle).completeTurn();
  await notes<{ lifecycleCompleted: boolean }>().set('lifecycleCompleted', completed).performAs(actor);
});

export const ConfirmOwnedLifecyclePersistence = () => Interaction.where('#actor reads the final native turn again after the renderer reload', async actor => {
  const persisted = await actor.abilityTo(SessionLifecycle).confirmPersistedTurn();
  await notes<{ lifecyclePersisted: boolean }>().set('lifecyclePersisted', persisted).performAs(actor);
});

export const AbortOwnedLifecycleTurn = () => Interaction.where('#actor waits for the exact cancelled run event and a covering inactive public view after UI Stop', async actor => {
  const cancelled = await actor.abilityTo(SessionLifecycle).abortTurn();
  await notes<{ lifecycleCancelled: boolean }>().set('lifecycleCancelled', cancelled).performAs(actor);
});

export const DeleteOwnedLifecycleSession = () => Interaction.where('#actor deletes only the owned session and waits for catalog reconciliation', async actor => {
  const deleted = await actor.abilityTo(SessionLifecycle).confirmDeletion();
  await notes<{ lifecycleDeleted: boolean }>().set('lifecycleDeleted', deleted).performAs(actor);
});

export const ExpandLifecycleCatalogBuckets = () => Interaction.where('#actor temporarily opens collapsed catalog buckets', async actor => {
  const expanded: string[] = [];
  await notes<{ lifecycleExpandedBuckets: string[] }>().set('lifecycleExpandedBuckets', expanded).performAs(actor);
  const buckets = await actor.answer(ChatPage.collapsedSessionBuckets);
  for (const bucket of buckets.reverse()) {
    const label = (await actor.answer(Text.of(bucket))).replace(/\s+\d+\s*$/, '').trim();
    expanded.push(label);
    await notes<{ lifecycleExpandedBuckets: string[] }>().set('lifecycleExpandedBuckets', [...expanded]).performAs(actor);
    await Click.on(bucket).performAs(actor);
  }
});

export const RestoreLifecycleCatalogBuckets = () => Interaction.where('#actor restores only catalog buckets opened by this scenario', async actor => {
  const labels = await actor.answer(notes<{ lifecycleExpandedBuckets: string[] }>().get('lifecycleExpandedBuckets'));
  for (const label of labels) {
    const bucket = SessionLifecyclePage.expandedBucket(label);
    if (await actor.answer(bucket.isVisible())) await Click.on(bucket).performAs(actor);
  }
  await notes<{ lifecycleExpandedBuckets: string[] }>().set('lifecycleExpandedBuckets', []).performAs(actor);
});

export const CleanUpOwnedLifecycleSession = () => Interaction.where('#actor restores the dialog and precisely cleans up its reserved session even on failure', async actor => {
  try {
    if (await actor.answer(SessionLifecyclePage.closeDelete.isVisible())) await Click.on(SessionLifecyclePage.closeDelete).performAs(actor);
    if (await actor.answer(SessionLifecyclePage.cancelRename.isVisible())) await Click.on(SessionLifecyclePage.cancelRename).performAs(actor);
    if (await actor.answer(ChatPage.switchboard.isVisible())) {
      await RestoreLifecycleCatalogBuckets().performAs(actor);
      await Click.on(ChatPage.switchboardBackdrop).performAs(actor);
    }
  } finally {
    await actor.abilityTo(SessionLifecycle).cleanup();
  }
});
