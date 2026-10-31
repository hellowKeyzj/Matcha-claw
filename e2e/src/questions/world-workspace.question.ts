import { Question, notes } from '@serenity-js/core';
import { Attribute, Selected, Text } from '@serenity-js/web';
import { WorldWorkspacePage } from '../pages/world-workspace.page.js';

type WorkspaceNotes = {
  currentWorldPrerequisites: { world: { tenantId: string; worldId: string }; status: string; activeRelease: string;
    activeReleaseHead: unknown; incarnation: string; activationLock: string; scopes: string[]; slots: string[];
    catalogs: Record<string, number>; catalogEntries: Record<string, unknown[]>; tasks: unknown[]; packages: unknown[]; trustPolicy: unknown; unchanged: boolean };
  workspaceCatalogs: { rounds: number; complete: boolean; definitions: string[]; materials: string[];
    connections: Array<{ name: string; configured: boolean }>; proposals: string[]; actions: string[]; pending: string[]; evaluations: string[] };
  workspaceOriginal: { exact: boolean; taskId: string; scope: string };
  workspaceUnchanged: { task: boolean; noOp: boolean; activeRelease: boolean };
  workspaceTask: { scope: string; taskValue: string; authoringValue: string; first: string[]; firstOptions: string[];
    following: Array<{ rows: string[]; options: string[] }>; evaluation: 'available' | 'not-configured'; error: string; abstractions: string[]; tests: string[] };
  workspaceTaskRendered: boolean;
  workspaceSession: { ids: string[]; first: string; missing: string };
  workspaceOperation: { id: string; phase: string; publicOnly: boolean };
  workspaceMissing: { id: string; code: string; stage: string; status: number; message: string; publicOnly: boolean };
  workspaceObjectsDecodeFailures: { cases: string[]; publicOnly: boolean };
};
const normalize = (values: string[]) => values.map(value => value.replace(/\s+/g, ' ').trim());
const sorted = (values: string[]) => [...values].sort();
export const CurrentWorldPrerequisites = () => notes<WorkspaceNotes>().get('currentWorldPrerequisites');
export const WorkspaceCatalogs = () => notes<WorkspaceNotes>().get('workspaceCatalogs');
export const WorkspaceOriginal = () => notes<WorkspaceNotes>().get('workspaceOriginal');
export const WorkspaceUnchanged = () => notes<WorkspaceNotes>().get('workspaceUnchanged');
export const WorkspaceTask = () => notes<WorkspaceNotes>().get('workspaceTask');
export const WorkspaceTaskRendered = () => notes<WorkspaceNotes>().get('workspaceTaskRendered');
export const WorkspaceSession = () => notes<WorkspaceNotes>().get('workspaceSession');
export const WorkspaceOperation = () => notes<WorkspaceNotes>().get('workspaceOperation');
export const WorkspaceMissing = () => notes<WorkspaceNotes>().get('workspaceMissing');
export const WorkspaceObjectsDecodeFailures = () => notes<WorkspaceNotes>().get('workspaceObjectsDecodeFailures');
export const WorkspaceNavigation = () => Question.about('the active World sidebar link and actual page heading agree', async actor => ({
  links: await actor.answer(WorldWorkspacePage.activeNavigation.eachMappedTo(Attribute.called('href'))),
  tabs: (await actor.answer(WorldWorkspacePage.pageTabs.eachMappedTo(Attribute.called('aria-label')))).map(label => {
    if (/^(Business data|业务数据)$/.test(label)) return '#/world';
    if (/^(Models & rules|模型与规则)$/.test(label)) return '#/world/model';
    if (/^(Review changes|Change review|变更审核)$/.test(label)) return '#/world/changes';
    if (/^(World settings|世界设置)$/.test(label)) return '#/world/settings';
    return label;
  }),
  headings: (await actor.answer(Text.ofAll(WorldWorkspacePage.headings))).map(heading => {
    if (/^(Business data|业务数据)$/.test(heading)) return '#/world';
    if (/^(Models & rules|模型与规则)$/.test(heading)) return '#/world/model';
    if (/^(Review changes|变更审核)$/.test(heading)) return '#/world/changes';
    if (/^(World settings|世界设置)$/.test(heading)) return '#/world/settings';
    return heading;
  }),
}));
export const WorkspaceOpeningSettled = () => Question.about('World opening has a real status or explicit error', async actor =>
  await actor.answer(WorldWorkspacePage.statuses.count()) > 0 || await actor.answer(WorldWorkspacePage.errors.count()) > 0,
);
export const WorkspaceState = () => Question.about('the current World status and all visible safe errors', async actor => ({
  status: await actor.answer(WorldWorkspacePage.statuses.count()) === 1 ? await actor.answer(Attribute.called('data-status').of(WorldWorkspacePage.status)) : null,
  errors: await actor.answer(Text.ofAll(WorldWorkspacePage.errors)),
}));
export const WorkspaceDefinitions = () => Question.about('complete loaded definition identities in the actual model catalog', async actor => sorted(await actor.answer(
  WorldWorkspacePage.definitionTitles.eachMappedTo(Attribute.called('title')),
)));
export const WorkspaceExpectedDefinitions = () => WorkspaceCatalogs().definitions.as(sorted);
export const WorkspaceMaterials = () => Question.about('material versions in the complete refreshed UI catalog', async actor => sorted(await actor.answer(Text.ofAll(WorldWorkspacePage.materialVersions))));
export const WorkspaceExpectedMaterials = () => WorkspaceCatalogs().materials.as(sorted);
export const WorkspaceConnections = () => Question.about('connection names and configured-state projection, never credentials', async actor => ({
  names: await actor.answer(Text.ofAll(WorldWorkspacePage.connectionNames)),
  configured: (await actor.answer(Text.ofAll(WorldWorkspacePage.connectionStates))).map(value => {
    if (/^(Configured|已配置)$/.test(value)) return true;
    if (/^(Not configured|待配置)$/.test(value)) return false;
    throw new Error('Unknown connection configured-state label');
  }),
}));
export const WorkspaceExpectedConnections = () => WorkspaceCatalogs().connections.as(items => ({ names: items.map(item => item.name), configured: items.map(item => item.configured) }));
export const WorkspaceProposals = () => Text.ofAll(WorldWorkspacePage.proposalIds).as(sorted);
export const WorkspaceExpectedProposals = () => WorkspaceCatalogs().proposals.as(sorted);
export const WorkspaceActions = () => Text.ofAll(WorldWorkspacePage.actionNames).as(sorted);
export const WorkspaceExpectedActions = () => WorkspaceCatalogs().actions.as(sorted);
export const WorkspaceChanges = () => Text.ofAll(WorldWorkspacePage.changesQueue).as(sorted);
export const WorkspaceExpectedChanges = () => WorkspaceCatalogs().pending.as(sorted);
export const WorkspaceEvaluations = () => Text.ofAll(WorldWorkspacePage.evaluationIds).as(sorted);
export const WorkspaceExpectedEvaluations = () => WorkspaceCatalogs().evaluations.as(sorted);
export const WorkspaceTaskRows = () => Text.ofAll(WorldWorkspacePage.taskRows).as(normalize);
export const WorkspaceFirstTaskRows = () => WorkspaceTask().first.as(normalize);
export const WorkspaceTaskOptions = () => WorldWorkspacePage.authoringOptions.eachMappedTo(Attribute.called('value'));
export const WorkspaceResolutionSettled = () => Question.about('TaskResolution reaches full contract or an explicit failure after its composed reads', async actor =>
  await actor.answer(WorldWorkspacePage.resolutionReading.count()) === 0 &&
  (await actor.answer(WorldWorkspacePage.fullContracts.count()) === 1 || await actor.answer(WorldWorkspacePage.resolutionErrors.count()) > 0),
);
export const WorkspaceResolutionErrors = () => Text.ofAll(WorldWorkspacePage.resolutionErrors);
export const WorkspaceAbstractions = () => WorldWorkspacePage.abstractionOptions.eachMappedTo(Attribute.called('value'));
export const WorkspaceTests = () => WorldWorkspacePage.testOptions.eachMappedTo(Attribute.called('value'));
export const WorkspaceOriginalAuthoringSelected = () => Question.about('authoring retains the original Task and exact current baseline', async actor =>
  await actor.answer(Selected.valueOf(WorldWorkspacePage.authoringTask)) === await actor.answer(WorkspaceTask().authoringValue)
  && await actor.answer(Selected.valueOf(WorldWorkspacePage.targetLock)) === await actor.answer(Attribute.called('value').of(WorldWorkspacePage.baselineLock)),
);
export const WorkspaceOperationSettled = () => Question.about('the selected public operation has a receipt or explicit read failure', async actor =>
  await actor.answer(WorldWorkspacePage.tracePhases.count()) === 1 || await actor.answer(WorldWorkspacePage.operationErrors.count()) > 0,
);
export const WorkspaceOperationErrorTexts = () => Text.ofAll(WorldWorkspacePage.operationErrors);
export const WorkspaceTrackedCount = () => Text.of(WorldWorkspacePage.tracked);
export const MaterialPolicySelections = () => Question.about('no material scope, access policy or retention policy has been selected', async actor => [
  await actor.answer(Selected.valueOf(WorldWorkspacePage.materialScope)),
  await actor.answer(Selected.valueOf(WorldWorkspacePage.materialAccess)),
  await actor.answer(Selected.valueOf(WorldWorkspacePage.materialRetention)),
]);
export const WorkspaceSessionValues = () => WorldWorkspacePage.sessionOptions.eachMappedTo(Attribute.called('value'));
export const WorkspaceSessionCount = () => WorkspaceSession().ids.as(ids => ids.length);
export const WorkspaceLeft = () => Question.about('normal navigation unmounted all owned World forms, drafts and disclosures', async actor =>
  await actor.answer(WorldWorkspacePage.worldSurfaces.count()) === 0,
);
