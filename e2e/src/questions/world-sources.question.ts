import { Question, notes } from '@serenity-js/core';
import type { Answerable } from '@serenity-js/core';
import { Text } from '@serenity-js/web';
import { WorldSourcesPage } from '../pages/world-sources.page.js';

type SourceInput = { connectionName: string; bindingValue: string; resource: string; typeId: string; objectId: string; sourceCount: number; permissions: { sourceReadApproved: boolean; schemaDiscoveryApproved: boolean; synchronizationApproved: boolean } };
type Prerequisites = { connectionExact: boolean; mappingExact: boolean; capabilitiesProbed: boolean; sourceCount: number; connection: unknown };
type Command = { operationId: string; phase: string; resultKind: string; exactReadback: boolean; checkpoint: unknown };
type Query = { receipt: unknown; objects: unknown[]; queryExact: boolean; sourceCount: number; afterReceiptId: string; originalReceiptId: string; originalCursor: unknown; sameSnapshotBasis: boolean; uiRawRowsVerified: boolean; uiRawEvidenceVerified: boolean; afterRawPageVerified: boolean };

export const WorldSourceSetupEvidence = () => notes<{ worldSourceSetup: { phase: string; confirmed: number; changedRelease: boolean; synchronized: boolean } }>().get('worldSourceSetup');
export const WorldSourcesInput = () => notes<{ worldSourcesInput: SourceInput }>().get('worldSourcesInput');
export const WorldSourcesPrerequisites = () => notes<{ worldSourcesPrerequisites: Prerequisites }>().get('worldSourcesPrerequisites');
export const WorldSourcesDiscovery = () => notes<{ worldSourcesDiscovery: Command }>().get('worldSourcesDiscovery');
export const WorldSourcesSynchronization = () => notes<{ worldSourcesSynchronization: Command }>().get('worldSourcesSynchronization');
export const WorldSourcesQuery = () => notes<{ worldSourcesQuery: Query }>().get('worldSourcesQuery');
export const WorldSourcesErrors = () => Text.ofAll(WorldSourcesPage.errors);
export const WorldSourcesConfirmationCount = () => WorldSourcesPage.confirmations.count();
export const WorldSourcesCheckpointCount = () => WorldSourcesPage.checkpointRecords.count();
export const WorldSourcesReceiptCount = () => WorldSourcesPage.receiptRecords.count();

const renderedRecordMatches = (root: 'connection' | 'checkpoint' | 'receipt', expected: () => Answerable<unknown>) => Question.about(`the complete rendered ${root} matches the same exact public record`, async actor => {
  const original = await actor.answer(expected());
  const matches = async (value: unknown, path: (string | number)[]): Promise<boolean> => {
    if (Array.isArray(value) && value.length) {
      if (await actor.answer(WorldSourcesPage.recordItems(root, path).count()) !== value.length) return false;
      return (await Promise.all(value.map((item, index) => matches(item, [...path, index])))).every(Boolean);
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value);
      const keys = await actor.answer(Text.ofAll(WorldSourcesPage.recordKeys(root, path)));
      if (JSON.stringify(keys) !== JSON.stringify(entries.map(([key]) => key))) return false;
      return (await Promise.all(entries.map(([key, item]) => matches(item, [...path, key])))).every(Boolean);
    }
    const text = await actor.answer(Text.of(WorldSourcesPage.recordValue(root, path)));
    return value === null ? /^(Not set|未设置)$/.test(text)
      : Array.isArray(value) ? /^(None|无)$/.test(text) : text === String(value);
  };
  return matches(original, []);
});

export const WorldSourcesConnectionIsExact = () => renderedRecordMatches('connection', () => Question.about('the original exact public ConnectionView', async actor =>
  actor.answer(WorldSourcesPrerequisites().connection)));
export const WorldSourcesCheckpointIsExact = () => renderedRecordMatches('checkpoint', () => Question.about('the same completed sync checkpoint', async actor =>
  actor.answer(notes<{ worldSourcesCheckpoint: unknown }>().get('worldSourcesCheckpoint'))));
export const WorldSourcesReceiptIsExact = () => renderedRecordMatches('receipt', () => Question.about('the same actual UI query receipt', async actor =>
  actor.answer(WorldSourcesQuery().receipt)));
