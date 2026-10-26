import { Ensure, equals } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait } from '@serenity-js/core';
import { Click, Enter, Select, isEnabled, isVisible } from '@serenity-js/web';
import {
  CaptureWorldRuleOperation, ChooseWorldRuleStage, ConfirmWorldRuleEvaluation, FillWorldRuleArguments,
  MarkWorldRuleEvaluation, OpenWorldRuleCatalog, ReadWorldRuleBinding, ReadWorldRuleChain, ReadWorldRulePrerequisites,
  ReleaseWorldRuleObservation, SelectWorldRuleBranch,
} from '../interactions/world-rules.interaction.js';
import { WorldRulesPage } from '../pages/world-rules.page.js';
import {
  WorldRuleCandidateValue, WorldRuleErrors, WorldRuleForm, WorldRuleOperationId,
  WorldRuleOperationSettled, WorldRuleReceipt, WorldRuleRecordMatches,
} from '../questions/world-rules.question.js';
import { LeaveWorldWorkspace, OpenWorldWorkspace } from './world-workspace.task.js';

export const PrepareWorldRules = () => Task.where('#actor requires authored PQR prerequisites, enters the actual World, and independently reads its canonical source-backed subject and unknown control before any evaluation',
  ReadWorldRuleBinding(), OpenWorldWorkspace(), ReadWorldRulePrerequisites(),
);

export const EvaluateWorldRule = (stage: 'q' | 'r' | 'unknown') => Task.where(`#actor executes the real ${stage} rule once through normal UI and reads its actual exact Operation result without replay`,
  ChooseWorldRuleStage(stage), Click.on(WorldRulesPage.modelNavigation),
  Check.whether(WorldRuleForm().entry, equals('candidate')).andIfSo(
    Click.on(WorldRulesPage.candidateTab),
    Wait.upTo(Duration.ofSeconds(15)).until(WorldRulesPage.candidate, isEnabled()),
    Select.value(WorldRuleCandidateValue()).from(WorldRulesPage.candidate),
  ).otherwise(
    Click.on(WorldRulesPage.definitionTab),
    OpenWorldRuleCatalog(stage),
    Click.on(WorldRulesPage.openEvaluation),
  ),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldRulesPage.evaluation, isVisible()),
  Select.value(WorldRuleForm().target).from(WorldRulesPage.target),
  Check.whether(WorldRuleForm().target, equals('branch')).andIfSo(SelectWorldRuleBranch()),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldRulesPage.loadObjects, isEnabled()), Click.on(WorldRulesPage.loadObjects),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldRulesPage.loadObjects, isEnabled()),
  Ensure.that(WorldRuleErrors(), equals([])), FillWorldRuleArguments(stage), Click.on(WorldRulesPage.previewSummary),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldRuleRecordMatches('preview'), equals(true)),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldRulesPage.execute, isEnabled()),
  MarkWorldRuleEvaluation(stage), Click.on(WorldRulesPage.execute), CaptureWorldRuleOperation(stage),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldRulesPage.historySummary, isVisible()), Click.on(WorldRulesPage.historySummary),
  Enter.theValue(WorldRuleOperationId()).into(WorldRulesPage.operationId), Click.on(WorldRulesPage.lookup),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldRuleOperationSettled(), equals(true)),
  ConfirmWorldRuleEvaluation(stage), Ensure.that(WorldRuleReceipt().phase, equals('completed')),
  Ensure.that(WorldRuleReceipt().result.kind, equals('rule_evaluated')),
  Click.on(WorldRulesPage.resultSummary), Ensure.that(WorldRuleRecordMatches('result'), equals(true)),
  Ensure.that(WorldRuleErrors(), equals([])),
);

export const VerifyWorldRuleChain = () => Task.where('#actor performs full public read-only P→Q→R provenance, bitemporal and unknown verification, with no model or hidden state', ReadWorldRuleChain());
export const ReleaseWorldRules = () => Task.where('#actor releases its owned event subscription without replay or durable cleanup', ReleaseWorldRuleObservation());
export const LeaveWorldRules = () => Task.where('#actor leaves only its World UI forms normally, preserving sources, derived assertions and operation history', LeaveWorldWorkspace());
