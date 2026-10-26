import { notes, Question } from '@serenity-js/core';
import { Attribute, Text } from '@serenity-js/web';
import { WorldOrderEvaluationPage } from '../pages/world-order-evaluation.page.js';

type Reference = { world: { tenantId: string; worldId: string }; id: string; revision: string };
type OrderNotes = { worldOrderEvaluation: {
  phase: string; blocker: string | null; world: { tenantId: string; worldId: string };
  inputSha256: string; originalSha256: string; task: Reference | null; branch: Reference | null; suite: Reference | null;
  reportId: string | null; candidateId: string | null; registered: number; train: number; holdout: number; memoryFailures: number;
  custody: { kind: string; attempt: number; operationId: string | null; runId: string | null; outcome: string }[];
  registrationsVerified: boolean; custodyBlocked: boolean; mayLeave: boolean; baselineEffectProven: boolean;
} };

export const OrderMaterialsExecutionGrantConfirmed = () => Question.about('the exact finite Source execution grant has a confirmed original authorization receipt', async actor => {
  const grant = await actor.answer(notes<{ worldOrderMaterialsExecutionGrant: { phase: string } }>().get('worldOrderMaterialsExecutionGrant'));
  return grant.phase === 'confirmed' || grant.phase === 'confirmed-original';
});

export const OrderFourArmExecutionGrantsConfirmed = () => Question.about('both known finite grants have original authorization receipts without claiming execution or full-report access', async actor => {
  const evidence = await actor.answer(notes<{ worldOrderFourArmExecutionGrant: { phase: string; executionAccess?: {
    arms: string[]; executionReady: boolean; resultAccess: { phase: string; evaluationId: string | null; caseIds: string[] };
    grants: { phase: string; input: { actor: { kind: string; id: string }; commitId: string; access: { resources: unknown[] }[]; labels: string[]; effects: string[] }; receipt?: { commitId: string; fence: { domain: string } } }[];
  } } }>().get('worldOrderFourArmExecutionGrant'));
  const access = evidence.executionAccess;
  return evidence.phase === 'known-execution-grants-confirmed' && access?.executionReady === false
    && JSON.stringify(access.arms) === JSON.stringify(['candidate', 'tool_memory', 'static_ontology', 'append_only'])
    && access.resultAccess.phase === 'deferred-until-real-results' && access.resultAccess.evaluationId === null && access.resultAccess.caseIds.length === 0
    && access.grants.length === 2 && access.grants[0].input.actor.kind === 'service' && access.grants[1].input.actor.kind === 'human'
    && access.grants.every(grant => ['confirmed', 'confirmed-original'].includes(grant.phase)
      && grant.receipt?.commitId === grant.input.commitId && grant.receipt.fence.domain === 'authorization'
      && grant.input.labels.length === 0 && grant.input.effects.length === 0 && grant.input.access.length > 0 && grant.input.access.every(item => item.resources.length > 0));
});

export const OrderEvaluationEvidence = () => notes<OrderNotes>().get('worldOrderEvaluation');
export const OrderEvaluationWorldStatus = () => Attribute.called('data-status').of(WorldOrderEvaluationPage.status);
export const OrderEvaluationIssues = () => Text.ofAll(WorldOrderEvaluationPage.errors);
export const OrderEvaluationHasRegisteredCase = (index: number) => Question.about(`authored case ${index + 1} has its exact completed original registration`, async actor => {
  const evidence = await actor.answer(OrderEvaluationEvidence());
  const custody = evidence.custody.find(item => item.attempt === index + 1);
  return !evidence.custodyBlocked && evidence.registered > index && custody?.kind === 'case'
    && custody.outcome === 'confirmed' && Boolean(custody.operationId);
});
export const OrderEvaluationHasExactRegistrations = () => Question.about('all eight exact Train/Holdout registrations have complete final readback and distinct confirmed original custody', async actor => {
  const evidence = await actor.answer(OrderEvaluationEvidence());
  const cases = evidence.custody.filter(item => item.kind === 'case');
  return evidence.registrationsVerified === true && !evidence.custodyBlocked
    && ['cases', 'suite-frozen', 'report-confirmed', 'report-rendered'].includes(evidence.phase)
    && evidence.registered === 8 && evidence.train === 4 && evidence.holdout === 4 && Boolean(evidence.task) && Boolean(evidence.branch)
    && cases.length === 8 && Array.from({ length: 8 }, (_, index) => index + 1).every(attempt => cases.some(item => item.attempt === attempt))
    && cases.every(item => item.outcome === 'confirmed' && Boolean(item.operationId))
    && new Set(cases.map(item => item.operationId)).size === 8;
});
export const OrderEvaluationHasFrozenSuite = () => Question.about('the exact original frozen suite is confirmed, including after its evaluation', async actor => {
  const evidence = await actor.answer(OrderEvaluationEvidence());
  return !evidence.custodyBlocked && Boolean(evidence.suite) && ['suite-frozen', 'report-confirmed'].includes(evidence.phase)
    && evidence.custody.filter(item => item.kind === 'suite').length === 1
    && evidence.custody.some(item => item.kind === 'suite' && item.outcome === 'confirmed' && Boolean(item.operationId));
});
export const OrderEvaluationHasOneRun = () => Question.about('exactly one confirmed evaluation operation with its original public run ownership', async actor => {
  const evidence = await actor.answer(OrderEvaluationEvidence());
  const runs = evidence.custody.filter(item => item.kind === 'evaluation');
  return runs.length === 1 && runs.every(item => item.outcome === 'confirmed' && Boolean(item.operationId) && Boolean(item.runId));
});
export const OrderEvaluationHasExactCoverage = () => Question.about('four Train and four protected Holdout tests with seven genuine constant-memory failures', async actor => {
  const evidence = await actor.answer(OrderEvaluationEvidence());
  return evidence.phase === 'report-rendered' && evidence.registered === 8 && evidence.train === 4 && evidence.holdout === 4
    && evidence.memoryFailures === 7 && Boolean(evidence.task) && Boolean(evidence.branch) && Boolean(evidence.suite)
    && Boolean(evidence.reportId) && Boolean(evidence.candidateId) && evidence.baselineEffectProven === false;
});
