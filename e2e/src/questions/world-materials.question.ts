import { Question, notes } from '@serenity-js/core';
import { Attribute, Text, Value } from '@serenity-js/web';
import { WorldMaterialsPage } from '../pages/world-materials.page.js';

type Rejection = {
  world: { tenantId: string; worldId: string }; requestId: string;
  failure: { code: string; stage: string; message: string; diagnosticId: string; details: unknown; recovery: unknown };
  transferId: string; digest: string; byteSize: string; sealed: boolean; outcome: string; operationAccepted: boolean;
  taskUnchanged: boolean; activeReleaseUnchanged: boolean; catalogUnchanged: boolean;
};
type MaterialsNotes = {
  worldMaterialsRejection: Rejection;
  worldMaterialsRejectionRefresh: Rejection;
  worldMaterialsPreparation: { existing: boolean };
  worldOrderUploadReadback: { transferId: string; sealed: boolean; byteSize: string; digest: string; importAcceptanceProved: boolean };
  worldOrderMaterialSource: { exactSourceVersion: { world: { tenantId: string; worldId: string }; sourceId: string; versionId: string };
    byteSize: string; digest: string; catalogMatches: number; operationId: string; complete: boolean; candidates: number;
    chatRouting: { revision: number; primary: { accountId: string; modelId: string } }; generationReceiptPubliclyVisible: boolean };
  worldMaterialsUpload: { sealed: boolean; byteSize: string; digest: string; transferId: string };
  worldMaterialsOperation: { operationId: string; phase: string; sourceCount: number; artifactCount: number; draftCount: number };
  worldMaterialsParsed: { exactOriginal: boolean; covered: boolean; sourceValue: string; artifactId: string; versionId: string; digest: string };
  worldMaterialsDraft: { candidates: number; modelCalls: number; evidence: number; coverage: number; readNeeds: number; activeReleaseUnchanged: boolean };
  worldMaterialsRefresh: { exact: boolean; activeReleaseUnchanged: boolean };
};
export const WorldMaterialsRejection = () => notes<MaterialsNotes>().get('worldMaterialsRejection');
export const WorldMaterialsRejectionRefresh = () => notes<MaterialsNotes>().get('worldMaterialsRejectionRefresh');
export const WorldMaterialRejectionRequest = () => Attribute.called('data-material-import-request').of(WorldMaterialsPage.uploadResult);
export const WorldMaterialsPreparation = () => notes<MaterialsNotes>().get('worldMaterialsPreparation');
export const WorldOrderUploadReadback = () => notes<MaterialsNotes>().get('worldOrderUploadReadback');
export const WorldOrderMaterialSource = () => notes<MaterialsNotes>().get('worldOrderMaterialSource');
export const WorldMaterialsUpload = () => notes<MaterialsNotes>().get('worldMaterialsUpload');
export const WorldMaterialsOperation = () => notes<MaterialsNotes>().get('worldMaterialsOperation');
export const WorldMaterialsParsed = () => notes<MaterialsNotes>().get('worldMaterialsParsed');
export const WorldMaterialsDraft = () => notes<MaterialsNotes>().get('worldMaterialsDraft');
export const WorldMaterialsRefresh = () => notes<MaterialsNotes>().get('worldMaterialsRefresh');
export const WorldMaterialUploadSettled = () => Question.about('the single upload was accepted, explicitly failed or remained unknown', async actor =>
  await actor.answer(WorldMaterialsPage.pending.count()) > 0 || await actor.answer(WorldMaterialsPage.failures.count()) > 0
  || await actor.answer(WorldMaterialsPage.incomplete.count()) > 0 || await actor.answer(WorldMaterialsPage.accepted.count()) > 0,
);
export const WorldMaterialOperationSettled = () => Question.about('the original material operation has a terminal or indeterminate receipt', async actor => {
  if (await actor.answer(WorldMaterialsPage.tracePhases.count()) !== 1) return false;
  return ['completed', 'failed', 'cancelled_before_commit', 'cancelled_after_commit', 'commit_indeterminate', 'effect_indeterminate', 'retained']
    .includes(await actor.answer(Attribute.called('data-status').of(WorldMaterialsPage.tracePhase)));
});
export const WorldMaterialBudget = () => Question.about('the exact finite text-only import budget visible in the UI', async actor =>
  Promise.all([WorldMaterialsPage.wallTime, WorldMaterialsPage.steps, WorldMaterialsPage.sourceReads, WorldMaterialsPage.rows,
    WorldMaterialsPage.bytes, WorldMaterialsPage.modelCalls, WorldMaterialsPage.inputTokens, WorldMaterialsPage.outputTokens]
    .map(field => actor.answer(Value.of(field)))),
);
export const WorldMaterialCandidateRows = () => WorldMaterialsPage.candidateRows.count();
export const WorldMaterialReadbackText = () => Text.of(WorldMaterialsPage.readback);
