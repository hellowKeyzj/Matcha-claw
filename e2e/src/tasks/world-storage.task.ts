import { Ensure, equals } from '@serenity-js/assertions';
import { Check, Duration, Log, Task, Wait } from '@serenity-js/core';
import { Attribute, Click, isEnabled, isVisible } from '@serenity-js/web';
import {
  ConfirmWorldStorageRepeated, ConnectWorldStorage, PrepareWorldStorage, ReadWorldStorageReady,
} from '../interactions/world-storage.interaction.js';
import { AccountPage } from '../pages/account.page.js';
import { WorldStoragePage } from '../pages/world-storage.page.js';
import {
  WorldStorageConnectionIsEmpty, WorldStorageIdentityMatches, WorldStorageIsIdle, WorldStoragePreparation,
  WorldStorageReady, WorldStorageRepeated, WorldStorageState,
} from '../questions/world-storage.question.js';
import { StartAtSignIn } from './account.task.js';
import { EnterChat } from './chat.task.js';

const RequireReadyStorageUi = () => Task.where('#actor observes the ready World and cleared connection form without changing storage or permissions',
  Wait.upTo(Duration.ofSeconds(45)).until(WorldStorageIsIdle(), equals(true)),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldStoragePage.ready, isVisible()),
  Ensure.that(WorldStorageState(), equals({ statuses: ['ready'], errors: [] })),
  Ensure.that(WorldStorageConnectionIsEmpty(), equals(true)),
);

export const OpenWorldStorage = () => Task.where('#actor enters World storage settings through normal visible navigation and records the actual fixture branch',
  StartAtSignIn(), EnterChat(),
  Check.whether(AccountPage.expandSidebar, isVisible()).andIfSo(Click.on(AccountPage.expandSidebar)),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldStoragePage.navigationGroup, isEnabled()),
  Check.whether(Attribute.called('aria-expanded').of(WorldStoragePage.navigationGroup), equals('false'))
    .andIfSo(Click.on(WorldStoragePage.navigationGroup)),
  Click.on(WorldStoragePage.settingsNavigation),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldStoragePage.settingsHeading, isVisible()),
  Click.on(WorldStoragePage.storageTab),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldStoragePage.heading, isVisible()),
  Ensure.that(WorldStoragePage.connection, isVisible()),
  PrepareWorldStorage(), Log.the(WorldStoragePreparation()),
);

export const EnableOrRestoreWorldStorage = () => Task.where('#actor connects once only for a fresh database or first verifies automatic restoration without input or submission',
  Check.whether(WorldStoragePreparation().kind, equals('fresh')).andIfSo(ConnectWorldStorage()),
  RequireReadyStorageUi(), ReadWorldStorageReady(), Log.the(WorldStorageReady()),
  Ensure.that(WorldStorageReady().kind, equals(WorldStoragePreparation().kind)),
  Ensure.that(WorldStorageIdentityMatches(), equals(true)),
  Check.whether(WorldStoragePreparation().kind, equals('restored')).andIfSo(
    Ensure.that(WorldStorageReady().restoredWithoutInput, equals(true)),
  ),
);

export const ReconnectWorldStorage = () => Task.where('#actor reconnects the same dedicated storage once and reads exact identity, authorization and journal invariants',
  ConnectWorldStorage(), RequireReadyStorageUi(), ConfirmWorldStorageRepeated(), Log.the(WorldStorageRepeated()),
  Ensure.that(WorldStorageIdentityMatches(), equals(true)),
);
