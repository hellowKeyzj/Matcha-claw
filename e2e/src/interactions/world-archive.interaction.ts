import type { Answerable } from '@serenity-js/core';
import { Interaction, notes } from '@serenity-js/core';
import { WorldArchive } from '../abilities/world-archive.ability.js';

export const PrepareWorldBackup = (prerequisites: Answerable<unknown>) => Interaction.where('#actor records complete public backup prerequisites and the pre-submit session in the owned evidence directory', async actor => {
  await actor.abilityTo(WorldArchive).prepare(await actor.answer(prerequisites));
});
export const SubmitWorldBackup = () => Interaction.where('#actor durably records one default backup attempt before its normal UI click and captures the unique public session key', async actor => {
  await notes().set('worldArchiveKey', await actor.abilityTo(WorldArchive).submit()).performAs(actor);
});
export const ReadWorldBackupReceipt = () => Interaction.where('#actor checks only the original public status, result and backup_status operation receipts without replay or resume', async actor => {
  await notes().set('worldArchiveReceipt', await actor.abilityTo(WorldArchive).confirmReceipt()).performAs(actor);
});
export const DownloadWorldBackupReceipt = () => Interaction.where('#actor saves this same application download in the evidence directory and compares every parsed receipt field', async actor => {
  await notes().set('worldArchiveDownload', await actor.abilityTo(WorldArchive).downloadReceipt()).performAs(actor);
});
export const CompareWorldBackupPrerequisites = (prerequisites: Answerable<unknown>) => Interaction.where('#actor compares the current complete six directories, packages, trust and release basis with the original backup baseline', async actor => {
  await notes().set('worldArchiveReadback', await actor.abilityTo(WorldArchive).comparePrerequisites(await actor.answer(prerequisites))).performAs(actor);
});
