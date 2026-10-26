import { Ensure, equals } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait } from '@serenity-js/core';
import { Click, Enter, Select, isEnabled } from '@serenity-js/web';
import {
  BindWorldSourceOriginals, ConfirmWorldSchemaDiscovery, ConfirmWorldSourceQuery, ConfirmWorldSourceSynchronization,
  MarkWorldSchemaDiscovery, MarkWorldSourceSynchronization, PrepareWorldSourceConnections, ReadWorldSourceObjectRows,
  ReadWorldSourceCheckpoint, ReadWorldSourcePrerequisites, ReleaseWorldSourceObservations,
} from '../interactions/world-sources.interaction.js';
import { WorldSourcesPage } from '../pages/world-sources.page.js';
import {
  WorldSourcesCheckpointCount, WorldSourcesCheckpointIsExact, WorldSourcesConfirmationCount, WorldSourcesConnectionIsExact,
  WorldSourcesErrors, WorldSourcesInput, WorldSourcesReceiptCount, WorldSourcesReceiptIsExact,
} from '../questions/world-sources.question.js';
import { LeaveWorldWorkspace, OpenWorldWorkspace } from './world-workspace.task.js';

const openConnection = () => Task.where('#actor reaches the exact already configured connection through the ordinary materials catalog; saving configuration is not a probe or synchronization',
  Click.on(WorldSourcesPage.dataNavigation), Click.on(WorldSourcesPage.materialsTab),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldSourcesPage.connection(WorldSourcesInput().connectionName), isEnabled()),
  Click.on(WorldSourcesPage.connection(WorldSourcesInput().connectionName)),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldSourcesPage.connectionRecords.count(), equals(1)),
  Ensure.that(WorldSourcesConnectionIsExact(), equals(true)), Ensure.that(WorldSourcesErrors(), equals([])),
);

export const SetUpWorldSourceConnections = () => Task.where('#actor opens the existing World and prepares two source connections, leaving real discovery to a separately verified active connector binding',
  OpenWorldWorkspace(), PrepareWorldSourceConnections(),
);
export const OpenApprovedWorldSource = () => Task.where('#actor rejects missing or false/null Source prerequisites before any business write or external Source read, then opens the exact existing public connection',
  BindWorldSourceOriginals(), OpenWorldWorkspace(), ReadWorldSourcePrerequisites(), openConnection(),
);
export const DiscoverOriginalWorldSourceSchema = () => Task.where('#actor performs one real normal UI schema probe and verifies its original operation and independent exact result without saving configuration or changing mappings',
  Enter.theValue(WorldSourcesInput().resource).into(WorldSourcesPage.resource),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldSourcesPage.discover, isEnabled()),
  MarkWorldSchemaDiscovery(), Click.on(WorldSourcesPage.discover), ConfirmWorldSchemaDiscovery(),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldSourcesPage.operations.count(), equals(1)),
  Ensure.that(WorldSourcesErrors(), equals([])),
);
export const SynchronizeOriginalWorldSource = () => Task.where('#actor requests one bounded synchronization of the exact published binding through the real application confirmation and verifies a new same-operation checkpoint',
  openConnection(), Select.value(WorldSourcesInput().bindingValue).from(WorldSourcesPage.publishedBinding),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldSourcesPage.start, isEnabled()), Click.on(WorldSourcesPage.start),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldSourcesConfirmationCount(), equals(1)),
  MarkWorldSourceSynchronization(), Click.on(WorldSourcesPage.confirm), ConfirmWorldSourceSynchronization(),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldSourcesConfirmationCount(), equals(0)),
  openConnection(), Select.value(WorldSourcesInput().bindingValue).from(WorldSourcesPage.publishedBinding),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldSourcesPage.readCheckpoint, isEnabled()), Click.on(WorldSourcesPage.readCheckpoint),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldSourcesCheckpointCount(), equals(1)),
  ReadWorldSourceCheckpoint(), Ensure.that(WorldSourcesCheckpointIsExact(), equals(true)), Ensure.that(WorldSourcesErrors(), equals([])),
);
export const QueryOriginalWorldSources = () => Task.where('#actor queries actual hybrid business objects through the normal UI, not its local search filter, and checks the same real receipt plus cursor/snapshot-bound After read',
  Click.on(WorldSourcesPage.dataTab),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldSourcesPage.queryType, isEnabled()),
  Select.value(WorldSourcesInput().typeId).from(WorldSourcesPage.queryType),
  Click.on(WorldSourcesPage.query),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldSourcesPage.object(WorldSourcesInput().objectId), isEnabled()),
  Ensure.that(WorldSourcesErrors(), equals([])), ReadWorldSourceObjectRows(),
  Click.on(WorldSourcesPage.object(WorldSourcesInput().objectId)),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldSourcesPage.selectedObjects.count(), equals(1)),
  Click.on(WorldSourcesPage.receiptSummary),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldSourcesReceiptCount(), equals(1)),
  ConfirmWorldSourceQuery(), Ensure.that(WorldSourcesReceiptIsExact(), equals(true)),
);
export const LeaveWorldSources = () => Task.where('#actor releases only its read observers and leaves its UI selections, never resending, aborting or deleting an unknown Source mutation',
  ReleaseWorldSourceObservations(),
  Check.whether(WorldSourcesConfirmationCount(), equals(1)).andIfSo(Click.on(WorldSourcesPage.cancel)),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldSourcesConfirmationCount(), equals(0)),
  LeaveWorldWorkspace(),
);
