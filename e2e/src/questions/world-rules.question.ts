import { Question, notes } from '@serenity-js/core';
import { Attribute, Text } from '@serenity-js/web';
import { WorldRulesPage } from '../pages/world-rules.page.js';

type Form = { entry: 'catalog' | 'candidate'; reference: { world: { tenantId: string; worldId: string }; id: string; revision: string }; target: string; branchValue: string; request: unknown };
type Receipt = { phase: string; result: { kind: string; result: { status: string; assertion: unknown } } };

export const WorldRuleForm = () => notes<{ worldRuleForm: Form }>().get('worldRuleForm');
export const WorldRuleCandidateValue = () => WorldRuleForm().reference.as(reference => JSON.stringify([
  reference.world.tenantId, reference.world.worldId, reference.id, reference.revision,
]));
export const WorldRuleOperationId = () => notes<{ worldRuleOperationKey: { operationId: string } }>().get('worldRuleOperationKey').operationId;
export const WorldRuleReceipt = () => notes<{ worldRuleReceipt: Receipt }>().get('worldRuleReceipt');
export const WorldRuleChain = () => notes<{ worldRuleChain: {
  chainVerified: boolean; recordedReplayVerified: boolean; unknownRemainsUnknown: boolean; inputDigest: string;
  explanation: unknown; original: unknown; final: unknown; historical: unknown; sourceReadback: unknown;
} }>().get('worldRuleChain');
export const WorldRuleErrors = () => Text.ofAll(WorldRulesPage.errors);
export const WorldRuleOperationSettled = () => Question.about('the exact looked-up UI operation reaches a terminal or indeterminate phase without another API poller', async actor =>
  await actor.answer(WorldRulesPage.phases.count()) === 1
  && ['completed', 'failed', 'cancelled_before_commit', 'cancelled_after_commit', 'commit_indeterminate', 'effect_indeterminate', 'retained']
    .includes(await actor.answer(Attribute.called('data-status').of(WorldRulesPage.phase))),
);

export const WorldRuleRecordMatches = (kind: 'preview' | 'result') => Question.about(`every ${kind} record field and typed leaf matches the exact public input/receipt, including false and null`, async actor => {
  const expected = kind === 'preview' ? await actor.answer(WorldRuleForm().request) : await actor.answer(WorldRuleReceipt().result);
  const matches = async (value: unknown, path: (string | number)[]): Promise<boolean> => {
    if (Array.isArray(value) && value.length) {
      const items = kind === 'preview' ? WorldRulesPage.previewItems(path) : WorldRulesPage.resultItems(path);
      if (await actor.answer(items.count()) !== value.length) return false;
      return (await Promise.all(value.map((item, index) => matches(item, [...path, index])))).every(Boolean);
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value);
      const keys = await actor.answer(Text.ofAll(kind === 'preview' ? WorldRulesPage.previewKeys(path) : WorldRulesPage.resultKeys(path)));
      if (JSON.stringify([...keys].sort()) !== JSON.stringify(entries.map(([key]) => key).sort())) return false;
      return (await Promise.all(entries.map(([key, item]) => matches(item, [...path, key])))).every(Boolean);
    }
    const text = await actor.answer(Text.of(kind === 'preview' ? WorldRulesPage.previewValue(path) : WorldRulesPage.resultValue(path)));
    return value == null ? /^(Not set|未设置)$/.test(text) : Array.isArray(value) ? /^(None|无)$/.test(text) : text === String(value);
  };
  return matches(expected, []);
});
