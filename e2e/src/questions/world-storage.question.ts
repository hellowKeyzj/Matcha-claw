import { Question, notes } from '@serenity-js/core';
import { Attribute, Text, Value } from '@serenity-js/web';
import { WorldStoragePage } from '../pages/world-storage.page.js';

type StorageNotes = {
  worldStoragePreparation: { kind: 'fresh' | 'restored' };
  worldStorageReady: {
    kind: 'fresh' | 'restored'; world: { tenantId: string; worldId: string }; storageId: string; activeRelease: string;
    catalogs: string[]; canonicalReady: true; authorizationUnchanged: true; restoredWithoutInput: boolean;
  };
  worldStorageRepeated: {
    sameWorld: true; sameStorage: true; sameRelease: true; authorizationUnchanged: true; catalogs: string[]; journalCleared: true;
  };
};

export const WorldStoragePreparation = () => notes<StorageNotes>().get('worldStoragePreparation');
export const WorldStorageReady = () => notes<StorageNotes>().get('worldStorageReady');
export const WorldStorageRepeated = () => notes<StorageNotes>().get('worldStorageRepeated');
export const WorldStorageConnectionIsEmpty = () => Value.of(WorldStoragePage.connection).as(value => value === '');
export const WorldStorageIsIdle = () => Attribute.called('aria-busy').of(WorldStoragePage.panel).as(value => value === 'false');
export const WorldStorageState = () => Question.about('the unique top-bar World status and all safe visible errors', async actor => ({
  statuses: await actor.answer(WorldStoragePage.statuses.eachMappedTo(Attribute.called('data-status'))),
  errors: await actor.answer(Text.ofAll(WorldStoragePage.errors)),
}));
export const WorldStorageIdentityMatches = () => Question.about('the visible World, enabled storage and current release match the canonical readback', async actor => {
  const ready = await actor.answer(WorldStorageReady());
  const world = await actor.answer(Attribute.called('title').of(WorldStoragePage.world));
  const release = await actor.answer(Attribute.called('title').of(WorldStoragePage.activeRelease));
  const storage = await actor.answer(Text.of(WorldStoragePage.storageId));
  return world === `${ready.world.tenantId} / ${ready.world.worldId}` && release === ready.activeRelease
    && /^(Enabled storage|已启用存储) · /u.test(storage)
    && storage.replace(/^(Enabled storage|已启用存储) · /u, '') === ready.storageId;
});
