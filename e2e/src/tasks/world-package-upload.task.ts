import { Ensure, equals } from '@serenity-js/assertions';
import { Duration, Task, Wait } from '@serenity-js/core';
import { Attribute, Click, Enter, isEnabled, isVisible } from '@serenity-js/web';
import { CaptureWorldPackageUpload, InspectOriginalWorldPackageUploadUI, LoadWorldPackageUploadReadback, PrepareOriginalWorldPackageRecovery, ReadOriginalWorldPackageUpload, ReadWorldPackageUploadReceipt, ResumeOriginalWorldPackageOnce, SelectWorldPackageUploadOperation, SubmitWorldPackageUploadOnce } from '../interactions/world-package-upload.interaction.js';
import { OriginalWorldPackageUpload, WorldPackageUpload } from '../questions/world-package-upload.question.js';
import { WorldWorkspacePage } from '../pages/world-workspace.page.js';
import { WorkspaceOperationSettled } from '../questions/world-workspace.question.js';
import { OpenExistingWorldWorkspace } from './world-workspace.task.js';

export const UploadTruncatedWorldPackage = () => Task.where('#actor submits one independent truncated package through World settings and displays its failed final receipt',
  OpenExistingWorldWorkspace(), Click.on(WorldWorkspacePage.settingsNavigation),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.settingsHeading, isVisible()),
  Click.on(WorldWorkspacePage.operationsTab), Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.session, isEnabled()),
  CaptureWorldPackageUpload(), Click.on(WorldWorkspacePage.capabilitiesTab),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.packageFile, isEnabled()), SubmitWorldPackageUploadOnce(),
  Click.on(WorldWorkspacePage.operationsTab), Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.session, isEnabled()),
  SelectWorldPackageUploadOperation(), Wait.upTo(Duration.ofSeconds(15)).until(WorkspaceOperationSettled(), equals(true)),
  Ensure.that(Attribute.called('data-status').of(WorldWorkspacePage.tracePhase), equals('failed')),
  Click.on(WorldWorkspacePage.result), Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.result, isEnabled()),
  ReadWorldPackageUploadReceipt(false),
);
export const InspectRepairedWorldPackageUpload = () => Task.where('#actor displays the retained failed upload from the repaired build without another installation or recovery',
  OpenExistingWorldWorkspace(), LoadWorldPackageUploadReadback(), Click.on(WorldWorkspacePage.settingsNavigation),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.settingsHeading, isVisible()),
  Click.on(WorldWorkspacePage.operationsTab), Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.session, isEnabled()),
  Click.on(WorldWorkspacePage.historySummary), Enter.theValue(WorldPackageUpload().operationKey.operationId).into(WorldWorkspacePage.operationId),
  Click.on(WorldWorkspacePage.lookup), Wait.upTo(Duration.ofSeconds(15)).until(WorkspaceOperationSettled(), equals(true)),
  Ensure.that(Attribute.called('data-status').of(WorldWorkspacePage.tracePhase), equals('failed')),
  Click.on(WorldWorkspacePage.result), Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.result, isEnabled()),
  ReadWorldPackageUploadReceipt(false),
);
export const RefreshWorldPackageUploadReceipt = () => Task.where('#actor refreshes World normally and displays the same terminal receipt without replay or recovery',
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.refresh, isEnabled()), Click.on(WorldWorkspacePage.refresh),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.refresh, isEnabled()),
  Ensure.that(Attribute.called('data-status').of(WorldWorkspacePage.tracePhase), equals('failed')),
  Click.on(WorldWorkspacePage.result), Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.result, isEnabled()),
  ReadWorldPackageUploadReceipt(true),
);
export const InspectOriginalWorldPackageUpload = () => Task.where('#actor reads the original r28 upload publicly before looking up and displaying its terminal UI receipt, with no new command',
  OpenExistingWorldWorkspace(), ReadOriginalWorldPackageUpload(false), Click.on(WorldWorkspacePage.settingsNavigation),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.settingsHeading, isVisible()),
  Click.on(WorldWorkspacePage.operationsTab), Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.session, isEnabled()),
  Click.on(WorldWorkspacePage.historySummary), Enter.theValue(OriginalWorldPackageUpload().identity.operationId).into(WorldWorkspacePage.operationId),
  Click.on(WorldWorkspacePage.lookup), Wait.upTo(Duration.ofSeconds(15)).until(WorkspaceOperationSettled(), equals(true)),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.result, isEnabled()), Click.on(WorldWorkspacePage.result),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.result, isEnabled()), InspectOriginalWorldPackageUploadUI(),
);
export const RefreshOriginalWorldPackageUpload = () => Task.where('#actor refreshes only World and reads the same original full terminal receipt without uploading, resuming or retrying',
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.refresh, isEnabled()), Click.on(WorldWorkspacePage.refresh),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.refresh, isEnabled()), ReadOriginalWorldPackageUpload(true),
  Click.on(WorldWorkspacePage.result), Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.result, isEnabled()),
  InspectOriginalWorldPackageUploadUI(),
);
export const RecoverOriginalWorldPackageUpload = () => Task.where('#actor explicitly resumes only the r28 original operation after exact repaired native assembly and admitted receipt checks',
  OpenExistingWorldWorkspace(), PrepareOriginalWorldPackageRecovery(), Click.on(WorldWorkspacePage.settingsNavigation),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.settingsHeading, isVisible()),
  Click.on(WorldWorkspacePage.operationsTab), Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.session, isEnabled()),
  Click.on(WorldWorkspacePage.historySummary), Enter.theValue(OriginalWorldPackageUpload().identity.operationId).into(WorldWorkspacePage.operationId),
  Click.on(WorldWorkspacePage.lookup), Wait.upTo(Duration.ofSeconds(15)).until(WorkspaceOperationSettled(), equals(true)),
  ResumeOriginalWorldPackageOnce(),
  Wait.upTo(Duration.ofSeconds(15)).until(Attribute.called('data-status').of(WorldWorkspacePage.tracePhase), equals(OriginalWorldPackageUpload().actualPhase)),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.result, isEnabled()), Click.on(WorldWorkspacePage.result),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldWorkspacePage.result, isEnabled()), InspectOriginalWorldPackageUploadUI(),
);
