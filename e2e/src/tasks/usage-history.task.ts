import { Ensure, equals } from '@serenity-js/assertions';
import { Duration, Task, Wait } from '@serenity-js/core';
import { Click, isVisible, Navigate } from '@serenity-js/web';
import { ReadPublicDashboardUsage } from '../interactions/usage-history.interaction.js';
import { EnterChat } from './chat.task.js';
import { UsageHistoryPage } from '../pages/usage-history.page.js';
import { DashboardUsageHasNoErrors, DashboardUsageHasSettled } from '../questions/usage-history.question.js';

export const OpenDashboardUsage = () => Task.where('#actor opens Dashboard through the UI and reads its selected runtime public usage projection',
  EnterChat(),
  Navigate.reloadPage(),
  EnterChat(),
  Wait.upTo(Duration.ofSeconds(45)).until(UsageHistoryPage.navigation, isVisible()),
  Click.on(UsageHistoryPage.navigation),
  Wait.upTo(Duration.ofSeconds(45)).until(UsageHistoryPage.heading, isVisible()),
  Wait.upTo(Duration.ofSeconds(45)).until(DashboardUsageHasSettled(), equals(true)),
  Ensure.that(DashboardUsageHasNoErrors(), equals(true)),
  Wait.upTo(Duration.ofSeconds(45)).until(UsageHistoryPage.selectedRuntime, isVisible()),
  ReadPublicDashboardUsage(),
);
