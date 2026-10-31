import { Question, notes } from '@serenity-js/core';
import { Attribute, Selected, Text } from '@serenity-js/web';
import { WorldArchivePage } from '../pages/world-archive.page.js';
import { CurrentWorldPrerequisites } from './world-workspace.question.js';

type ArchiveNotes = {
  worldArchiveKey: { world: { tenantId: string; worldId: string }; operationId: string };
  worldArchiveReceipt: {
    accepted: { world: { tenantId: string; worldId: string }; operationId: string; incarnation: string; revision: string };
    phase: string; disclosure: { kind: string }; effects: unknown[]; failure: unknown;
    result: { kind: string; result: { manifest: { digest: string; byteSize: string } } };
  };
  worldArchiveDownload: { byteSize: number; equalsReceipt: boolean };
  worldArchiveReadback: { unchanged: boolean; operationKey: ArchiveNotes['worldArchiveKey']; manifest: { digest: string; byteSize: string } };
};
export const WorldBackupKey = () => notes<ArchiveNotes>().get('worldArchiveKey');
export const WorldBackupReceipt = () => notes<ArchiveNotes>().get('worldArchiveReceipt');
export const WorldBackupDownload = () => notes<ArchiveNotes>().get('worldArchiveDownload');
export const WorldBackupReadback = () => notes<ArchiveNotes>().get('worldArchiveReadback');
export const WorldBackupErrors = () => Text.ofAll(WorldArchivePage.errors);
export const WorldBackupPhase = () => Attribute.called('data-status').of(WorldArchivePage.phase);
export const WorldBackupHasSettled = () => Question.about('the one backup UI receipt completes, fails or becomes indeterminate, without resubmission', async actor => {
  if (await actor.answer(WorldArchivePage.errors.count()) > 0 || await actor.answer(WorldArchivePage.pendingRequests.count()) > 0) return true;
  if (await actor.answer(WorldArchivePage.phases.count()) !== 1) return false;
  return ['completed', 'failed', 'cancelled_before_commit', 'cancelled_after_commit', 'commit_indeterminate', 'effect_indeterminate', 'retained']
    .includes(await actor.answer(WorldBackupPhase()));
});
export const WorldBackupStorageIdentityMatches = () => Question.about('backup details show the actual selected World, incarnation and a public numeric revision', async actor => {
  const facts = await actor.answer(CurrentWorldPrerequisites());
  const values = await actor.answer(Text.ofAll(WorldArchivePage.backupValues));
  return values.length === 3 && values[0] === `${facts.world.tenantId} / ${facts.world.worldId}`
    && values[1] === facts.incarnation && /^\d+$/.test(values[2]);
});
export const WorldBackupUiMatchesReceipt = () => Question.about('the real completed timeline, open Result details and Receipt identity show the original key, incarnation and sealed manifest', async actor => {
  const receipt = await actor.answer(WorldBackupReceipt());
  const key = await actor.answer(WorldBackupKey());
  if (await actor.answer(WorldBackupPhase()) !== 'completed'
    || !/^(Completed|已完成)$/.test(await actor.answer(Text.of(WorldArchivePage.phase)))
    || await actor.answer(Text.of(WorldArchivePage.operationId)) !== key.operationId
    || await actor.answer(Selected.valueOf(WorldArchivePage.operationSelect)) !== key.operationId) return false;
  for (const [path, expected] of [
    [['kind'], 'backup'],
    [['result', 'manifest', 'digest'], receipt.result.result.manifest.digest],
    [['result', 'manifest', 'byteSize'], receipt.result.result.manifest.byteSize],
  ] as const) {
    if (await actor.answer(Text.of(WorldArchivePage.resultValue(path))) !== expected) return false;
  }
  for (const [path, expected] of [
    [['accepted', 'world', 'tenantId'], key.world.tenantId], [['accepted', 'world', 'worldId'], key.world.worldId],
    [['accepted', 'operationId'], key.operationId], [['accepted', 'incarnation'], receipt.accepted.incarnation],
    [['accepted', 'revision'], receipt.accepted.revision],
  ] as const) {
    if (await actor.answer(Text.of(WorldArchivePage.identityValue(path))) !== expected) return false;
  }
  return true;
});
export const WorldBackupReadbackIsComplete = () => Text.ofAll(WorldArchivePage.resultStatuses).as(values =>
  values.length === 1 && /^(The current world state has been checked\.|当前世界状态已核对)$/.test(values[0]));
