import { Log, Task } from '@serenity-js/core';
import { Click } from '@serenity-js/web';
import { InstallSignedWorldMaterials, RetainWorldMaterialsSetup } from '../interactions/world-materials-setup.interaction.js';
import { WorldWorkspacePage } from '../pages/world-workspace.page.js';
import { WorldMaterialsSetupEvidence } from '../questions/world-materials-setup.question.js';
import { OpenExistingWorldWorkspace } from './world-workspace.task.js';

export const PrepareSignedWorldMaterials = () => Task.where('#actor opens local/personal and prepares the signed materials runtime without activation or grants',
  OpenExistingWorldWorkspace(), Click.on(WorldWorkspacePage.settingsNavigation), InstallSignedWorldMaterials(),
  Log.the(WorldMaterialsSetupEvidence()),
);
export const PreserveSignedWorldMaterials = () => Task.where('#actor preserves the original signed materials receipts and any unknown attempt',
  RetainWorldMaterialsSetup(), Log.the(WorldMaterialsSetupEvidence()),
);
