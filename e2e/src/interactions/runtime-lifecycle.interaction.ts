import { Duration, Interaction, Wait, notes } from '@serenity-js/core';
import { UseElectron } from '../abilities/use-electron.ability.js';

function statusObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Public runtime status must be an object');
  return value as Record<string, unknown>;
}

export const ObserveRuntimeLifecycle = () => Interaction.where('#actor observes public Host and OpenClaw readiness without private control access', async actor => {
  const electron = actor.abilityTo(UseElectron);
  const deadline = Date.now() + 45_000;
  do {
    const gatewayReply = await electron.fetchHostApi({ path: '/api/gateway/status', method: 'GET', timeoutMs: 5_000 });
    const hostReply = await electron.fetchHostApi({ path: '/api/runtime-host/status', method: 'GET', timeoutMs: 5_000 });
    if (!gatewayReply.ok || !hostReply.ok) throw new Error('Public runtime lifecycle transport is unavailable');
    if (gatewayReply.data.status !== 200 || !gatewayReply.data.ok || hostReply.data.status !== 200 || !hostReply.data.ok) {
      throw new Error(`Public runtime lifecycle requires HTTP 200: gateway=${gatewayReply.data.status}, host=${hostReply.data.status}`);
    }
    const gateway = statusObject(gatewayReply.data.json);
    const host = statusObject(hostReply.data.json);
    const observation = {
      startup: await electron.startupOutcome(),
      gateway: {
        processState: gateway.processState, gatewayReady: gateway.gatewayReady,
        portReachable: gateway.portReachable, transportState: gateway.transportState, healthSummary: gateway.healthSummary,
      },
      host: { status: host.status, hostLifecycle: host.hostLifecycle, runtimeLifecycle: host.runtimeLifecycle },
    };
    await notes<{ runtimeLifecycleObservation: typeof observation }>().set('runtimeLifecycleObservation', observation).performAs(actor);
    if (gateway.processState === 'running' && gateway.gatewayReady === true && gateway.portReachable === true
      && gateway.transportState === 'connected' && gateway.healthSummary === 'healthy'
      && host.status === 'running' && host.hostLifecycle === 'ready' && host.runtimeLifecycle === 'ready') return;
    await Wait.for(Duration.ofMilliseconds(250)).performAs(actor);
  } while (Date.now() < deadline);
});
