import { Question, notes } from '@serenity-js/core';
import { Attribute, Selected, Text } from '@serenity-js/web';
import { WorldAuthoringPage } from '../pages/world-authoring.page.js';
import { WorldCompilationPage } from '../pages/world-compilation.page.js';

type OriginalInputs = { task: unknown; definitions: string; input: unknown };
type StructuralReadback = {
  id: string; revision: string; status: string; branchId: string; branchRevision: string; operationId: string;
  phase: string; resultKind: string; effects: unknown[]; modelCalls: unknown[]; sourceBasis: unknown[];
  exactDefinitions: boolean; activeReleaseUnchanged: boolean;
};
type OrderDefinition = {
  reference: { id: string }; dependencies: unknown[];
  body: { body: { parameters: unknown[]; resultType?: unknown; expression?: unknown; guard?: unknown; steps?: unknown[] } };
};

export const WorldOrderOriginalDefinitions = () => notes<{ worldOrderOriginal: OriginalInputs }>().get('worldOrderOriginal').definitions
  .as(text => JSON.parse(text) as unknown);
export const WorldOrderOriginalInput = () => notes<{ worldOrderOriginal: OriginalInputs }>().get('worldOrderOriginal').input;
export const WorldOrderDefinitionPreview = () => Text.of(WorldAuthoringPage.preview).as(text => JSON.parse(text) as unknown);
export const WorldOrderAmountSemantics = () => Text.of(WorldAuthoringPage.preview).as(text => {
  const definitions = JSON.parse(text) as OrderDefinition[];
  const fn = definitions.find(item => item.reference.id === 'function:order-line-total:20261026:r1');
  const strategy = definitions.find(item => item.reference.id === 'strategy:order-line-total:20261026:r1');
  return {
    count: definitions.length,
    functionParameters: fn?.body.body.parameters,
    resultType: fn?.body.body.resultType,
    expression: fn?.body.body.expression,
    strategyParameters: strategy?.body.body.parameters,
    strategyGuard: strategy?.body.body.guard,
    strategySteps: strategy?.body.body.steps,
    strategyDependencies: strategy?.dependencies,
  };
});

export const WorldOrderTaskPreviewMatchesOriginal = () => Question.about('every Task contract field, array item and nested leaf matches the unchanged original UI import', async actor => {
  const original = await actor.answer(notes<{ worldOrderOriginal: OriginalInputs }>().get('worldOrderOriginal').task);
  const matches = async (value: unknown, path: (string | number)[]): Promise<boolean> => {
    if (Array.isArray(value) && value.length) {
      if (await actor.answer(WorldCompilationPage.taskItems(path).count()) !== value.length) return false;
      return (await Promise.all(value.map((item, index) => matches(item, [...path, index])))).every(Boolean);
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value);
      const keys = await actor.answer(Text.ofAll(WorldCompilationPage.taskKeys(path)));
      if (JSON.stringify(keys) !== JSON.stringify(entries.map(([key]) => key))) return false;
      return (await Promise.all(entries.map(([key, item]) => matches(item, [...path, key])))).every(Boolean);
    }
    const text = await actor.answer(Text.of(WorldCompilationPage.taskValue(path)));
    return value == null ? /^(Not set|未设置)$/.test(text)
      : Array.isArray(value) ? /^(None|无)$/.test(text) : text === String(value);
  };
  return matches(original, []);
});

export const WorldOrderTaskIsRecorded = () => notes<{ worldOrderTask: { exists: boolean } }>().get('worldOrderTask').exists;
export const WorldOrderTaskIsExact = () => notes<{ worldOrderTask: { exact: boolean } }>().get('worldOrderTask').exact;
export const WorldOrderRecordedTaskValue = () => notes<{ worldOrderTask: { taskValue: string } }>().get('worldOrderTask').taskValue;
export const WorldOrderRegistrationHasResponded = () => Question.about('single Task submission reaches processing records, a direct registration notice, or an explicit UI failure', async actor =>
  await actor.answer(WorldCompilationPage.operationRecords.count()) > 0
  || await actor.answer(WorldCompilationPage.registrationNotices.count()) > 0
  || await actor.answer(WorldAuthoringPage.errors.count()) > 0,
);
export const WorldOrderOperationIsSettled = () => Question.about('the original UI processing record settles or becomes indeterminate; no second poller or resubmission', async actor => {
  if (await actor.answer(WorldCompilationPage.operationPhases.count()) !== 1) return false;
  return ['completed', 'failed', 'cancelled_before_commit', 'cancelled_after_commit', 'commit_indeterminate', 'effect_indeterminate', 'retained']
    .includes(await actor.answer(Attribute.called('data-status').of(WorldCompilationPage.operationPhase)));
});
export const WorldOrderRegistrationErrors = () => Text.ofAll(WorldAuthoringPage.errors);
export const WorldOrderProposalPrerequisites = () => notes<{ worldOrderProposalPrerequisites: { status: string; reason: string } }>().get('worldOrderProposalPrerequisites');
export const WorldOrderStructureMode = () => notes<{ worldOrderStructure: { mode: 'submit' | 'resume' } }>().get('worldOrderStructure').mode;
export const WorldOrderStructureResume = () => notes<{ worldOrderResume: {
  mode: string; verification: string; operationReceiptsRechecked: boolean; candidateRechecked: boolean;
  record: { world: { tenantId: string; worldId: string }; changeId: string; branchId: string; firstRun: string };
  change: { id: string; revision: string; status: string }; branch: { id: string; revision: string };
  exactDefinitions: boolean; exactTask: boolean; activeReleaseUnchanged: boolean;
} }>().get('worldOrderResume');
export const WorldOrderProposal = () => notes<{ worldOrderProposal: StructuralReadback }>().get('worldOrderProposal');
export const WorldOrderValidation = () => notes<{ worldOrderValidation: StructuralReadback }>().get('worldOrderValidation');
export const WorldOrderSelectedChangeId = () => Text.of(WorldCompilationPage.changeId);
export const WorldOrderTaskPreviewCount = () => WorldCompilationPage.importedTasks.count();
export const WorldOrderFunctionOptionCount = () => WorldCompilationPage.orderFunctionOptions.count();
export const WorldOrderSelectedFunction = () => Selected.valueOf(WorldAuthoringPage.functionDefinition);
export const WorldOrderSelectedTask = () => Selected.valueOf(WorldAuthoringPage.task);
export const WorldOrderCompileGroupCount = () => WorldCompilationPage.compilationGroups.count();
export const WorldOrderNoOpDraftTaskValue = () => Question.about('the exact existing NoOp Task used only for compilation UI draft selection, never submission', async actor => {
  if (await actor.answer(WorldCompilationPage.noOpTaskOptions.count()) !== 1) {
    throw new Error('The original NoOp Task must be present exactly once; no registration, substitute Task or submission is permitted');
  }
  return actor.answer(Attribute.called('value').of(WorldCompilationPage.noOpTaskOptions.first()));
});
export const WorldOrderDraftIsGone = () => Question.about('normal canvas navigation removed the owned Task import and authoring draft', async actor =>
  await actor.answer(WorldCompilationPage.versionPanels.count()) === 0
  && await actor.answer(WorldAuthoringPage.authoringPanels.count()) === 0
  && await actor.answer(WorldAuthoringPage.remainingPreviews.count()) === 0,
);
