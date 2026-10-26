import { Ensure, equals } from '@serenity-js/assertions';
import { Check, Duration, Log, Task, Wait } from '@serenity-js/core';
import { Attribute, Click, Enter, isEnabled, isVisible } from '@serenity-js/web';
import {
  ArmOrderEvaluationWrite, ChooseOrderEvaluationContext, ConfirmOrderEvaluationWrite, FillOrderEvaluationCase,
  FillOrderEvaluationRun, FillOrderEvaluationSuite, PrepareOrderEvaluation, PreserveOrderEvaluationEvidence,
  ShowOrderEvaluationReport, VerifyOrderEvaluationRegistrations,
} from '../interactions/world-order-evaluation.interaction.js';
import { AccountPage } from '../pages/account.page.js';
import { WorldOrderEvaluationPage } from '../pages/world-order-evaluation.page.js';
import {
  OrderEvaluationEvidence, OrderEvaluationHasExactCoverage, OrderEvaluationHasExactRegistrations, OrderEvaluationHasFrozenSuite,
  OrderEvaluationHasOneRun, OrderEvaluationHasRegisteredCase,
  OrderEvaluationIssues, OrderEvaluationWorldStatus,
} from '../questions/world-order-evaluation.question.js';
import { StartAtSignIn } from './account.task.js';
import { EnterChat } from './chat.task.js';

export const OpenOrderEvaluation = (setup?: Parameters<typeof PrepareOrderEvaluation>[0]) => Task.where('#actor enters existing local/personal through normal World navigation and assembles exact Task, branch and independent Oracle registration prerequisites',
  StartAtSignIn(), EnterChat(),
  Check.whether(AccountPage.expandSidebar, isVisible()).andIfSo(Click.on(AccountPage.expandSidebar)),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldOrderEvaluationPage.navigationGroup, isEnabled()),
  Check.whether(Attribute.called('aria-expanded').of(WorldOrderEvaluationPage.navigationGroup), equals('false'))
    .andIfSo(Click.on(WorldOrderEvaluationPage.navigationGroup)),
  Click.on(WorldOrderEvaluationPage.changesNavigation),
  Check.whether(WorldOrderEvaluationPage.tenant, isVisible()).andIfSo().otherwise(Click.on(WorldOrderEvaluationPage.worldSelector)),
  Enter.theValue('local').into(WorldOrderEvaluationPage.tenant),
  Enter.theValue('personal').into(WorldOrderEvaluationPage.world),
  Wait.upTo(Duration.ofSeconds(45)).until(WorldOrderEvaluationPage.open, isEnabled()),
  Click.on(WorldOrderEvaluationPage.open),
  Wait.upTo(Duration.ofSeconds(45)).until(OrderEvaluationWorldStatus(), equals('ready')),
  Ensure.that(OrderEvaluationIssues(), equals([])),
  Ensure.that(WorldOrderEvaluationPage.dialogs.count(), equals(0)),
  Click.on(WorldOrderEvaluationPage.evaluationTab),
  Click.on(WorldOrderEvaluationPage.openEvaluation),
  PrepareOrderEvaluation(setup), ChooseOrderEvaluationContext(),
  Ensure.that(OrderEvaluationEvidence().custodyBlocked, equals(false)),
);

const RegisterOrderCase = (index: number) => Task.where(`#actor registers authored Train/Holdout case ${index + 1} once through real UI and reads the exact sealed result`,
  Check.whether(OrderEvaluationHasRegisteredCase(index), equals(false)).andIfSo(
    FillOrderEvaluationCase(index),
    Wait.upTo(Duration.ofSeconds(15)).until(WorldOrderEvaluationPage.register, isEnabled()),
    ArmOrderEvaluationWrite('case'), Click.on(WorldOrderEvaluationPage.register), ConfirmOrderEvaluationWrite('case'),
  ),
  Ensure.that(OrderEvaluationHasRegisteredCase(index), equals(true)),
  Ensure.that(OrderEvaluationIssues(), equals([])),
);

export const RegisterOrderEvaluationCases = () => Task.where('#actor registers four fixed Train and four disjoint protected Holdout examples without changing author data',
  ...Array.from({ length: 8 }, (_, index) => RegisterOrderCase(index)),
  VerifyOrderEvaluationRegistrations(),
  Ensure.that(OrderEvaluationHasExactRegistrations(), equals(true)),
  Ensure.that(OrderEvaluationEvidence().registered, equals(8)),
  Ensure.that(OrderEvaluationEvidence().train, equals(4)),
  Ensure.that(OrderEvaluationEvidence().holdout, equals(4)),
);

export const FreezeOrderEvaluationSuite = () => Task.where('#actor freezes the required real four-arm suite once with identical tool closure and conditions',
  Check.whether(OrderEvaluationEvidence().suite, equals(null)).andIfSo(
    FillOrderEvaluationSuite(),
    Wait.upTo(Duration.ofSeconds(15)).until(WorldOrderEvaluationPage.freezeFirst, isEnabled()),
    ArmOrderEvaluationWrite('suite'), Click.on(WorldOrderEvaluationPage.freezeFirst), ConfirmOrderEvaluationWrite('suite'),
  ),
  Ensure.that(OrderEvaluationHasFrozenSuite(), equals(true)),
  Ensure.that(OrderEvaluationIssues(), equals([])),
);

export const RunOrderEvaluationOnce = () => Task.where('#actor runs the original four-arm suite once and preserves real failed constant-memory cases in the exact report',
  Check.whether(OrderEvaluationEvidence().reportId, equals(null)).andIfSo(
    FillOrderEvaluationRun(),
    Wait.upTo(Duration.ofSeconds(15)).until(WorldOrderEvaluationPage.run, isEnabled()),
    ArmOrderEvaluationWrite('evaluation'), Click.on(WorldOrderEvaluationPage.run), ConfirmOrderEvaluationWrite('evaluation'),
  ),
  ShowOrderEvaluationReport(),
  Ensure.that(OrderEvaluationHasOneRun(), equals(true)),
  Ensure.that(OrderEvaluationHasExactCoverage(), equals(true)),
  Ensure.that(OrderEvaluationIssues(), equals([])),
  Log.the(OrderEvaluationEvidence()),
);

export const PreserveOrderEvaluation = () => Task.where('#actor retains all durable test/suite/report history and leaves an unknown original submission untouched',
  PreserveOrderEvaluationEvidence(), Log.the(OrderEvaluationEvidence()),
  Check.whether(OrderEvaluationEvidence().mayLeave, equals(true)).andIfSo(
    Ensure.that(WorldOrderEvaluationPage.dialogs.count(), equals(0)),
    Click.on(WorldOrderEvaluationPage.modelNavigation),
    Wait.upTo(Duration.ofSeconds(15)).until(WorldOrderEvaluationPage.managementPanels.count(), equals(0)),
  ),
);
