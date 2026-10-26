import { notes } from '@serenity-js/core';
import { Text } from '@serenity-js/web';
import { RuntimeLifecyclePage } from '../pages/runtime-lifecycle.page.js';

type RuntimeLifecycleNotes = {
  runtimeLifecycleObservation: {
    startup: { stage: string; outcome: string } | null;
    gateway: {
      processState: unknown; gatewayReady: unknown; portReachable: unknown;
      transportState: unknown; healthSummary: unknown;
    };
    host: { status: unknown; hostLifecycle: unknown; runtimeLifecycle: unknown };
  };
};

export const ElectronStartupOutcome = () => notes<RuntimeLifecycleNotes>().get('runtimeLifecycleObservation').startup;
export const PublicOpenClawReadiness = () => notes<RuntimeLifecycleNotes>().get('runtimeLifecycleObservation').gateway;
export const PublicRuntimeHostReadiness = () => notes<RuntimeLifecycleNotes>().get('runtimeLifecycleObservation').host;
export const RuntimeHostSettingsStatus = () => Text.of(RuntimeLifecyclePage.hostStatus);
export const OpenClawSettingsStatus = () => Text.of(RuntimeLifecyclePage.openClawStatus);
