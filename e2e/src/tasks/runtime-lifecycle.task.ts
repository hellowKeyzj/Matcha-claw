import { equals } from '@serenity-js/assertions';
import { Duration, Task, Wait } from '@serenity-js/core';
import { Click, isVisible } from '@serenity-js/web';
import { ObserveRuntimeLifecycle } from '../interactions/runtime-lifecycle.interaction.js';
import { RuntimeLifecyclePage } from '../pages/runtime-lifecycle.page.js';
import { OpenClawSettingsStatus, RuntimeHostSettingsStatus } from '../questions/runtime-lifecycle.question.js';

export const ObservePublicRuntimeReadiness = () => Task.where('#actor waits for the retained public runtime lifecycle projections',
  ObserveRuntimeLifecycle(),
);

export const OpenRuntimeLifecycleSettings = () => Task.where('#actor opens the current runtime status UI',
  Click.on(RuntimeLifecyclePage.openSettings),
  Wait.until(RuntimeLifecyclePage.settings, isVisible()),
  Click.on(RuntimeLifecyclePage.runtimeStatus),
  Wait.until(RuntimeLifecyclePage.hostRow, isVisible()),
  Wait.upTo(Duration.ofSeconds(45)).until(RuntimeHostSettingsStatus(), equals('running')),
  Wait.upTo(Duration.ofSeconds(45)).until(OpenClawSettingsStatus(), equals('running')),
);
