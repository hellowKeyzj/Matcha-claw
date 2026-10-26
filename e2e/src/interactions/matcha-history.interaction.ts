import { Duration, Interaction, Wait, notes } from '@serenity-js/core';
import { equals } from '@serenity-js/assertions';
import { Click, Text, isVisible } from '@serenity-js/web';
import { UseMatchaHistory } from '../abilities/matcha-history.ability.js';
import { ExpandSessionBuckets } from './chat.interaction.js';
import { ChatPage } from '../pages/chat.page.js';
import { MatchaHistoryPage } from '../pages/matcha-history.page.js';

export const PrepareMatchaHistoryAbility = () => Interaction.where('#actor borrows the shared Electron for Matcha history without owning its lifecycle', async actor => {
  await notes<{ matchaHistoryExpandedBuckets: string[] }>().set('matchaHistoryExpandedBuckets', []).performAs(actor);
  const preparation = await actor.abilityTo(UseMatchaHistory).prepare();
  await notes<{ matchaHistoryPreparation: typeof preparation }>().set('matchaHistoryPreparation', preparation).performAs(actor);
});

export const CreateMatchaHistorySession = () => Interaction.where('#actor creates an owned Matcha history session through the current public capability', async actor => {
  const result = await actor.abilityTo(UseMatchaHistory).createSession();
  await notes<{ matchaHistorySession: typeof result }>().set('matchaHistorySession', result).performAs(actor);
});

export const PrepareMatchaHistoryUiTurn = () => Interaction.where('#actor records existing public identities and observes native terminals before the only composer send', actor =>
  actor.abilityTo(UseMatchaHistory).prepareUiTurn());

export const CompleteMatchaHistoryTurn = () => Interaction.where('#actor observes the real Matcha run terminal rather than treating its receipt as completion', async actor => {
  const result = await actor.abilityTo(UseMatchaHistory).runRealTurn();
  await notes<{ matchaHistorySession: typeof result.session }>().set('matchaHistorySession', result.session).performAs(actor);
  await notes<{ matchaHistoryTurnCompleted: boolean }>().set('matchaHistoryTurnCompleted', result.completed).performAs(actor);
});

export const CaptureMatchaPublicHistory = () => Interaction.where('#actor reads canonical public history for this exact Matcha identity and run', async actor => {
  const snapshot = await actor.abilityTo(UseMatchaHistory).capturePublicHistory();
  await notes<{ matchaHistorySnapshot: typeof snapshot }>().set('matchaHistorySnapshot', snapshot).performAs(actor);
});

export const RecoverMatchaHistoryAfterNativeRestart = () => Interaction.where('#actor restarts only the native Matcha app-server through its public route and checks the same complete history', async actor => {
  const recovered = await actor.abilityTo(UseMatchaHistory).recoverAfterNativeRestart();
  await notes<{ matchaHistoryRecovered: boolean }>().set('matchaHistoryRecovered', recovered).performAs(actor);
});

export const ExpandMatchaHistorySessionBuckets = () => Interaction.where('#actor records collapsed session buckets before temporarily opening them', async actor => {
  const buckets = await actor.answer(ChatPage.collapsedSessionBuckets);
  const labels: string[] = [];
  for (const bucket of buckets) labels.push((await actor.answer(Text.of(bucket))).replace(/\s+\d+\s*$/, '').trim());
  await notes<{ matchaHistoryExpandedBuckets: string[] }>().set('matchaHistoryExpandedBuckets', labels).performAs(actor);
  await ExpandSessionBuckets().performAs(actor);
});

export const RestoreMatchaHistorySessionBuckets = () => Interaction.where('#actor restores only session buckets temporarily opened for Matcha history', async actor => {
  const labels = await actor.answer(notes<{ matchaHistoryExpandedBuckets: string[] }>().get('matchaHistoryExpandedBuckets'));
  try {
    if (labels.length) {
      if (!await actor.answer(ChatPage.switchboard.isVisible())) await Click.on(ChatPage.identity).performAs(actor);
      await Click.on(ChatPage.sessionsTab).performAs(actor);
      await Wait.upTo(Duration.ofSeconds(45)).until(ChatPage.sessionDirectory, isVisible()).performAs(actor);
      await Wait.upTo(Duration.ofSeconds(45)).until(ChatPage.sessionListLoading.isPresent(), equals(false)).performAs(actor);
      await Wait.until(ChatPage.sessionErrors.count(), equals(0)).performAs(actor);
      if (await actor.answer(ChatPage.normalSessionsTab.isVisible())) await Click.on(ChatPage.normalSessionsTab).performAs(actor);
      for (const label of labels) {
        const bucket = MatchaHistoryPage.expandedBucket(label);
        if (await actor.answer(bucket.isVisible())) await Click.on(bucket).performAs(actor);
      }
      await notes<{ matchaHistoryExpandedBuckets: string[] }>().set('matchaHistoryExpandedBuckets', []).performAs(actor);
    }
  } finally {
    if (await actor.answer(MatchaHistoryPage.switchboards.count()) === 1) await Click.on(ChatPage.switchboardBackdrop).performAs(actor);
    await Wait.until(MatchaHistoryPage.switchboards.count(), equals(0)).performAs(actor);
  }
});

export const DeleteMatchaHistorySession = () => Interaction.where('#actor restores session buckets and deletes only its confirmed owned session unless the native outcome remains unknown', async actor => {
  const failures: unknown[] = [];
  try { await RestoreMatchaHistorySessionBuckets().performAs(actor); } catch (error) { failures.push(error); }
  try {
    const cleanup = await actor.abilityTo(UseMatchaHistory).deleteOwnedSession();
    await notes<{ matchaHistoryCleanup: typeof cleanup }>().set('matchaHistoryCleanup', cleanup).performAs(actor);
  } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Matcha history bucket restoration and exact session cleanup both failed');
});

export const CaptureMatchaMarkdown = () => Interaction.where('#actor downloads the actual UI Markdown and compares its user and assistant sections with public history', async actor => {
  const [verified] = await Promise.all([
    actor.abilityTo(UseMatchaHistory).readMarkdownDownload(),
    Click.on(MatchaHistoryPage.exportMarkdown).performAs(actor),
  ]);
  await notes<{ matchaHistoryMarkdownVerified: boolean }>().set('matchaHistoryMarkdownVerified', verified).performAs(actor);
});
