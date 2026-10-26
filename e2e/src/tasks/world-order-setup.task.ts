import { Log, Task, notes } from '@serenity-js/core';
import { ActivateWorldOrderOracle, GrantWorldOrderActivation, GrantWorldOrderChangeSetExecution, GrantWorldOrderFourArmExecution, GrantWorldOrderMaterialsExecution, PrepareWorldOrderExecutionBranch, RetainWorldOrderSetupEvidence } from '../interactions/world-order-setup.interaction.js';
import { OpenWorldAuthoring } from './world-authoring.task.js';

export const AuthorizeWorldOrderMaterialsExecution = () => Task.where('#actor grants only finite exact Source materials read/write/execute with probabilistic effects, without importing materials',
  GrantWorldOrderMaterialsExecution(), Log.the(notes().get('worldOrderMaterialsExecutionGrant')),
);

export const AuthorizeWorldOrderFourArmExecution = () => Task.where('#actor grants only known finite four-arm execution and oracle resources, retaining missing materials and deferred full-report authorization separately',
  GrantWorldOrderFourArmExecution(), Log.the(notes().get('worldOrderFourArmExecutionGrant')),
);

export const AuthorizeWorldOrderChangeSetExecution = () => Task.where('#actor binds original proposal and validation custody, grants only exact ChangeSet read/write to the desktop human, then freshly verifies both complete original receipts',
  GrantWorldOrderChangeSetExecution(), Log.the(notes().get('worldOrderChangeSetGrant')),
);

export const PrepareWorldOrderExecution = () => Task.where('#actor prepares the real arithmetic execution through package, Task and branch UI',
  OpenWorldAuthoring(), GrantWorldOrderActivation(), ActivateWorldOrderOracle(), PrepareWorldOrderExecutionBranch(),
  Log.the(notes().get('worldOrderExecutionSetup')),
);

export const PreserveWorldOrderSetup = () => Task.where('#actor preserves setup history and original operation custody',
  RetainWorldOrderSetupEvidence(), Log.the(notes().get('worldOrderExecutionSetup')),
  Log.the(notes().get('worldOrderActivationGrant')), Log.the(notes().get('worldOrderPackageSetup')),
);
