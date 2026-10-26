import { Ensure, equals } from '@serenity-js/assertions';
import { Duration, Log, Task, Wait } from '@serenity-js/core';
import { Click, Select, isEnabled } from '@serenity-js/web';
import {
  CheckWorldViewsSession, ConfirmWorldViewsOriginals, FillWorldViewsInput, MarkWorldViewsResolution,
  ReachWorldViewsSelection, ReachWorldViewsTask, ReadRenderedWorldView, ReadWorldViewsBindings,
  ReadWorldViewsResolution, RegisterWorldViewTask, ReleaseWorldViewsObservation,
} from '../interactions/world-views.interaction.js';
import { WorldViewsPage } from '../pages/world-views.page.js';
import {
  WorldViewsBinding, WorldViewsErrors, WorldViewsFacts, WorldViewsOperationSettled,
  WorldViewsReadingSettled, WorldViewsResolution, WorldViewsResponseObserved,
} from '../questions/world-views.question.js';
import { LeaveWorldWorkspace, OpenExistingWorldWorkspace, OpenWorldWorkspace } from './world-workspace.task.js';

export const PrepareWorldViewTask = () => Task.where('#actor enters the existing World and independently registers one new zero-effect business Task without resolving or changing any existing Task',
  OpenExistingWorldWorkspace(), Click.on(WorldViewsPage.versionTab), RegisterWorldViewTask(),
);

export const BuildWorldTaskView = (purpose: 'view' | 'false' | 'unknown') => Task.where('#actor builds a real authorized Context WorldView from explicitly bound existing material, objects and Strategy, leaving Task and Oracle unchanged',
  OpenWorldWorkspace(), ReadWorldViewsBindings(purpose),
  Click.on(WorldViewsPage.versionTab),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldViewsPage.taskScope, isEnabled()),
  Select.value(WorldViewsBinding().scope).from(WorldViewsPage.taskScope),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldViewsPage.taskRefresh, isEnabled()), Click.on(WorldViewsPage.taskRefresh), ReachWorldViewsTask(),
  Click.on(WorldViewsPage.summary), Select.value(WorldViewsBinding().taskValue).from(WorldViewsPage.task),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldViewsReadingSettled(), equals(true)), Ensure.that(WorldViewsErrors(), equals([])),
  Ensure.that(WorldViewsPage.contracts.count(), equals(1)), ReachWorldViewsSelection('abstraction'),
  Select.value(WorldViewsBinding().abstractionValue).from(WorldViewsPage.abstraction), Click.on(WorldViewsPage.inspect),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldViewsReadingSettled(), equals(true)), Ensure.that(WorldViewsErrors(), equals([])),
  Select.value(WorldViewsBinding().queryValue).from(WorldViewsPage.queryType), Click.on(WorldViewsPage.buildView),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldViewsReadingSettled(), equals(true)), Ensure.that(WorldViewsErrors(), equals([])),
  Ensure.that(WorldViewsPage.views.count(), equals(1)), ReadRenderedWorldView(), ConfirmWorldViewsOriginals(), Log.the(WorldViewsFacts()),
);

export const ResolveWorldTaskToGuardStop = () => Task.where('#actor submits the exact original Task, abstraction, independent test and typed input once, observing only this operation\'s real guard/stop result',
  ReachWorldViewsSelection('test'), Select.value(WorldViewsBinding().testValue).from(WorldViewsPage.test),
  Click.on(WorldViewsPage.readEndpoints), Wait.upTo(Duration.ofSeconds(45)).until(WorldViewsPage.endpoint, isEnabled()),
  Select.value(WorldViewsBinding().endpointId).from(WorldViewsPage.endpoint), Click.on(WorldViewsPage.readSessions),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldViewsPage.session, isEnabled()), Ensure.that(WorldViewsErrors(), equals([])), CheckWorldViewsSession(),
  Select.value(WorldViewsBinding().sessionValue).from(WorldViewsPage.session), FillWorldViewsInput(),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldViewsPage.submit, isEnabled()), MarkWorldViewsResolution(), Click.on(WorldViewsPage.submit),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldViewsPage.dialogs.count(), equals(1)), Click.on(WorldViewsPage.confirm),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldViewsPage.dialogs.count(), equals(0)),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldViewsResponseObserved(), equals(true)), Ensure.that(WorldViewsErrors(), equals([])),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldViewsOperationSettled(), equals(true)), ReadWorldViewsResolution(), Log.the(WorldViewsResolution()),
);

export const LeaveWorldTaskView = () => Task.where('#actor releases owned F observation and leaves the UI normally without deleting history, changing Task/pin, resuming or retrying an unknown request',
  ReleaseWorldViewsObservation(), LeaveWorldWorkspace(),
);
