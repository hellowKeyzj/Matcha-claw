import { Ensure, equals } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait } from '@serenity-js/core';
import { Attribute, Click, Enter, isEnabled, isVisible } from '@serenity-js/web';
import {
  ConfirmWorldAction, ConfigureOriginalWorldAction, MarkWorldAction, PreserveWorldActionCustody,
  ReadWorldActionBinding, ReadWorldActionPrerequisites, ReviewOriginalWorldApproval,
  ReviewOriginalWorldProposal, VerifyOriginalWorldAction,
} from '../interactions/world-actions.interaction.js';
import { AccountPage } from '../pages/account.page.js';
import { WorldActionsPage } from '../pages/world-actions.page.js';
import { WorldWorkspacePage } from '../pages/world-workspace.page.js';
import { WorldActionErrors, WorldActionIsSelected, WorldActionMayLeave } from '../questions/world-actions.question.js';
import { WorkspaceOpeningSettled, WorkspaceState } from '../questions/world-workspace.question.js';
import { StartAtSignIn } from './account.task.js';
import { EnterChat } from './chat.task.js';

export const OpenBoundWorldAction = () => Task.where('#actor binds a legal one-shot public input before entering the existing World through normal local navigation',
  ReadWorldActionBinding(), StartAtSignIn(), EnterChat(),
  Check.whether(AccountPage.expandSidebar, isVisible()).andIfSo(Click.on(AccountPage.expandSidebar)),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldWorkspacePage.navigationGroup, isEnabled()),
  Check.whether(Attribute.called('aria-expanded').of(WorldWorkspacePage.navigationGroup), equals('false')).andIfSo(Click.on(WorldWorkspacePage.navigationGroup)),
  Click.on(WorldWorkspacePage.dataNavigation),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldWorkspacePage.dataHeading, isVisible()),
  Check.whether(WorldWorkspacePage.tenant, isVisible()).andIfSo().otherwise(Click.on(WorldWorkspacePage.worldSelector)),
  Enter.theValue('local').into(WorldWorkspacePage.tenant), Enter.theValue('personal').into(WorldWorkspacePage.world),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldWorkspacePage.open, isEnabled()), Click.on(WorldWorkspacePage.open),
  Wait.upTo(Duration.ofSeconds(45)).until(WorkspaceOpeningSettled(), equals(true)),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldWorkspacePage.refresh, isEnabled()),
  Ensure.that(WorkspaceState(), equals({ status: 'ready', errors: [] })),
  ReadWorldActionPrerequisites(), ConfigureOriginalWorldAction(),
  Ensure.that(WorldActionErrors(), equals([])),
);
export const ProposeAndReviewBoundWorldAction = () => Task.where('#actor creates exactly one real action proposal and reviews its unchanged request and impact before approval',
  Wait.upTo(Duration.ofSeconds(15)).until(WorldActionsPage.createProposal, isEnabled()),
  MarkWorldAction('proposal'), Click.on(WorldActionsPage.createProposal), ConfirmWorldAction('proposal'),
  ReviewOriginalWorldProposal(), Ensure.that(WorldActionIsSelected(), equals(true)), Ensure.that(WorldActionErrors(), equals([])),
);
export const ApproveBoundWorldAction = () => Task.where('#actor approves the exact original proposal once through the application, keeping server admission authoritative',
  Ensure.that(WorldActionIsSelected(), equals(true)),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldActionsPage.approve, isEnabled()),
  MarkWorldAction('approval'), Click.on(WorldActionsPage.approve), ConfirmWorldAction('approval'),
  ReviewOriginalWorldApproval(), Ensure.that(WorldActionErrors(), equals([])),
);
export const ExecuteBoundWorldActionOnce = () => Task.where('#actor submits once with the real UI-generated idempotency identity and verifies the same receipt and independent business result',
  Ensure.that(WorldActionIsSelected(), equals(true)),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldActionsPage.submit, isEnabled()),
  MarkWorldAction('action'), Click.on(WorldActionsPage.submit), ConfirmWorldAction('action'),
  VerifyOriginalWorldAction(), Ensure.that(WorldActionErrors(), equals([])),
);
export const PreserveBoundWorldAction = () => Task.where('#actor releases only its observer and collapses confirmed UI review; rejected or unknown custody is never navigated away or replayed',
  PreserveWorldActionCustody(),
  Check.whether(WorldActionMayLeave(), equals(true)).andIfSo(
    Check.whether(WorldActionsPage.collapse, isVisible()).andIfSo(Click.on(WorldActionsPage.collapse)),
  ),
);
