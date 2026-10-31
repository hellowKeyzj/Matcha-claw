import { Ensure, equals, not } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait } from '@serenity-js/core';
import { Click, isEnabled, isSelected, isVisible } from '@serenity-js/web';
import {
  CompareWorldBackupPrerequisites, DownloadWorldBackupReceipt, PrepareWorldBackup, ReadWorldBackupReceipt, SubmitWorldBackup,
} from '../interactions/world-archive.interaction.js';
import { WorldArchivePage } from '../pages/world-archive.page.js';
import { WorldWorkspacePage } from '../pages/world-workspace.page.js';
import {
  WorldBackupErrors, WorldBackupHasSettled, WorldBackupPhase, WorldBackupReadbackIsComplete,
  WorldBackupStorageIdentityMatches, WorldBackupUiMatchesReceipt,
} from '../questions/world-archive.question.js';
import { CurrentWorldPrerequisites, WorkspaceState } from '../questions/world-workspace.question.js';

const InspectBackupUi = () => Task.where('#actor opens the actual Result details and Receipt identity and verifies the completed original backup manifest',
  Check.whether(WorldArchivePage.resultOpen, isVisible()).andIfSo().otherwise(Click.on(WorldArchivePage.resultSummary)),
  Check.whether(WorldArchivePage.identityOpen, isVisible()).andIfSo().otherwise(Click.on(WorldArchivePage.identitySummary)),
  Ensure.that(WorldBackupUiMatchesReceipt(), equals(true)), Ensure.that(WorldBackupErrors(), equals([])),
);
const CheckCurrentBackupWorld = () => Task.where('#actor uses the normal current-world readback control and requires the actual completed UI status',
  Wait.upTo(Duration.ofSeconds(15)).until(WorldArchivePage.readback, isEnabled()), Click.on(WorldArchivePage.readback),
  Wait.upTo(Duration.ofSeconds(30)).until(WorldBackupReadbackIsComplete(), equals(true)),
  Ensure.that(WorkspaceState(), equals({ status: 'ready', errors: [] })),
);

export const CreateWorldBackup = () => Task.where('#actor backs up the actual selected World once through Settings, Storage and default backup details, never restoring, deleting or changing trust',
  Click.on(WorldArchivePage.settings), Click.on(WorldArchivePage.operationsTab),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldArchivePage.operationSelect, isEnabled()),
  PrepareWorldBackup(CurrentWorldPrerequisites()),
  Click.on(WorldArchivePage.storageTab), Click.on(WorldArchivePage.backupSummary),
  Ensure.that(WorldArchivePage.backupRows.count(), equals(3)),
  Ensure.that(WorldBackupStorageIdentityMatches(), equals(true)),
  Ensure.that(WorldArchivePage.includeMaterials, not(isSelected())),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldArchivePage.createBackup, isEnabled()), SubmitWorldBackup(),
  Wait.upTo(Duration.ofSeconds(70)).until(WorldBackupHasSettled(), equals(true)),
  ReadWorldBackupReceipt(), Ensure.that(WorldBackupPhase(), equals('completed')),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldArchivePage.finalReceipt, isEnabled()), Click.on(WorldArchivePage.finalReceipt),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldArchivePage.finalReceipt, isEnabled()),
  InspectBackupUi(), DownloadWorldBackupReceipt(), CheckCurrentBackupWorld(),
);

export const RefreshWorldBackupReadback = () => Task.where('#actor refreshes World normally and rechecks the same original key, terminal receipt, manifest and current-world completion marker',
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.refresh, isEnabled()), Click.on(WorldWorkspacePage.refresh),
  Wait.upTo(Duration.ofSeconds(30)).until(WorldWorkspacePage.refresh, isEnabled()),
  Ensure.that(WorkspaceState(), equals({ status: 'ready', errors: [] })),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldArchivePage.finalReceipt, isEnabled()), Click.on(WorldArchivePage.finalReceipt),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldArchivePage.finalReceipt, isEnabled()),
  ReadWorldBackupReceipt(), InspectBackupUi(), CheckCurrentBackupWorld(),
);

export const VerifyWorldBackupPreservedBusiness = () => Task.where('#actor requires the complete post-backup prerequisites to equal the public original baseline, allowing World description revision changes',
  CompareWorldBackupPrerequisites(CurrentWorldPrerequisites()),
);
