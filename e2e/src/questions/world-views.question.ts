import { Question, notes } from '@serenity-js/core';
import { Attribute, Text } from '@serenity-js/web';
import { WorldViewsPage } from '../pages/world-views.page.js';

type Binding = { purpose: string; scope: string; taskValue: string; abstractionValue: string; queryValue: string; testValue: string; endpointId: string; sessionValue: string; assurance: string; fallback: { kind: string }; originalTaskUnchanged: boolean; rawEvidenceBound: boolean };
type View = { receiptId: string; rawEvidenceBound: boolean; exactFacts: boolean; unknowns: unknown[]; assurance: string; guardVerdict: string; fallback: { kind: string } };
type Resolution = { operationId: string; caseId: string; phase: string; outcome: unknown; guard: string; fallback: string; assurance: string; verified: boolean; originalTaskUnchanged: boolean; effects: unknown[] };

export const WorldViewTaskSetup = () => notes<{ worldViewTaskSetup: { operationId: string; taskFile: string; custody: string; phase: string; fullContractMatched: boolean; allowedEffects: unknown[]; reused: boolean } }>().get('worldViewTaskSetup');
export const WorldViewsBinding = () => notes<{ worldViewsBinding: Binding }>().get('worldViewsBinding');
export const WorldViewsFacts = () => notes<{ worldViewsView: View }>().get('worldViewsView');
export const WorldViewsUnknownCount = () => WorldViewsFacts().unknowns.as(items => items.length);
export const WorldViewsResolution = () => notes<{ worldViewsResolution: Resolution }>().get('worldViewsResolution');
export const WorldViewsOriginals = () => notes<{ worldViewsOriginals: { originalTaskUnchanged: boolean; originalAbstractionUnchanged: boolean; activeReleaseUnchanged: boolean } }>().get('worldViewsOriginals');
export const WorldViewsErrors = () => Text.ofAll(WorldViewsPage.errors);
export const WorldViewsReadingSettled = () => WorldViewsPage.reading.count().as(count => count === 0);
export const WorldViewsResponseObserved = () => Question.about('this UI command exposes processing records or an explicit current resolution error without replay', async actor =>
  await actor.answer(WorldViewsPage.recordRegions.count()) === 1 || await actor.answer(WorldViewsPage.errors.count()) > 0,
);
export const WorldViewsOperationSettled = () => Question.about('the original operation is terminal or indeterminate, never inferred successful from acceptance', async actor => {
  if (await actor.answer(WorldViewsPage.operationPhases.count()) !== 1) return false;
  return ['completed', 'failed', 'cancelled_before_commit', 'cancelled_after_commit', 'commit_indeterminate', 'effect_indeterminate', 'retained']
    .includes(await actor.answer(Attribute.called('data-status').of(WorldViewsPage.operationPhase)));
});
