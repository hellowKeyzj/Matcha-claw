import { Question, notes } from '@serenity-js/core';
import { Text } from '@serenity-js/web';
import { WorldActionsPage } from '../pages/world-actions.page.js';

type Evidence = {
  phase: string; complete: boolean; oneSubmission: boolean; canLeave: boolean;
  proposalId: string | null; operationId: string | null; idempotencyKey: string | null;
  independentReadId: string | null; submission: unknown;
  custody: { kind: string; operationId: string | null; outcome: string }[];
  sourceReceipts: { intentId: string }[];
  verifications: { intentId: string; verdict: string }[];
};
const evidence = () => notes<{ worldActions: Evidence }>().get('worldActions');
export const WorldActionEvidence = () => evidence();
export const WorldActionErrors = () => Text.ofAll(WorldActionsPage.errors);
export const WorldActionMayLeave = () => evidence().canLeave;
export const WorldActionIsSelected = () => Question.about('only the same confirmed original action proposal is selected', async actor =>
  await actor.answer(WorldActionsPage.selectedProposals.count()) === 1
  && await actor.answer(Text.of(WorldActionsPage.selectedProposalId)) === await actor.answer(evidence().proposalId),
);
export const WorldActionCompletedOnce = () => Question.about('one original UI submission is completed by the same-intent independent Verifier and separate public expected-result read', async actor => {
  const result = await actor.answer(evidence());
  const intent = result.sourceReceipts.at(0)?.intentId;
  return result.phase === 'verified' && result.complete && result.oneSubmission && result.canLeave
    && Boolean(result.proposalId && result.operationId && result.idempotencyKey && result.independentReadId && intent)
    && result.custody.length === 3 && result.custody.every(item => item.outcome === 'confirmed' && item.operationId)
    && result.sourceReceipts.every(item => item.intentId === intent)
    && result.verifications.length > 0 && result.verifications.every(item => item.intentId === intent && item.verdict === 'verified')
    && JSON.stringify(await actor.answer(Text.ofAll(WorldActionsPage.submissionIds))) === JSON.stringify([result.operationId])
    && !await actor.answer(WorldActionsPage.submit.isEnabled());
});
export const WorldActionIdentityMatchesOriginal = () => Question.about('every public submission identity field remains identical to the first real UI-generated request', async actor => {
  const original = await actor.answer(evidence().submission);
  if (!original) return false;
  const matches = async (value: unknown, path: (string | number)[]): Promise<boolean> => {
    if (Array.isArray(value) && value.length) {
      if (await actor.answer(WorldActionsPage.identityItems(path).count()) !== value.length) return false;
      return (await Promise.all(value.map((item, index) => matches(item, [...path, index])))).every(Boolean);
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value);
      if (JSON.stringify(await actor.answer(Text.ofAll(WorldActionsPage.identityKeys(path)))) !== JSON.stringify(entries.map(([key]) => key))) return false;
      return (await Promise.all(entries.map(([key, item]) => matches(item, [...path, key])))).every(Boolean);
    }
    const text = await actor.answer(Text.of(WorldActionsPage.identityValue(path)));
    return value == null ? /^(Not set|未设置)$/.test(text) : Array.isArray(value) ? /^(None|无)$/.test(text) : text === String(value);
  };
  return matches(original, []);
});
